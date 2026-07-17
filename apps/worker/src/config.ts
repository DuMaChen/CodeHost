export const CAPACITY_LIMITS = {
  maxActiveRuns: 1,
  maxQueuedRuns: 3,
  maxStepLogBytes: 20 * 1024 * 1024,
  maxReviewInputBytes: 64 * 1024,
  maxDeliveryRetries: 1,
  maxWorkflowAttempts: 2,
} as const;

export interface WorkerConfig {
  readonly nodeEnv: string;
  readonly databaseUrl: string | undefined;
  readonly healthHost: string;
  readonly healthPort: number;
  readonly workflowQueue: string;
  readonly workflowExecutor: 'fixture' | 'kubernetes';
  readonly runnerImage: string | undefined;
  readonly previewImage: string | undefined;
  readonly giteaBaseUrl: string | undefined;
  readonly giteaRunnerBaseUrl: string | undefined;
  readonly giteaRunnerToken: string | undefined;
  readonly giteaPlatformToken: string | undefined;
  readonly agentReviewUrl: string | undefined;
  readonly previewBaseUrl: string | undefined;
  readonly previewTlsSecretName: string | undefined;
  readonly previewMode: 'local' | 'ingress' | 'ssh';
  readonly storageClassName: string;
  readonly jobTimeoutMs: number;
  readonly retentionIntervalMs: number;
  readonly registryPullHost: string | undefined;
  readonly registryApiUrl: string | undefined;
  readonly registryToken: string | undefined;
  readonly logRoot: string;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function boundedPositiveInteger(value: string | undefined, fallback: number, maximum: number): number {
  return Math.min(positiveInteger(value, fallback), maximum);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const workflowExecutor = env.WORKFLOW_EXECUTOR === 'kubernetes' ? 'kubernetes' : 'fixture';
  const previewMode = env.PREVIEW_MODE === 'ingress' || env.PREVIEW_MODE === 'ssh' ? env.PREVIEW_MODE : 'local';
  return {
    nodeEnv: env.NODE_ENV ?? 'development',
    databaseUrl: env.DATABASE_URL,
    healthHost: env.WORKER_HEALTH_HOST ?? '0.0.0.0',
    healthPort: positiveInteger(env.WORKER_HEALTH_PORT ?? env.PORT, 3001),
    workflowQueue: env.WORKFLOW_QUEUE ?? 'platform.workflow',
    workflowExecutor,
    runnerImage: env.K8S_RUNNER_IMAGE,
    previewImage: env.K8S_PREVIEW_IMAGE,
    giteaBaseUrl: env.GITEA_BASE_URL,
    giteaRunnerBaseUrl: env.GITEA_RUNNER_BASE_URL,
    giteaRunnerToken: env.GITEA_RUNNER_TOKEN,
    giteaPlatformToken: env.GITEA_PLATFORM_TOKEN,
    agentReviewUrl: env.AGENT_REVIEW_URL,
    previewBaseUrl: env.PREVIEW_BASE_URL,
    previewTlsSecretName: env.PREVIEW_TLS_SECRET_NAME,
    previewMode,
    storageClassName: env.K8S_STORAGE_CLASS ?? 'local-path',
    jobTimeoutMs: boundedPositiveInteger(env.K8S_JOB_TIMEOUT_MS, 15 * 60 * 1000, 15 * 60 * 1000),
    retentionIntervalMs: positiveInteger(env.RETENTION_INTERVAL_MS, 24 * 60 * 60 * 1000),
    registryPullHost: env.REGISTRY_PULL_HOST,
    registryApiUrl: env.REGISTRY_API_URL,
    registryToken: env.REGISTRY_TOKEN,
    logRoot: env.WORKER_LOG_ROOT ?? '/var/log/platform',
  };
}
