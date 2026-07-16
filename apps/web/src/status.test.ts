import { describe, expect, it } from "vitest";
import { cleanupStatusLabel, isRunStatus, runStatusLabel, runStatusTone } from "./status";

describe("run status presentation", () => {
  it("accepts only statuses in the API contract", () => {
    expect(isRunStatus("EXECUTING")).toBe(true);
    expect(isRunStatus("SUCCESS")).toBe(false);
    expect(isRunStatus(undefined)).toBe(false);
  });

  it("keeps terminal failures visibly different from a pass", () => {
    expect(runStatusLabel("PASSED")).toBe("通过");
    expect(runStatusTone("PASSED")).toBe("success");
    expect(runStatusTone("FAILED")).toBe("danger");
    expect(runStatusLabel("INCOMPLETE")).toBe("未完成");
  });

  it("labels cleanup independently from the run result", () => {
    expect(cleanupStatusLabel("PENDING")).toBe("清理中");
    expect(cleanupStatusLabel("FAILED")).toBe("清理失败");
  });
});
