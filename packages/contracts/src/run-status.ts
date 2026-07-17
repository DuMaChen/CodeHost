import { z } from "zod";

export const RUN_STATUS_VALUES = [
  "RECEIVED",
  "QUEUED",
  "PLANNING",
  "EXECUTING",
  "ANALYZING",
  "REPORTING",
  "PASSED",
  "FAILED",
  "INCOMPLETE",
  "CANCEL_REQUESTED",
  "CANCELLED",
  "REJECTED_BY_CAPACITY",
] as const;

export const RunStatusSchema = z.enum(RUN_STATUS_VALUES);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const CLEANUP_STATUS_VALUES = [
  "NOT_SCHEDULED",
  "PENDING",
  "CLEANED",
  "FAILED",
] as const;

export const CleanupStatusSchema = z.enum(CLEANUP_STATUS_VALUES);
export type CleanupStatus = z.infer<typeof CleanupStatusSchema>;

export const EXECUTION_LOCK_STATUSES = [
  "PLANNING",
  "EXECUTING",
  "ANALYZING",
  "REPORTING",
  "CANCEL_REQUESTED",
] as const satisfies readonly RunStatus[];

export const TERMINAL_RUN_STATUSES = [
  "PASSED",
  "FAILED",
  "INCOMPLETE",
  "CANCELLED",
  "REJECTED_BY_CAPACITY",
] as const satisfies readonly RunStatus[];

export const RUN_STATUS_TRANSITIONS: Readonly<
  Record<RunStatus, readonly RunStatus[]>
> = {
  RECEIVED: ["QUEUED", "REJECTED_BY_CAPACITY"],
  QUEUED: ["PLANNING", "CANCEL_REQUESTED"],
  PLANNING: ["EXECUTING", "ANALYZING", "INCOMPLETE", "CANCEL_REQUESTED"],
  EXECUTING: ["ANALYZING", "INCOMPLETE", "CANCEL_REQUESTED"],
  ANALYZING: ["REPORTING", "INCOMPLETE", "CANCEL_REQUESTED"],
  REPORTING: ["PASSED", "FAILED", "INCOMPLETE"],
  PASSED: [],
  FAILED: [],
  INCOMPLETE: [],
  CANCEL_REQUESTED: ["CANCELLED"],
  CANCELLED: [],
  REJECTED_BY_CAPACITY: [],
};

export interface RunTransitionOptions {
  cleanupConfirmed?: boolean;
}

export function isRunStatus(value: string): value is RunStatus {
  return RunStatusSchema.safeParse(value).success;
}

export function isCleanupStatus(value: string): value is CleanupStatus {
  return CleanupStatusSchema.safeParse(value).success;
}

/**
 * CANCEL_REQUESTED is deliberately not enough to enter CANCELLED. The
 * worker must confirm that the associated Jobs and Preview were removed.
 */
export function isValidRunStatusTransition(
  from: string,
  to: string,
  options: RunTransitionOptions = {},
): boolean {
  if (!isRunStatus(from) || !isRunStatus(to)) {
    return false;
  }

  if (from === "CANCEL_REQUESTED" && to === "CANCELLED") {
    return options.cleanupConfirmed === true;
  }

  return RUN_STATUS_TRANSITIONS[from].includes(to);
}

export function getAllowedRunStatusTransitions(
  from: RunStatus,
): readonly RunStatus[] {
  return RUN_STATUS_TRANSITIONS[from];
}

export function isTerminalRunStatus(status: RunStatus): boolean {
  return (TERMINAL_RUN_STATUSES as readonly RunStatus[]).includes(status);
}

export function holdsExecutionLock(status: RunStatus): boolean {
  return (EXECUTION_LOCK_STATUSES as readonly RunStatus[]).includes(status);
}

export function canRetryRun(
  status: RunStatus,
  cleanupStatus: CleanupStatus,
  manuallyConfirmedCleanupFailure = false,
): boolean {
  if (status !== "FAILED" && status !== "INCOMPLETE") {
    return false;
  }

  return (
    cleanupStatus === "CLEANED" ||
    (cleanupStatus === "FAILED" && manuallyConfirmedCleanupFailure)
  );
}

export class InvalidRunStatusTransitionError extends Error {
  public readonly from: string;
  public readonly to: string;

  constructor(from: string, to: string) {
    super(`Invalid Run status transition: ${from} -> ${to}`);
    this.name = "InvalidRunStatusTransitionError";
    this.from = from;
    this.to = to;
  }
}

export function assertValidRunStatusTransition(
  from: string,
  to: string,
  options: RunTransitionOptions = {},
): void {
  if (!isValidRunStatusTransition(from, to, options)) {
    throw new InvalidRunStatusTransitionError(from, to);
  }
}
