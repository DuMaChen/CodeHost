import {
  MAX_REPORT_BYTES,
  MAX_REVIEW_INPUT_BYTES,
  createAgentProvider,
  type AgentProvider,
  type AgentProviderConfig,
} from "@platform/agent";

export const REVIEW_INPUT_BYTES = MAX_REVIEW_INPUT_BYTES;
export const REVIEW_REPORT_BYTES = MAX_REPORT_BYTES;
export const MAX_HTTP_BODY_BYTES = 512 * 1024;

export interface AgentReviewConfig {
  readonly host: string;
  readonly port: number;
  readonly databaseUrl: string | undefined;
  readonly provider: AgentProviderConfig;
  readonly maxHttpBodyBytes: number;
}

function positiveInteger(value: string | undefined, fallback: number, maximum: number): number {
  if (value === undefined || !/^\d+$/.test(value)) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= maximum
    ? parsed
    : fallback;
}

function required(value: string | undefined, name: string): string {
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${name} is required for the selected Agent provider`);
  }
  if (value.length > 4_096 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function providerConfig(env: NodeJS.ProcessEnv): AgentProviderConfig {
  const provider = env.AGENT_PROVIDER ?? "mock";
  if (provider === "mock") {
    const model = env.AGENT_MODEL;
    return model === undefined
      ? { provider: "mock" }
      : { provider: "mock", model: required(model, "AGENT_MODEL") };
  }

  if (provider !== "openai-compatible") {
    throw new Error("AGENT_PROVIDER must be mock or openai-compatible");
  }

  const apiUrl = required(env.AGENT_API_URL, "AGENT_API_URL");
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(apiUrl);
  } catch {
    throw new Error("AGENT_API_URL must be an absolute HTTP(S) URL");
  }
  if (
    (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") ||
    parsedUrl.username.length > 0 ||
    parsedUrl.password.length > 0
  ) {
    throw new Error("AGENT_API_URL must be an HTTP(S) URL without embedded credentials");
  }

  return {
    provider: "openai-compatible",
    apiUrl,
    apiKey: required(env.AGENT_MODEL_API_KEY, "AGENT_MODEL_API_KEY"),
    model: required(env.AGENT_MODEL, "AGENT_MODEL"),
    timeoutMs: positiveInteger(env.AGENT_PROVIDER_TIMEOUT_MS, 30_000, 300_000),
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentReviewConfig {
  return {
    host: env.AGENT_REVIEW_HOST ?? "0.0.0.0",
    port: positiveInteger(env.AGENT_REVIEW_PORT, 3_002, 65_535),
    databaseUrl: env.DATABASE_URL,
    provider: providerConfig(env),
    maxHttpBodyBytes: MAX_HTTP_BODY_BYTES,
  };
}

export function createConfiguredProvider(config: AgentReviewConfig): AgentProvider {
  return createAgentProvider(config.provider);
}
