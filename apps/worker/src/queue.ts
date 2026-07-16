import PgBoss from 'pg-boss';
import { CAPACITY_LIMITS } from './config.js';
import type { Logger } from './logger.js';
import type {
  WorkflowJobData,
} from './workflow/types.js';
import type {
  WorkflowConsumer,
} from './workflow/consumer.js';
import type { WorkflowDispatcher } from './workflow/consumer.js';

interface PgBossJob<T> {
  readonly data: T;
}

export interface PgBossClient {
  start(): Promise<void>;
  stop(): Promise<void>;
  createQueue(queueName: string): Promise<void>;
  work<T>(
    queueName: string,
    handler: (
      job: PgBossJob<T> | readonly PgBossJob<T>[],
    ) => Promise<void>,
  ): Promise<unknown>;
  send<T>(
    queueName: string,
    data: T,
    options: Readonly<{
      readonly singletonKey: string;
      readonly retryLimit: number;
      readonly retryDelay: number;
    }>,
  ): Promise<string | null>;
}

export function createPgBoss(connectionString: string): PgBossClient {
  // Keep pg-boss API surface isolated so the rest of the worker is testable.
  return new PgBoss({ connectionString }) as unknown as PgBossClient;
}

export class PgBossWorkflowQueue implements WorkflowDispatcher {
  private consumer: WorkflowConsumer | undefined;

  constructor(
    private readonly boss: PgBossClient,
    private readonly queueName: string,
    private readonly logger: Logger,
  ) {}

  setConsumer(consumer: WorkflowConsumer): void {
    this.consumer = consumer;
  }

  async start(): Promise<void> {
    if (this.consumer === undefined) {
      throw new Error('workflow queue consumer has not been configured');
    }

    await this.boss.start();
    await this.boss.createQueue(this.queueName);
    await this.boss.work<WorkflowJobData>(this.queueName, async (job) => {
      const jobs = Array.isArray(job) ? job : [job];
      for (const item of jobs) {
        await this.consumer?.handle(item.data);
      }
    });
    this.logger.info('workflow queue consumer started', {
      queue: this.queueName,
    });
  }

  async dispatch(job: WorkflowJobData): Promise<void> {
    const id = await this.boss.send(this.queueName, job, {
      singletonKey: `${job.runId}:${job.attempt}:${job.stepKey}`,
      retryLimit: CAPACITY_LIMITS.maxDeliveryRetries,
      retryDelay: 5,
    });
    if (id === null) throw new Error(`pg-boss rejected workflow job for queue ${this.queueName}`);
    this.logger.debug('workflow job dispatched', {
      queue: this.queueName,
      jobId: id,
      runId: job.runId,
      attempt: job.attempt,
      stepKey: job.stepKey,
    });
  }

  async stop(): Promise<void> {
    await this.boss.stop();
  }
}
