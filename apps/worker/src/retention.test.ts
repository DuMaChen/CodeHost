import { describe, expect, it } from "vitest";
import { namespaceMayBeCollected } from "./retention.js";

describe("retention eligibility", () => {
  it("leaves every namespace with a known Run to workflow cleanup", () => {
    expect(namespaceMayBeCollected({ runExists: true, runStatus: "EXECUTING", cleanupStatus: "PENDING", due: true })).toBe(false);
    expect(namespaceMayBeCollected({ runExists: true, runStatus: "FAILED", cleanupStatus: "FAILED", due: true })).toBe(false);
    expect(namespaceMayBeCollected({ runExists: true, runStatus: "FAILED", cleanupStatus: "CLEANED", due: true })).toBe(false);
    expect(namespaceMayBeCollected({ runExists: true, due: false })).toBe(false);
  });

  it("collects only due orphan namespaces", () => {
    expect(namespaceMayBeCollected({ runExists: false, due: true })).toBe(true);
    expect(namespaceMayBeCollected({ runExists: false, due: false })).toBe(false);
  });
});
