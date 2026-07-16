import { executeAgentReview, MockProvider } from '@platform/agent';
import { buildControlledDockerfile, buildRunResourcePlan, detectProjectProfile, type ProjectType, type RunIdentity } from '@platform/k8s';
import { CAPACITY_LIMITS } from '../config.js';
import type {
  StepExecutionContext,
  StepExecutionResult,
  StepKey,
} from './types.js';

export interface StepExecutor {
  execute(context: StepExecutionContext): Promise<StepExecutionResult>;
}

export type FixtureScenario =
  | 'success'
  | 'test-failure'
  | 'build-failure'
  | 'health-failure'
  | 'infrastructure-failure'
  | 'agent-failure';

function scenarioFromEnvironment(): FixtureScenario {
  const value = process.env.WORKFLOW_FIXTURE_SCENARIO;
  return value === 'test-failure' || value === 'build-failure' || value === 'health-failure' || value === 'infrastructure-failure' || value === 'agent-failure'
    ? value
    : 'success';
}

function runIdentity(context: StepExecutionContext): RunIdentity {
  return {
    runId: context.run.id,
    runShortId: context.run.id.replaceAll('-', '').slice(0, 12),
    attempt: context.job.attempt,
  };
}

function k8sPlan(context: StepExecutionContext): readonly Record<string, string>[] {
  const plan = buildRunResourcePlan({ run: runIdentity(context) });
  return plan.map((resource) => ({
    kind: resource.kind,
    name: resource.metadata.name,
    ...(resource.metadata.namespace === undefined ? {} : { namespace: resource.metadata.namespace }),
  }));
}

function failedApplication(errorCode: string, details?: Record<string, unknown>): StepExecutionResult {
  return {
    status: 'FAILED',
    failureKind: 'application',
    errorCode,
    ...(details === undefined ? {} : { details }),
  };
}

function incompleteInfrastructure(errorCode: string, details?: Record<string, unknown>): StepExecutionResult {
  return {
    status: 'INCOMPLETE',
    failureKind: 'infrastructure',
    errorCode,
    ...(details === undefined ? {} : { details }),
  };
}

function fixtureProfile(projectType: ProjectType) {
  const files = projectType === 'python' ? ['requirements.txt', 'main.py'] : ['package.json', 'server.js'];
  const detected = detectProjectProfile(files);
  if (detected.status !== 'SUPPORTED') throw new Error(`fixture profile is invalid: ${detected.errorCode}`);
  return detected.plan;
}

/**
 * A deterministic, low-cost executor for the course demo. It exercises the
 * same state machine, K8s resource plan, report persistence and cleanup
 * boundaries while dynamic builds and real cluster calls remain disabled.
 */
export class FixtureStepExecutor implements StepExecutor {
  private readonly scenario: FixtureScenario;
  private readonly projectType: ProjectType;

  constructor(scenario: FixtureScenario = scenarioFromEnvironment(), projectType: ProjectType = process.env.WORKFLOW_FIXTURE_PROFILE === 'python' ? 'python' : 'node') {
    this.scenario = scenario;
    this.projectType = projectType;
  }

  async execute(context: StepExecutionContext): Promise<StepExecutionResult> {
    const step = context.job.stepKey;
    const baseDetails = {
      mode: 'fixture',
      stepKey: step,
      k8sResourcePlan: k8sPlan(context),
    };

    if (this.scenario === 'infrastructure-failure' && step === 'fetch') {
      return incompleteInfrastructure('FIXTURE_K8S_UNAVAILABLE', baseDetails);
    }
    if (this.scenario === 'test-failure' && step === 'test') {
      return failedApplication('FIXTURE_TESTS_FAILED', { ...baseDetails, exitCode: 1 });
    }
    if (this.scenario === 'build-failure' && step === 'build') {
      return failedApplication('FIXTURE_BUILD_FAILED', { ...baseDetails, exitCode: 1 });
    }
    if (this.scenario === 'health-failure' && step === 'health') {
      return failedApplication('FIXTURE_HEALTH_FAILED', { ...baseDetails, health: 'unavailable' });
    }

    if (step === 'detect') {
      const plan = fixtureProfile(this.projectType);
      return { status: 'PASSED', details: { ...baseDetails, ...plan, executionPlan: { ...plan, controlledDockerfile: buildControlledDockerfile(plan) } } };
    }

    if (step === 'agent-review') {
      const provider = this.scenario === 'agent-failure'
        ? new MockProvider({ failure: 'PROVIDER_ERROR' })
        : new MockProvider();
      const review = await executeAgentReview(
        provider,
        {
          changedFiles: ['src/index.ts'],
          diff: 'fixture diff for the current Pull Request',
          checks: { tests: 'passed', secrets: 'clean' },
        },
        { maxInputBytes: context.capacity.maxReviewInputBytes },
      );
      const details = {
        ...baseDetails,
        provider: review.provider,
        model: review.model,
        inputHash: review.inputHash,
        report: review.report,
      };
      if (review.verdict === 'INCOMPLETE') {
        return {
          status: 'INCOMPLETE',
          failureKind: 'model',
          errorCode: review.reason,
          details,
        };
      }
      return { status: 'PASSED', details };
    }

    if (step === 'preview') {
      const previewUrl = process.env.FIXTURE_PREVIEW_URL;
      if (previewUrl) {
        try {
          const url = new URL(previewUrl);
          if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('unsupported protocol');
          const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
          return {
            status: 'PASSED',
            details: { ...baseDetails, previewHost: url.toString(), previewExpiresAt: expiresAt.toISOString() },
          };
        } catch {
          return incompleteInfrastructure('FIXTURE_PREVIEW_URL_INVALID', baseDetails);
        }
      }
      return { status: 'PASSED', details: { ...baseDetails, preview: 'omitted-in-fixture-mode' } };
    }

    if (step === 'build') {
      return { status: 'PASSED', details: { ...baseDetails, buildMode: 'FIXTURE' } };
    }

    if (step === 'cleanup') {
      return { status: 'PASSED', details: { ...baseDetails, cleanup: 'confirmed' } };
    }

    return { status: 'PASSED', details: baseDetails };
  }
}

/** Retained as an explicit failure boundary for tests that require it. */
export class UnconfiguredStepExecutor implements StepExecutor {
  async execute(context: StepExecutionContext): Promise<StepExecutionResult> {
    return incompleteInfrastructure('STEP_EXECUTOR_NOT_CONFIGURED', {
      stepKey: context.job.stepKey,
      maxStepLogBytes: CAPACITY_LIMITS.maxStepLogBytes,
    });
  }
}
