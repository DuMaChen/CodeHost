import type { AgentReviewResult } from "@platform/agent";
import type { Logger } from "../logger.js";

export const REVIEW_QUEUE_NAME = "platform.agent-review";
export const REVIEW_RESULT_QUEUE_NAME = "platform.agent-review-result";
const REVIEW_TIMEOUT_MS = 60_000;

export interface ReviewRequest {
  readonly runId: string;
  readonly attempt: number;
  readonly headSha: string;
  readonly inputHash: string;
  readonly reviewInput: string;
}

export interface ReviewResponse {
  readonly runId: string;
  readonly attempt: number;
  readonly headSha: string;
  readonly inputHash: string;
  readonly result: AgentReviewResult;
}

export interface AgentReviewQueueClient {
  request(input: ReviewRequest): Promise<ReviewResponse>;
}

interface PgBossJob<T> {
  readonly data: T;
}

export interface PgBossReviewClient {
  createQueue(queueName: string): Promise<void>;
  work<T>(
    queueName: string,
    handler: (job: PgBossJob<T> | readonly PgBossJob<T>[]) => Promise<void>,
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

interface PendingReview {
  readonly promise: Promise<ReviewResponse>;
  readonly resolve: (response: ReviewResponse) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

function reviewKey(input: Pick<ReviewRequest, "runId" | "attempt" | "inputHash">): string {
  return `${input.runId}:${input.attempt}:${input.inputHash}`;
}

export class PgBossAgentReviewClient implements AgentReviewQueueClient {
  private readonly pending = new Map<string, PendingReview>();
  private started = false;

  constructor(
    private readonly boss: PgBossReviewClient,
    private readonly logger: Logger,
  ) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.boss.createQueue(REVIEW_QUEUE_NAME);
    await this.boss.createQueue(REVIEW_RESULT_QUEUE_NAME);
    await this.boss.work<ReviewResponse>(REVIEW_RESULT_QUEUE_NAME, async (job) => {
      const jobs = Array.isArray(job) ? job : [job];
      for (const item of jobs) {
        if (!this.resolveResult(item.data)) {
          throw new Error("agent review result has no waiting consumer");
        }
      }
    });
  }

  async request(input: ReviewRequest): Promise<ReviewResponse> {
    const key = reviewKey(input);
    const existing = this.pending.get(key);
    if (existing !== undefined) return existing.promise;

    let resolve!: (response: ReviewResponse) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<ReviewResponse>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const timer = setTimeout(() => {
      this.pending.delete(key);
      reject(new Error("agent review result timed out"));
    }, REVIEW_TIMEOUT_MS);
    timer.unref?.();
    this.pending.set(key, { promise, resolve, reject, timer });

    try {
      const jobId = await this.boss.send(REVIEW_QUEUE_NAME, input, {
        singletonKey: key,
        retryLimit: 1,
        retryDelay: 5,
      });
      if (jobId === null) throw new Error("pg-boss rejected agent review request");
      this.logger.debug("agent review queued", { runId: input.runId, attempt: input.attempt, inputHash: input.inputHash });
      return await promise;
    } catch (error) {
      this.pending.delete(key);
      clearTimeout(timer);
      const failure = error instanceof Error ? error : new Error(String(error));
      reject(failure);
      throw failure;
    }
  }

  async stop(): Promise<void> {
    for (const [key, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error("agent review queue is stopping"));
      this.pending.delete(key);
    }
    this.started = false;
  }

  private resolveResult(response: ReviewResponse): boolean {
    const key = reviewKey(response);
    const pending = this.pending.get(key);
    if (pending === undefined) {
      this.logger.warn("deferring late agent review result until a workflow step is waiting", { runId: response.runId, attempt: response.attempt, inputHash: response.inputHash });
      return false;
    }
    this.pending.delete(key);
    clearTimeout(pending.timer);
    pending.resolve(response);
    return true;
  }
}
