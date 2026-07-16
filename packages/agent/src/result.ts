import { ReportSchema, type AgentReport } from "@platform/contracts";
import { MAX_REPORT_BYTES, truncateUtf8, utf8ByteLength } from "./limits.js";
import {
  collectSanitizedInputDetails,
  prepareReviewInput,
  type SanitizeOptions,
} from "./sanitize.js";
import { AgentProviderError } from "./provider.js";
import { validateAgentReportEvidence } from "./evidence.js";
import type {
  AgentProvider,
  AgentReviewResult,
  IncompleteReason,
  ReviewExecutionOptions,
} from "./types.js";

export interface ReportValidationSuccess {
  readonly ok: true;
  readonly report: AgentReport;
  readonly reportJson: string;
  readonly reportBytes: number;
}

export interface ReportValidationFailure {
  readonly ok: false;
  readonly reason: IncompleteReason;
}

export type ReportValidation = ReportValidationSuccess | ReportValidationFailure;

export interface AgentResultContext {
  readonly inputHash?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly truncatedInput?: boolean;
  readonly maxReportBytes?: number;
  readonly secretValues?: readonly string[];
}

const PROHIBITED_REPORT_FIELDS = new Set([
  "command",
  "patch",
  "commit",
  "merge",
  "shellcommand",
  "kubectlcommand",
]);

const INCOMPLETE_REPORT: AgentReport = {
  summary: "Agent review incomplete.",
  riskLevel: "HIGH",
  confidence: 0,
  findings: [],
};

function decodeModelOutput(output: unknown): { ok: true; value: unknown } | { ok: false } {
  if (typeof output !== "string") return { ok: true, value: output };
  try {
    return { ok: true, value: JSON.parse(output) as unknown };
  } catch {
    return { ok: false };
  }
}

function serializedSize(output: unknown): number | undefined {
  if (typeof output === "string") return utf8ByteLength(output);
  try {
    const serialized = JSON.stringify(output);
    return serialized === undefined ? undefined : utf8ByteLength(serialized);
  } catch {
    return undefined;
  }
}

function hasProhibitedField(value: unknown, activeObjects = new WeakSet<object>()): boolean {
  if (value === null || typeof value !== "object") return false;
  if (activeObjects.has(value)) return false;
  activeObjects.add(value);

  if (Array.isArray(value)) {
    const result = value.some((item) => hasProhibitedField(item, activeObjects));
    activeObjects.delete(value);
    return result;
  }

  for (const [key, child] of Object.entries(value)) {
    if (PROHIBITED_REPORT_FIELDS.has(key.toLowerCase())) {
      activeObjects.delete(value);
      return true;
    }
    if (hasProhibitedField(child, activeObjects)) {
      activeObjects.delete(value);
      return true;
    }
  }
  activeObjects.delete(value);
  return false;
}

function containsSecret(value: unknown, secretValues: readonly string[]): boolean {
  if (secretValues.length === 0) return false;
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value);
    } catch {
      return false;
    }
  }
  return secretValues.some((secret) => secret.length > 0 && text.includes(secret));
}

export function validateAgentReport(
  output: unknown,
  options: Pick<AgentResultContext, "maxReportBytes" | "secretValues"> = {},
): ReportValidation {
  const maximumBytes = Math.min(options.maxReportBytes ?? MAX_REPORT_BYTES, MAX_REPORT_BYTES);
  const outputBytes = serializedSize(output);
  if (outputBytes !== undefined && outputBytes > maximumBytes) {
    return { ok: false, reason: "REPORT_TOO_LARGE" };
  }

  const decoded = decodeModelOutput(output);
  if (!decoded.ok) return { ok: false, reason: "INVALID_OUTPUT" };
  if (hasProhibitedField(decoded.value)) return { ok: false, reason: "PROHIBITED_FIELD" };
  if (containsSecret(decoded.value, options.secretValues ?? [])) {
    return { ok: false, reason: "SECRET_DETECTED" };
  }

  const parsed = ReportSchema.safeParse(decoded.value);
  if (!parsed.success) return { ok: false, reason: "INVALID_OUTPUT" };

  const reportJson = JSON.stringify(parsed.data);
  const reportBytes = utf8ByteLength(reportJson);
  if (reportBytes > maximumBytes) return { ok: false, reason: "REPORT_TOO_LARGE" };
  return { ok: true, report: parsed.data, reportJson, reportBytes };
}

export const validateReport = validateAgentReport;

function incompleteResult(
  context: Required<Pick<AgentResultContext, "inputHash" | "provider" | "model" | "truncatedInput">>,
  reason: IncompleteReason,
): AgentReviewResult {
  const reportJson = JSON.stringify(INCOMPLETE_REPORT);
  return {
    verdict: "INCOMPLETE",
    report: INCOMPLETE_REPORT,
    reportJson,
    reportBytes: utf8ByteLength(reportJson),
    inputHash: context.inputHash,
    provider: context.provider,
    model: context.model,
    truncatedInput: context.truncatedInput,
    reason,
  };
}

function completeResult(
  context: Required<Pick<AgentResultContext, "inputHash" | "provider" | "model" | "truncatedInput">>,
  validation: ReportValidationSuccess,
): AgentReviewResult {
  return {
    verdict: "PASSED",
    report: validation.report,
    reportJson: validation.reportJson,
    reportBytes: validation.reportBytes,
    inputHash: context.inputHash,
    provider: context.provider,
    model: context.model,
    truncatedInput: context.truncatedInput,
  };
}

export function validateAgentResult(
  output: unknown,
  context: AgentResultContext = {},
): AgentReviewResult {
  const resolvedContext = {
    inputHash: context.inputHash ?? "",
    provider: context.provider ?? "unknown",
    model: context.model ?? "unknown",
    truncatedInput: context.truncatedInput ?? false,
  };
  const validation = validateAgentReport(output, context);
  return validation.ok
    ? completeResult(resolvedContext, validation)
    : incompleteResult(resolvedContext, validation.reason);
}

function providerCall(
  provider: AgentProvider,
  input: ReturnType<typeof prepareReviewInput>,
  timeoutMs: number | undefined,
): Promise<unknown> {
  const call = provider.review(input);
  if (timeoutMs === undefined) return call;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("timeoutMs must be positive");
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new AgentProviderError("PROVIDER_TIMEOUT"));
    }, timeoutMs);
    call.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

export async function runAgentReview(
  provider: AgentProvider,
  input: unknown,
  options: ReviewExecutionOptions = {},
): Promise<AgentReviewResult> {
  const sanitizeOptions: SanitizeOptions = {
    ...(options.maxInputBytes === undefined ? {} : { maxBytes: options.maxInputBytes }),
    ...(options.secretValues === undefined ? {} : { secretValues: options.secretValues }),
  };
  const details = collectSanitizedInputDetails(input, sanitizeOptions);
  const context = {
    inputHash: details.input.inputHash,
    provider: provider.name,
    model: provider.model,
    truncatedInput: details.input.truncated,
    secretValues: details.secretValues,
    ...(options.maxReportBytes === undefined ? {} : { maxReportBytes: options.maxReportBytes }),
  };

  try {
    const output = await providerCall(provider, details.input, options.timeoutMs);
    return validateAgentResult(output, context);
  } catch (error) {
    const reason: IncompleteReason =
      error instanceof AgentProviderError && error.code === "PROVIDER_TIMEOUT"
        ? "PROVIDER_TIMEOUT"
        : "PROVIDER_ERROR";
    return incompleteResult(
      {
        inputHash: context.inputHash,
        provider: context.provider,
        model: context.model,
        truncatedInput: context.truncatedInput,
      },
      reason,
    );
  }
}

/**
 * Strict persistence-facing executor. A valid model response is not accepted
 * unless its findings can be tied to the current head's file and diff evidence.
 */
export async function executeAgentReview(
  provider: AgentProvider,
  input: unknown,
  options: ReviewExecutionOptions = {},
): Promise<AgentReviewResult> {
  const result = await runAgentReview(provider, input, options);
  if (result.verdict !== "PASSED") return result;

  const evidence =
    options.fileCatalog === undefined || options.changedLineRanges === undefined
      ? undefined
      : {
          fileCatalog: options.fileCatalog,
          changedLineRanges: options.changedLineRanges,
        };
  const evidenceValidation = validateAgentReportEvidence(result.report, evidence);
  if (evidenceValidation.ok) return result;

  return incompleteResult(
    {
      inputHash: result.inputHash,
      provider: result.provider,
      model: result.model,
      truncatedInput: result.truncatedInput,
    },
    evidenceValidation.reason,
  );
}

export function incompleteReport(): AgentReport {
  return { ...INCOMPLETE_REPORT };
}

export function truncateReportText(value: string, maximumBytes = MAX_REPORT_BYTES): string {
  return truncateUtf8(value, Math.min(maximumBytes, MAX_REPORT_BYTES)).value;
}
