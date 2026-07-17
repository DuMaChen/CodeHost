import { parseReviewRequest, type ReviewRequest, type ReviewResponse } from "./protocol.js";
import { AgentReviewService } from "./service.js";
import PgBoss from "pg-boss";

export const REVIEW_QUEUE_NAME = "platform.agent-review";
export const REVIEW_RESULT_QUEUE_NAME = "platform.agent-review-result";

export type ReviewJobHandler = (payload: unknown) => Promise<ReviewResponse>;

interface PgBossJob<T> {
  readonly data: T;
}

interface PgBossQueueClient {
  createQueue(queueName: string): Promise<void>;
  work<T>(
    queueName: string,
    handler: (job: PgBossJob<T> | readonly PgBossJob<T>[]) => Promise<void>,
  ): Promise<unknown>;
  send<T>(
    queueName: string,
    data: T,
    options: Readonly<Record<string, unknown>>,
  ): Promise<string | null>;
}

interface PgBossClient extends PgBossQueueClient {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createPgBoss(connectionString: string): PgBossClient {
  return new PgBoss({ connectionString }) as unknown as PgBossClient;
}

export function createReviewJobHandler(service: AgentReviewService): ReviewJobHandler {
  return async (payload: unknown): Promise<ReviewResponse> => {
    const request: ReviewRequest = parseReviewRequest(payload);
    return service.review(request);
  };
}

export async function startReviewQueue(
  boss: PgBossQueueClient,
  service: AgentReviewService,
): Promise<void> {
  await boss.createQueue(REVIEW_QUEUE_NAME);
  await boss.createQueue(REVIEW_RESULT_QUEUE_NAME);
  await boss.work<ReviewRequest>(REVIEW_QUEUE_NAME, async (job) => {
    const jobs = Array.isArray(job) ? job : [job];
    for (const item of jobs) {
      const request = parseReviewRequest(item.data);
      const result = await service.review(request);
      const jobId = await boss.send(REVIEW_RESULT_QUEUE_NAME, result, {
        singletonKey: `${result.runId}:${result.attempt}:${result.inputHash}`,
        retryLimit: 2,
        retryDelay: 5,
      });
      if (jobId === null) throw new Error("pg-boss rejected agent review result");
    }
  });
}
