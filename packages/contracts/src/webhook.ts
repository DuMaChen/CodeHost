import { z } from "zod";

export const WEBHOOK_EVENT_TYPES = ["opened", "reopened", "synchronize"] as const;
export const WebhookEventTypeSchema = z.enum(WEBHOOK_EVENT_TYPES);
export type WebhookEventType = z.infer<typeof WebhookEventTypeSchema>;
const GITEA_WEBHOOK_ACTIONS = ["opened", "reopened", "synchronize", "synchronized"] as const;

function normalizeGiteaAction(action: (typeof GITEA_WEBHOOK_ACTIONS)[number]): WebhookEventType {
  return action === "synchronized" ? "synchronize" : action;
}

const positiveId = z.number().int().positive();
const sha = z.string().regex(/^[0-9a-f]{7,64}$/i, "Expected a hexadecimal commit SHA");
const eventDate = z.coerce.date().refine((value) => !Number.isNaN(value.getTime()), {
  message: "Expected a valid event timestamp",
});

/**
 * Provider-neutral input used after the HTTP signature and repository allowlist
 * checks. It contains the fields needed to create the webhook audit record and
 * the Run uniqueness key.
 */
export const WebhookEventInputSchema = z
  .object({
    providerDeliveryId: z.string().trim().min(1).max(255),
    eventType: WebhookEventTypeSchema,
    repositoryId: positiveId,
    pullRequestId: positiveId,
    externalNumber: positiveId,
    headSha: sha,
    createdAt: eventDate,
  })
  .strict();

export type WebhookEventInput = z.infer<typeof WebhookEventInputSchema>;

const giteaRepository = z
  .object({
    id: positiveId,
    full_name: z.string().trim().min(1).max(512),
  })
  .passthrough();

const giteaPullRequest = z
  .object({
    id: positiveId,
    number: positiveId,
    created_at: eventDate,
    updated_at: eventDate.optional(),
    head: z.object({ sha }).passthrough(),
  })
  .passthrough();

/** Gitea's provider payload is intentionally passthrough for forward compatibility. */
export const GiteaPullRequestWebhookPayloadSchema = z
  .object({
    action: z.enum(GITEA_WEBHOOK_ACTIONS),
    created_at: eventDate.optional(),
    repository: giteaRepository,
    pull_request: giteaPullRequest,
  })
  .passthrough();

export type GiteaPullRequestWebhookPayload = z.infer<
  typeof GiteaPullRequestWebhookPayloadSchema
>;

export const DEFAULT_WEBHOOK_MAX_AGE_MS = 15 * 60 * 1000;

export function isWebhookEventFresh(
  input: Pick<WebhookEventInput, "createdAt">,
  now = new Date(),
  maxAgeMs = DEFAULT_WEBHOOK_MAX_AGE_MS,
): boolean {
  const createdAt = input.createdAt.getTime();
  const currentTime = now.getTime();
  const age = currentTime - createdAt;

  return (
    Number.isFinite(createdAt) &&
    Number.isFinite(currentTime) &&
    Number.isFinite(maxAgeMs) &&
    maxAgeMs >= 0 &&
    age >= 0 &&
    age <= maxAgeMs
  );
}

export function parseWebhookEventInput(
  input: unknown,
  options: { now?: Date; maxAgeMs?: number } = {},
): WebhookEventInput {
  const parsed = WebhookEventInputSchema.parse(input);
  if (!isWebhookEventFresh(parsed, options.now, options.maxAgeMs)) {
    throw new z.ZodError([
      {
        code: z.ZodIssueCode.custom,
        path: ["createdAt"],
        message: "Webhook event is older than the allowed 15 minute window or from the future",
      },
    ]);
  }
  return parsed;
}

export function normalizeGiteaPullRequestWebhook(
  payload: unknown,
  providerDeliveryId: string,
  options: { now?: Date; maxAgeMs?: number } = {},
): WebhookEventInput {
  const parsed = GiteaPullRequestWebhookPayloadSchema.parse(payload);
  return parseWebhookEventInput(
    {
      providerDeliveryId,
      eventType: normalizeGiteaAction(parsed.action),
      repositoryId: parsed.repository.id,
      pullRequestId: parsed.pull_request.id,
      externalNumber: parsed.pull_request.number,
      headSha: parsed.pull_request.head.sha,
      createdAt:
        parsed.created_at ??
        parsed.pull_request.updated_at ??
        parsed.pull_request.created_at,
    },
    options,
  );
}
