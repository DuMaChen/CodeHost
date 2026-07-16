import { describe, expect, it } from "vitest";
import {
  canRetryRun,
  CleanupStatusSchema,
  getAllowedRunStatusTransitions,
  holdsExecutionLock,
  isTerminalRunStatus,
  isValidRunStatusTransition,
  RUN_STATUS_VALUES,
} from "./index.js";

describe("Run status contract", () => {
  it("contains the complete status set from the plan", () => {
    expect(RUN_STATUS_VALUES).toEqual([
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
    ]);
  });

  it("accepts the happy path and rejects skipped or backward transitions", () => {
    expect(isValidRunStatusTransition("RECEIVED", "QUEUED")).toBe(true);
    expect(isValidRunStatusTransition("ANALYZING", "REPORTING")).toBe(true);
    expect(isValidRunStatusTransition("PLANNING", "ANALYZING")).toBe(true);
    expect(isValidRunStatusTransition("RECEIVED", "EXECUTING")).toBe(false);
    expect(isValidRunStatusTransition("PASSED", "FAILED")).toBe(false);
    expect(getAllowedRunStatusTransitions("PLANNING")).toEqual([
      "EXECUTING",
      "ANALYZING",
      "INCOMPLETE",
      "CANCEL_REQUESTED",
    ]);
  });

  it("requires cleanup confirmation before cancellation becomes terminal", () => {
    expect(isValidRunStatusTransition("QUEUED", "CANCEL_REQUESTED")).toBe(true);
    expect(isValidRunStatusTransition("CANCEL_REQUESTED", "CANCELLED")).toBe(false);
    expect(
      isValidRunStatusTransition("CANCEL_REQUESTED", "CANCELLED", {
        cleanupConfirmed: true,
      }),
    ).toBe(true);
  });

  it("identifies lock, terminal, retry, and cleanup states", () => {
    expect(holdsExecutionLock("REPORTING")).toBe(true);
    expect(holdsExecutionLock("QUEUED")).toBe(false);
    expect(isTerminalRunStatus("REJECTED_BY_CAPACITY")).toBe(true);
    expect(isTerminalRunStatus("CANCEL_REQUESTED")).toBe(false);
    expect(canRetryRun("FAILED", "CLEANED")).toBe(true);
    expect(canRetryRun("INCOMPLETE", "FAILED")).toBe(false);
    expect(canRetryRun("INCOMPLETE", "FAILED", true)).toBe(true);
    expect(CleanupStatusSchema.safeParse("NOT_SCHEDULED").success).toBe(true);
  });
});
