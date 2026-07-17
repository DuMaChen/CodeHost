import { describe, expect, it } from "vitest";
import { MockProvider } from "@platform/agent";
import { AgentReviewService } from "./service.js";
import { REVIEW_QUEUE_NAME, REVIEW_RESULT_QUEUE_NAME, startReviewQueue } from "./queue.js";

describe("Agent Review queue worker", () => {
  it("validates a request and publishes a result envelope", async () => {
    let handler: ((job: unknown) => Promise<void>) | undefined;
    const sent: Array<{ queue: string; data: unknown }> = [];
    const boss = {
      async createQueue(_queue: string) {
        return undefined;
      },
      async work<T>(_queue: string, callback: (job: { readonly data: T } | readonly { readonly data: T }[]) => Promise<void>) {
        handler = callback as unknown as (job: unknown) => Promise<void>;
      },
      async send<T>(queue: string, data: T, _options: Readonly<Record<string, unknown>>) {
        sent.push({ queue, data });
        return "result-id";
      },
    };
    await startReviewQueue(boss, new AgentReviewService(new MockProvider()));
    expect(handler).toBeDefined();
    const reviewInput = "safe input";
    const { sha256 } = await import("@platform/agent");
    await handler!({ data: {
      runId: "run-1",
      attempt: 1,
      headSha: "a".repeat(40),
      inputHash: sha256(reviewInput),
      reviewInput,
    } });
    expect(sent[0]?.queue).toBe(REVIEW_RESULT_QUEUE_NAME);
    expect(sent[0]?.data).toMatchObject({ runId: "run-1", attempt: 1, inputHash: sha256(reviewInput) });
    expect(REVIEW_QUEUE_NAME).toBe("platform.agent-review");
  });
});
