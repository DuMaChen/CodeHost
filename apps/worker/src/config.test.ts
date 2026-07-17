import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

describe("worker timeout configuration", () => {
  it("accepts a short bounded timeout for deterministic integration fixtures", () => {
    expect(loadConfig({ K8S_JOB_TIMEOUT_MS: "5000" }).jobTimeoutMs).toBe(5000);
  });

  it("does not allow a configured timeout above the 15 minute safety bound", () => {
    expect(loadConfig({ K8S_JOB_TIMEOUT_MS: "999999999" }).jobTimeoutMs).toBe(15 * 60 * 1000);
  });
});
