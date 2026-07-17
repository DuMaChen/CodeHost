import { and, eq, isNull, lte, or, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import type { Database } from '@platform/db';
import { findings, giteaSyncs, k8sResources, pullRequests, reports, repositories, runSteps, runs } from '@platform/db';
import {
  isValidRunStatusTransition,
  isTerminalRunStatus,
  type CleanupStatus,
  type RunStatus,
} from '@platform/contracts';
import { AgentReportSchema } from '@platform/contracts';
import { isTerminalStepForRetry, type StepGuard, type StepGuardKey, type StepGuardResult } from './step-guard.js';
import type {
  FailureKind,
  RunSnapshot,
  StepExecutionResult,
  StepRecord,
  StepStatus,
  TerminalStepStatus,
} from './types.js';
import type { GiteaSyncInput, WorkflowStore } from './store.js';

const STALE_STEP_MS = 20 * 60 * 1000;
const STEP_HEARTBEAT_MS = 5 * 60 * 1000;

class StepLeaseLostError extends Error {
  constructor(key: StepGuardKey) {
    super(`workflow step lease lost: ${key.runId}/${key.attempt}/${key.stepKey}`);
    this.name = 'StepLeaseLostError';
  }
}

function lockFor(key: StepGuardKey) {
  return sql`select pg_advisory_xact_lock(hashtextextended(${`${key.runId}:${key.attempt}:${key.stepKey}`}, 0))`;
}

function asRunSnapshot(
  row: typeof runs.$inferSelect,
  details?: { readonly repositoryFullName?: string; readonly pullRequestNumber?: number },
): RunSnapshot {
  return {
    id: row.id,
    attempt: row.currentAttempt,
    headSha: row.headSha,
    status: row.status as RunStatus,
    cleanupStatus: row.cleanupStatus as CleanupStatus,
    executionPlan: row.executionPlanJson,
    ...(details?.repositoryFullName === undefined ? {} : { repositoryFullName: details.repositoryFullName }),
    ...(details?.pullRequestNumber === undefined ? {} : { pullRequestNumber: details.pullRequestNumber }),
  };
}

export class DatabaseWorkflowStore implements WorkflowStore {
  constructor(private readonly db: Database) {}

  async getRun(runId: string): Promise<RunSnapshot | null> {
    const rows = await this.db
      .select({ run: runs, repositoryFullName: repositories.fullName, pullRequestNumber: pullRequests.externalNumber })
      .from(runs)
      .innerJoin(repositories, eq(runs.repositoryId, repositories.id))
      .innerJoin(pullRequests, eq(runs.pullRequestId, pullRequests.id))
      .where(eq(runs.id, runId))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : asRunSnapshot(row.run, {
      repositoryFullName: row.repositoryFullName,
      pullRequestNumber: row.pullRequestNumber,
    });
  }

  async transitionRun(input: {
    readonly runId: string;
    readonly attempt: number;
    readonly headSha: string;
    readonly to: RunStatus;
    readonly reason?: string;
  }): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`platform:run:${input.runId}`}, 0))`);
      const current = await tx.select().from(runs).where(eq(runs.id, input.runId)).limit(1);
      const row = current[0];
      if (!row) throw new Error(`run not found: ${input.runId}`);
      if (row.currentAttempt !== input.attempt || row.headSha !== input.headSha) throw new Error(`stale run identity rejected: ${input.runId}`);
      if (
        !isValidRunStatusTransition(row.status, input.to, {
          cleanupConfirmed: row.cleanupStatus === 'CLEANED',
        })
      ) {
        throw new Error(`invalid run transition: ${row.status} -> ${input.to}`);
      }

      const now = new Date();
      const terminal = isTerminalRunStatus(input.to);
      const updated = await tx
        .update(runs)
        .set({
          status: input.to,
          updatedAt: now,
          ...(input.to === 'PLANNING' && row.startedAt === null ? { startedAt: now } : {}),
          ...(terminal ? { finishedAt: now } : {}),
          ...(input.to === 'PASSED' || input.to === 'FAILED' || input.to === 'INCOMPLETE'
            ? { verdict: input.to }
            : {}),
          ...(input.reason === undefined ? {} : { errorCode: input.reason.slice(0, 128) }),
        })
        .where(and(eq(runs.id, input.runId), eq(runs.status, row.status), eq(runs.currentAttempt, input.attempt), eq(runs.headSha, input.headSha)))
        .returning({ id: runs.id });
      if (updated.length !== 1) {
        throw new Error(`stale run transition rejected: ${input.runId}`);
      }
    });
  }

  async setCleanupStatus(input: {
    readonly runId: string;
    readonly attempt: number;
    readonly headSha: string;
    readonly status: CleanupStatus;
    readonly errorCode?: string;
  }): Promise<void> {
    const changes: {
      cleanupStatus: CleanupStatus;
      cleanupAt?: Date;
      cleanupError?: string | null;
    } = { cleanupStatus: input.status };
    if (input.status === 'CLEANED' || input.status === 'FAILED') {
      changes.cleanupAt = new Date();
    }
    if (input.status === 'PENDING' || input.status === 'CLEANED') {
      changes.cleanupError = null;
    } else if (input.errorCode !== undefined) {
      changes.cleanupError = input.errorCode;
    }
    const updated = await this.db.update(runs).set({ ...changes, updatedAt: new Date() }).where(and(eq(runs.id, input.runId), eq(runs.currentAttempt, input.attempt), eq(runs.headSha, input.headSha))).returning({ id: runs.id });
    if (updated.length !== 1) throw new Error(`stale cleanup identity rejected: ${input.runId}`);
  }

  async setPreview(input: {
    readonly runId: string;
    readonly attempt: number;
    readonly headSha: string;
    readonly previewHost: string;
    readonly expiresAt: Date;
  }): Promise<void> {
    const updated = await this.db.update(runs).set({
      previewHost: input.previewHost,
      previewExpiresAt: input.expiresAt,
      updatedAt: new Date(),
    }).where(and(eq(runs.id, input.runId), eq(runs.currentAttempt, input.attempt), eq(runs.headSha, input.headSha))).returning({ id: runs.id });
    if (updated.length !== 1) throw new Error(`stale preview identity rejected: ${input.runId}`);
  }

  async setExecutionPlan(input: {
    readonly runId: string;
    readonly attempt: number;
    readonly headSha: string;
    readonly plan: Record<string, unknown>;
  }): Promise<void> {
    const current = await this.db.select({
      attempt: runs.currentAttempt,
      headSha: runs.headSha,
      executionPlan: runs.executionPlanJson,
    }).from(runs).where(eq(runs.id, input.runId)).limit(1);
    const row = current[0];
    if (row === undefined || row.attempt !== input.attempt || row.headSha !== input.headSha) {
      throw new Error(`stale execution plan identity rejected: ${input.runId}`);
    }
    await this.db.update(runs).set({
      executionPlanJson: { ...row.executionPlan, ...input.plan },
      updatedAt: new Date(),
    }).where(and(eq(runs.id, input.runId), eq(runs.currentAttempt, input.attempt), eq(runs.headSha, input.headSha)));
  }

  async saveReport(input: {
    readonly runId: string;
    readonly attempt: number;
    readonly headSha: string;
    readonly provider: string;
    readonly model: string;
    readonly inputHash: string;
    readonly verdict: 'PASSED' | 'INCOMPLETE';
    readonly summary: string;
    readonly reportJson: Record<string, unknown>;
    readonly expiresAt?: Date;
  }): Promise<void> {
    await this.db.transaction(async (tx) => {
      const currentRun = await tx.select({ attempt: runs.currentAttempt, headSha: runs.headSha }).from(runs).where(eq(runs.id, input.runId)).limit(1);
      if (currentRun[0]?.attempt !== input.attempt || currentRun[0]?.headSha !== input.headSha) throw new Error(`stale report identity rejected: ${input.runId}`);
      const inserted = await tx.insert(reports).values({
        runId: input.runId,
        attempt: input.attempt,
        headSha: input.headSha,
        provider: input.provider,
        model: input.model,
        inputHash: input.inputHash,
        verdict: input.verdict,
        summary: input.summary,
        reportJson: input.reportJson,
        ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
      }).onConflictDoUpdate({
        target: [reports.runId, reports.attempt],
        set: {
          headSha: input.headSha,
          provider: input.provider,
          model: input.model,
          inputHash: input.inputHash,
          verdict: input.verdict,
          summary: input.summary,
          reportJson: input.reportJson,
          ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
        },
        where: eq(reports.headSha, input.headSha),
      }).returning({ id: reports.id });
      const report = inserted[0];
      if (!report) throw new Error('report upsert returned no row');
      await tx.delete(findings).where(eq(findings.reportId, report.id));
      const parsedReport = AgentReportSchema.parse(input.reportJson);
      if (parsedReport.findings.length > 0) {
        await tx.insert(findings).values(parsedReport.findings.map((finding) => ({
          reportId: report.id,
          severity: finding.severity,
          category: finding.category,
          filePath: finding.file,
          lineStart: finding.lineStart,
          lineEnd: finding.lineEnd,
          title: finding.title,
          description: finding.description,
          evidence: finding.evidence,
          source: 'agent',
          confidence: parsedReport.confidence,
        })));
      }
    });
  }

  async recordKubernetesResource(input: {
    readonly runId: string;
    readonly attempt: number;
    readonly stepKey: string;
    readonly namespace: string;
    readonly kind: string;
    readonly name: string;
    readonly uid?: string | undefined;
    readonly phase: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'DELETING' | 'DELETED' | 'UNKNOWN';
  }): Promise<void> {
    await this.db.insert(k8sResources).values({
      runId: input.runId,
      attempt: input.attempt,
      stepKey: input.stepKey,
      namespace: input.namespace,
      kind: input.kind,
      name: input.name,
      ...(input.uid === undefined ? {} : { uid: input.uid }),
      phase: input.phase,
      ...(input.phase === 'DELETED' ? { deletedAt: new Date() } : { deletedAt: null }),
    }).onConflictDoUpdate({
      target: [k8sResources.runId, k8sResources.attempt, k8sResources.stepKey, k8sResources.kind, k8sResources.name],
      set: {
        namespace: input.namespace,
        ...(input.uid === undefined ? {} : { uid: input.uid }),
        phase: input.phase,
        ...(input.phase === 'DELETED' ? { deletedAt: new Date() } : { deletedAt: null }),
      },
    });
  }

  async markKubernetesResourceDeleted(input: {
    readonly runId: string;
    readonly attempt: number;
    readonly stepKey: string;
    readonly kind: string;
    readonly name: string;
    readonly uid: string;
  }): Promise<void> {
    await this.db.update(k8sResources).set({ phase: 'DELETED', deletedAt: new Date() }).where(and(
      eq(k8sResources.runId, input.runId),
      eq(k8sResources.attempt, input.attempt),
      eq(k8sResources.stepKey, input.stepKey),
      eq(k8sResources.kind, input.kind),
      eq(k8sResources.name, input.name),
      eq(k8sResources.uid, input.uid),
    ));
  }

  async enqueueGiteaSync(input: GiteaSyncInput): Promise<void> {
    await this.db.transaction(async (tx) => {
      const currentRun = await tx.select({ attempt: runs.currentAttempt, headSha: runs.headSha }).from(runs).where(eq(runs.id, input.runId)).limit(1);
      if (currentRun[0]?.attempt !== input.attempt || currentRun[0]?.headSha !== input.headSha) throw new Error(`stale Gitea sync identity rejected: ${input.runId}`);
      const existing = await tx.select().from(giteaSyncs).where(and(
        eq(giteaSyncs.runId, input.runId),
        eq(giteaSyncs.attempt, input.attempt),
        eq(giteaSyncs.context, input.context),
        eq(giteaSyncs.headSha, input.headSha),
      )).limit(1);
      const row = existing[0];
      const now = new Date();
      if (row?.desiredHash === input.desiredHash && row.syncStatus === 'SYNCED') return;
      if (row?.leaseUntil !== null && row?.leaseUntil !== undefined && row.leaseUntil > now) return;
      const values = {
        artifactType: input.artifactType,
        desiredHash: input.desiredHash,
        desiredState: input.desiredState,
        desiredDescription: input.desiredDescription,
        ...(input.desiredTargetUrl === undefined ? { desiredTargetUrl: null } : { desiredTargetUrl: input.desiredTargetUrl }),
        desiredBody: input.desiredBody,
        syncStatus: 'PENDING' as const,
        nextAttemptAt: now,
        leaseUntil: null,
        lastSyncError: null,
        syncedAt: null,
      };
      if (row) {
        await tx.update(giteaSyncs).set(values).where(and(eq(giteaSyncs.id, row.id), or(isNull(giteaSyncs.leaseUntil), lte(giteaSyncs.leaseUntil, now))));
      } else {
        await tx.insert(giteaSyncs).values({
          runId: input.runId,
          attempt: input.attempt,
          headSha: input.headSha,
          context: input.context,
          ...values,
        });
      }
    });
  }

  async saveStepLog(input: {
    readonly runId: string;
    readonly attempt: number;
    readonly headSha: string;
    readonly stepKey: string;
    readonly logPath: string;
    readonly expiresAt: Date;
  }): Promise<void> {
    await this.db.transaction(async (tx) => {
      const current = await tx.select({ attempt: runs.currentAttempt, headSha: runs.headSha }).from(runs).where(eq(runs.id, input.runId)).limit(1);
      if (current[0]?.attempt !== input.attempt || current[0]?.headSha !== input.headSha) throw new Error(`stale step log identity rejected: ${input.runId}`);
      const updated = await tx.update(runSteps).set({ logPath: input.logPath, expiresAt: input.expiresAt }).where(and(
        eq(runSteps.runId, input.runId),
        eq(runSteps.attempt, input.attempt),
        eq(runSteps.stepKey, input.stepKey),
      )).returning({ id: runSteps.id });
      if (updated.length !== 1) throw new Error(`step log row is missing: ${input.runId}`);
    });
  }
}

function stepRecord(row: typeof runSteps.$inferSelect): StepRecord {
  const failureKind = row.failureKind as FailureKind | null;
  return {
    stepKey: row.stepKey as StepRecord['stepKey'],
    status: row.status as StepStatus,
    ...(failureKind === null ? {} : { failureKind }),
    ...(row.errorCode === null ? {} : { errorCode: row.errorCode }),
  };
}

function dbResult(result: StepExecutionResult): {
  status: 'PASSED' | 'FAILED' | 'INCOMPLETE';
  failureKind?: string;
  errorCode?: string;
} {
  return result.status === 'PASSED'
    ? { status: 'PASSED' }
    : { status: result.status, failureKind: result.failureKind, errorCode: result.errorCode };
}

export class DatabaseStepGuard implements StepGuard {
  constructor(private readonly db: Database) {}

  async runOnce(
    key: StepGuardKey,
    operation: () => Promise<StepExecutionResult>,
  ): Promise<StepGuardResult> {
    const now = new Date();
    const leaseToken = randomBytes(24).toString('hex');
    const admission = await this.db.transaction(async (tx) => {
      await tx.execute(lockFor(key));
      const existing = await tx
        .select()
        .from(runSteps)
        .where(and(eq(runSteps.runId, key.runId), eq(runSteps.attempt, key.attempt), eq(runSteps.stepKey, key.stepKey)))
        .limit(1);
      const row = existing[0];
      if (row && isTerminalStepForRetry(key.stepKey, row.status as StepStatus)) {
        return { outcome: 'already-terminal' as const, status: row.status as TerminalStepStatus };
      }
      if (
        row?.status === 'RUNNING' &&
        row.leaseUntil !== null &&
        row.leaseUntil.getTime() > now.getTime()
      ) {
        return { outcome: 'busy' as const };
      }
      if (row) {
        await tx
          .update(runSteps)
          .set({ status: 'RUNNING', startedAt: now, finishedAt: null, leaseToken, leaseUntil: new Date(now.getTime() + STALE_STEP_MS), errorCode: null, failureKind: null })
          .where(eq(runSteps.id, row.id));
      } else {
        await tx.insert(runSteps).values({
          runId: key.runId,
          attempt: key.attempt,
          stepKey: key.stepKey,
          status: 'RUNNING',
          startedAt: now,
          leaseToken,
          leaseUntil: new Date(now.getTime() + STALE_STEP_MS),
        });
      }
      return { outcome: 'admitted' as const, leaseToken };
    });

    if (admission.outcome === 'busy') return { outcome: 'busy' };
    if (admission.outcome === 'already-terminal') {
      return { outcome: 'already-terminal', status: admission.status };
    }

    let leaseLost = false;
    const heartbeat = setInterval(() => {
      void this.db.update(runSteps)
        .set({ leaseUntil: new Date(Date.now() + STALE_STEP_MS) })
        .where(and(eq(runSteps.runId, key.runId), eq(runSteps.attempt, key.attempt), eq(runSteps.stepKey, key.stepKey), eq(runSteps.status, 'RUNNING'), eq(runSteps.leaseToken, leaseToken)))
        .returning({ id: runSteps.id })
        .then((rows) => { if (rows.length !== 1) leaseLost = true; })
        .catch(() => { leaseLost = true; });
    }, STEP_HEARTBEAT_MS);
    heartbeat.unref?.();
    try {
      const result = await operation();
      if (leaseLost) throw new StepLeaseLostError(key);
      const persisted = dbResult(result);
      await this.db.transaction(async (tx) => {
        await tx.execute(lockFor(key));
        const updated = await tx
          .update(runSteps)
          .set({
            status: persisted.status,
            ...(persisted.failureKind === undefined ? {} : { failureKind: persisted.failureKind }),
            ...(persisted.errorCode === undefined ? {} : { errorCode: persisted.errorCode }),
            finishedAt: new Date(),
            leaseToken: null,
            leaseUntil: null,
          })
          .where(and(eq(runSteps.runId, key.runId), eq(runSteps.attempt, key.attempt), eq(runSteps.stepKey, key.stepKey), eq(runSteps.status, 'RUNNING'), eq(runSteps.leaseToken, leaseToken)))
          .returning({ id: runSteps.id });
        if (updated.length !== 1) throw new StepLeaseLostError(key);
      });
      return { outcome: 'executed', result };
    } catch (error) {
      await this.db.update(runSteps).set({ status: 'PENDING', failureKind: null, errorCode: 'STEP_RETRYABLE_ERROR', startedAt: null, leaseToken: null, leaseUntil: null }).where(and(eq(runSteps.runId, key.runId), eq(runSteps.attempt, key.attempt), eq(runSteps.stepKey, key.stepKey), eq(runSteps.leaseToken, leaseToken)));
      throw error;
    } finally {
      clearInterval(heartbeat);
    }
  }

  async markSkipped(key: StepGuardKey, reason: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute(lockFor(key));
      const rows = await tx.select().from(runSteps).where(and(eq(runSteps.runId, key.runId), eq(runSteps.attempt, key.attempt), eq(runSteps.stepKey, key.stepKey))).limit(1);
      const row = rows[0];
      if (row && isTerminalStepForRetry(key.stepKey, row.status as StepStatus)) return;
      if (row?.status === 'RUNNING') throw new Error(`step is running: ${key.stepKey}`);
      if (row) {
        await tx.update(runSteps).set({ status: 'SKIPPED', errorCode: reason, finishedAt: new Date(), leaseToken: null, leaseUntil: null }).where(eq(runSteps.id, row.id));
      } else {
        await tx.insert(runSteps).values({ runId: key.runId, attempt: key.attempt, stepKey: key.stepKey, status: 'SKIPPED', errorCode: reason, finishedAt: new Date() });
      }
    });
  }

  async list(runId: string, attempt: number): Promise<readonly StepRecord[]> {
    const rows = await this.db.select().from(runSteps).where(and(eq(runSteps.runId, runId), eq(runSteps.attempt, attempt)));
    return rows.map(stepRecord);
  }
}
