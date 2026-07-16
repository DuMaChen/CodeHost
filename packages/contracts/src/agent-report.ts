import { z } from "zod";

export const AGENT_RISK_LEVELS = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
export const AgentRiskLevelSchema = z.enum(AGENT_RISK_LEVELS);
export type AgentRiskLevel = z.infer<typeof AgentRiskLevelSchema>;

export const AGENT_FINDING_CATEGORIES = [
  "bug",
  "security",
  "reliability",
  "maintainability",
] as const;
export const AgentFindingCategorySchema = z.enum(AGENT_FINDING_CATEGORIES);
export type AgentFindingCategory = z.infer<typeof AgentFindingCategorySchema>;

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u001B]/;
const HTML_TAG_PATTERN = /<\/?[a-z][^>]*>/i;
const SCRIPT_PROTOCOL_PATTERN = /\b(?:javascript|data|vbscript):/i;
const EXTERNAL_LINK_PATTERN = /(?:\b(?:https?|ftp):\/\/|\/\/\S+|\b(?:www\.|mailto:|tel:)\S+)/i;
export const MAX_AGENT_REPORT_BYTES = 256 * 1024;

function hasUnsafeText(value: string): boolean {
  return (
    CONTROL_CHARACTER_PATTERN.test(value) ||
    HTML_TAG_PATTERN.test(value) ||
    SCRIPT_PROTOCOL_PATTERN.test(value) ||
    EXTERNAL_LINK_PATTERN.test(value)
  );
}

function safeText(maximum: number) {
  return z
    .string()
    .min(1)
    .max(maximum)
    .refine((value) => value.trim().length > 0, "Text must not be blank")
    .refine((value) => !hasUnsafeText(value), "Text contains unsafe content");
}

const repositoryFilePath = z
  .string()
  .min(1)
  .max(1024)
  .refine((value) => value.trim() === value, "File path must not have outer whitespace")
  .refine((value) => !value.startsWith("/"), "File path must be relative")
  .refine((value) => !value.includes("\\"), "File path must use POSIX separators")
  .refine(
    (value) => !value.split("/").some((segment) => segment === ".." || segment === ""),
    "File path must stay inside the repository",
  )
  .refine((value) => !hasUnsafeText(value), "File path contains unsafe content");

export const AgentFindingSchema = z
  .object({
    severity: AgentRiskLevelSchema,
    category: AgentFindingCategorySchema,
    file: repositoryFilePath,
    lineStart: z.number().int().positive(),
    lineEnd: z.number().int().positive(),
    title: safeText(8 * 1024),
    description: safeText(8 * 1024),
    evidence: safeText(8 * 1024),
    recommendation: safeText(8 * 1024),
  })
  .strict()
  .superRefine((finding, context) => {
    if (finding.lineStart > finding.lineEnd) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["lineEnd"],
        message: "lineEnd must be greater than or equal to lineStart",
      });
    }
  });

export type AgentFinding = z.infer<typeof AgentFindingSchema>;

export const AgentReportSchema = z
  .object({
    summary: safeText(4 * 1024),
    riskLevel: AgentRiskLevelSchema,
    confidence: z.number().min(0).max(1),
    findings: z.array(AgentFindingSchema).max(20),
  })
  .strict()
  .superRefine((report, context) => {
    const reportBytes = new TextEncoder().encode(JSON.stringify(report)).byteLength;
    if (reportBytes > MAX_AGENT_REPORT_BYTES) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Report must not exceed ${MAX_AGENT_REPORT_BYTES} UTF-8 bytes`,
      });
    }
  });

export type AgentReport = z.infer<typeof AgentReportSchema>;

export const ReportSchema = AgentReportSchema;
export const FindingSchema = AgentFindingSchema;

export interface AgentChangedLineRange {
  readonly lineStart: number;
  readonly lineEnd: number;
}

export interface AgentReportLocationContext {
  readonly changedFiles: Readonly<Record<string, readonly AgentChangedLineRange[]>>;
}

/**
 * The Zod schema validates report shape and safe repository-relative paths.
 * This second check applies the current head's diff metadata without doing I/O.
 */
export function validateAgentReportLocations(
  report: AgentReport,
  context: AgentReportLocationContext,
): AgentReport {
  const issues: z.ZodIssue[] = [];

  report.findings.forEach((finding, index) => {
    const hasFile = Object.prototype.hasOwnProperty.call(
      context.changedFiles,
      finding.file,
    );
    const ranges = hasFile ? context.changedFiles[finding.file] : undefined;
    const isInChangedRange = ranges?.some(
      (range) =>
        range.lineStart <= finding.lineStart && range.lineEnd >= finding.lineEnd,
    );

    if (!isInChangedRange) {
      issues.push({
        code: z.ZodIssueCode.custom,
        path: ["findings", index, "file"],
        message: "Finding file and line range must be present in the current diff",
      });
    }
  });

  if (issues.length > 0) {
    throw new z.ZodError(issues);
  }

  return report;
}

export function parseAgentReport(input: unknown): AgentReport {
  return AgentReportSchema.parse(input);
}
