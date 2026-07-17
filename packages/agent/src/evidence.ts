import type { AgentChangedLineRange, AgentReport } from "@platform/contracts";

export interface AgentFileCatalog {
  /** The catalog must be bound to the report's current head SHA. */
  has(filePath: string): boolean;
}

export interface AgentChangedLineRanges {
  /** Ranges must be derived from the same current head SHA as fileCatalog. */
  get(filePath: string): readonly AgentChangedLineRange[] | undefined;
}

export interface AgentReportEvidence {
  readonly fileCatalog: AgentFileCatalog;
  readonly changedLineRanges: AgentChangedLineRanges;
}

export interface AgentEvidenceIssue {
  readonly findingIndex: number;
  readonly file: string;
  readonly message: string;
}

export type AgentEvidenceValidation =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "MISSING_EVIDENCE";
      readonly issues: readonly AgentEvidenceIssue[];
    };

function invalidRange(range: AgentChangedLineRange): boolean {
  return (
    !Number.isSafeInteger(range.lineStart) ||
    !Number.isSafeInteger(range.lineEnd) ||
    range.lineStart < 1 ||
    range.lineEnd < range.lineStart
  );
}

/**
 * Validate finding locations against evidence for the current head SHA.
 * Missing or malformed evidence is always a validation failure.
 */
export function validateAgentReportEvidence(
  report: AgentReport,
  evidence: Partial<AgentReportEvidence> | undefined,
): AgentEvidenceValidation {
  const fileCatalog = evidence?.fileCatalog;
  const changedLineRanges = evidence?.changedLineRanges;
  if (report.findings.length === 0 && evidence === undefined) return { ok: true };
  if (
    typeof fileCatalog?.has !== "function" ||
    typeof changedLineRanges?.get !== "function"
  ) {
    return {
      ok: false,
      reason: "MISSING_EVIDENCE",
      issues: report.findings.map((finding, findingIndex) => ({
        findingIndex,
        file: finding.file,
        message: "Current head file catalog and changed line ranges are required",
      })),
    };
  }

  const issues: AgentEvidenceIssue[] = [];
  report.findings.forEach((finding, findingIndex) => {
    let fileExists = false;
    let ranges: readonly AgentChangedLineRange[] | undefined;
    try {
      fileExists = fileCatalog.has(finding.file);
      ranges = changedLineRanges.get(finding.file);
    } catch {
      issues.push({
        findingIndex,
        file: finding.file,
        message: "Current head evidence could not be read",
      });
      return;
    }

    if (!fileExists) {
      issues.push({
        findingIndex,
        file: finding.file,
        message: "Finding file is not present in the current head",
      });
      return;
    }

    if (
      ranges === undefined ||
      ranges.length === 0 ||
      ranges.some(invalidRange) ||
      !ranges.some(
        (range) =>
          range.lineStart <= finding.lineStart &&
          range.lineEnd >= finding.lineEnd,
      )
    ) {
      issues.push({
        findingIndex,
        file: finding.file,
        message: "Finding line range is not present in the current diff",
      });
    }
  });

  return issues.length === 0
    ? { ok: true }
    : { ok: false, reason: "MISSING_EVIDENCE", issues };
}
