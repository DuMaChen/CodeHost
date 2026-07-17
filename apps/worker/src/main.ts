import { createPgBoss, PgBossWorkflowQueue } from './queue.js';
import { loadConfig } from './config.js';
import { HealthServer } from './health.js';
import { Logger } from './logger.js';
import { WorkflowConsumer } from './workflow/consumer.js';
import { FixtureStepExecutor } from './workflow/executor.js';
import { KubernetesApiClient } from './kubernetes/client.js';
import { KubernetesStepExecutor } from './kubernetes/runtime.js';
import { GiteaClient } from './gitea/client.js';
import { GiteaSyncPublisher } from './gitea/sync.js';
import { RetentionWorker } from './retention.js';
import { RegistryClient } from './registry.js';
import { PgBossAgentReviewClient } from './agent-review/queue.js';
import type { StepExecutor } from './workflow/executor.js';
import { DatabaseStepGuard, DatabaseWorkflowStore } from './workflow/db-adapter.js';
import { OutboxPublisher } from './workflow/outbox.js';
import { createDatabase, createPool } from '@platform/db';

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const logger = new Logger();
  const health = new HealthServer(
    config.healthHost,
    config.healthPort,
    logger,
  );
  let queue: PgBossWorkflowQueue | undefined;
  let outbox: OutboxPublisher | undefined;
  let giteaSyncPublisher: GiteaSyncPublisher | undefined;
  let retentionWorker: RetentionWorker | undefined;
  let kubernetesClient: KubernetesApiClient | undefined;
  let giteaClient: GiteaClient | undefined;
  let agentReviewClient: PgBossAgentReviewClient | undefined;
  let pool: ReturnType<typeof createPool> | undefined;

  await health.start();

  const shutdown = async (signal: string): Promise<void> => {
    logger.info('worker shutting down', { signal });
    await outbox?.stop();
    await giteaSyncPublisher?.stop();
    await retentionWorker?.stop();
    await agentReviewClient?.stop();
    await queue?.stop();
    await pool?.end();
    await health.stop();
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  if (config.databaseUrl === undefined) {
    health.setQueueHealth('disabled');
    logger.warn('workflow queue disabled because DATABASE_URL is not set');
    return;
  }

  pool = createPool({ connectionString: config.databaseUrl });
  const database = createDatabase(pool);
  if (config.giteaBaseUrl !== undefined && config.giteaPlatformToken !== undefined && config.giteaPlatformToken.length > 0) {
    giteaClient = new GiteaClient({ baseUrl: config.giteaBaseUrl, token: config.giteaPlatformToken });
  }
  const boss = createPgBoss(config.databaseUrl);
  queue = new PgBossWorkflowQueue(
    boss,
    config.workflowQueue,
    logger,
  );
  const reviewClient = new PgBossAgentReviewClient(boss, logger);
  agentReviewClient = reviewClient;
  let executor: StepExecutor = new FixtureStepExecutor();
  if (config.workflowExecutor === 'kubernetes') {
    if (!config.runnerImage || !config.previewImage || !config.giteaBaseUrl) {
      throw new Error('K8S_RUNNER_IMAGE, K8S_PREVIEW_IMAGE and GITEA_BASE_URL are required for Kubernetes workflow execution');
    }
    const client = await KubernetesApiClient.fromEnvironment();
    kubernetesClient = client;
    executor = new KubernetesStepExecutor({
      client,
      store: new DatabaseWorkflowStore(database),
      runnerImage: config.runnerImage,
      previewImage: config.previewImage,
      giteaBaseUrl: config.giteaBaseUrl,
      ...(config.giteaRunnerBaseUrl === undefined ? {} : { giteaRunnerBaseUrl: config.giteaRunnerBaseUrl }),
      ...(config.giteaRunnerToken === undefined ? {} : { giteaRunnerToken: config.giteaRunnerToken }),
      ...(config.previewBaseUrl === undefined ? {} : { previewBaseUrl: config.previewBaseUrl }),
      ...(config.previewTlsSecretName === undefined ? {} : { previewTlsSecretName: config.previewTlsSecretName }),
      ...(config.agentReviewUrl === undefined ? {} : { agentReviewUrl: config.agentReviewUrl }),
      ...(giteaClient === undefined ? {} : { giteaClient }),
      ...(agentReviewClient === undefined ? {} : { agentReviewClient }),
      logRoot: config.logRoot,
      previewMode: config.previewMode,
      storageClassName: config.storageClassName,
      jobTimeoutMs: config.jobTimeoutMs,
      logger,
    });
  }
  const workflowStore = new DatabaseWorkflowStore(database);
  const consumer = new WorkflowConsumer({
    store: workflowStore,
    stepGuard: new DatabaseStepGuard(database),
    executor,
    dispatcher: queue,
    logger,
  });
  queue.setConsumer(consumer);

  try {
    await queue.start();
    await reviewClient.start();
    outbox = new OutboxPublisher(database, queue, logger);
    await outbox.start();
    if (config.giteaBaseUrl !== undefined && config.giteaPlatformToken !== undefined && config.giteaPlatformToken.length > 0) {
      giteaSyncPublisher = new GiteaSyncPublisher(
        database,
        giteaClient ?? new GiteaClient({ baseUrl: config.giteaBaseUrl, token: config.giteaPlatformToken }),
        logger,
      );
      await giteaSyncPublisher.start();
    } else {
      logger.warn('Gitea status/comment sync disabled because GITEA_PLATFORM_TOKEN is not set');
    }
    const registry = config.registryApiUrl ?? (config.registryPullHost === undefined ? undefined : `http://${config.registryPullHost}`);
    const registryClient = registry === undefined ? undefined : new RegistryClient({ baseUrl: registry, ...(config.registryToken === undefined ? {} : { token: config.registryToken }) });
    retentionWorker = new RetentionWorker(database, logger, kubernetesClient, registryClient, config.logRoot, config.retentionIntervalMs);
    await retentionWorker.start();
    health.setQueueHealth('ready');
  } catch (error) {
    health.setQueueHealth('error');
    logger.error('workflow queue failed to start', {
      error: error instanceof Error ? error.message : String(error),
    });
    await health.stop();
    throw error;
  }
}

void bootstrap().catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      service: 'platform-worker',
      level: 'error',
      message: 'worker bootstrap failed',
      error: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
  process.exitCode = 1;
});
