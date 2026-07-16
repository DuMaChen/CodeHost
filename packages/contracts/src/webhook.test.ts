import { describe, expect, it } from "vitest";
import {
  isWebhookEventFresh,
  normalizeGiteaPullRequestWebhook,
  parseWebhookEventInput,
  WebhookEventInputSchema,
} from "./index.js";

const now = new Date("2026-07-14T06:00:00.000Z");
const validInput = {
  providerDeliveryId: "delivery-123",
  eventType: "synchronize" as const,
  repositoryId: 10,
  pullRequestId: 22,
  externalNumber: 7,
  headSha: "0123456789abcdef0123456789abcdef01234567",
  createdAt: new Date("2026-07-14T05:50:00.000Z"),
};

describe("Webhook event contract", () => {
  it("accepts only supported PR actions and required identity fields", () => {
    expect(WebhookEventInputSchema.safeParse(validInput).success).toBe(true);
    expect(
      WebhookEventInputSchema.safeParse({ ...validInput, eventType: "closed" }).success,
    ).toBe(false);
    expect(
      WebhookEventInputSchema.safeParse({ ...validInput, unknown: true }).success,
    ).toBe(false);
  });

  it("rejects stale and future events at the freshness boundary", () => {
    expect(isWebhookEventFresh(validInput, now)).toBe(true);
    expect(
      isWebhookEventFresh(
        { createdAt: new Date("2026-07-14T05:44:59.999Z") },
        now,
      ),
    ).toBe(false);
    expect(
      isWebhookEventFresh({ createdAt: new Date("2026-07-14T06:00:00.001Z") }, now),
    ).toBe(false);
    expect(() => parseWebhookEventInput(validInput, { now })).not.toThrow();
    expect(() =>
      parseWebhookEventInput(
        { ...validInput, createdAt: new Date("2026-07-14T05:44:59.999Z") },
        { now },
      ),
    ).toThrow();
  });

  it("normalizes the provider payload without trusting provider extras", () => {
    const normalized = normalizeGiteaPullRequestWebhook(
      {
        action: "opened",
        repository: { id: 10, full_name: "course/example", ignored: "ok" },
        pull_request: {
          id: 22,
          number: 7,
          created_at: "2026-07-14T05:55:00.000Z",
          head: { sha: validInput.headSha },
          title: "Add health check",
        },
      },
      "delivery-456",
      { now },
    );

    expect(normalized).toMatchObject({
      providerDeliveryId: "delivery-456",
      eventType: "opened",
      repositoryId: 10,
      pullRequestId: 22,
      externalNumber: 7,
      headSha: validInput.headSha,
    });
  });

  it("uses the event timestamp instead of the original PR creation time", () => {
    const normalized = normalizeGiteaPullRequestWebhook(
      {
        action: "synchronize",
        created_at: "2026-07-14T05:59:00.000Z",
        repository: { id: 10, full_name: "course/example" },
        pull_request: {
          id: 22,
          number: 7,
          created_at: "2026-07-01T05:55:00.000Z",
          head: { sha: validInput.headSha },
        },
      },
      "delivery-789",
      { now },
    );

    expect(normalized.createdAt).toEqual(new Date("2026-07-14T05:59:00.000Z"));
  });

  it("canonicalizes Gitea's synchronized action", () => {
    const normalized = normalizeGiteaPullRequestWebhook(
      {
        action: "synchronized",
        created_at: "2026-07-14T05:59:00.000Z",
        repository: { id: 10, full_name: "course/example" },
        pull_request: {
          id: 22,
          number: 7,
          created_at: "2026-07-14T05:55:00.000Z",
          head: { sha: validInput.headSha },
        },
      },
      "delivery-synchronized",
      { now },
    );

    expect(normalized.eventType).toBe("synchronize");
  });
});
