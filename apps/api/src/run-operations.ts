import {
  canRetryRun,
  type CleanupStatus,
  type RunStatus,
} from '@platform/contracts';

export const CANCELLABLE_RUN_STATUSES = [
  'QUEUED',
  'PLANNING',
  'EXECUTING',
  'ANALYZING',
  'REPORTING',
] as const satisfies readonly RunStatus[];

export function isCancellableRunStatus(status: RunStatus): boolean {
  return CANCELLABLE_RUN_STATUSES.includes(status as (typeof CANCELLABLE_RUN_STATUSES)[number]);
}

export function isRetryEligible(
  status: RunStatus,
  cleanupStatus: CleanupStatus,
  manuallyConfirmedCleanupFailure = false,
): boolean {
  return canRetryRun(status, cleanupStatus, manuallyConfirmedCleanupFailure);
}

export function hasRetryCapacity(activeRuns: number, queuedRuns: number, maxQueuedRuns: number): boolean {
  return Number.isSafeInteger(activeRuns) && activeRuns >= 0 && Number.isSafeInteger(queuedRuns) && queuedRuns >= 0 && Number.isSafeInteger(maxQueuedRuns) && maxQueuedRuns >= 0 && activeRuns < 1 && queuedRuns < maxQueuedRuns;
}
