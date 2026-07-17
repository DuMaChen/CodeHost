import { and, eq, inArray, lte, sql } from "drizzle-orm";
import { giteaSyncs, pullRequests, repositories, runs, type Database } from "@platform/db";
import type { Logger } from "../logger.js";
import { GiteaClient, type GiteaCommitStatus } from "./client.js";

const POLL_INTERVAL_MS = 2_000;
const LEASE_MS = 30_000;
const MAX_BATCH = 10;
const COMMENT_MARKER_PREFIX = "<!-- platform-run:";

interface SyncRow {
  readonly id: string;
  readonly runId: string;
  readonly attempt: number;
  readonly headSha: string;
  readonly context: string;
  readonly artifactType: string;
  readonly desiredState: string;
  readonly desiredDescription: string;
  readonly desiredTargetUrl: string | null;
  readonly desiredBody: string;
  readonly attempts: number;
  readonly leaseUntil: Date | null;
}

function repositoryParts(fullName: string): { readonly owner: string; readonly repository: string } {
  const separator = fullName.indexOf("/");
  if (separator <= 0 || separator === fullName.length - 1 || fullName.indexOf("/", separator + 1) !== -1) throw new Error("repository full name is invalid");
  return { owner: fullName.slice(0, separator), repository: fullName.slice(separator + 1) };
}

function sameTargetUrl(actual: string | undefined, desired: string | null): boolean {
  return (actual ?? "") === (desired ?? "");
}

function retryAt(attempts: number): Date {
  const delay = Math.min(5 * 60 * 1000, 5_000 * 2 ** Math.min(6, Math.max(0, attempts - 1)));
  return new Date(Date.now() + delay);
}

function statusState(value: string): "pending" | "success" | "failure" | "error" {
  if (value === "pending" || value === "success" || value === "failure" || value === "error") return value;
  throw new Error("Gitea status state is invalid");
}

export class GiteaSyncPublisher {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly db: Database,
    private readonly client: GiteaClient,
    private readonly logger: Logger,
  ) {}

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.poll();
    this.timer = setInterval(() => {
      void this.poll().catch((error) => this.logger.error("Gitea sync poll failed", {
        error: error instanceof Error ? error.message : String(error),
      }));
    }, POLL_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async poll(): Promise<void> {
    if (!this.running) return;
    const now = new Date();
    const rows = await this.db
      .select({ sync: giteaSyncs, repositoryFullName: repositories.fullName, pullRequestNumber: pullRequests.externalNumber })
      .from(giteaSyncs)
      .innerJoin(runs, eq(giteaSyncs.runId, runs.id))
      .innerJoin(repositories, eq(runs.repositoryId, repositories.id))
      .innerJoin(pullRequests, eq(runs.pullRequestId, pullRequests.id))
      .where(and(
        inArray(giteaSyncs.syncStatus, ["PENDING", "FAILED"]),
        lte(giteaSyncs.nextAttemptAt, now),
        sql`(${giteaSyncs.leaseUntil} is null or ${giteaSyncs.leaseUntil} < ${now})`,
      ))
      .limit(MAX_BATCH);

    // The joins above intentionally need the Run relation. Use a direct
    // lookup for repository/PR metadata in the adapter until the schema adds
    // explicit relation helpers; the row identity remains the sync primary key.
    for (const row of rows) {
      await this.publish(row.sync, row.repositoryFullName, row.pullRequestNumber);
    }
  }

  private async publish(sync: SyncRow, repositoryFullName: string, pullRequestNumber: number): Promise<void> {
    const leaseUntil = new Date(Date.now() + LEASE_MS);
    const claimed = await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${sync.id}, 0))`);
      const rows = await tx.select().from(giteaSyncs).where(eq(giteaSyncs.id, sync.id)).limit(1);
      const row = rows[0];
      if (!row || !["PENDING", "FAILED"].includes(row.syncStatus) || row.nextAttemptAt.getTime() > Date.now() || (row.leaseUntil !== null && row.leaseUntil.getTime() >= Date.now())) return null;
      await tx.update(giteaSyncs).set({ leaseUntil, attempts: row.attempts + 1 }).where(eq(giteaSyncs.id, sync.id));
      return { ...row, leaseUntil };
    });
    if (!claimed) return;

    try {
      const { owner, repository } = repositoryParts(repositoryFullName);
      if (claimed.artifactType === "comment") {
        const comments = await this.client.listIssueComments(owner, repository, pullRequestNumber);
        const marker = claimed.desiredBody.split("\n", 1)[0] ?? "";
        const existing = marker.startsWith(COMMENT_MARKER_PREFIX)
          ? comments.find((comment) => comment.body.split("\n", 1)[0] === marker)
          : undefined;
        const result = existing === undefined
          ? await this.client.createIssueComment({ owner, repository, issueNumber: pullRequestNumber, body: claimed.desiredBody })
          : existing.body === claimed.desiredBody
            ? existing
            : await this.client.updateIssueComment({ commentId: existing.id, body: claimed.desiredBody });
        await this.markSynced(claimed.id, leaseUntil, { commentId: result.id });
        return;
      }

      const statuses = await this.client.listCommitStatuses(owner, repository, claimed.headSha);
      const existing = findMatchingStatus(statuses, claimed);
      const result = existing ?? await this.client.createCommitStatus({
        owner,
        repository,
        sha: claimed.headSha,
        context: claimed.context,
        state: statusState(claimed.desiredState),
        description: claimed.desiredDescription,
        ...(claimed.desiredTargetUrl === null ? {} : { targetUrl: claimed.desiredTargetUrl }),
      });
      await this.markSynced(claimed.id, leaseUntil, { externalStatusId: result.id });
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 512) : String(error).slice(0, 512);
      await this.db.update(giteaSyncs).set({ syncStatus: "FAILED", lastSyncError: message, nextAttemptAt: retryAt(claimed.attempts), leaseUntil: null }).where(and(eq(giteaSyncs.id, claimed.id), eq(giteaSyncs.leaseUntil, leaseUntil)));
      this.logger.warn("Gitea sync failed", { syncId: claimed.id, error: message });
    }
  }

  private async markSynced(id: string, leaseUntil: Date, input: { readonly externalStatusId?: number; readonly commentId?: number }): Promise<void> {
    await this.db.update(giteaSyncs).set({
      syncStatus: "SYNCED",
      syncedAt: new Date(),
      lastSyncError: null,
      leaseUntil: null,
      ...(input.externalStatusId === undefined ? {} : { externalStatusId: input.externalStatusId }),
      ...(input.commentId === undefined ? {} : { commentId: input.commentId }),
    }).where(and(eq(giteaSyncs.id, id), eq(giteaSyncs.leaseUntil, leaseUntil)));
  }
}

function findMatchingStatus(statuses: readonly GiteaCommitStatus[], sync: SyncRow): GiteaCommitStatus | undefined {
  return statuses.find((status) =>
    status.context === sync.context &&
    status.state === sync.desiredState &&
    status.description === sync.desiredDescription &&
    sameTargetUrl(status.targetUrl, sync.desiredTargetUrl),
  );
}

export const giteaCommentMarkerPrefix = COMMENT_MARKER_PREFIX;
export { findMatchingStatus };
