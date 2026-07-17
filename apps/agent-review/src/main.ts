import { createConfiguredProvider, loadConfig } from "./config.js";
import { ReviewHttpServer } from "./http.js";
import { AgentReviewService } from "./service.js";
import { createPgBoss, startReviewQueue } from "./queue.js";

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const provider = createConfiguredProvider(config);
  const service = new AgentReviewService(provider);
  const boss = config.databaseUrl === undefined ? undefined : createPgBoss(config.databaseUrl);
  let queueReady = boss === undefined;
  const server = new ReviewHttpServer({
    service,
    ready: () => queueReady,
    maxBodyBytes: config.maxHttpBodyBytes,
  });

  await server.start(config.host, config.port);
  if (boss !== undefined) {
    await boss.start();
    await startReviewQueue(boss, service);
    queueReady = true;
  }

  const shutdown = async (): Promise<void> => {
    await server.stop();
    await boss?.stop();
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

void bootstrap().catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({
      service: "agent-review",
      level: "error",
      message: "agent review bootstrap failed",
      error: error instanceof Error ? error.message : "unknown error",
    })}\n`,
  );
  process.exitCode = 1;
});
