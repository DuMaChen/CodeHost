import type { AgentFinding, AgentReport } from "@platform/contracts";
import type { AgentChangedLineRanges, AgentFileCatalog } from "./evidence.js";

export type AgentVerdict = "PASSED" | "FAILED" | "INCOMPLETE";

export type IncompleteReason =
  | "PROVIDER_ERROR"
  | "PROVIDER_TIMEOUT"
  | "INVALID_OUTPUT"
  | "PROHIBITED_FIELD"
  | "SECRET_DETECTED"
  | "REPORT_TOO_LARGE"
  | "MISSING_EVIDENCE";

export interface PreparedReviewInput {
  readonly text: string;
  readonly inputHash: string;
  readonly truncated: boolean;
}

export interface AgentProvider {
  readonly name: string;
  readonly model: string;
  review(input: PreparedReviewInput): Promise<unknown>;
}

export interface ReviewExecutionOptions {
  readonly maxInputBytes?: number;
  readonly maxReportBytes?: number;
  readonly secretValues?: readonly string[];
  readonly timeoutMs?: number;
  readonly fileCatalog?: AgentFileCatalog;
  readonly changedLineRanges?: AgentChangedLineRanges;
}

export interface CompleteAgentResult {
  readonly verdict: "PASSED";
  readonly report: AgentReport;
  readonly reportJson: string;
  readonly reportBytes: number;
  readonly inputHash: string;
  readonly provider: string;
  readonly model: string;
  readonly truncatedInput: boolean;
}

export interface IncompleteAgentResult {
  readonly verdict: "INCOMPLETE";
  readonly report: AgentReport;
  readonly reportJson: string;
  readonly reportBytes: number;
  readonly inputHash: string;
  readonly provider: string;
  readonly model: string;
  readonly truncatedInput: boolean;
  readonly reason: IncompleteReason;
}

export type AgentReviewResult = CompleteAgentResult | IncompleteAgentResult;

export interface ReportPersistenceRecord {
  readonly runId: string;
  readonly attempt: number;
  readonly headSha: string;
  readonly provider: string;
  readonly model: string;
  readonly inputHash: string;
  readonly verdict: AgentVerdict;
  readonly summary: string;
  readonly reportJson: AgentReport;
  readonly findings: readonly AgentFinding[];
  readonly expiresAt?: Date;
}

export interface ReportStore {
  save(record: ReportPersistenceRecord): Promise<void>;
}

export type ReportRepository = ReportStore;

export interface ReportPersistenceMetadata {
  readonly runId: string;
  readonly attempt: number;
  readonly headSha: string;
  readonly expiresAt?: Date;
}
