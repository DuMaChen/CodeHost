import { ReportSchema } from "@platform/contracts";
import { MAX_REPORT_BYTES, utf8ByteLength } from "./limits.js";
import {
  validateAgentReportEvidence,
  type AgentReportEvidence,
} from "./evidence.js";
import type {
  AgentReviewResult,
  ReportPersistenceMetadata,
  ReportPersistenceRecord,
  ReportStore,
} from "./types.js";

function requiredText(value: string, field: string): string {
  if (value.trim().length === 0) throw new Error(`${field} must not be blank`);
  return value;
}

export function toReportPersistenceRecord(
  metadata: ReportPersistenceMetadata,
  result: AgentReviewResult,
  evidence?: AgentReportEvidence,
): ReportPersistenceRecord {
  requiredText(metadata.runId, "runId");
  requiredText(metadata.headSha, "headSha");
  if (!Number.isSafeInteger(metadata.attempt) || metadata.attempt < 1) {
    throw new Error("attempt must be a positive safe integer");
  }
  requiredText(result.provider, "provider");
  requiredText(result.model, "model");
  if (!/^[0-9a-f]{64}$/i.test(result.inputHash)) {
    throw new Error("inputHash must be a SHA-256 hex digest");
  }

  const report = ReportSchema.parse(result.report);
  const evidenceValidation = validateAgentReportEvidence(report, evidence);
  if (!evidenceValidation.ok) {
    throw new Error("current head file and changed-line evidence is required");
  }
  const reportJson = JSON.stringify(report);
  if (utf8ByteLength(reportJson) > MAX_REPORT_BYTES) {
    throw new Error("report exceeds the maximum persisted size");
  }

  const record: ReportPersistenceRecord = {
    runId: metadata.runId,
    attempt: metadata.attempt,
    headSha: metadata.headSha,
    provider: result.provider,
    model: result.model,
    inputHash: result.inputHash,
    verdict: result.verdict,
    summary: report.summary,
    reportJson: report,
    findings: report.findings.map((finding) => ({ ...finding })),
    ...(metadata.expiresAt === undefined
      ? {}
      : { expiresAt: new Date(metadata.expiresAt) }),
  };
  return record;
}

export async function persistAgentResult(
  store: ReportStore,
  metadata: ReportPersistenceMetadata,
  result: AgentReviewResult,
  evidence?: AgentReportEvidence,
): Promise<ReportPersistenceRecord> {
  const record = toReportPersistenceRecord(metadata, result, evidence);
  await store.save(record);
  return record;
}

export class ReportPersistence {
  constructor(private readonly store: ReportStore) {}

  save(
    metadata: ReportPersistenceMetadata,
    result: AgentReviewResult,
    evidence?: AgentReportEvidence,
  ): Promise<ReportPersistenceRecord> {
    return persistAgentResult(this.store, metadata, result, evidence);
  }

  persist(
    metadata: ReportPersistenceMetadata,
    result: AgentReviewResult,
    evidence?: AgentReportEvidence,
  ): Promise<ReportPersistenceRecord> {
    return this.save(metadata, result, evidence);
  }
}

export class InMemoryReportStore implements ReportStore {
  private readonly records: ReportPersistenceRecord[] = [];

  async save(record: ReportPersistenceRecord): Promise<void> {
    const copy: ReportPersistenceRecord = {
      ...record,
      reportJson: {
        ...record.reportJson,
        findings: record.reportJson.findings.map((finding) => ({ ...finding })),
      },
      findings: record.findings.map((finding) => ({ ...finding })),
      ...(record.expiresAt === undefined
        ? {}
        : { expiresAt: new Date(record.expiresAt) }),
    };
    this.records.push(copy);
  }

  all(): readonly ReportPersistenceRecord[] {
    return this.records.map((record) => ({
      ...record,
      reportJson: {
        ...record.reportJson,
        findings: record.reportJson.findings.map((finding) => ({ ...finding })),
      },
      findings: record.findings.map((finding) => ({ ...finding })),
      ...(record.expiresAt === undefined
        ? {}
        : { expiresAt: new Date(record.expiresAt) }),
    }));
  }
}
