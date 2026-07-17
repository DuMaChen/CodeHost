import { describe, expect, it } from "vitest";
import { PgBossAgentReviewClient, REVIEW_QUEUE_NAME, REVIEW_RESULT_QUEUE_NAME, type ReviewResponse } from "./queue.js";

class FakeBoss {
  readonly handlers = new Map<string, (job: unknown) => Promise<void>>();
  readonly sent: Array<{ queue: string; data: unknown }> = [];

  async createQueue(_queue: string): Promise<void> {
    return undefined;
  }

  async work<T>(queue: string, handler: (job: { readonly data: T } | readonly { readonly data: T }[]) => Promise<void>): Promise<void> {
    this.handlers.set(queue, handler as unknown as (job: unknown) => Promise<void>);
    return undefined;
  }

  async send<T>(queue: string, data: T, _options: Readonly<{ readonly singletonKey: string; readonly retryLimit: number; readonly retryDelay: number }>): Promise<string | null> {
    this.sent.push({ queue, data });
    return "job-id";
  }
}

const logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
} as never;

describe("Agent Review queue client", () => {
  it("correlates a result by run, attempt, and input hash", async () => {
    const boss = new FakeBoss();
    const client = new PgBossAgentReviewClient(boss, logger);
    await client.start();
    const request = {
      runId: "run-1",
      attempt: 1,
      headSha: "a".repeat(40),
      inputHash: "b".repeat(64),
      reviewInput: "safe",
    } as const;
    const pending = client.request(request);
    await new Promise((resolve) => setImmediate(resolve));
    const response: ReviewResponse = {
      ...request,
      result: {
        verdict: "PASSED",
        report: { summary: "ok", riskLevel: "LOW", confidence: 1, findings: [] },
        reportJson: JSON.stringify({ summary: "ok", riskLevel: "LOW", confidence: 1, findings: [] }),
        reportBytes: 64,
        inputHash: request.inputHash,
        provider: "mock",
        model: "mock",
        truncatedInput: false,
      },
    };
    await boss.handlers.get(REVIEW_RESULT_QUEUE_NAME)?.({ data: response });
    await expect(pending).resolves.toEqual(response);
    expect(boss.sent[0]).toMatchObject({ queue: REVIEW_QUEUE_NAME, data: request });
    await client.stop();
  });
});
