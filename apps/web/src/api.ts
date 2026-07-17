import {
  isCleanupStatus,
  isFindingCategory,
  isFindingSeverity,
  isRunStatus,
  isStepStatus,
} from "./status";
import type { Finding, Preview, Report, RunDetail, RunLog, RunStep, RunSummary, User } from "./types";

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/$/, "");

export function authLoginUrl(): string {
  return `${API_BASE_URL}/auth/login`;
}

export type ApiErrorCode = "AUTH_REQUIRED" | "FORBIDDEN" | "NOT_FOUND" | "HTTP_ERROR" | "INVALID_RESPONSE" | "NETWORK_ERROR";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly code: ApiErrorCode,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function endpoint(path: string): string {
  return `${API_BASE_URL}${path}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown, field: string, required = true): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) return value;
  if (!required && (value === undefined || value === null)) return undefined;
  throw new ApiError(`API 返回的 ${field} 无效`, "INVALID_RESPONSE");
}

function asNumber(value: unknown, field: string, required = true): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (!required && (value === undefined || value === null)) return undefined;
  throw new ApiError(`API 返回的 ${field} 无效`, "INVALID_RESPONSE");
}

function unwrap(value: unknown, key: string): unknown {
  return isRecord(value) && key in value ? value[key] : value;
}

async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (init.body !== undefined && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  try {
    response = await fetch(endpoint(path), {
      ...init,
      credentials: "include",
      headers,
    });
  } catch {
    throw new ApiError("无法连接运行台 API", "NETWORK_ERROR");
  }

  if (response.status === 401) {
    throw new ApiError("登录已失效", "AUTH_REQUIRED", response.status);
  }
  if (response.status === 403) {
    throw new ApiError("当前账号没有访问权限", "FORBIDDEN", response.status);
  }
  if (response.status === 404) {
    throw new ApiError("运行记录不存在", "NOT_FOUND", response.status);
  }
  if (!response.ok) {
    throw new ApiError(`运行台 API 返回 HTTP ${response.status}`, "HTTP_ERROR", response.status);
  }

  try {
    return (await response.json()) as T;
  } catch {
    throw new ApiError("运行台 API 返回了无法解析的数据", "INVALID_RESPONSE", response.status);
  }
}

function parseUser(value: unknown): User | null {
  if (!isRecord(value)) throw new ApiError("登录接口返回的数据无效", "INVALID_RESPONSE");
  if (value.authenticated === false || value.user === null) {
    return null;
  }
  const userValue = isRecord(value.user) ? value.user : value;
  const id = asString(userValue.id, "user.id", false);
  const username = asString(userValue.username ?? userValue.login, "user.username", false);
  const displayName = asString(userValue.displayName ?? userValue.name, "user.displayName", false);
  const csrfToken = asString(value.csrfToken, "csrfToken", false);
  const user: User = {
    ...(id === undefined ? {} : { id }),
    ...(username === undefined ? {} : { username }),
    ...(displayName === undefined ? {} : { displayName }),
    ...(csrfToken === undefined ? {} : { csrfToken }),
  };
  if (!user.id && !user.username && !user.displayName) {
    throw new ApiError("登录接口没有返回用户身份", "INVALID_RESPONSE");
  }
  return user;
}

export async function getSession(): Promise<User | null> {
  return parseUser(await requestJson<unknown>("/api/me"));
}

async function postRunAction(runId: string, action: "retry" | "cancel", csrfToken: string, confirmCleanupFailure = false): Promise<void> {
  await requestJson(`/api/runs/${encodeURIComponent(runId)}/${action}`, {
    method: "POST",
    headers: {
      "x-csrf-token": csrfToken,
      ...(confirmCleanupFailure ? { "x-confirm-cleanup-failure": "true" } : {}),
    },
  });
}

export async function retryRun(runId: string, csrfToken: string, confirmCleanupFailure = false): Promise<void> {
  await postRunAction(runId, "retry", csrfToken, confirmCleanupFailure);
}

export async function cancelRun(runId: string, csrfToken: string): Promise<void> {
  await postRunAction(runId, "cancel", csrfToken);
}

function parseRun(value: unknown): RunSummary {
  if (!isRecord(value)) throw new ApiError("运行列表返回的数据无效", "INVALID_RESPONSE");
  const repositoryValue = isRecord(value.repository) ? value.repository : undefined;
  const status = value.status;
  const cleanupStatus = value.cleanupStatus ?? value.cleanup_status;
  if (!isRunStatus(status)) throw new ApiError("运行记录包含未知的运行状态", "INVALID_RESPONSE");
  if (!isCleanupStatus(cleanupStatus)) throw new ApiError("运行记录包含未知的清理状态", "INVALID_RESPONSE");

  return {
    id: asString(value.id, "run.id")!,
    repository: asString(value.repositoryName ?? value.repo ?? repositoryValue?.fullName, "run.repository", false) ?? "仓库名称未提供",
    pullRequestNumber: asNumber(value.pullRequestNumber ?? value.prNumber ?? (isRecord(value.pullRequest) ? value.pullRequest.number : undefined), "run.pullRequestNumber", false),
    title: asString(value.title, "run.title", false) ?? "运行标题未提供",
    author: asString(value.author, "run.author", false),
    headSha: asString(value.headSha ?? value.head_sha, "run.headSha")!,
    status,
    verdict: value.verdict === undefined || value.verdict === null
      ? undefined
      : value.verdict === "PASSED" || value.verdict === "FAILED" || value.verdict === "INCOMPLETE"
        ? value.verdict
        : (() => { throw new ApiError("运行记录包含未知的 verdict", "INVALID_RESPONSE"); })(),
    cleanupStatus,
    createdAt: asString(value.createdAt ?? value.created_at, "run.createdAt")!,
    updatedAt: asString(value.updatedAt ?? value.updated_at, "run.updatedAt")!,
  };
}

export async function getRuns(): Promise<RunSummary[]> {
  const response = unwrap(await requestJson<unknown>("/api/runs"), "runs");
  if (!Array.isArray(response)) throw new ApiError("运行列表返回的数据无效", "INVALID_RESPONSE");
  return response.map(parseRun);
}

export async function getRun(runId: string): Promise<RunDetail> {
  const response = unwrap(await requestJson<unknown>(`/api/runs/${encodeURIComponent(runId)}`), "run");
  const run = parseRun(response);
  if (!isRecord(response)) throw new ApiError("运行详情返回的数据无效", "INVALID_RESPONSE");
  return {
    ...run,
    currentAttempt: asNumber(response.currentAttempt ?? response.current_attempt, "run.currentAttempt")!,
    executionPlan: isRecord(response.executionPlan ?? response.execution_plan) ? (response.executionPlan ?? response.execution_plan) as Record<string, unknown> : undefined,
    namespace: asString(response.namespace, "run.namespace", false),
    previewHost: asString(response.previewHost ?? response.preview_host, "run.previewHost", false),
    cleanupAt: asString(response.cleanupAt ?? response.cleanup_at, "run.cleanupAt", false),
    cleanupError: asString(response.cleanupError ?? response.cleanup_error, "run.cleanupError", false),
  };
}

function parseStep(value: unknown): RunStep {
  if (!isRecord(value)) throw new ApiError("步骤返回的数据无效", "INVALID_RESPONSE");
  const status = value.status;
  if (!isStepStatus(status)) throw new ApiError("步骤包含未知状态", "INVALID_RESPONSE");
  return {
    key: asString(value.stepKey ?? value.step_key ?? value.key, "step.key")!,
    label: asString(value.label ?? value.name, "step.label", false) ?? String(value.stepKey ?? value.step_key ?? value.key),
    status,
    startedAt: asString(value.startedAt ?? value.started_at, "step.startedAt", false),
    finishedAt: asString(value.finishedAt ?? value.finished_at, "step.finishedAt", false),
    durationMs: asNumber(value.durationMs ?? value.duration_ms, "step.durationMs", false),
    failureReason: asString(value.failureReason ?? value.failure_reason, "step.failureReason", false),
  };
}

export async function getSteps(runId: string): Promise<RunStep[]> {
  const response = unwrap(await requestJson<unknown>(`/api/runs/${encodeURIComponent(runId)}/steps`), "steps");
  if (!Array.isArray(response)) throw new ApiError("步骤列表返回的数据无效", "INVALID_RESPONSE");
  return response.map(parseStep);
}

export async function getLogs(runId: string): Promise<RunLog[]> {
  const response = unwrap(await requestJson<unknown>(`/api/runs/${encodeURIComponent(runId)}/logs`), "logs");
  if (!Array.isArray(response)) throw new ApiError("日志返回的数据无效", "INVALID_RESPONSE");
  return response.map((value) => {
    if (!isRecord(value)) throw new ApiError("日志返回的数据无效", "INVALID_RESPONSE");
    return {
      stepKey: asString(value.stepKey ?? value.step_key, "log.stepKey")!,
      label: asString(value.label, "log.label")!,
      content: asString(value.content, "log.content")!,
      truncated: value.truncated === true,
      expiresAt: asString(value.expiresAt ?? value.expires_at, "log.expiresAt", false),
    };
  });
}

function parseFinding(value: unknown): Finding {
  if (!isRecord(value)) throw new ApiError("Finding 返回的数据无效", "INVALID_RESPONSE");
  if (!isFindingSeverity(value.severity) || !isFindingCategory(value.category)) {
    throw new ApiError("Finding 包含未知分类或严重级别", "INVALID_RESPONSE");
  }
  const lineStart = asNumber(value.lineStart ?? value.line_start, "finding.lineStart")!;
  const lineEnd = asNumber(value.lineEnd ?? value.line_end, "finding.lineEnd")!;
  if (!Number.isInteger(lineStart) || !Number.isInteger(lineEnd) || lineStart < 1 || lineEnd < lineStart) {
    throw new ApiError("Finding 的行号范围无效", "INVALID_RESPONSE");
  }
  return {
    severity: value.severity,
    category: value.category,
    file: asString(value.file, "finding.file")!,
    lineStart,
    lineEnd,
    title: asString(value.title, "finding.title")!,
    description: asString(value.description, "finding.description")!,
    evidence: asString(value.evidence, "finding.evidence")!,
    recommendation: asString(value.recommendation, "finding.recommendation")!,
  };
}

function parseReport(value: unknown): Report | null {
  if (value === null) return null;
  const report = unwrap(value, "report");
  if (report === null) return null;
  if (!isRecord(report) || !isFindingSeverity(report.riskLevel)) {
    throw new ApiError("报告返回的数据无效", "INVALID_RESPONSE");
  }
  const confidence = asNumber(report.confidence, "report.confidence")!;
  const findings = report.findings;
  if (!Array.isArray(findings) || confidence < 0 || confidence > 1) {
    throw new ApiError("报告返回的数据无效", "INVALID_RESPONSE");
  }
  return {
    summary: asString(report.summary, "report.summary")!,
    riskLevel: report.riskLevel,
    confidence,
    findings: findings.map(parseFinding),
  };
}

export async function getReport(runId: string): Promise<Report | null> {
  return parseReport(await requestJson<unknown>(`/api/runs/${encodeURIComponent(runId)}/report`));
}

function parsePreview(value: unknown, trustedPreviewHost?: string): Preview | null {
  if (value === null) return null;
  const preview = unwrap(value, "preview");
  if (!isRecord(preview)) throw new ApiError("Preview 返回的数据无效", "INVALID_RESPONSE");
  const rawUrl = asString(preview.url, "preview.url", false);
  const expiresAt = asString(preview.expiresAt ?? preview.expires_at, "preview.expiresAt", false);
  const configuredHost = trustedPreviewHost?.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "");
  let expired = false;
  if (expiresAt) {
    const expiry = Date.parse(expiresAt);
    if (!Number.isFinite(expiry)) throw new ApiError("Preview 过期时间无效", "INVALID_RESPONSE");
    expired = expiry <= Date.now();
  }
  if (rawUrl) {
    try {
      const parsed = new URL(rawUrl, window.location.origin);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("unsupported protocol");
      if (configuredHost && parsed.hostname.toLowerCase() !== configuredHost.split(":")[0]) {
        throw new Error("untrusted preview host");
      }
    } catch {
      throw new ApiError("Preview URL 无效", "INVALID_RESPONSE");
    }
  }
  return {
    accessMode: asString(preview.accessMode ?? preview.access_mode, "preview.accessMode")!,
    status: expired ? "EXPIRED" : asString(preview.status, "preview.status")!,
    url: expired ? undefined : rawUrl,
    portForwardCommand: asString(preview.portForwardCommand ?? preview.port_forward_command, "preview.portForwardCommand", false),
    expiresAt,
    sshTunnelCommand: asString(preview.sshTunnelCommand ?? preview.ssh_tunnel_command, "preview.sshTunnelCommand", false),
  };
}

export async function getPreview(runId: string, trustedPreviewHost?: string): Promise<Preview | null> {
  return parsePreview(
    await requestJson<unknown>(`/api/runs/${encodeURIComponent(runId)}/preview`),
    trustedPreviewHost,
  );
}
