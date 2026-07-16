import { CAPACITY_LIMITS } from '../config.js';
import { createHash } from 'node:crypto';
import type { Logger } from '../logger.js';
import {
  deriveFinalRunStatus,
  isTerminalRunStatus,
} from './state-machine.js';
import { nextStepAction } from './plan.js';
import type { StepExecutor } from './executor.js';
import type { StepGuard, StepGuardResult } from './step-guard.js';
import type { GiteaSyncInput, WorkflowStore } from './store.js';
import {
  parseWorkflowJob,
  type RunSnapshot,
  type StepKey,
  type StepExecutionResult,
  type WorkflowJobData,
} from './types.js';

export interface WorkflowDispatcher {
  dispatch(job: WorkflowJobData): Promise<void>;
}

export interface WorkflowConsumerDependencies {
  readonly store: WorkflowStore;
  readonly stepGuard: StepGuard;
  readonly executor: StepExecutor;
  readonly dispatcher: WorkflowDispatcher;
  readonly logger: Logger;
}

class WorkflowOrderingError extends Error {
  constructor(requested: StepKey, expected: StepKey) {
    super(`workflow step out of order: requested ${requested}, expected ${expected}`);
    this.name = 'WorkflowOrderingError';
  }
}

function phaseForStep(stepKey: StepKey): RunSnapshot['status'] | undefined {
  if (stepKey === 'detect' || stepKey === 'fetch') {
    return 'PLANNING';
  }
  if (
    stepKey === 'analyze' ||
    stepKey === 'test' ||
    stepKey === 'build' ||
    stepKey === 'preview' ||
    stepKey === 'health'
  ) {
    return 'EXECUTING';
  }
  if (stepKey === 'assemble-review-input') {
    return 'ANALYZING';
  }
  if (stepKey === 'agent-review' || stepKey === 'report') {
    return 'REPORTING';
  }
  return undefined;
}

export class WorkflowConsumer {
  constructor(private readonly dependencies: WorkflowConsumerDependencies) {}

  async handle(payload: unknown): Promise<void> {
    const job = parseWorkflowJob(payload);
    if (job === undefined) {
      this.dependencies.logger.error('discarding malformed workflow job');
      return;
    }

    const run = await this.dependencies.store.getRun(job.runId);
    if (run === null) {
      this.dependencies.logger.warn('discarding workflow job for missing run', {
        runId: job.runId,
        attempt: job.attempt,
        stepKey: job.stepKey,
      });
      return;
    }

    if (run.attempt !== job.attempt || run.headSha !== job.headSha) {
      this.dependencies.logger.info('discarding stale workflow job', {
        runId: job.runId,
        jobAttempt: job.attempt,
        currentAttempt: run.attempt,
        stepKey: job.stepKey,
      });
      return;
    }

    if (run.status === 'CANCEL_REQUESTED' && job.stepKey !== 'cleanup') {
      await this.dependencies.dispatcher.dispatch({ ...job, stepKey: 'cleanup' });
      return;
    }

    if (run.status === 'CANCEL_REQUESTED') {
      await this.advanceCancellation(run, job);
      return;
    }

    await this.advance(run, job);
  }

  private async advance(run: RunSnapshot, job: WorkflowJobData): Promise<void> {
    let currentRun = run;

    while (true) {
      const records = await this.dependencies.stepGuard.list(
        job.runId,
        job.attempt,
      );
      const next = nextStepAction(records);
      if (next === undefined) {
        return;
      }

      if (next.action === 'skip') {
        await this.dependencies.stepGuard.markSkipped(
          {
            runId: job.runId,
            attempt: job.attempt,
            stepKey: next.stepKey,
          },
          next.reason,
        );
        await this.enqueueGiteaStatus(currentRun, next.stepKey);
        continue;
      }

      const requestedRecord = records.find(
        (record) => record.stepKey === job.stepKey,
      );
      if (
        next.stepKey !== job.stepKey &&
        (requestedRecord?.status === 'PASSED' ||
          requestedRecord?.status === 'FAILED' ||
          requestedRecord?.status === 'SKIPPED' ||
          requestedRecord?.status === 'INCOMPLETE' ||
          requestedRecord?.status === 'CANCELLED')
      ) {
        await this.dispatchNext(currentRun, job);
        return;
      }
      if (next.stepKey !== job.stepKey) {
        throw new WorkflowOrderingError(job.stepKey, next.stepKey);
      }

      currentRun = await this.moveToStepPhase(currentRun, job.stepKey);
      if (job.stepKey === 'cleanup') {
        await this.dependencies.store.setCleanupStatus({
          runId: job.runId,
          attempt: job.attempt,
          headSha: job.headSha,
          status: 'PENDING',
        });
      }

      const result = await this.dependencies.stepGuard.runOnce(
        {
          runId: job.runId,
          attempt: job.attempt,
          stepKey: job.stepKey,
        },
        () =>
          this.dependencies.executor.execute({
            run: currentRun,
            job,
            capacity: {
              maxActiveRuns: CAPACITY_LIMITS.maxActiveRuns,
              maxQueuedRuns: CAPACITY_LIMITS.maxQueuedRuns,
              maxStepLogBytes: CAPACITY_LIMITS.maxStepLogBytes,
              maxReviewInputBytes: CAPACITY_LIMITS.maxReviewInputBytes,
            },
          }),
      );

      if (result.outcome === 'busy') {
        throw new Error(
          `workflow step lease is busy: ${job.runId}/${job.attempt}/${job.stepKey}`,
        );
      }

      if (result.outcome === 'already-terminal') {
        this.dependencies.logger.info('workflow step already terminal', {
          runId: job.runId,
          attempt: job.attempt,
          stepKey: job.stepKey,
          status: result.status,
        });
      }

      if (result.outcome === 'executed') {
        await this.persistStepDetails(job, result.result);
      }

      await this.enqueueGiteaStatus(currentRun, job.stepKey);

      if (job.stepKey === 'report') {
        await this.finalizeReport(job);
        await this.enqueueQualitySync(job);
      }
      if (job.stepKey === 'cleanup') {
        await this.finalizeCleanup(currentRun, job, result);
        const cleanupSucceeded =
          result.outcome === 'already-terminal'
            ? result.status === 'PASSED'
            : result.outcome === 'executed' && result.result.status === 'PASSED';
        if (!cleanupSucceeded) return;
      }

      const refreshedRun = await this.dependencies.store.getRun(job.runId);
      if (refreshedRun?.status === 'CANCEL_REQUESTED') {
        await this.dependencies.dispatcher.dispatch({ ...job, stepKey: 'cleanup' });
        return;
      }
      await this.dispatchNext(currentRun, job);
      return;
    }
  }

  private async persistStepDetails(
    job: WorkflowJobData,
    result: StepExecutionResult,
  ): Promise<void> {
    const details = result.details;
    if (details === undefined) return;

    if (
      job.stepKey === 'detect' &&
      this.dependencies.store.setExecutionPlan !== undefined &&
      typeof details.executionPlan === 'object' &&
      details.executionPlan !== null &&
      !Array.isArray(details.executionPlan)
    ) {
      await this.dependencies.store.setExecutionPlan({
        runId: job.runId,
        attempt: job.attempt,
        headSha: job.headSha,
        plan: details.executionPlan as Record<string, unknown>,
      });
    }

    if (
      job.stepKey === 'build' &&
      this.dependencies.store.setExecutionPlan !== undefined &&
      details.buildMode === 'FIXTURE'
    ) {
      await this.dependencies.store.setExecutionPlan({
        runId: job.runId,
        attempt: job.attempt,
        headSha: job.headSha,
        plan: { buildMode: 'FIXTURE' },
      });
    }

    if (
      job.stepKey === 'preview' &&
      typeof details.previewHost === 'string' &&
      typeof details.previewExpiresAt === 'string'
    ) {
      const expiresAt = new Date(details.previewExpiresAt);
      if (Number.isFinite(expiresAt.getTime())) {
        await this.dependencies.store.setPreview?.({
          runId: job.runId,
          attempt: job.attempt,
          headSha: job.headSha,
          previewHost: details.previewHost,
          expiresAt,
        });
      }
    }

    if (
      job.stepKey === 'agent-review' &&
      (result.status === 'PASSED' || result.status === 'INCOMPLETE') &&
      typeof details.provider === 'string' &&
      typeof details.model === 'string' &&
      typeof details.inputHash === 'string' &&
      typeof details.report === 'object' &&
      details.report !== null &&
      typeof (details.report as Record<string, unknown>).summary === 'string'
    ) {
      await this.dependencies.store.saveReport?.({
        runId: job.runId,
        attempt: job.attempt,
        headSha: job.headSha,
        provider: details.provider,
        model: details.model,
        inputHash: details.inputHash,
        verdict: result.status === 'PASSED' ? 'PASSED' : 'INCOMPLETE',
        summary: (details.report as { summary: string }).summary,
        reportJson: details.report as Record<string, unknown>,
      });
    }
  }

  private async moveToStepPhase(
    run: RunSnapshot,
    stepKey: StepKey,
  ): Promise<RunSnapshot> {
    const target = phaseForStep(stepKey);
    if (target === undefined || run.status === target) {
      return run;
    }

    if (run.status === 'RECEIVED') {
      throw new Error(
        'received runs must be admitted to QUEUED before worker execution',
      );
    }

    await this.dependencies.store.transitionRun({
      runId: run.id,
      attempt: run.attempt,
      headSha: run.headSha,
      to: target,
      reason: `workflow step ${stepKey}`,
    });
    return { ...run, status: target };
  }

  private async finalizeReport(job: WorkflowJobData): Promise<void> {
    const records = await this.dependencies.stepGuard.list(
      job.runId,
      job.attempt,
    );
    const run = await this.dependencies.store.getRun(job.runId);
    if (run === null || isTerminalRunStatus(run.status)) {
      return;
    }

    await this.dependencies.store.transitionRun({
      runId: job.runId,
      attempt: job.attempt,
      headSha: job.headSha,
      to: deriveFinalRunStatus(records),
      reason: 'workflow report finalized',
    });
  }

  private async finalizeCleanup(
    run: RunSnapshot,
    job: WorkflowJobData,
    result: StepGuardResult,
  ): Promise<void> {
    if (result.outcome === 'busy') {
      return;
    }

    const succeeded =
      result.outcome === 'already-terminal'
        ? result.status === 'PASSED'
        : result.result.status === 'PASSED';

    if (!succeeded) {
      const errorCode =
        result.outcome === 'executed' && result.result.status === 'FAILED'
          ? result.result.errorCode
          : 'CLEANUP_STEP_FAILED';
      await this.dependencies.store.setCleanupStatus({
        runId: job.runId,
        attempt: job.attempt,
        headSha: job.headSha,
        status: 'FAILED',
        errorCode,
      });
      return;
    }

    await this.dependencies.store.setCleanupStatus({
      runId: job.runId,
      attempt: job.attempt,
      headSha: job.headSha,
      status: 'CLEANED',
    });
    const refreshedRun = await this.dependencies.store.getRun(job.runId);
    if (refreshedRun?.status === 'CANCEL_REQUESTED') {
      await this.dependencies.store.transitionRun({
        runId: run.id,
        attempt: job.attempt,
        headSha: job.headSha,
        to: 'CANCELLED',
        reason: 'cleanup confirmed after cancellation request',
      });
    }
  }

  private async advanceCancellation(
    run: RunSnapshot,
    job: WorkflowJobData,
  ): Promise<void> {
    if (job.stepKey !== 'cleanup') {
      return;
    }

    const records = await this.dependencies.stepGuard.list(run.id, run.attempt);
    if (records.some((record) => record.status === 'RUNNING' && record.stepKey !== 'cleanup')) {
      this.dependencies.logger.info('deferring cancellation cleanup while a workflow step is running', {
        runId: job.runId,
        attempt: job.attempt,
      });
      return;
    }

    await this.dependencies.store.setCleanupStatus({
      runId: job.runId,
      attempt: job.attempt,
      headSha: job.headSha,
      status: 'PENDING',
    });
    const result = await this.dependencies.stepGuard.runOnce(
      {
        runId: job.runId,
        attempt: job.attempt,
        stepKey: 'cleanup',
      },
      () =>
        this.dependencies.executor.execute({
          run,
          job,
          capacity: {
            maxActiveRuns: CAPACITY_LIMITS.maxActiveRuns,
            maxQueuedRuns: CAPACITY_LIMITS.maxQueuedRuns,
            maxStepLogBytes: CAPACITY_LIMITS.maxStepLogBytes,
            maxReviewInputBytes: CAPACITY_LIMITS.maxReviewInputBytes,
          },
        }),
    );
    if (result.outcome === 'busy') {
      throw new Error(`cleanup is already running for ${job.runId}`);
    }
    await this.finalizeCleanup(run, job, result);
  }

  private async dispatchNext(
    run: RunSnapshot,
    job: WorkflowJobData,
  ): Promise<void> {
    const next = nextStepAction(
      await this.dependencies.stepGuard.list(job.runId, job.attempt),
    );
    if (next === undefined) {
      return;
    }

    await this.dependencies.dispatcher.dispatch({
      runId: run.id,
      attempt: job.attempt,
      headSha: job.headSha,
      stepKey: next.stepKey,
    });
  }

  private async enqueueGiteaStatus(run: RunSnapshot, stepKey: StepKey): Promise<void> {
    const context = stepKey === 'build'
      ? 'platform/build'
      : stepKey === 'test'
        ? 'platform/test'
        : stepKey === 'analyze'
          ? 'platform/security'
          : stepKey === 'health'
            ? 'platform/preview'
            : undefined;
    if (context === undefined) return;
    const records = await this.dependencies.stepGuard.list(run.id, run.attempt);
    const record = records.find((candidate) => candidate.stepKey === stepKey);
    if (!record) return;
    await this.enqueueGiteaSync(run, {
      artifactType: 'status',
      context,
      desiredState: record.status === 'PASSED' ? 'success' : 'failure',
      desiredDescription: `${context} ${record.status === 'PASSED' ? '通过' : '未通过'} [run ${run.id} a${run.attempt}]`,
      desiredBody: '',
    });
  }

  private async enqueueQualitySync(job: WorkflowJobData): Promise<void> {
    const run = await this.dependencies.store.getRun(job.runId);
    if (!run) return;
    const records = await this.dependencies.stepGuard.list(run.id, run.attempt);
    const passed = run.status === 'PASSED';
    await this.enqueueGiteaSync(run, {
      artifactType: 'status',
      context: 'platform/quality-review',
      desiredState: passed ? 'success' : 'failure',
      desiredDescription: `${passed ? '质量审查通过' : '质量审查未通过'} [run ${run.id} a${run.attempt}]`,
      desiredBody: '',
    });
    const marker = `<!-- platform-run:${run.id}:attempt:${run.attempt}:head:${run.headSha}:quality -->`;
    const lines = [
      marker,
      '## 平台质量审查',
      `- 运行结果：${run.status}`,
      ...records.map((record) => `- ${record.stepKey}: ${record.status}`),
    ];
    await this.enqueueGiteaSync(run, {
      artifactType: 'comment',
      context: 'platform/quality-comment',
      desiredState: passed ? 'success' : 'failure',
      desiredDescription: '',
      desiredBody: lines.join('\n'),
    });
  }

  private async enqueueGiteaSync(
    run: RunSnapshot,
    input: Omit<GiteaSyncInput, 'runId' | 'attempt' | 'headSha' | 'repositoryFullName' | 'pullRequestNumber' | 'desiredHash'>,
  ): Promise<void> {
    if (
      this.dependencies.store.enqueueGiteaSync === undefined ||
      run.repositoryFullName === undefined ||
      run.pullRequestNumber === undefined
    ) return;
    const desiredHash = createHash('sha256').update(JSON.stringify({
      context: input.context,
      state: input.desiredState,
      description: input.desiredDescription,
      targetUrl: input.desiredTargetUrl ?? null,
      body: input.desiredBody,
    })).digest('hex');
    await this.dependencies.store.enqueueGiteaSync({
      ...input,
      runId: run.id,
      attempt: run.attempt,
      headSha: run.headSha,
      repositoryFullName: run.repositoryFullName,
      pullRequestNumber: run.pullRequestNumber,
      desiredHash,
    });
  }
}
