import {
  buildJob,
  buildPreviewDeployment,
  buildPreviewIngress,
  buildPreviewService,
  buildRunResourcePlan,
  buildControlledDockerfile,
  detectProjectProfile,
  labelsForResource,
  namespaceName,
  reconcileResource,
  type JobProfile,
  type KubernetesObject,
  type ManagedKubernetesObject,
  type RunIdentity,
} from "@platform/k8s";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "../logger.js";
import type { StepExecutor } from "../workflow/executor.js";
import { prepareReviewInput, reviewInputBytes, validateAgentReportEvidence } from "@platform/agent";
import { AgentReportSchema } from "@platform/contracts";
import type { AgentChangedLineRange } from "@platform/contracts";
import type {
  RunSnapshot,
  StepExecutionContext,
  StepExecutionResult,
  StepKey,
} from "../workflow/types.js";
import type { WorkflowStore } from "../workflow/store.js";
import type { GiteaClient } from "../gitea/client.js";
import type { AgentReviewQueueClient, ReviewRequest } from "../agent-review/queue.js";
import { KubernetesApiClient, KubernetesApiError } from "./client.js";

const DEFAULT_JOB_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_PREVIEW_TIMEOUT_MS = 90 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const HEALTH_CHECK_TIMEOUT_MS = 5_000;
const MAX_EXPORTED_LOG_BYTES = 64 * 1024;
const PREVIEW_TTL_MS = 30 * 60 * 1000;

type ResourcePhase = "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "DELETING" | "DELETED" | "UNKNOWN";

export interface KubernetesStepExecutorOptions {
  readonly client: KubernetesApiClient;
  readonly store?: Pick<WorkflowStore, "recordKubernetesResource" | "markKubernetesResourceDeleted" | "saveStepLog">;
  readonly runnerImage: string;
  readonly previewImage: string;
  readonly giteaBaseUrl: string;
  readonly giteaRunnerBaseUrl?: string;
  readonly giteaRunnerToken?: string;
  readonly previewBaseUrl?: string;
  readonly previewTlsSecretName?: string;
  readonly previewMode: "local" | "ingress" | "ssh";
  readonly giteaClient?: Pick<GiteaClient, "getPullRequestDiff" | "listRepositoryFiles">;
  readonly agentReviewClient?: Pick<AgentReviewQueueClient, "request">;
  readonly agentReviewUrl?: string;
  readonly storageClassName?: string;
  readonly pollIntervalMs?: number;
  readonly jobTimeoutMs?: number;
  readonly previewTimeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly logger?: Logger;
  readonly logRoot?: string;
}

interface JobStatus {
  readonly succeeded?: number;
  readonly failed?: number;
  readonly conditions?: readonly { readonly type?: string; readonly reason?: string; readonly message?: string }[];
}

interface KubernetesResourceMetadata {
  readonly name?: string;
  readonly namespace?: string;
  readonly uid?: string;
  readonly generation?: number;
  readonly deletionTimestamp?: string;
  readonly labels?: Readonly<Record<string, string>>;
}

function identity(run: RunSnapshot): RunIdentity {
  return {
    runId: run.id,
    runShortId: run.id.replaceAll("-", "").slice(0, 12),
    attempt: run.attempt,
  };
}

function sourceSecretName(run: RunIdentity): string {
  return `source-token-a${run.attempt}`;
}

const KUBERNETES_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function buildPreviewServiceReference(namespace: string, serviceName: string): string {
  if (!KUBERNETES_NAME.test(namespace) || !KUBERNETES_NAME.test(serviceName)) {
    throw new Error("Preview Service reference contains an invalid Kubernetes name");
  }
  return `service://${namespace}/${serviceName}`;
}

function healthPath(context: StepExecutionContext): string {
  const candidate = context.run.executionPlan?.healthPath;
  return typeof candidate === "string" && candidate.startsWith("/") ? candidate : "/health";
}

function previewHealthUrl(run: RunIdentity, serviceName: string, path: string): string {
  buildPreviewServiceReference(namespaceName(run.runShortId), serviceName);
  return `http://${serviceName}.${namespaceName(run.runShortId)}.svc.cluster.local${path}`;
}

function resourceName(resource: unknown): string | undefined {
  if (typeof resource !== "object" || resource === null) return undefined;
  const metadata = (resource as { readonly metadata?: KubernetesResourceMetadata }).metadata;
  return metadata?.name;
}

function resourceNamespace(resource: unknown): string | undefined {
  if (typeof resource !== "object" || resource === null) return undefined;
  const metadata = (resource as { readonly metadata?: KubernetesResourceMetadata }).metadata;
  return metadata?.namespace;
}

function resourceUid(resource: unknown): string | undefined {
  if (typeof resource !== "object" || resource === null) return undefined;
  const metadata = (resource as { readonly metadata?: KubernetesResourceMetadata }).metadata;
  return metadata?.uid;
}

function jobStatus(resource: unknown): JobStatus {
  if (typeof resource !== "object" || resource === null) return {};
  const status = (resource as { readonly status?: unknown }).status;
  return typeof status === "object" && status !== null ? status as JobStatus : {};
}

function podLabels(run: RunIdentity, stepKey: string): string {
  const resource = stepKey === "fetch" ? "source-fetch" : stepKey === "analyze" ? "analysis-tools" : "build-test";
  const labels = labelsForResource({ ...run, stepKey }, resource);
  return Object.entries(labels).map(([key, value]) => `${key}=${value}`).join(",");
}

function truncateUtf8(value: string, maximumBytes: number): { readonly value: string; readonly truncated: boolean } {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maximumBytes) return { value, truncated: false };
  return { value: bytes.subarray(0, maximumBytes).toString("utf8"), truncated: true };
}

function redact(value: string, secret: string | undefined): string {
  return secret === undefined || secret.length === 0 ? value : value.split(secret).join("[REDACTED]");
}

function failed(errorCode: string, details: Record<string, unknown>): StepExecutionResult {
  return { status: "FAILED", failureKind: "application", errorCode, details };
}

function incomplete(errorCode: string, details: Record<string, unknown>): StepExecutionResult {
  return { status: "INCOMPLETE", failureKind: "infrastructure", errorCode, details };
}

export function parseUnifiedDiffEvidence(diff: string): {
  readonly filePaths: readonly string[];
  readonly changedFiles: Readonly<Record<string, readonly AgentChangedLineRange[]>>;
} {
  const files = new Set<string>();
  const ranges = new Map<string, AgentChangedLineRange[]>();
  let currentFile: string | undefined;
  let newLine: number | undefined;
  let pendingAddedStart: number | undefined;
  let pendingAddedEnd: number | undefined;

  const flushAddedRange = (): void => {
    if (currentFile !== undefined && pendingAddedStart !== undefined && pendingAddedEnd !== undefined) {
      ranges.get(currentFile)?.push({ lineStart: pendingAddedStart, lineEnd: pendingAddedEnd });
    }
    pendingAddedStart = undefined;
    pendingAddedEnd = undefined;
  };

  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      flushAddedRange();
      currentFile = undefined;
      newLine = undefined;
      continue;
    }
    if (line.startsWith("+++ ")) {
      flushAddedRange();
      const rawPath = line.slice(4);
      const filePath = rawPath.startsWith("b/") ? rawPath.slice(2) : "";
      const segments = filePath.split("/");
      if (
        filePath.length > 0 &&
        !filePath.startsWith("/") &&
        !filePath.includes("\\") &&
        !segments.includes("..")
      ) {
        currentFile = filePath;
        files.add(filePath);
        if (!ranges.has(filePath)) ranges.set(filePath, []);
      } else {
        currentFile = undefined;
      }
      newLine = undefined;
      continue;
    }

    if (currentFile === undefined) continue;
    if (line.startsWith("@@")) {
      flushAddedRange();
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!hunk) {
        newLine = undefined;
        continue;
      }
      const lineStart = Number(hunk[1]);
      if (!Number.isSafeInteger(lineStart) || lineStart < 1) {
        newLine = undefined;
        continue;
      }
      newLine = lineStart;
      continue;
    }
    if (newLine === undefined || line.startsWith("\\")) continue;
    if (line.startsWith("+")) {
      pendingAddedStart ??= newLine;
      pendingAddedEnd = newLine;
      newLine += 1;
      continue;
    }
    flushAddedRange();
    if (line.startsWith("-") || line.startsWith(" ")) {
      if (line.startsWith(" ") || line.startsWith("-")) {
        if (line.startsWith(" ")) newLine += 1;
      }
    }
  }
  flushAddedRange();

  return {
    filePaths: [...files],
    changedFiles: Object.fromEntries(
      [...ranges].map(([filePath, fileRanges]) => [filePath, fileRanges]),
    ),
  };
}

export class KubernetesStepExecutor implements StepExecutor {
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly pollIntervalMs: number;
  private readonly jobTimeoutMs: number;
  private readonly previewTimeoutMs: number;

  constructor(private readonly options: KubernetesStepExecutorOptions) {
    this.pollIntervalMs = Math.max(0, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    this.jobTimeoutMs = Math.max(1, options.jobTimeoutMs ?? DEFAULT_JOB_TIMEOUT_MS);
    this.previewTimeoutMs = Math.max(1, options.previewTimeoutMs ?? DEFAULT_PREVIEW_TIMEOUT_MS);
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  async execute(context: StepExecutionContext): Promise<StepExecutionResult> {
    const run = identity(context.run);
    try {
      switch (context.job.stepKey) {
        case "detect":
          return await this.executeDetect(context);
        case "fetch":
          return await this.executeJob(context, "sourceFetch", {
            PLATFORM_GITEA_BASE_URL: this.options.giteaRunnerBaseUrl ?? this.options.giteaBaseUrl,
            PLATFORM_REPOSITORY: context.run.repositoryFullName ?? "",
            PLATFORM_PULL_REQUEST: String(context.run.pullRequestNumber ?? ""),
            PLATFORM_HEAD_SHA: context.job.headSha,
          });
        case "analyze":
          return await this.executeJob(context, "analysisTools");
        case "test":
          return await this.executeJob(context, "buildTest", this.profileEnvironment(context));
        case "build":
          return await this.executeJob(context, "buildTest", this.profileEnvironment(context));
        case "preview":
          return await this.executePreview(context);
        case "health":
          return await this.waitForPreview(context);
        case "cleanup":
          return await this.cleanup(context);
        case "agent-review":
          return await this.executeAgentReview(context);
        case "assemble-review-input":
        case "report":
          return { status: "PASSED", details: { mode: "kubernetes" } };
        default:
          return { status: "PASSED", details: { mode: "kubernetes" } };
      }
    } catch (error) {
      this.options.logger?.error("Kubernetes workflow step failed", {
        runId: context.run.id,
        stepKey: context.job.stepKey,
        error: error instanceof Error ? error.message : String(error),
      });
      return incomplete("K8S_API_ERROR", {
        mode: "kubernetes",
        stepKey: context.job.stepKey,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async executeDetect(context: StepExecutionContext): Promise<StepExecutionResult> {
    const giteaClient = this.options.giteaClient;
    const repositoryFullName = context.run.repositoryFullName;
    if (giteaClient === undefined || repositoryFullName === undefined) {
      return incomplete("PROFILE_DETECTION_UNAVAILABLE", { mode: "kubernetes" });
    }
    const separator = repositoryFullName.indexOf("/");
    if (separator <= 0 || separator === repositoryFullName.length - 1 || repositoryFullName.indexOf("/", separator + 1) !== -1) {
      return failed("REPOSITORY_NAME_INVALID", { mode: "kubernetes" });
    }
    let files: readonly string[];
    try {
      files = await giteaClient.listRepositoryFiles(
        repositoryFullName.slice(0, separator),
        repositoryFullName.slice(separator + 1),
        context.job.headSha,
      );
    } catch (error) {
      return incomplete("PROFILE_DETECTION_UNAVAILABLE", {
        mode: "kubernetes",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    const detection = detectProjectProfile(files);
    if (detection.status !== "SUPPORTED") {
      return failed(detection.errorCode, {
        mode: "kubernetes",
        candidates: detection.candidates,
        fileCount: files.length,
      });
    }
    return {
      status: "PASSED",
      details: {
        mode: "kubernetes",
        ...detection.plan,
        fileCount: files.length,
        executionPlan: {
          projectType: detection.plan.projectType,
          profile: detection.plan.profile,
          port: detection.plan.port,
          healthPath: detection.plan.healthPath,
          testProfile: detection.plan.testProfile,
          entrypoint: detection.plan.entrypoint,
          baseImage: detection.plan.baseImage,
          controlledDockerfile: buildControlledDockerfile(detection.plan),
        },
      },
    };
  }

  private profileEnvironment(context: StepExecutionContext): Readonly<Record<string, string>> {
    const plan = context.run.executionPlan;
    if (plan === undefined || typeof plan.projectType !== "string" || typeof plan.profile !== "string") return {};
    return {
      PLATFORM_PROJECT_TYPE: plan.projectType,
      PLATFORM_PROJECT_PROFILE: plan.profile,
      ...(typeof plan.port === "number" ? { PLATFORM_PROJECT_PORT: String(plan.port) } : {}),
      ...(typeof plan.healthPath === "string" ? { PLATFORM_PROJECT_HEALTH_PATH: plan.healthPath } : {}),
    };
  }

  private async executeAgentReview(context: StepExecutionContext): Promise<StepExecutionResult> {
    const endpoint = this.options.agentReviewUrl;
    const agentReviewClient = this.options.agentReviewClient;
    if (endpoint === undefined && agentReviewClient === undefined) {
      return incomplete("AGENT_REVIEW_TRANSPORT_NOT_CONFIGURED", { mode: "kubernetes" });
    }
    const giteaClient = this.options.giteaClient;
    const repositoryFullName = context.run.repositoryFullName;
    const pullRequestNumber = context.run.pullRequestNumber;
    if (giteaClient === undefined || repositoryFullName === undefined || pullRequestNumber === undefined) {
      return incomplete("AGENT_REVIEW_EVIDENCE_UNAVAILABLE", { mode: "kubernetes" });
    }
    const separator = repositoryFullName.indexOf("/");
    if (separator <= 0 || separator === repositoryFullName.length - 1 || repositoryFullName.indexOf("/", separator + 1) !== -1) {
      return incomplete("AGENT_REVIEW_REPOSITORY_INVALID", { mode: "kubernetes" });
    }
    let diff: string;
    try {
      diff = await giteaClient.getPullRequestDiff(
        repositoryFullName.slice(0, separator),
        repositoryFullName.slice(separator + 1),
        pullRequestNumber,
      );
    } catch {
      return incomplete("AGENT_REVIEW_DIFF_UNAVAILABLE", { mode: "kubernetes" });
    }
    const evidence = parseUnifiedDiffEvidence(diff);
    const prepared = prepareReviewInput({
      changedFiles: evidence.filePaths,
      diff,
      checks: await this.readReviewLogs(context.run.id, context.run.attempt),
    }, {
      maxBytes: context.capacity.maxReviewInputBytes,
      ...(this.options.giteaRunnerToken === undefined ? {} : { secretValues: [this.options.giteaRunnerToken] }),
    });
    const reviewInput = prepared.text;
    if (reviewInputBytes(reviewInput) > context.capacity.maxReviewInputBytes || prepared.truncated) {
      return incomplete("REVIEW_INPUT_TOO_LARGE", { mode: "kubernetes" });
    }
    const inputHash = prepared.inputHash;
    let payload: unknown;
    const request: ReviewRequest = {
      runId: context.job.runId,
      attempt: context.job.attempt,
      headSha: context.job.headSha,
      inputHash,
      reviewInput,
    };
    if (endpoint === undefined && agentReviewClient !== undefined) {
      try {
        payload = await agentReviewClient.request(request);
      } catch {
        return incomplete("AGENT_REVIEW_UNAVAILABLE", { mode: "kubernetes", transport: "queue" });
      }
    } else {
      let response: Response;
      try {
        response = await fetch(new URL("/review", endpoint as string), {
          method: "POST",
          signal: AbortSignal.timeout(30_000),
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify(request),
        });
      } catch {
        return incomplete("AGENT_REVIEW_UNAVAILABLE", { mode: "kubernetes", transport: "http" });
      }
      if (!response.ok) return incomplete("AGENT_REVIEW_HTTP_ERROR", { mode: "kubernetes", status: response.status });
      try {
        payload = await response.json();
      } catch {
        return incomplete("AGENT_REVIEW_INVALID_RESPONSE", { mode: "kubernetes" });
      }
    }
    if (typeof payload !== "object" || payload === null) return incomplete("AGENT_REVIEW_INVALID_RESPONSE", { mode: "kubernetes" });
    const responsePayload = payload as Record<string, unknown>;
    if (responsePayload.runId !== context.job.runId || responsePayload.attempt !== context.job.attempt || responsePayload.headSha !== context.job.headSha) {
      return incomplete("AGENT_REVIEW_IDENTITY_MISMATCH", { mode: "kubernetes" });
    }
    const result = responsePayload.result;
    if (typeof result !== "object" || result === null) return incomplete("AGENT_REVIEW_INVALID_RESPONSE", { mode: "kubernetes" });
    const candidate = result as Record<string, unknown>;
    const report = AgentReportSchema.safeParse(candidate.report);
    if (
      candidate.inputHash !== inputHash ||
      typeof candidate.provider !== "string" ||
      typeof candidate.model !== "string" ||
      (candidate.verdict !== "PASSED" && candidate.verdict !== "INCOMPLETE") ||
      !report.success
    ) {
      return incomplete("AGENT_REVIEW_INVALID_RESPONSE", { mode: "kubernetes" });
    }
    const evidenceValidation = validateAgentReportEvidence(report.data, {
      fileCatalog: { has: (filePath) => Object.prototype.hasOwnProperty.call(evidence.changedFiles, filePath) },
      changedLineRanges: { get: (filePath) => evidence.changedFiles[filePath] },
    });
    if (!evidenceValidation.ok) {
      return incomplete("AGENT_REVIEW_MISSING_EVIDENCE", { mode: "kubernetes", issues: evidenceValidation.issues });
    }
    const details = { mode: "kubernetes", provider: candidate.provider, model: candidate.model, inputHash, report: report.data };
    return candidate.verdict === "PASSED"
      ? { status: "PASSED", details }
      : { status: "INCOMPLETE", failureKind: "model", errorCode: typeof candidate.reason === "string" ? candidate.reason : "AGENT_REVIEW_INCOMPLETE", details };
  }

  private async readReviewLogs(runId: string, attempt: number): Promise<Record<string, string>> {
    if (this.options.logRoot === undefined) return {};
    const directory = join(this.options.logRoot, "runs", runId, `attempt-${attempt}`);
    const logs: Record<string, string> = {};
    for (const stepKey of ["analyze", "test", "build", "health"] as const) {
      try {
        const value = await readFile(join(directory, `${stepKey}.log`), "utf8");
        logs[stepKey] = truncateUtf8(value, 8 * 1024).value;
      } catch {
        logs[stepKey] = "[evidence unavailable]";
      }
    }
    return logs;
  }

  private async ensureBaseResources(run: RunIdentity, stepKey: StepKey, preview = false, previewExpiresAt?: Date): Promise<void> {
    const previewOptions = preview
      ? {
          ...run,
          image: this.options.previewImage,
          containerPort: 8080,
          healthPath: "/health",
        }
      : undefined;
    const previewIngress = preview && this.options.previewMode === "ingress"
      ? {
          ...run,
          baseUrl: this.options.previewBaseUrl ?? "",
          expiresAt: previewExpiresAt ?? new Date(Date.now() + PREVIEW_TTL_MS),
          ...(this.options.previewTlsSecretName === undefined ? {} : { tlsSecretName: this.options.previewTlsSecretName }),
        }
      : undefined;
    const resources = buildRunResourcePlan({ run, ...(this.options.storageClassName === undefined ? {} : { storageClassName: this.options.storageClassName }), ...(previewOptions === undefined ? {} : { preview: previewOptions }), ...(previewIngress === undefined ? {} : { previewIngress }) });
    for (const desired of resources) {
      // Kubernetes creates the Namespace's default ServiceAccount itself. The
      // Worker deliberately has no serviceaccounts RBAC permission.
      if (desired.kind === "ServiceAccount") continue;
      const result = await reconcileResource(this.options.client, desired as ManagedKubernetesObject);
      await this.recordResource(run, desired.kind === "Namespace" ? "cleanup" : stepKey, result.resource, desired.kind === "Namespace" ? "RUNNING" : "PENDING");
    }
  }

  private async recordResource(run: RunIdentity, stepKey: StepKey, resource: KubernetesObject, phase: ResourcePhase): Promise<void> {
    const name = resourceName(resource);
    const namespace = resourceNamespace(resource) ?? namespaceName(run.runShortId);
    if (name === undefined || this.options.store?.recordKubernetesResource === undefined) return;
    await this.options.store.recordKubernetesResource({
      runId: run.runId,
      attempt: run.attempt,
      stepKey,
      namespace,
      kind: resource.kind,
      name,
      ...(resourceUid(resource) === undefined ? {} : { uid: resourceUid(resource) }),
      phase,
    });
  }

  private async executeJob(context: StepExecutionContext, profile: JobProfile, environment: Readonly<Record<string, string>> = {}): Promise<StepExecutionResult> {
    const run = identity(context.run);
    await this.ensureBaseResources(run, context.job.stepKey);
    const needsSourceToken = profile === "sourceFetch";
    const giteaRunnerToken = this.options.giteaRunnerToken;
    if (needsSourceToken && (!giteaRunnerToken || !context.run.repositoryFullName || !context.run.pullRequestNumber)) {
      return incomplete("SOURCE_FETCH_CREDENTIALS_NOT_CONFIGURED", { mode: "kubernetes", stepKey: context.job.stepKey });
    }

    const secretName = needsSourceToken ? sourceSecretName(run) : undefined;
    let sourceSecretUid: string | undefined;
    if (secretName !== undefined) {
      if (giteaRunnerToken === undefined) {
        return incomplete("SOURCE_FETCH_CREDENTIALS_NOT_CONFIGURED", { mode: "kubernetes", stepKey: context.job.stepKey });
      }
      const secret = await this.ensureSourceSecret(run, secretName, giteaRunnerToken);
      sourceSecretUid = resourceUid(secret);
      if (sourceSecretUid === undefined) throw new Error("source Secret UID is missing after creation");
      await this.recordResource(run, "fetch", secret, "RUNNING");
    }

    const desired = buildJob({
      ...run,
      stepKey: context.job.stepKey === "build" ? "build" : context.job.stepKey,
      profile,
      image: this.options.runnerImage,
      ...(secretName === undefined ? {} : { sourceCredentialSecretName: secretName }),
      environment: Object.entries(environment).map(([name, value]) => ({ name, value })),
    });
    let jobResource: ManagedKubernetesObject | undefined;
    try {
      const reconciled = await reconcileResource(this.options.client, desired);
      jobResource = reconciled.resource;
      await this.recordResource(run, context.job.stepKey, jobResource, "RUNNING");
      const observed = await this.waitForJob(run, context.job.stepKey, jobResource.metadata.name, context.capacity.maxStepLogBytes);
      await this.recordResource(run, context.job.stepKey, jobResource, observed.status === "succeeded" ? "SUCCEEDED" : observed.status === "failed" ? "FAILED" : "UNKNOWN");
      const logs = await this.collectLogs(run, context.job.stepKey, context.capacity.maxStepLogBytes);
      const logDetails = truncateUtf8(redact(logs.value, giteaRunnerToken), MAX_EXPORTED_LOG_BYTES);
      await this.persistStepLog(run, context.job, logDetails.value);
      await this.deleteOwnedResource({
        kind: "Job",
        namespace: namespaceName(run.runShortId),
        name: jobResource.metadata.name,
        run,
        stepKey: context.job.stepKey,
      });
      const details = {
        mode: "kubernetes",
        jobName: jobResource.metadata.name,
        namespace: namespaceName(run.runShortId),
        logs: logDetails.value,
        logsTruncated: logs.truncated || logDetails.truncated,
        ...(context.job.stepKey === "build" ? { buildMode: "FIXTURE" } : {}),
        ...(observed.status === "succeeded" ? { exitCode: 0 } : { exitCode: 1 }),
      };
      if (observed.status === "timeout") return incomplete("JOB_TIMEOUT", details);
      if (observed.status === "failed") return failed(observed.errorCode ?? "JOB_FAILED", details);
      return { status: "PASSED", details };
    } finally {
      if (secretName !== undefined && sourceSecretUid !== undefined) {
        await this.deleteOwnedSecret(run, secretName, sourceSecretUid).catch((error) => this.options.logger?.warn("source token cleanup failed", { error: error instanceof Error ? error.message : String(error) }));
      }
    }
  }

  private async persistStepLog(run: RunIdentity, job: StepExecutionContext["job"], value: string): Promise<void> {
    if (this.options.logRoot === undefined) return;
    const directory = join(this.options.logRoot, "runs", run.runId, `attempt-${run.attempt}`);
    const logPath = join(directory, `${job.stepKey}.log`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(logPath, value, { encoding: "utf8", mode: 0o600 });
    await this.options.store?.saveStepLog?.({
      runId: run.runId,
      attempt: run.attempt,
      headSha: job.headSha,
      stepKey: job.stepKey,
      logPath,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });
  }

  private async ensureSourceSecret(run: RunIdentity, name: string, token: string): Promise<KubernetesObject> {
    const namespace = namespaceName(run.runShortId);
    return this.options.client.createRaw({
      apiVersion: "v1",
      kind: "Secret",
      metadata: {
        name,
        namespace,
        labels: labelsForResource({ ...run, stepKey: "fetch" }, "source-token"),
      },
      type: "Opaque",
      stringData: { token },
    } as unknown as ManagedKubernetesObject) as unknown as KubernetesObject;
  }

  private async waitForJob(run: RunIdentity, stepKey: StepKey, name: string, maxLogBytes: number): Promise<{ readonly status: "succeeded" | "failed" | "timeout"; readonly errorCode?: string }> {
    const started = Date.now();
    while (Date.now() - started <= this.jobTimeoutMs) {
      const resource = await this.options.client.getRaw({ kind: "Job", namespace: namespaceName(run.runShortId), name });
      if (resource === null) return { status: "failed", errorCode: "JOB_DISAPPEARED" };
      const status = jobStatus(resource);
      if ((status.succeeded ?? 0) >= 1) return { status: "succeeded" };
      if ((status.failed ?? 0) >= 1) {
        const deadline = status.conditions?.find((condition) => condition.reason === "DeadlineExceeded");
        return { status: "failed", errorCode: deadline ? "JOB_DEADLINE_EXCEEDED" : "JOB_FAILED" };
      }
      await this.sleep(this.pollIntervalMs);
    }
    this.options.logger?.warn("Kubernetes Job timed out", { runId: run.runId, stepKey, maxLogBytes });
    return { status: "timeout" };
  }

  private async collectLogs(run: RunIdentity, stepKey: StepKey, maxBytes: number): Promise<{ readonly value: string; readonly truncated: boolean }> {
    const pods = await this.options.client.listPods(namespaceName(run.runShortId), podLabels(run, stepKey));
    let output = "";
    let truncated = false;
    for (const pod of pods) {
      const name = resourceName(pod);
      if (!name) continue;
      const podLog = await this.options.client.logs({ namespace: namespaceName(run.runShortId), podName: name, tailLines: 50_000 }).catch(() => "");
      const remaining = Math.max(0, maxBytes - Buffer.byteLength(output, "utf8"));
      const piece = truncateUtf8(podLog, remaining);
      output += piece.value;
      truncated ||= piece.truncated;
      if (piece.truncated) break;
    }
    return { value: output, truncated };
  }

  private async executePreview(context: StepExecutionContext): Promise<StepExecutionResult> {
    if (this.options.previewMode === "ingress" && (!this.options.previewBaseUrl || (this.options.previewBaseUrl.startsWith("https:") && !this.options.previewTlsSecretName))) {
      return incomplete("PREVIEW_BASE_URL_NOT_CONFIGURED", { mode: "kubernetes" });
    }
    const run = identity(context.run);
    const expiresAt = new Date(Date.now() + PREVIEW_TTL_MS);
    // Base resources and Preview resources are reconciled separately. Passing
    // preview=true here would reconcile the Deployment once more below and
    // can race the Deployment controller's resource-version update.
    await this.ensureBaseResources(run, context.job.stepKey);
    const preview = { ...run, image: this.options.previewImage, containerPort: 8080, healthPath: healthPath(context) };
    const resources: ManagedKubernetesObject[] = [buildPreviewDeployment(preview), buildPreviewService(preview)];
    if (this.options.previewMode === "ingress") {
      resources.push(buildPreviewIngress({ ...run, baseUrl: this.options.previewBaseUrl as string, expiresAt, ...(this.options.previewTlsSecretName === undefined ? {} : { tlsSecretName: this.options.previewTlsSecretName }) }));
    }
    let service: KubernetesObject | undefined;
    for (const resource of resources) {
      const result = await reconcileResource(this.options.client, resource);
      await this.recordResource(run, context.job.stepKey, result.resource, "RUNNING");
      if (result.resource.kind === "Service") service = result.resource;
    }
    if (service === undefined || resourceName(service) === undefined) {
      return incomplete("PREVIEW_SERVICE_UNAVAILABLE", {
        mode: "kubernetes",
        namespace: namespaceName(run.runShortId),
      });
    }
    const serviceName = resourceName(service) as string;
    const previewHost = this.options.previewMode === "ingress"
      ? `${new URL(this.options.previewBaseUrl as string).protocol}//${(resources[2] as ManagedKubernetesObject & { readonly spec: { readonly rules: readonly [{ readonly host: string }] } }).spec.rules[0].host}`
      : buildPreviewServiceReference(namespaceName(run.runShortId), serviceName);
    return { status: "PASSED", details: { mode: "kubernetes", previewHost, previewExpiresAt: expiresAt.toISOString() } };
  }

  private async waitForPreview(context: StepExecutionContext): Promise<StepExecutionResult> {
    const run = identity(context.run);
    const deployment = buildPreviewDeployment({ ...run, image: this.options.previewImage, containerPort: 8080, healthPath: healthPath(context) });
    const started = Date.now();
    while (Date.now() - started <= this.previewTimeoutMs) {
      const resource = await this.options.client.getRaw({ kind: "Deployment", namespace: namespaceName(run.runShortId), name: deployment.metadata.name });
      if (resource === null) return incomplete("PREVIEW_DEPLOYMENT_MISSING", { mode: "kubernetes" });
      const status = typeof resource.status === "object" && resource.status !== null ? resource.status as Record<string, unknown> : {};
      if (Number(status.availableReplicas ?? 0) >= 1 && Number(status.updatedReplicas ?? 0) >= 1) {
        const serviceName = resourceName(buildPreviewService({ ...run })) ?? resourceName(deployment);
        if (serviceName === undefined) return incomplete("PREVIEW_SERVICE_UNAVAILABLE", { mode: "kubernetes" });
        const request = this.options.fetch ?? globalThis.fetch;
        if (typeof request !== "function") return incomplete("PREVIEW_HEALTH_CHECK_UNAVAILABLE", { mode: "kubernetes" });
        const url = previewHealthUrl(run, serviceName, healthPath(context));
        try {
          const response = await request(url, {
            method: "GET",
            headers: { accept: "application/json, text/plain;q=0.9, */*;q=0.1" },
            signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
          });
          if (!response.ok) return failed("PREVIEW_HEALTH_CHECK_FAILED", { mode: "kubernetes", status: response.status, healthPath: healthPath(context) });
          return { status: "PASSED", details: { mode: "kubernetes", availableReplicas: status.availableReplicas, healthStatus: response.status } };
        } catch (error) {
          return incomplete("PREVIEW_HEALTH_CHECK_UNAVAILABLE", { mode: "kubernetes", healthPath: healthPath(context), message: error instanceof Error ? error.message : String(error) });
        }
      }
      const conditions = Array.isArray(status.conditions) ? status.conditions as readonly Record<string, unknown>[] : [];
      if (conditions.some((condition) => condition.type === "Progressing" && condition.reason === "ProgressDeadlineExceeded")) {
        return incomplete("PREVIEW_PROGRESS_DEADLINE_EXCEEDED", { mode: "kubernetes" });
      }
      await this.sleep(this.pollIntervalMs);
    }
    return incomplete("PREVIEW_HEALTH_TIMEOUT", { mode: "kubernetes" });
  }

  private async cleanup(context: StepExecutionContext): Promise<StepExecutionResult> {
    const run = identity(context.run);
    const name = namespaceName(run.runShortId);
    let namespace: Record<string, unknown> | null;
    try {
      namespace = await this.options.client.getRaw({ kind: "Namespace", name });
    } catch (error) {
      if (error instanceof KubernetesApiError && error.status === 400) {
        return incomplete("NAMESPACE_LOOKUP_UNAVAILABLE", { mode: "kubernetes", namespace: name });
      }
      throw error;
    }
    if (namespace === null) return { status: "PASSED", details: { mode: "kubernetes", cleanup: "already-gone" } };
    const labels = (namespace.metadata as KubernetesResourceMetadata | undefined)?.labels;
    if (labels?.["platform.io/managed"] !== "true" || labels["platform.io/run-id"] !== run.runId) {
      return incomplete("NAMESPACE_OWNERSHIP_CONFLICT", { mode: "kubernetes", namespace: name });
    }
    const uid = resourceUid(namespace);
    if (uid === undefined) return incomplete("NAMESPACE_UID_MISSING", { mode: "kubernetes", namespace: name });
    const deletionTimestamp = (namespace.metadata as KubernetesResourceMetadata | undefined)?.deletionTimestamp;
    if (typeof deletionTimestamp !== "string") {
      try {
        await this.options.client.delete({ kind: "Namespace", name, uid });
      } catch (error) {
        if (error instanceof KubernetesApiError && error.status === 400) {
          return incomplete("NAMESPACE_DELETE_REQUEST_FAILED", { mode: "kubernetes", namespace: name });
        }
        throw error;
      }
    }
    const started = Date.now();
    while (Date.now() - started <= this.previewTimeoutMs) {
      try {
        if (await this.options.client.getRaw({ kind: "Namespace", name }) === null) {
          await this.options.store?.markKubernetesResourceDeleted?.({ runId: run.runId, attempt: run.attempt, stepKey: "cleanup", kind: "Namespace", name, uid });
          return { status: "PASSED", details: { mode: "kubernetes", cleanup: "confirmed", namespace: name } };
        }
      } catch (error) {
        if (error instanceof KubernetesApiError && error.status === 400) {
          return { status: "PASSED", details: { mode: "kubernetes", cleanup: "deletion-pending", namespace: name } };
        }
        throw error;
      }
      await this.sleep(this.pollIntervalMs);
    }
    return incomplete("NAMESPACE_DELETE_TIMEOUT", { mode: "kubernetes", namespace: name });
  }

  private async deleteOwnedResource(input: { readonly kind: string; readonly namespace: string; readonly name: string; readonly run: RunIdentity; readonly stepKey: StepKey }): Promise<void> {
    const resource = await this.options.client.getRaw({ kind: input.kind, namespace: input.namespace, name: input.name });
    if (!resource) return;
    const labels = (resource.metadata as KubernetesResourceMetadata | undefined)?.labels;
    const expectedResource = input.kind === "Job"
      ? "job"
      : input.stepKey === "fetch"
        ? "source-fetch"
        : input.stepKey === "analyze"
          ? "analysis-tools"
          : "build-test";
    if (
      labels?.["platform.io/managed"] !== "true" ||
      labels["platform.io/run-id"] !== input.run.runId ||
      labels["platform.io/attempt"] !== String(input.run.attempt) ||
      labels["platform.io/step-key"] !== input.stepKey ||
      labels["platform.io/resource"] !== expectedResource
    ) {
      throw new Error("Kubernetes resource ownership conflict during delete");
    }
    const uid = resourceUid(resource);
    if (uid === undefined) throw new Error("Kubernetes resource UID is missing during delete");
    await this.options.client.delete({ kind: input.kind, namespace: input.namespace, name: input.name, uid });
    await this.options.store?.markKubernetesResourceDeleted?.({ runId: input.run.runId, attempt: input.run.attempt, stepKey: input.stepKey, kind: input.kind, name: input.name, uid });
  }

  private async deleteOwnedSecret(run: RunIdentity, name: string, uid: string): Promise<void> {
    const namespace = namespaceName(run.runShortId);
    await this.options.client.delete({ kind: "Secret", namespace, name, uid });
    await this.options.store?.markKubernetesResourceDeleted?.({ runId: run.runId, attempt: run.attempt, stepKey: "fetch", kind: "Secret", name, uid });
  }
}
