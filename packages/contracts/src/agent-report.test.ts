import { describe, expect, it } from "vitest";
import {
  AgentReportSchema,
  validateAgentReportLocations,
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

describe("Agent report contract", () => {
  it("accepts the strict report shape", () => {
    expect(AgentReportSchema.parse(validReport)).toEqual(validReport);
  });

  it("rejects unknown fields and prohibited command-shaped fields", () => {
    expect(
      AgentReportSchema.safeParse({ ...validReport, shellCommand: "kubectl get pods" })
        .success,
    ).toBe(false);
    expect(
      AgentReportSchema.safeParse({
        ...validReport,
        findings: [{ ...validFinding, patch: "diff --git" }],
      }).success,
    ).toBe(false);
  });

  it("enforces finding count, confidence, line ranges, and repository paths", () => {
    expect(
      AgentReportSchema.safeParse({
        ...validReport,
        confidence: 1.01,
      }).success,
    ).toBe(false);
    expect(
      AgentReportSchema.safeParse({
        ...validReport,
        findings: [{ ...validFinding, lineStart: 20, lineEnd: 19 }],
      }).success,
    ).toBe(false);
    expect(
      AgentReportSchema.safeParse({
        ...validReport,
        findings: [{ ...validFinding, file: "../secret.txt" }],
      }).success,
    ).toBe(false);
    expect(
      AgentReportSchema.safeParse({
        ...validReport,
        findings: Array.from({ length: 21 }, () => validFinding),
      }).success,
    ).toBe(false);
  });

  it("rejects HTML, external links, and terminal control characters", () => {
    expect(
      AgentReportSchema.safeParse({
        ...validReport,
        summary: "<script>alert(1)</script>",
      }).success,
    ).toBe(false);
    expect(
      AgentReportSchema.safeParse({
        ...validReport,
        findings: [{ ...validFinding, evidence: "See https://example.com" }],
      }).success,
    ).toBe(false);
    expect(
      AgentReportSchema.safeParse({
        ...validReport,
        findings: [{ ...validFinding, evidence: "See //example.com/path" }],
      }).success,
    ).toBe(false);
    expect(
      AgentReportSchema.safeParse({
        ...validReport,
        findings: [{ ...validFinding, title: "bad\u001b[2J" }],
      }).success,
    ).toBe(false);
  });

  it("enforces the report byte limit and current diff location", () => {
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
    expect(AgentReportSchema.safeParse(oversizedReport).success).toBe(false);

    expect(() =>
      validateAgentReportLocations(validReport, {
        changedFiles: { "src/auth.ts": [{ lineStart: 12, lineEnd: 15 }] },
      }),
    ).not.toThrow();
    expect(() =>
      validateAgentReportLocations(validReport, {
        changedFiles: { "src/auth.ts": [{ lineStart: 1, lineEnd: 11 }] },
      }),
    ).toThrow(/current diff/);
    expect(() =>
      validateAgentReportLocations(validReport, {
        changedFiles: {},
      }),
    ).toThrow(/current diff/);
  });
});
