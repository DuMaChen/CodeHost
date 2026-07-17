import { describe, expect, it } from "vitest";
import {
  executeAgentReview,
  InMemoryReportStore,
  MockProvider,
  persistAgentResult,
  validateAgentResult,
  type AgentReportEvidence,
} from "./index.js";

const validFinding = {
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

const validReport = {
  summary: "The change introduces a high-risk logging issue.",
  riskLevel: "HIGH" as const,
  confidence: 0.92,
  findings: [validFinding],
};

const validEvidence: AgentReportEvidence = {
  fileCatalog: {
    has: (filePath) => filePath === "src/auth.ts",
  },
  changedLineRanges: {
    get: (filePath) =>
      filePath === "src/auth.ts"
        ? [{ lineStart: 12, lineEnd: 15 }]
        : undefined,
  },
};

const persistenceMetadata = {
  runId: "run-1",
  attempt: 1,
  headSha: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
};

describe("strict Agent executor", () => {
  it("returns PASSED only when file and changed-line evidence covers every finding", async () => {
    const result = await executeAgentReview(
      new MockProvider({ response: validReport }),
      { diff: "review input" },
      validEvidence,
    );

    expect(result).toMatchObject({ verdict: "PASSED", report: validReport });
  });

  it("returns INCOMPLETE when evidence dependencies are missing", async () => {
    const result = await executeAgentReview(
      new MockProvider({ response: validReport }),
      { diff: "review input" },
      {},
    );

    expect(result).toMatchObject({
      verdict: "INCOMPLETE",
      reason: "MISSING_EVIDENCE",
    });
  });

  it("returns INCOMPLETE when the file or changed range is not evidenced", async () => {
    const missingFile = await executeAgentReview(
      new MockProvider({ response: validReport }),
      {},
      {
        fileCatalog: { has: () => false },
        changedLineRanges: { get: () => [{ lineStart: 12, lineEnd: 15 }] },
      },
    );
    const missingRange = await executeAgentReview(
      new MockProvider({ response: validReport }),
      {},
      {
        fileCatalog: { has: () => true },
        changedLineRanges: { get: () => [{ lineStart: 1, lineEnd: 11 }] },
      },
    );

    expect(missingFile).toMatchObject({ verdict: "INCOMPLETE", reason: "MISSING_EVIDENCE" });
    expect(missingRange).toMatchObject({ verdict: "INCOMPLETE", reason: "MISSING_EVIDENCE" });
  });
});

describe("Agent output boundary", () => {
  it("rejects unknown fields", () => {
    const result = validateAgentResult({ ...validReport, shellCommand: "kubectl get pods" });

    expect(result).toMatchObject({ verdict: "INCOMPLETE", reason: "PROHIBITED_FIELD" });
  });

  it("rejects external links outside the common HTTP form", () => {
    const result = validateAgentResult({
      ...validReport,
      findings: [{ ...validFinding, evidence: "See //evil.example/payload" }],
    });

    expect(result).toMatchObject({ verdict: "INCOMPLETE", reason: "INVALID_OUTPUT" });
  });

  it("rejects reports over the serialized 256 KiB limit", () => {
    const oversizedReport = {
      ...validReport,
      findings: Array.from({ length: 20 }, (_, index) => ({
        ...validFinding,
        file: `src/file-${index}.ts`,
        description: "x".repeat(8192),
        evidence: "y".repeat(8192),
        recommendation: "z".repeat(8192),
      })),
    };
    const result = validateAgentResult(oversizedReport);

    expect(result).toMatchObject({ verdict: "INCOMPLETE", reason: "REPORT_TOO_LARGE" });
  });
});

describe("report persistence boundary", () => {
  it("validates evidence before saving a report", async () => {
    const result = await executeAgentReview(
      new MockProvider({ response: validReport }),
      {},
      validEvidence,
    );
    if (result.verdict !== "PASSED") throw new Error("expected a valid result");

    const store = new InMemoryReportStore();
    await persistAgentResult(store, persistenceMetadata, result, validEvidence);
    await expect(
      persistAgentResult(store, persistenceMetadata, result, {
        fileCatalog: { has: () => false },
        changedLineRanges: validEvidence.changedLineRanges,
      }),
    ).rejects.toThrow(/evidence/);

    expect(store.all()).toHaveLength(1);
  });
});
