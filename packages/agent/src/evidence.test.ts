import { describe, expect, it } from "vitest";
import {
  MockProvider,
  executeAgentReview,
  validateAgentReportEvidence,
} from "./index.js";

const finding = {
  severity: "HIGH" as const,
  category: "security" as const,
  file: "src/auth.ts",
  lineStart: 12,
  lineEnd: 15,
  title: "Token is logged",
  description: "The request token is written to the application log.",
  evidence: "logger.info(token)",
  recommendation: "Remove the token from structured log fields.",
};

const report = {
  summary: "The change contains a security finding.",
  riskLevel: "HIGH" as const,
  confidence: 0.9,
  findings: [finding],
};

const evidence = {
  fileCatalog: { has: (file: string) => file === "src/auth.ts" },
  changedLineRanges: { get: () => [{ lineStart: 10, lineEnd: 20 }] },
};

describe("current-head report evidence", () => {
  it("requires an existing file and a containing changed-line range", () => {
    expect(validateAgentReportEvidence(report, evidence)).toEqual({ ok: true });
    expect(
      validateAgentReportEvidence(report, {
        fileCatalog: { has: () => true },
        changedLineRanges: { get: () => [{ lineStart: 1, lineEnd: 2 }] },
      }).ok,
    ).toBe(false);
  });

  it("marks a finding without current-head evidence incomplete before persistence", async () => {
    const provider = new MockProvider({ response: report });
    const result = await executeAgentReview(provider, { diff: "safe" });

    expect(result.verdict).toBe("INCOMPLETE");
    if (result.verdict === "INCOMPLETE") expect(result.reason).toBe("MISSING_EVIDENCE");
  });

  it("accepts findings when evidence is supplied to the persistence-facing executor", async () => {
    const provider = new MockProvider({ response: report });
    const result = await executeAgentReview(provider, { diff: "safe" }, evidence);

    expect(result.verdict).toBe("PASSED");
  });
});
