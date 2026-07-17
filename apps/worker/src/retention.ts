import { and, eq, inArray, isNotNull, isNull, lte, or } from "drizzle-orm";
import { rm } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  auditEvents,
  createWorkflowOutboxDedupeKey,
  findings,
  reports,
  runSteps,
  runs,
  sessions,
  workflowOutbox,
  type Database,
} from "@platform/db";
import { KubernetesApiClient, KubernetesApiError } from "./kubernetes/client.js";
import type { Logger } from "./logger.js";
import { parseRegistryManifestReference, type RegistryClient } from "./registry.js";

const TERMINAL_RUN_STATUSES = ["PASSED", "FAILED", "INCOMPLETE", "CANCELLED"] as const;
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const CLEANUP_QUEUE = "platform.workflow";

export interface RetentionResult {
  readonly expiredFindings: number;
  readonly expiredReports: number;
  readonly expiredAuditEvents: number;
  readonly expiredSessions: number;
  readonly cleanupJobsQueued: number;
  readonly orphanNamespacesDeleted: number;
  readonly expiredImages: number;
  readonly expiredLogs: number;
}

export function namespaceMayBeCollected(input: {
  readonly runExists: boolean;
  readonly runStatus?: string;
  readonly cleanupStatus?: string;
  readonly due: boolean;
}): boolean {
  // Known Runs are cleaned by the workflow step. Retention only handles
  // namespaces whose Run record no longer exists.
  return input.due && !input.runExists;
}

function runIdFromLabels(resource: Record<string, unknown>): string | undefined {
  const metadata = resource.metadata;
  if (typeof metadata !== "object" || metadata === null) return undefined;
  const labels = (metadata as Record<string, unknown>).labels;
  if (typeof labels !== "object" || labels === null) return undefined;
  const label = (labels as Record<string, unknown>)["platform.io/run-id"];
  return typeof label === "string" ? label : undefined;
}

function metadata(resource: Record<string, unknown>): Record<string, unknown> | undefined {
  return typeof resource.metadata === "object" && resource.metadata !== null
    ? resource.metadata as Record<string, unknown>
    : undefined;
}

export class RetentionWorker {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly db: Database,
    private readonly logger: Logger,
    private readonly client?: KubernetesApiClient,
    private readonly registry?: RegistryClient,
    private readonly logRoot = "/var/log/platform",
    private readonly intervalMs = DEFAULT_INTERVAL_MS,
  ) {}

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.runOnce();
    this.timer = setInterval(() => {
      void this.runOnce().catch((error) => this.logger.error("retention sweep failed", { error: error instanceof Error ? error.message : String(error) }));
    }, this.intervalMs);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  async runOnce(now = new Date()): Promise<RetentionResult> {
    const expiredFindings = await this.deleteExpired(findings, findings.expiresAt, now);
    const expiredReports = await this.deleteExpired(reports, reports.expiresAt, now);
    const expiredAuditEvents = await this.deleteExpired(auditEvents, auditEvents.expiresAt, now);
    const expiredSessions = await this.db.delete(sessions).where(or(
      lte(sessions.expiresAt, now),
      and(isNull(sessions.revokedAt), lte(sessions.expiresAt, now)),
    )).returning({ id: sessions.id });
    const cleanupJobsQueued = await this.queueExpiredCleanup(now);
    const orphanNamespacesDeleted = await this.collectNamespaces(now);
    const expiredImages = await this.deleteExpiredImages(now);
    const expiredLogs = await this.deleteExpiredLogs(now);
    const result = {
      expiredFindings,
      expiredReports,
      expiredAuditEvents,
      expiredSessions: expiredSessions.length,
      cleanupJobsQueued,
      orphanNamespacesDeleted,
      expiredImages,
      expiredLogs,
    };
    this.logger.info("retention sweep completed", result);
    return result;
  }

  private async deleteExpired<TTable extends typeof findings | typeof reports | typeof auditEvents>(table: TTable, expiresAt: TTable["expiresAt"], now: Date): Promise<number> {
    const deleted = await this.db.delete(table).where(lte(expiresAt, now)).returning({ id: table.id });
    return deleted.length;
  }

  private async queueExpiredCleanup(now: Date): Promise<number> {
    const MAX_CLEANUP_RETRIES = 3;
    const candidates = await this.db.select({
      id: runs.id,
      attempt: runs.currentAttempt,
      headSha: runs.headSha,
      status: runs.status,
      cleanupStatus: runs.cleanupStatus,
      cleanupAt: runs.cleanupAt,
      previewExpiresAt: runs.previewExpiresAt,
      finishedAt: runs.finishedAt,
    }).from(runs).where(and(
      inArray(runs.status, [...TERMINAL_RUN_STATUSES]),
      inArray(runs.cleanupStatus, ["NOT_SCHEDULED", "FAILED"]),
      or(
        lte(runs.previewExpiresAt, now),
        lte(runs.finishedAt, now),
      ),
    )).limit(100);
    let queued = 0;
    for (const run of candidates) {
      const dedupeKey = createWorkflowOutboxDedupeKey(run.id, "cleanup", run.attempt);
      const existing = await this.db.select({ attempts: workflowOutbox.attempts })
        .from(workflowOutbox)
        .where(eq(workflowOutbox.dedupeKey, dedupeKey))
        .limit(1);
      const previousAttempts = existing[0]?.attempts ?? 0;
      if (previousAttempts >= MAX_CLEANUP_RETRIES) {
        this.logger.warn("cleanup max retries exceeded, skipping", {
          runId: run.id,
          attempts: previousAttempts,
        });
        await this.db.update(runs).set({
          cleanupError: `max retries exceeded (${previousAttempts} attempts)`,
          updatedAt: now,
        }).where(eq(runs.id, run.id));
        continue;
      }
      const inserted = await this.db.insert(workflowOutbox).values({
        runId: run.id,
        attempt: run.attempt,
        stepKey: "cleanup",
        queueName: CLEANUP_QUEUE,
        payloadJson: { runId: run.id, attempt: run.attempt, headSha: run.headSha, stepKey: "cleanup" },
        dedupeKey,
      }).onConflictDoUpdate({
        target: workflowOutbox.dedupeKey,
        set: { status: "PENDING", availableAt: new Date(), publishedAt: null, leaseUntil: null, lastError: null },
        where: inArray(workflowOutbox.status, ["FAILED", "PUBLISHED"]),
      }).returning({ id: workflowOutbox.id });
      queued += inserted.length;
    }
    return queued;
  }

  private async deleteExpiredImages(now: Date): Promise<number> {
    if (!this.registry) return 0;
    const candidates = await this.db.select({
      id: runs.id,
      registryRef: runs.registryRef,
    }).from(runs).where(and(
      inArray(runs.status, [...TERMINAL_RUN_STATUSES]),
      lte(runs.registryExpiresAt, now),
    )).limit(100);
    let deleted = 0;
    for (const run of candidates) {
      if (run.registryRef === null) continue;
      try {
        const reference = parseRegistryManifestReference(run.registryRef, run.id);
        await this.registry.deleteManifest(reference);
        await this.db.update(runs).set({ registryRef: null, registryExpiresAt: null, updatedAt: now }).where(and(eq(runs.id, run.id), eq(runs.registryRef, run.registryRef)));
        deleted += 1;
      } catch (error) {
        this.logger.warn("registry retention failed", { runId: run.id, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return deleted;
  }

  private async deleteExpiredLogs(now: Date): Promise<number> {
    const rows = await this.db.select({ id: runSteps.id, logPath: runSteps.logPath }).from(runSteps).where(and(lte(runSteps.expiresAt, now), isNotNull(runSteps.logPath))).limit(500);
    const root = resolve(this.logRoot);
    let deleted = 0;
    for (const row of rows) {
      if (row.logPath === null) continue;
      const target = resolve(row.logPath);
      const relativePath = relative(root, target);
      if (isAbsolute(relativePath) || relativePath === ".." || relativePath.startsWith(`..${sep}`)) {
        this.logger.warn("retention refused an out-of-root log path", { logPath: row.logPath });
        continue;
      }
      await rm(target, { force: true });
      await this.db.update(runSteps).set({ logPath: null, expiresAt: null }).where(eq(runSteps.id, row.id));
      deleted += 1;
    }
    return deleted;
  }

  private async collectNamespaces(now: Date): Promise<number> {
    if (!this.client) return 0;
    const response = await this.client.listRaw({ kind: "Namespace", labelSelector: "platform.io/managed=true" });
    let deleted = 0;
    for (const resource of response.items) {
      const runId = runIdFromLabels(resource);
      const name = metadata(resource)?.name;
      const uid = metadata(resource)?.uid;
      if (!runId || typeof name !== "string" || typeof uid !== "string") continue;
      const rows = await this.db.select({ attempt: runs.currentAttempt, status: runs.status, cleanupStatus: runs.cleanupStatus, previewExpiresAt: runs.previewExpiresAt, finishedAt: runs.finishedAt }).from(runs).where(eq(runs.id, runId)).limit(1);
      const run = rows[0];
      const due = run === undefined || (run.previewExpiresAt !== null && run.previewExpiresAt <= now) || (run.finishedAt !== null && run.finishedAt <= now);
      if (!namespaceMayBeCollected({ runExists: run !== undefined, due })) continue;
      const labels = metadata(resource)?.labels;
      if (typeof labels !== "object" || labels === null || (labels as Record<string, unknown>)["platform.io/managed"] !== "true") continue;
      try {
        await this.client.delete({ kind: "Namespace", name, uid });
      } catch (error) {
        if (error instanceof KubernetesApiError && (error.status === 400 || error.status === 404)) {
          this.logger.warn("orphan namespace deletion is pending", { namespace: name, status: error.status });
          continue;
        }
        throw error;
      }
      try {
        if (await this.client.getRaw({ kind: "Namespace", name }) !== null) continue;
      } catch (error) {
        if (error instanceof KubernetesApiError && (error.status === 400 || error.status === 404)) {
          this.logger.warn("orphan namespace deletion confirmation is pending", { namespace: name, status: error.status });
          continue;
        }
        throw error;
      }
      deleted += 1;
    }
    return deleted;
  }
}
