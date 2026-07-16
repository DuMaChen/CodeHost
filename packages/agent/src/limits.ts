import { createHash } from "node:crypto";

export const MAX_REVIEW_INPUT_BYTES = 64 * 1024;
export const MAX_REPORT_BYTES = 256 * 1024;

export function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/** Truncate by UTF-8 bytes without leaving a partial code point. */
export function truncateUtf8(
  value: string,
  maximumBytes: number,
  marker = "[TRUNCATED]",
): { value: string; truncated: boolean; bytes: number } {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw new RangeError("maximumBytes must be a non-negative safe integer");
  }

  const valueBytes = utf8ByteLength(value);
  if (valueBytes <= maximumBytes) {
    return { value, truncated: false, bytes: valueBytes };
  }

  const markerBytes = utf8ByteLength(marker);
  if (markerBytes >= maximumBytes) {
    const prefix = utf8Prefix(value, maximumBytes);
    return { value: prefix, truncated: true, bytes: utf8ByteLength(prefix) };
  }

  const prefixMaximum = maximumBytes - markerBytes;
  const prefix = utf8Prefix(value, prefixMaximum);

  const truncatedValue = `${prefix}${marker}`;
  return {
    value: truncatedValue,
    truncated: true,
    bytes: utf8ByteLength(truncatedValue),
  };
}

function utf8Prefix(value: string, maximumBytes: number): string {
  let lower = 0;
  let upper = Math.min(value.length, maximumBytes);
  while (lower < upper) {
    const middle = Math.ceil((lower + upper) / 2);
    if (utf8ByteLength(value.slice(0, middle)) <= maximumBytes) lower = middle;
    else upper = middle - 1;
  }

  let end = lower;
  const lastCodeUnit = end > 0 ? value.charCodeAt(end - 1) : 0;
  if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) end -= 1;
  return value.slice(0, end);
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
