import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgres://platform:platform@127.0.0.1:5432/platform";
process.env.GITEA_BASE_URL ??= "http://gitea.test";
process.env.GITEA_WEBHOOK_SECRET ??= "test-webhook-secret";
process.env.SESSION_ENCRYPTION_KEY ??= "12345678901234567890123456789012";
process.env.K8S_MODE ??= "server";
process.env.PREVIEW_MODE ??= "ingress";
process.env.PREVIEW_BASE_URL ??= "http://preview.test";
process.env.REGISTRY_PUSH_HOST ??= "registry.test:5000";
process.env.REGISTRY_PULL_HOST ??= "registry.test:5000";
process.env.AGENT_PROVIDER ??= "mock";

const { createApiApp } = await import("../dist/app.js");
const app = await createApiApp();

try {
  await app.init();
  const server = app.getHttpAdapter().getInstance();

  const health = await server.inject({ method: "GET", url: "/healthz" });
  assert.equal(health.statusCode, 200);
  assert.deepEqual(JSON.parse(health.body), { status: "ok" });

  const webhook = await server.inject({
    method: "POST",
    url: "/webhooks/gitea",
    headers: {
      "content-type": "application/json",
      "x-gitea-delivery": "e2e-delivery",
      "x-gitea-signature": "sha256=invalid",
    },
    payload: JSON.stringify({ action: "opened" }),
  });
  assert.equal(webhook.statusCode, 401);

  process.stdout.write(`${JSON.stringify({ health: 200, invalidWebhook: 401 })}\n`);
} finally {
  await app.close();
}
