import {
  CLEANUP_STATUS_VALUES,
  RUN_STATUS_VALUES,
  type CleanupStatus,
  type RunStatus,
} from '@platform/contracts';

export const RUN_STATUSES = RUN_STATUS_VALUES;
export const CLEANUP_STATUSES = CLEANUP_STATUS_VALUES;
export type { CleanupStatus, RunStatus } from '@platform/contracts';

export const WORKFLOW_STEPS = [
  'detect',
  'fetch',
  'analyze',
  'test',
  'build',
  'preview',
  'health',
  'assemble-review-input',
  'agent-review',
  'report',
  'cleanup',
] as const;

export type StepKey = (typeof WORKFLOW_STEPS)[number];

export const STEP_STATUSES = [
  'PENDING',
  'RUNNING',
  'PASSED',
  'FAILED',
  'SKIPPED',
  'INCOMPLETE',
  'CANCELLED',
] as const;

export type StepStatus = (typeof STEP_STATUSES)[number];
export type TerminalStepStatus = Exclude<StepStatus, 'PENDING' | 'RUNNING'>;

export type FailureKind =
  | 'application'
  | 'infrastructure'
  | 'model'
  | 'evidence'
  | 'cancelled';

export interface RunSnapshot {
  readonly id: string;
  readonly attempt: number;
  readonly headSha: string;
  readonly status: RunStatus;
  readonly cleanupStatus: CleanupStatus;
  readonly executionPlan?: Readonly<Record<string, unknown>>;
  readonly repositoryFullName?: string;
  readonly pullRequestNumber?: number;
}

export interface StepRecord {
  readonly stepKey: StepKey;
  readonly status: StepStatus;
  readonly failureKind?: FailureKind;
  readonly errorCode?: string;
  readonly reason?: string;
}

export interface WorkflowJobData {
  readonly runId: string;
  readonly attempt: number;
  readonly headSha: string;
  readonly stepKey: StepKey;
}

export interface StepExecutionContext {
  readonly run: RunSnapshot;
  readonly job: WorkflowJobData;
  readonly capacity: {
    readonly maxActiveRuns: number;
    readonly maxQueuedRuns: number;
    readonly maxStepLogBytes: number;
    readonly maxReviewInputBytes: number;
  };
}

export type StepExecutionResult =
  | {
      readonly status: 'PASSED';
      readonly details?: Readonly<Record<string, unknown>>;
    }
  | {
      readonly status: 'FAILED';
      readonly failureKind: FailureKind;
      readonly errorCode: string;
      readonly details?: Readonly<Record<string, unknown>>;
    }
  | {
      readonly status: 'INCOMPLETE';
      readonly failureKind: Exclude<FailureKind, 'application'>;
      readonly errorCode: string;
      readonly details?: Readonly<Record<string, unknown>>;
    };

export function isStepKey(value: unknown): value is StepKey {
  return (
    typeof value === 'string' &&
    (WORKFLOW_STEPS as readonly string[]).includes(value)
  );
}

export function parseWorkflowJob(value: unknown): WorkflowJobData | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }

  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.runId !== 'string' ||
    candidate.runId.length === 0 ||
    typeof candidate.attempt !== 'number' ||
    !Number.isInteger(candidate.attempt) ||
    candidate.attempt < 1 ||
    typeof candidate.headSha !== 'string' ||
    candidate.headSha.length === 0 ||
    !isStepKey(candidate.stepKey)
  ) {
    return undefined;
  }

  return {
    runId: candidate.runId,
    attempt: candidate.attempt,
    headSha: candidate.headSha,
    stepKey: candidate.stepKey,
  };
}
