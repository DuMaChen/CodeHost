import {
  canRetryRun,
  isTerminalRunStatus as isContractTerminalRunStatus,
  isValidRunStatusTransition,
  RUN_STATUS_TRANSITIONS,
} from '@platform/contracts';
import type {
  CleanupStatus,
  FailureKind,
  RunSnapshot,
  RunStatus,
  StepRecord,
} from './types.js';

export class InvalidRunTransitionError extends Error {
  constructor(
    readonly from: RunStatus,
    readonly to: RunStatus,
    reason?: string,
  ) {
    super(
      reason === undefined
        ? `invalid run transition: ${from} -> ${to}`
        : `invalid run transition: ${from} -> ${to}: ${reason}`,
    );
    this.name = 'InvalidRunTransitionError';
  }
}

export function canTransitionRun(from: RunStatus, to: RunStatus): boolean {
  return from === to || RUN_STATUS_TRANSITIONS[from].includes(to);
}

export function transitionRun(
  run: RunSnapshot,
  to: RunStatus,
): RunSnapshot {
  if (run.status === to) {
    return run;
  }

  if (
    !isValidRunStatusTransition(run.status, to, {
      cleanupConfirmed: run.cleanupStatus === 'CLEANED',
    })
  ) {
    throw new InvalidRunTransitionError(run.status, to);
  }

  if (to === 'CANCELLED' && run.cleanupStatus !== 'CLEANED') {
    throw new InvalidRunTransitionError(
      run.status,
      to,
      'cleanup must be confirmed before cancellation',
    );
  }

  return { ...run, status: to };
}

export function classifyFailure(kind: FailureKind): 'FAILED' | 'INCOMPLETE' {
  return kind === 'application' ? 'FAILED' : 'INCOMPLETE';
}

export function deriveFinalRunStatus(
  steps: readonly StepRecord[],
): 'PASSED' | 'FAILED' | 'INCOMPLETE' {
  const report = steps.find((step) => step.stepKey === 'report');
  if (report?.status !== 'PASSED') {
    return 'INCOMPLETE';
  }

  if (
    steps.some(
      (step) =>
        step.status === 'INCOMPLETE' ||
        (step.status === 'FAILED' && step.failureKind !== 'application'),
    )
  ) {
    return 'INCOMPLETE';
  }

  return steps.some(
    (step) => step.status === 'FAILED' && step.failureKind === 'application',
  )
    ? 'FAILED'
    : 'PASSED';
}

export function canCreateRetry(
  run: Pick<RunSnapshot, 'status' | 'cleanupStatus'>,
  manualCleanupConfirmation = false,
): boolean {
  return canRetryRun(
    run.status,
    run.cleanupStatus,
    manualCleanupConfirmation,
  );
}

export function nextAttempt(
  run: Pick<RunSnapshot, 'attempt' | 'status' | 'cleanupStatus'>,
  manualCleanupConfirmation = false,
): number {
  if (!canCreateRetry(run, manualCleanupConfirmation)) {
    throw new Error(
      'retry requires FAILED or INCOMPLETE status and confirmed cleanup',
    );
  }
  return run.attempt + 1;
}

export function isTerminalRunStatus(status: RunStatus): boolean {
  return isContractTerminalRunStatus(status);
}

export function isCleanupStatus(value: unknown): value is CleanupStatus {
  return (
    value === 'NOT_SCHEDULED' ||
    value === 'PENDING' ||
    value === 'CLEANED' ||
    value === 'FAILED'
  );
}
