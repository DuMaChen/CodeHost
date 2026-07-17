import { and, eq, inArray, lte, sql } from 'drizzle-orm';
import { workflowOutbox, type Database } from '@platform/db';
import type { Logger } from '../logger.js';
import type { WorkflowDispatcher } from './consumer.js';
import { parseWorkflowJob } from './types.js';

const POLL_INTERVAL_MS = 1000;
const LEASE_MS = 30_000;
const MAX_BATCH = 10;

export class OutboxPublisher {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly db: Database,
    private readonly dispatcher: WorkflowDispatcher,
    private readonly logger: Logger,
  ) {}

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.poll();
    this.timer = setInterval(() => {
      void this.poll().catch((error) => this.logger.error('workflow outbox poll failed', {
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
      .select()
      .from(workflowOutbox)
      .where(
        and(
          inArray(workflowOutbox.status, ['PENDING', 'FAILED']),
          lte(workflowOutbox.availableAt, now),
          sql`(${workflowOutbox.leaseUntil} is null or ${workflowOutbox.leaseUntil} < ${now})`,
        ),
      )
      .limit(MAX_BATCH);

    for (const row of rows) {
      await this.publish(row.id);
    }
  }

  private async publish(outboxId: string): Promise<void> {
    const leaseUntil = new Date(Date.now() + LEASE_MS);
    const claimed = await this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${outboxId}, 0))`,
      );
      const rows = await tx
        .select()
        .from(workflowOutbox)
        .where(eq(workflowOutbox.id, outboxId))
        .limit(1);
      const row = rows[0];
      if (
        !row ||
        row.status === 'PUBLISHED' ||
        row.availableAt.getTime() > Date.now() ||
        (row.leaseUntil !== null && row.leaseUntil.getTime() >= Date.now())
      ) {
        return null;
      }
      await tx
        .update(workflowOutbox)
        .set({
          attempts: row.attempts + 1,
          leaseUntil,
          lastError: null,
        })
        .where(eq(workflowOutbox.id, outboxId));
      return { row, leaseUntil };
    });

    if (!claimed) return;
    const job = parseWorkflowJob(claimed.row.payloadJson);
    if (!job) {
      await this.fail(outboxId, 'INVALID_WORKFLOW_PAYLOAD', claimed.leaseUntil);
      return;
    }

    try {
      await this.dispatcher.dispatch(job);
      await this.db
        .update(workflowOutbox)
        .set({ status: 'PUBLISHED', publishedAt: new Date(), leaseUntil: null })
        .where(and(eq(workflowOutbox.id, outboxId), eq(workflowOutbox.leaseUntil, claimed.leaseUntil)));
    } catch (error) {
      await this.fail(
        outboxId,
        error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000),
        claimed.leaseUntil,
      );
    }
  }

  private async fail(outboxId: string, message: string, leaseUntil: Date): Promise<void> {
    const nextAttempt = new Date(Date.now() + 5000);
    await this.db
      .update(workflowOutbox)
      .set({
        status: 'FAILED',
        lastError: message,
        availableAt: nextAttempt,
        leaseUntil: null,
      })
      .where(and(eq(workflowOutbox.id, outboxId), eq(workflowOutbox.leaseUntil, leaseUntil)));
    this.logger.warn('workflow outbox publish failed', {
      outboxId,
      error: message,
    });
  }
}
