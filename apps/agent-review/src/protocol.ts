import {
  prepareReviewInput,
  reviewInputBytes,
  sha256,
} from "@platform/agent";
import { REVIEW_INPUT_BYTES } from "./config.js";

const RUN_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const HEAD_SHA_PATTERN = /^[0-9a-f]{7,64}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u001b]/;
const REQUEST_FIELDS = new Set([
  "runId",
  "attempt",
  "headSha",
  "inputHash",
  "reviewInput",
]);

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
  readonly result: import("@platform/agent").AgentReviewResult;
}

export type ReviewErrorCode =
  | "INVALID_REQUEST"
  | "INVALID_JSON"
  | "INPUT_TOO_LARGE"
  | "INPUT_NOT_REDACTED"
  | "INPUT_HASH_MISMATCH";

export class ReviewRequestError extends Error {
  constructor(
    readonly code: ReviewErrorCode,
    readonly statusCode: 400 | 413,
  ) {
    super(code);
    this.name = "ReviewRequestError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidRequest(): never {
  throw new ReviewRequestError("INVALID_REQUEST", 400);
}

function exactFields(value: Record<string, unknown>): boolean {
  return (
    Object.keys(value).length === REQUEST_FIELDS.size &&
    Object.keys(value).every((key) => REQUEST_FIELDS.has(key))
  );
}

/** Parse the shared HTTP/queue payload. Raw review objects are deliberately rejected. */
export function parseReviewRequest(payload: unknown): ReviewRequest {
  if (!isRecord(payload) || !exactFields(payload)) return invalidRequest();

  const { runId, attempt, headSha, inputHash, reviewInput } = payload;
  if (
    typeof runId !== "string" ||
    !RUN_ID_PATTERN.test(runId) ||
    typeof attempt !== "number" ||
    !Number.isSafeInteger(attempt) ||
    attempt < 1 ||
    typeof headSha !== "string" ||
    !HEAD_SHA_PATTERN.test(headSha) ||
    typeof inputHash !== "string" ||
    !SHA256_PATTERN.test(inputHash) ||
    typeof reviewInput !== "string"
  ) {
    return invalidRequest();
  }

  if (reviewInputBytes(reviewInput) > REVIEW_INPUT_BYTES) {
    throw new ReviewRequestError("INPUT_TOO_LARGE", 413);
  }
  if (CONTROL_CHARACTER_PATTERN.test(reviewInput)) {
    throw new ReviewRequestError("INPUT_NOT_REDACTED", 400);
  }

  const prepared = prepareReviewInput(reviewInput, { maxBytes: REVIEW_INPUT_BYTES });
  if (prepared.truncated || prepared.text !== reviewInput) {
    throw new ReviewRequestError("INPUT_NOT_REDACTED", 400);
  }
  if (prepared.inputHash !== inputHash || sha256(reviewInput) !== inputHash) {
    throw new ReviewRequestError("INPUT_HASH_MISMATCH", 400);
  }

  return { runId, attempt, headSha, inputHash, reviewInput };
}
