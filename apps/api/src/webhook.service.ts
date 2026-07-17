import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  isWebhookEventFresh,
  GiteaPullRequestWebhookPayloadSchema,
  normalizeGiteaPullRequestWebhook,
  type GiteaPullRequestWebhookPayload,
} from '@platform/contracts';
import { PLATFORM_CONFIG } from './tokens.js';
import type { AppConfig } from '@platform/config';
import {
  auditEvents,
  pullRequests,
  repositories,
  runs,
  webhookEvents,
  workflowOutbox,
} from '@platform/db';
import { DatabaseHandle, PLATFORM_DB } from './database.provider.js';

const ACTIVE_RUN_STATUSES = [
  'PLANNING',
  'EXECUTING',
  'ANALYZING',
  'REPORTING',
  'CANCEL_REQUESTED',
] as const;

const WORKFLOW_QUEUE = 'platform.workflow';
const WORKFLOW_VERSION = '0.1.0';

const REPLAY_AUDIT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type WebhookResult =
  | { readonly kind: 'created'; readonly runId: string; readonly status: string }
  | { readonly kind: 'duplicate'; readonly runId?: string }
  | { readonly kind: 'replay-rejected' }
  | { readonly kind: 'ignored'; readonly reason: 'unsupported-event' };

function repositoryParts(fullName: string): { owner: string; name: string } {
  const separator = fullName.indexOf('/');
  if (separator <= 0 || separator === fullName.length - 1) {
    throw new Error('repository.full_name must be owner/name');
  }
  return { owner: fullName.slice(0, separator), name: fullName.slice(separator + 1) };
}

function textField(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value : fallback;
}

@Injectable()
export class WebhookService {
  constructor(
    @Inject(PLATFORM_DB) private readonly database: DatabaseHandle,
    @Inject(PLATFORM_CONFIG) private readonly config: AppConfig,
  ) {}

  async accept(
    rawBody: Buffer,
    payload: unknown,
    deliveryId: string | undefined,
  ): Promise<WebhookResult> {
    if (!deliveryId || deliveryId.length > 255) {
      throw new Error('x-gitea-delivery is required');
    }

    const parsedPayload = payload as { action?: unknown };
    const action = parsedPayload.action === 'synchronized' ? 'synchronize' : parsedPayload.action;
    if (
      action !== 'opened' &&
      action !== 'reopened' &&
      action !== 'synchronize'
    ) {
      return { kind: 'ignored', reason: 'unsupported-event' };
    }

    const payloadHash = createHash('sha256').update(rawBody).digest('hex');
    const validatedPayload = GiteaPullRequestWebhookPayloadSchema.safeParse(payload);
    if (validatedPayload.success) {
      const createdAt = validatedPayload.data.created_at
        ?? validatedPayload.data.pull_request.updated_at
        ?? validatedPayload.data.pull_request.created_at;
      if (!isWebhookEventFresh({ createdAt }, new Date(), this.config.webhookMaxAgeMinutes * 60 * 1000)) {
        await this.database.db.insert(auditEvents).values({
          action: 'WEBHOOK_REPLAY_REJECTED',
          entityType: 'webhook_event',
          entityId: deliveryId,
          metadataJson: {
            providerDeliveryId: deliveryId,
            payloadHash,
            reason: 'stale-or-future-event',
            createdAt: createdAt.toISOString(),
          },
          expiresAt: new Date(Date.now() + REPLAY_AUDIT_TTL_MS),
        });
        throw new ConflictException('webhook event is stale or from the future');
      }
    }

    const normalized = normalizeGiteaPullRequestWebhook(payload, deliveryId, {
      maxAgeMs: this.config.webhookMaxAgeMinutes * 60 * 1000,
    });
    if (!isWebhookEventFresh(normalized, new Date(), this.config.webhookMaxAgeMinutes * 60 * 1000)) {
      throw new Error('webhook event is stale or from the future');
    }

    const providerPayload = payload as GiteaPullRequestWebhookPayload & {
      repository: GiteaPullRequestWebhookPayload['repository'] & {
        default_branch?: unknown;
      };
      pull_request: GiteaPullRequestWebhookPayload['pull_request'] & {
        base?: { sha?: unknown };
        head?: { ref?: unknown };
        user?: { login?: unknown };
        title?: unknown;
      };
    };
    const { owner, name } = repositoryParts(providerPayload.repository.full_name);
    const allowedRepositories = new Set(this.config.giteaAllowedRepositories);
    if (
      allowedRepositories.size > 0 &&
      !allowedRepositories.has(providerPayload.repository.full_name)
    ) {
      throw new ForbiddenException('repository is not in the platform allowlist');
    }
    const pullRequest = providerPayload.pull_request;
    const repositoryId = normalized.repositoryId;
    const pullRequestId = normalized.pullRequestId;
    const baseSha = textField(pullRequest.base?.sha, normalized.headSha);
    const sourceBranch = textField(pullRequest.head?.ref, `pr/${normalized.externalNumber}`);
    const author = textField(pullRequest.user?.login, 'unknown');
    const title = textField(pullRequest.title, `PR #${normalized.externalNumber}`);
    return this.database.db.transaction(async (tx) => {
      const insertedEvent = await tx
        .insert(webhookEvents)
        .values({
          providerDeliveryId: deliveryId,
          eventType: normalized.eventType,
          externalNumber: normalized.externalNumber,
          headSha: normalized.headSha,
          payloadHash,
          status: 'RECEIVED',
        })
        .onConflictDoNothing({ target: webhookEvents.providerDeliveryId })
        .returning({ id: webhookEvents.id });

      if (insertedEvent.length === 0) {
        const existing = await tx
          .select({
            payloadHash: webhookEvents.payloadHash,
            externalNumber: webhookEvents.externalNumber,
            headSha: webhookEvents.headSha,
          })
          .from(webhookEvents)
          .where(eq(webhookEvents.providerDeliveryId, deliveryId))
          .limit(1);
        const record = existing[0];
        if (
          record &&
          (record.payloadHash !== payloadHash ||
            record.externalNumber !== normalized.externalNumber ||
            record.headSha !== normalized.headSha)
        ) {
          await tx.insert(auditEvents).values({
            action: 'WEBHOOK_REPLAY_REJECTED',
            entityType: 'webhook_event',
            entityId: deliveryId,
            metadataJson: {
              providerDeliveryId: deliveryId,
              originalPayloadHash: record.payloadHash,
              attemptedPayloadHash: payloadHash,
              originalExternalNumber: record.externalNumber,
              attemptedExternalNumber: normalized.externalNumber,
              originalHeadSha: record.headSha,
              attemptedHeadSha: normalized.headSha,
            },
            expiresAt: new Date(Date.now() + REPLAY_AUDIT_TTL_MS),
          });
          return { kind: 'replay-rejected' };
        }
        return { kind: 'duplicate' };
      }
      const event = insertedEvent[0];
      if (!event) throw new Error('webhook event insert returned no row');

      const repository = await tx
        .insert(repositories)
        .values({
          providerRepoId: repositoryId,
          owner,
          name,
          fullName: providerPayload.repository.full_name,
          defaultBranch: textField(providerPayload.repository.default_branch, 'main'),
          enabled: true,
        })
        .onConflictDoUpdate({
          target: repositories.providerRepoId,
          set: {
            owner,
            name,
            fullName: providerPayload.repository.full_name,
            defaultBranch: textField(providerPayload.repository.default_branch, 'main'),
            enabled: true,
          },
        })
        .returning({ id: repositories.id });
      const repositoryRecord = repository[0];
      if (!repositoryRecord) throw new Error('repository upsert returned no row');

      await tx
        .update(webhookEvents)
        .set({ repositoryId: repositoryRecord.id })
        .where(eq(webhookEvents.id, event.id));

      const currentPullRequest = await tx
        .insert(pullRequests)
        .values({
          repositoryId: repositoryRecord.id,
          externalNumber: normalized.externalNumber,
          headSha: normalized.headSha,
          baseSha,
          sourceBranch,
          title,
          author,
          state: 'OPEN',
        })
        .onConflictDoUpdate({
          target: [pullRequests.repositoryId, pullRequests.externalNumber],
          set: { headSha: normalized.headSha, baseSha, sourceBranch, title, author, state: 'OPEN', updatedAt: new Date() },
        })
        .returning({ id: pullRequests.id });
      const pullRequestRecord = currentPullRequest[0];
      if (!pullRequestRecord) throw new Error('pull request upsert returned no row');

      const existingRun = await tx
        .select({ id: runs.id })
        .from(runs)
        .where(
          and(
            eq(runs.repositoryId, repositoryRecord.id),
            eq(runs.pullRequestId, pullRequestRecord.id),
            eq(runs.headSha, normalized.headSha),
          ),
        )
        .limit(1);
      if (existingRun[0]) {
        await tx
          .update(webhookEvents)
          .set({ status: 'PROCESSED', processedAt: new Date() })
          .where(eq(webhookEvents.id, event.id));
        return { kind: 'duplicate', runId: existingRun[0].id };
      }

      // Serialize capacity admission across concurrent Webhook requests. The
      // database partial index still protects per-PR active runs; this lock
      // makes the course-wide MAX_ACTIVE_RUNS=1 decision deterministic.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended('platform:run-capacity', 0))`,
      );

      const activeCount = await tx
        .select({ count: sql<number>`count(*)` })
        .from(runs)
        .where(inArray(runs.status, [...ACTIVE_RUN_STATUSES]));
      const queuedCount = await tx
        .select({ count: sql<number>`count(*)` })
        .from(runs)
        .where(eq(runs.status, 'QUEUED'));
      const active = Number(activeCount[0]?.count ?? 0);
      const queued = Number(queuedCount[0]?.count ?? 0);
      const status = active >= 1 || queued >= 3 ? 'REJECTED_BY_CAPACITY' : 'QUEUED';
      const runId = randomUUID();
      const runRows = await tx
        .insert(runs)
        .values({
          id: runId,
          repositoryId: repositoryRecord.id,
          pullRequestId: pullRequestRecord.id,
          headSha: normalized.headSha,
          trigger: 'gitea-webhook',
          status,
          namespace: `pr-run-${runId.replaceAll('-', '').slice(0, 12)}`,
          executionPlanJson: {
            workflowVersion: WORKFLOW_VERSION,
            projectType: 'pending-detect',
            steps: ['detect', 'fetch', 'analyze', 'test', 'build', 'preview', 'health', 'assemble-review-input', 'agent-review', 'report', 'cleanup'],
          },
          workflowVersion: WORKFLOW_VERSION,
          currentAttempt: 1,
        })
        .returning({ id: runs.id, status: runs.status });
      const run = runRows[0];
      if (!run) throw new Error('run insert returned no row');

      if (status === 'QUEUED') {
        await tx.insert(workflowOutbox).values({
          runId: run.id,
          attempt: 1,
          stepKey: 'detect',
          queueName: WORKFLOW_QUEUE,
          payloadJson: { runId: run.id, attempt: 1, headSha: normalized.headSha, stepKey: 'detect' },
          dedupeKey: `${run.id}:detect:1`,
        });
      }

      await tx
        .update(webhookEvents)
        .set({ status: 'PROCESSED', processedAt: new Date() })
        .where(eq(webhookEvents.id, event.id));
      return { kind: 'created', runId: run.id, status: run.status };
    });
  }
}
