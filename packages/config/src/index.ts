import { z } from "zod";

const HTTP_PROTOCOLS = new Set(["http:", "https:"]);
const POSTGRES_PROTOCOLS = new Set(["postgres:", "postgresql:"]);

const nonEmpty = z.string().trim().min(1);
const httpUrl = nonEmpty.url().refine(
  (value) => HTTP_PROTOCOLS.has(new URL(value).protocol),
  "URL must use http or https",
);
const postgresUrl = nonEmpty.url().refine(
  (value) => POSTGRES_PROTOCOLS.has(new URL(value).protocol),
  "DATABASE_URL must use postgres or postgresql",
);

function integerEnv(defaultValue: number, minimum: number, maximum: number) {
  return z
    .string()
    .trim()
    .regex(/^\d+$/, "Expected a non-negative integer")
    .transform(Number)
    .pipe(z.number().int().min(minimum).max(maximum))
    .default(String(defaultValue));
}

const registryEndpoint = nonEmpty
  .regex(
    /^(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\])(?::[0-9]{1,5})?$/,
    "Registry host must be a host with an optional port and no URL scheme",
  )
  .refine((value) => {
    const port = value.match(/:(\d{1,5})$/)?.[1];
    return port === undefined || (Number(port) >= 1 && Number(port) <= 65535);
  }, "Registry port must be between 1 and 65535");

const safeRegistryEndpoint = registryEndpoint.refine((value) => {
  const host = value.replace(/:\d{1,5}$/, "").toLowerCase();
  return !new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]"]).has(host);
}, "Registry host must not be localhost or a loopback address");

const repositoryFullName = z
  .string()
  .trim()
  .min(3)
  .max(512)
  .regex(
    /^[^/\\\s]+\/[^/\\\s]+$/,
    "Repository must be a full_name in owner/name form",
  )
  .refine((value) => {
    const [owner, repository] = value.split("/");
    return owner !== "." && owner !== ".." && repository !== "." && repository !== "..";
  }, "Repository owner and name must not be path traversal segments");

const allowedRepositories = z
  .string()
  .optional()
  .transform((value) => {
    if (value === undefined || value.trim() === "") {
      return [];
    }
    return value.split(",").map((repository) => repository.trim());
  })
  .pipe(z.array(repositoryFullName).max(100))
  .transform((repositories) => [...new Set(repositories)]);

const kubernetesName = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const sshHost = nonEmpty
  .max(253)
  .regex(
    /^(?:(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?))*|\[[0-9A-Fa-f:]+\])$/,
    "SSH host must be a hostname or bracketed IPv6 address",
  );
const sshUser = nonEmpty
  .max(64)
  .regex(/^[A-Za-z_][A-Za-z0-9._-]*$/, "SSH user contains unsupported characters");
const sshPort = z
  .string()
  .trim()
  .regex(/^\d+$/, "SSH port must be a positive integer")
  .transform(Number)
  .pipe(z.number().int().min(1).max(65535));

export const PREVIEW_SERVICE_PORT = 80;
export const PREVIEW_PORT_FORWARD_PORT = 8080;

export interface PreviewServiceReference {
  readonly namespace: string;
  readonly serviceName: string;
}

export function buildPreviewServiceReference(namespace: string, serviceName: string): string {
  if (!kubernetesName.test(namespace) || !kubernetesName.test(serviceName)) {
    throw new Error("Preview Service reference contains an invalid Kubernetes name");
  }
  return `service://${namespace}/${serviceName}`;
}

export function parsePreviewServiceReference(value: string): PreviewServiceReference | undefined {
  const match = /^service:\/\/([^/]+)\/([^/?#]+)$/.exec(value);
  const namespace = match?.[1];
  const serviceName = match?.[2];
  if (namespace === undefined || serviceName === undefined || !kubernetesName.test(namespace) || !kubernetesName.test(serviceName)) return undefined;
  return { namespace, serviceName };
}

function shellQuote(value: string, label: string): string {
  if (!/^[A-Za-z0-9_.:@[\]/-]+$/.test(value) || value.includes("..")) {
    throw new Error(`${label} contains unsupported shell characters`);
  }
  return `'${value}'`;
}

export function buildPreviewPortForwardCommand(reference: PreviewServiceReference): string {
  const parsed = parsePreviewServiceReference(buildPreviewServiceReference(reference.namespace, reference.serviceName));
  if (parsed === undefined) throw new Error("Preview Service reference is invalid");
  return [
    "kubectl",
    "-n",
    shellQuote(parsed.namespace, "Preview namespace"),
    "port-forward",
    "--address=127.0.0.1",
    shellQuote(`service/${parsed.serviceName}`, "Preview Service"),
    `${PREVIEW_PORT_FORWARD_PORT}:${PREVIEW_SERVICE_PORT}`,
  ].join(" ");
}

export function buildPreviewSshTunnelCommand(
  reference: PreviewServiceReference,
  options: { readonly host: string; readonly user: string; readonly port?: number },
): string {
  const parsed = parsePreviewServiceReference(buildPreviewServiceReference(reference.namespace, reference.serviceName));
  if (parsed === undefined) throw new Error("Preview Service reference is invalid");
  const port = options.port ?? 22;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("SSH port must be between 1 and 65535");
  const destination = `${options.user}@${options.host}`;
  return [
    "ssh",
    "-p",
    String(port),
    "-o",
    "ExitOnForwardFailure=yes",
    "-L",
    `127.0.0.1:${PREVIEW_PORT_FORWARD_PORT}:127.0.0.1:${PREVIEW_PORT_FORWARD_PORT}`,
    shellQuote(destination, "SSH destination"),
    "kubectl",
    "-n",
    shellQuote(parsed.namespace, "Preview namespace"),
    "port-forward",
    "--address=127.0.0.1",
    shellQuote(`service/${parsed.serviceName}`, "Preview Service"),
    `${PREVIEW_PORT_FORWARD_PORT}:${PREVIEW_SERVICE_PORT}`,
  ].join(" ");
}

const baseEnvironmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: integerEnv(3000, 1, 65535),
  LOG_LEVEL: z
    .enum(["trace", "debug", "info", "warn", "error", "fatal"])
    .default("info"),

  DATABASE_URL: postgresUrl,
  GITEA_BASE_URL: httpUrl,
  GITEA_PUBLIC_URL: httpUrl.optional(),
  GITEA_WEBHOOK_SECRET: nonEmpty,
  WEBHOOK_SECRET: nonEmpty.optional(),
  GITEA_ALLOWED_REPOSITORIES: allowedRepositories,
  SESSION_ENCRYPTION_KEY: z.string().min(32, "SESSION_ENCRYPTION_KEY must be at least 32 characters"),
  GITEA_OAUTH_CLIENT_ID: nonEmpty.optional(),
  GITEA_OAUTH_CLIENT_SECRET: nonEmpty.optional(),
  PLATFORM_PUBLIC_URL: httpUrl.optional(),
  LOG_ROOT: nonEmpty.default("/var/log/platform"),

  K8S_MODE: z.enum(["local", "server"]).default("local"),
  PREVIEW_MODE: z.enum(["local", "ingress", "ssh"]).optional(),
  KUBECONFIG: nonEmpty.optional(),
  REGISTRY_PUSH_HOST: safeRegistryEndpoint,
  REGISTRY_PULL_HOST: safeRegistryEndpoint,
  PREVIEW_BASE_URL: httpUrl.optional(),
  PREVIEW_SSH_HOST: sshHost.optional(),
  PREVIEW_SSH_USER: sshUser.optional(),
  PREVIEW_SSH_PORT: sshPort.optional(),

  MAX_ACTIVE_RUNS: integerEnv(1, 1, 1),
  MAX_QUEUED_RUNS: integerEnv(3, 0, 3),
  WEBHOOK_MAX_AGE_MINUTES: integerEnv(15, 1, 15),
  REPORT_MAX_BYTES: integerEnv(256 * 1024, 1, 256 * 1024),
  REVIEW_INPUT_MAX_BYTES: integerEnv(64 * 1024, 1, 64 * 1024),
  RETENTION_DAYS: integerEnv(7, 1, 7),

  AGENT_PROVIDER: z.enum(["mock", "openai-compatible"]).default("mock"),
  AGENT_API_URL: httpUrl.optional(),
  AGENT_API_KEY: nonEmpty.optional(),
  AGENT_MODEL: nonEmpty.default("mock"),
});

function normalizeEnvironmentAliases(input: unknown): unknown {
  if (typeof input !== "object" || input === null) {
    return input;
  }

  const environment = { ...(input as Record<string, unknown>) };
  for (const optionalKey of [
    "GITEA_PUBLIC_URL",
    "GITEA_OAUTH_CLIENT_ID",
    "GITEA_OAUTH_CLIENT_SECRET",
    "PLATFORM_PUBLIC_URL",
    "KUBECONFIG",
    "PREVIEW_BASE_URL",
    "PREVIEW_SSH_HOST",
    "PREVIEW_SSH_USER",
    "PREVIEW_SSH_PORT",
    "AGENT_API_URL",
    "AGENT_API_KEY",
  ]) {
    if (environment[optionalKey] === "") delete environment[optionalKey];
  }
  if (environment.GITEA_WEBHOOK_SECRET === undefined) {
    environment.GITEA_WEBHOOK_SECRET = environment.WEBHOOK_SECRET;
  }
  if (environment.K8S_MODE === undefined && environment.PREVIEW_MODE !== undefined) {
    environment.K8S_MODE = environment.PREVIEW_MODE === "local" ? "local" : "server";
  }
  return environment;
}

export const EnvironmentSchema = z
  .preprocess(
    normalizeEnvironmentAliases,
    baseEnvironmentSchema
      .passthrough()
      .superRefine((environment, context) => {
        if (
          environment.WEBHOOK_SECRET !== undefined &&
          environment.WEBHOOK_SECRET !== environment.GITEA_WEBHOOK_SECRET
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["WEBHOOK_SECRET"],
            message: "WEBHOOK_SECRET conflicts with GITEA_WEBHOOK_SECRET",
          });
        }

        if (
          environment.PREVIEW_MODE !== undefined &&
          ((environment.PREVIEW_MODE === "local" && environment.K8S_MODE !== "local") ||
            (environment.PREVIEW_MODE !== "local" && environment.K8S_MODE !== "server"))
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["PREVIEW_MODE"],
            message: "PREVIEW_MODE conflicts with K8S_MODE",
          });
        }

        if (environment.K8S_MODE === "local" && !environment.KUBECONFIG) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["KUBECONFIG"],
            message: "KUBECONFIG is required when K8S_MODE=local",
          });
        }

        if (
          environment.K8S_MODE === "local" &&
          environment.PREVIEW_MODE !== undefined &&
          environment.PREVIEW_MODE !== "local"
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["PREVIEW_MODE"],
            message: "PREVIEW_MODE must be local when K8S_MODE=local",
          });
        }

        if (
          environment.K8S_MODE === "server" &&
          environment.PREVIEW_MODE === "local"
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["PREVIEW_MODE"],
            message: "PREVIEW_MODE cannot be local when K8S_MODE=server",
          });
        }

        if (
          environment.K8S_MODE === "server" &&
          environment.PREVIEW_MODE === "ingress" &&
          !environment.PREVIEW_BASE_URL
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["PREVIEW_BASE_URL"],
            message: "PREVIEW_BASE_URL is required when K8S_MODE=server",
          });
        }

        const hasSshHost = Boolean(environment.PREVIEW_SSH_HOST);
        const hasSshUser = Boolean(environment.PREVIEW_SSH_USER);
        const hasSshPort = environment.PREVIEW_SSH_PORT !== undefined;
        if (hasSshHost !== hasSshUser) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [hasSshHost ? "PREVIEW_SSH_USER" : "PREVIEW_SSH_HOST"],
            message: "PREVIEW_SSH_HOST and PREVIEW_SSH_USER must be provided together",
          });
        }
        if (environment.PREVIEW_MODE === "ssh" && (!hasSshHost || !hasSshUser)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [!hasSshHost ? "PREVIEW_SSH_HOST" : "PREVIEW_SSH_USER"],
            message: "PREVIEW_SSH_HOST and PREVIEW_SSH_USER are required when PREVIEW_MODE=ssh",
          });
        }
        if (environment.PREVIEW_MODE !== "ssh" && (hasSshHost || hasSshUser || hasSshPort)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [hasSshHost ? "PREVIEW_SSH_HOST" : hasSshUser ? "PREVIEW_SSH_USER" : "PREVIEW_SSH_PORT"],
            message: "SSH Preview settings are only valid when PREVIEW_MODE=ssh",
          });
        }

        const hasOAuthClientId = Boolean(environment.GITEA_OAUTH_CLIENT_ID);
        const hasOAuthClientSecret = Boolean(environment.GITEA_OAUTH_CLIENT_SECRET);
        if (hasOAuthClientId !== hasOAuthClientSecret) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [hasOAuthClientId ? "GITEA_OAUTH_CLIENT_SECRET" : "GITEA_OAUTH_CLIENT_ID"],
            message: "Gitea OAuth client ID and secret must be provided together",
          });
        }

        const hasAgentApiUrl = Boolean(environment.AGENT_API_URL);
        const hasAgentApiKey = Boolean(environment.AGENT_API_KEY);
        if (environment.AGENT_PROVIDER === "openai-compatible" && (!hasAgentApiUrl || !hasAgentApiKey)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [!hasAgentApiUrl ? "AGENT_API_URL" : "AGENT_API_KEY"],
            message: "OpenAI-compatible Agent provider requires AGENT_API_URL and AGENT_API_KEY",
          });
        }
        if (environment.AGENT_PROVIDER === "mock" && (hasAgentApiUrl || hasAgentApiKey)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [hasAgentApiUrl ? "AGENT_API_URL" : "AGENT_API_KEY"],
            message: "Agent API credentials must be omitted when AGENT_PROVIDER=mock",
          });
        }
      }),
  );

export type Environment = z.infer<typeof EnvironmentSchema>;

export interface AppConfig {
  nodeEnv: Environment["NODE_ENV"];
  port: number;
  logLevel: Environment["LOG_LEVEL"];
  databaseUrl: string;
  giteaBaseUrl: string;
  giteaPublicUrl?: string;
  giteaWebhookSecret: string;
  giteaAllowedRepositories: readonly string[];
  sessionEncryptionKey: string;
  giteaOAuthClientId?: string;
  giteaOAuthClientSecret?: string;
  platformPublicUrl?: string;
  logRoot: string;
  k8sMode: Environment["K8S_MODE"];
  kubeconfig?: string;
  previewMode: "local" | "ingress" | "ssh";
  registryPushHost: string;
  registryPullHost: string;
  previewBaseUrl?: string;
  previewSshHost?: string;
  previewSshUser?: string;
  previewSshPort?: number;
  maxActiveRuns: number;
  maxQueuedRuns: number;
  webhookMaxAgeMinutes: number;
  reportMaxBytes: number;
  reviewInputMaxBytes: number;
  retentionDays: number;
  agentProvider: Environment["AGENT_PROVIDER"];
  agentApiUrl?: string;
  agentApiKey?: string;
  agentModel: string;
}

export function parseEnvironment(env: Record<string, unknown>): Environment {
  return EnvironmentSchema.parse(env);
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = parseEnvironment(env);
  const config: AppConfig = {
    nodeEnv: parsed.NODE_ENV,
    port: parsed.PORT,
    logLevel: parsed.LOG_LEVEL,
    databaseUrl: parsed.DATABASE_URL,
    giteaBaseUrl: parsed.GITEA_BASE_URL,
    giteaWebhookSecret: parsed.GITEA_WEBHOOK_SECRET,
    giteaAllowedRepositories: parsed.GITEA_ALLOWED_REPOSITORIES,
    sessionEncryptionKey: parsed.SESSION_ENCRYPTION_KEY,
    logRoot: parsed.LOG_ROOT,
    k8sMode: parsed.K8S_MODE,
    previewMode:
      parsed.PREVIEW_MODE ?? (parsed.K8S_MODE === "local" ? "local" : "ssh"),
    registryPushHost: parsed.REGISTRY_PUSH_HOST,
    registryPullHost: parsed.REGISTRY_PULL_HOST,
    maxActiveRuns: parsed.MAX_ACTIVE_RUNS,
    maxQueuedRuns: parsed.MAX_QUEUED_RUNS,
    webhookMaxAgeMinutes: parsed.WEBHOOK_MAX_AGE_MINUTES,
    reportMaxBytes: parsed.REPORT_MAX_BYTES,
    reviewInputMaxBytes: parsed.REVIEW_INPUT_MAX_BYTES,
    retentionDays: parsed.RETENTION_DAYS,
    agentProvider: parsed.AGENT_PROVIDER,
    agentModel: parsed.AGENT_MODEL,
  };

  if (parsed.GITEA_PUBLIC_URL !== undefined) {
    config.giteaPublicUrl = parsed.GITEA_PUBLIC_URL;
  }

  if (parsed.GITEA_OAUTH_CLIENT_ID !== undefined) {
    config.giteaOAuthClientId = parsed.GITEA_OAUTH_CLIENT_ID;
  }
  if (parsed.GITEA_OAUTH_CLIENT_SECRET !== undefined) {
    config.giteaOAuthClientSecret = parsed.GITEA_OAUTH_CLIENT_SECRET;
  }
  if (parsed.PLATFORM_PUBLIC_URL !== undefined) {
    config.platformPublicUrl = parsed.PLATFORM_PUBLIC_URL;
  }
  if (parsed.KUBECONFIG !== undefined) {
    config.kubeconfig = parsed.KUBECONFIG;
  }
  if (parsed.PREVIEW_BASE_URL !== undefined) {
    config.previewBaseUrl = parsed.PREVIEW_BASE_URL;
  }
  if (parsed.PREVIEW_SSH_HOST !== undefined) {
    config.previewSshHost = parsed.PREVIEW_SSH_HOST;
  }
  if (parsed.PREVIEW_SSH_USER !== undefined) {
    config.previewSshUser = parsed.PREVIEW_SSH_USER;
  }
  if (parsed.PREVIEW_SSH_PORT !== undefined) {
    config.previewSshPort = parsed.PREVIEW_SSH_PORT;
  }
  if (parsed.AGENT_API_URL !== undefined) {
    config.agentApiUrl = parsed.AGENT_API_URL;
  }
  if (parsed.AGENT_API_KEY !== undefined) {
    config.agentApiKey = parsed.AGENT_API_KEY;
  }

  return config;
}

export const ConfigSchema = EnvironmentSchema;
export const envSchema = EnvironmentSchema;
export const parseEnv = parseEnvironment;
