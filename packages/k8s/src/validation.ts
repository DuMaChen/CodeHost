import { createHash } from "node:crypto";

const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const HOST_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const LABEL_VALUE = /^[A-Za-z0-9](?:[-A-Za-z0-9_.]*[A-Za-z0-9])?$/;
const IMAGE_PATH = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?(?:\/[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?)*$/;
const IMAGE_REFERENCE_REPOSITORY = /^[a-z0-9](?:[a-z0-9._:-]*[a-z0-9])?(?:\/[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?)+$/;
const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/;

export const MAX_RUN_SHORT_ID_LENGTH = 32;
export const MAX_RUN_ID_LABEL_LENGTH = 63;

export function assertSafeSlug(value: string, field: string, maximumLength: number): string {
  if (
    value.length === 0 ||
    value.length > maximumLength ||
    !DNS_LABEL.test(value)
  ) {
    throw new RangeError(`${field} must be a lowercase DNS label of at most ${maximumLength} characters`);
  }
  return value;
}

export function assertLabelValue(value: string, field: string): string {
  if (value.length === 0 || value.length > MAX_RUN_ID_LABEL_LENGTH || !LABEL_VALUE.test(value)) {
    throw new RangeError(`${field} must be a valid Kubernetes label value`);
  }
  return value;
}

export function assertAttempt(attempt: number): number {
  if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > 99) {
    throw new RangeError("attempt must be an integer between 1 and 99");
  }
  return attempt;
}

export function assertNamespace(value: string): string {
  return assertSafeSlug(value, "namespace", 63);
}

export function assertStepKey(value: string): string {
  return assertSafeSlug(value, "stepKey", 32);
}

export function assertImageReference(value: string): string {
  const at = value.lastIndexOf("@");
  const repository = at === -1 ? "" : value.slice(0, at);
  const digest = at === -1 ? "" : value.slice(at + 1);
  if (!repository || !IMAGE_REFERENCE_REPOSITORY.test(repository) || !SHA256_DIGEST.test(digest)) {
    throw new RangeError("image must be a lowercase immutable OCI reference with a sha256 digest");
  }

  const registryHost = repository.split("/")[0];
  if (registryHost === undefined || isLoopbackHost(registryHost)) {
    throw new RangeError("image registry must not use localhost or a loopback address");
  }
  assertRegistryHost(registryHost);
  return value;
}

export function immutableImageReference(
  registryHost: string,
  repository: string,
  digest: string,
): string {
  assertRegistryHost(registryHost);
  if (!IMAGE_PATH.test(repository) || repository.startsWith("/")) {
    throw new RangeError("repository must be a lowercase OCI repository path");
  }
  if (!SHA256_DIGEST.test(digest)) {
    throw new RangeError("digest must be a sha256 digest");
  }
  return `${registryHost}/${repository}@${digest}`;
}

export function assertRegistryHost(value: string): string {
  if (
    value.length === 0 ||
    value.includes("/") ||
    value.includes("@") ||
    isLoopbackHost(value)
  ) {
    throw new RangeError("registry host must be a cluster-reachable host and must not be localhost");
  }
  const hostAndPort = value.startsWith("[")
    ? value.match(/^\[[0-9A-Fa-f:]+\](?::[0-9]{1,5})?$/)
    : value.match(/^[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/);
  if (!hostAndPort) {
    throw new RangeError("registry host must be a DNS host or IPv6 host with an optional port");
  }
  if (!value.startsWith("[")) {
    const hostname = value.replace(/:\d{1,5}$/, "");
    if (hostname.split(".").some((part) => !HOST_LABEL.test(part))) {
      throw new RangeError("registry host must contain only valid DNS labels");
    }
  }
  const port = value.match(/:(\d{1,5})$/)?.[1];
  if (port !== undefined && (Number(port) < 1 || Number(port) > 65535)) {
    throw new RangeError("registry port must be between 1 and 65535");
  }
  return value;
}

function isLoopbackHost(value: string): boolean {
  const host = value.replace(/:\d{1,5}$/, "").toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "[::1]";
}

export function assertContainerPort(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new RangeError("containerPort must be between 1 and 65535");
  }
  return value;
}

export function assertHealthPath(value: string): string {
  if (!/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/.test(value) || value.includes("..")) {
    throw new RangeError("healthPath must be an absolute, non-traversal HTTP path");
  }
  return value;
}

export function ingressHost(baseUrl: string, namespace: string): { host: string; url: string } {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new RangeError("preview base URL must be a valid HTTP(S) URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new RangeError("preview base URL must use HTTP or HTTPS");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== "/") {
    throw new RangeError("preview base URL must not contain credentials, query, fragment, or a path");
  }
  if (isLoopbackHost(parsed.hostname)) {
    throw new RangeError("server ingress base URL must not use localhost or a loopback address");
  }
  const host = `${namespace}.${parsed.hostname}`;
  if (host.length > 253 || host.split(".").some((part) => !DNS_LABEL.test(part))) {
    throw new RangeError("preview ingress host is not a valid DNS name");
  }
  const port = parsed.port ? `:${parsed.port}` : "";
  return { host, url: `${parsed.protocol}//${host}${port}/` };
}

export function expirationIso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new RangeError("expiresAt must be a valid date");
  }
  return date.toISOString();
}

export function shortHash(value: string, length = 12): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, length);
}
