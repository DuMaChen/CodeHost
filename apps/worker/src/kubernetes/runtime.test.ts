import { describe, expect, it } from "vitest";
import { KubernetesApiClient, type KubernetesHttpTransport } from "./client.js";
import { KubernetesStepExecutor, parseUnifiedDiffEvidence } from "./runtime.js";
import type { StepExecutionContext } from "../workflow/types.js";

const runId = "11111111-1111-4111-8111-111111111111";
const digest = "sha256:" + "a".repeat(64);

function context(stepKey: StepExecutionContext["job"]["stepKey"]): StepExecutionContext {
  return {
    run: {
      id: runId,
      attempt: 1,
      headSha: "b".repeat(40),
      status: "EXECUTING",
      cleanupStatus: "NOT_SCHEDULED",
      repositoryFullName: "course/example",
      pullRequestNumber: 7,
    },
    job: { runId, attempt: 1, headSha: "b".repeat(40), stepKey },
    capacity: { maxActiveRuns: 1, maxQueuedRuns: 3, maxStepLogBytes: 1024 * 1024, maxReviewInputBytes: 64 * 1024 },
  };
}

function fakeCluster(): {
  readonly transport: KubernetesHttpTransport;
  readonly resources: Map<string, Record<string, unknown>>;
  readonly requests: Array<{ readonly method: string; readonly path: string }>;
} {
  const resources = new Map<string, Record<string, unknown>>();
  const requests: Array<{ readonly method: string; readonly path: string }> = [];
  let uid = 0;
  const transport: KubernetesHttpTransport = async (request) => {
    const url = new URL(request.url);
    const path = url.pathname;
    requests.push({ method: request.method, path });
    const key = `${request.method} ${path}`;
    if (request.method === "GET" && path.endsWith("/log")) return { status: 200, headers: {}, body: "2026-01-01T00:00:00Z runner passed\n" };
    if (request.method === "GET" && path.includes("/pods") && !path.match(/\/pods\/[^/]+$/)) {
      return { status: 200, headers: {}, body: JSON.stringify({ items: [{ metadata: { name: "run-pod", labels: {} } }] }) };
    }
    if (request.method === "GET") {
      const resource = resources.get(path);
      if (!resource) return { status: 404, headers: {}, body: "" };
      return { status: 200, headers: {}, body: JSON.stringify(resource) };
    }
    if (request.method === "POST") {
      const body = JSON.parse(request.body ?? "{}") as Record<string, unknown>;
      const metadata: Record<string, unknown> = { ...(body.metadata as Record<string, unknown>), uid: `uid-${++uid}` };
      const resource: Record<string, unknown> = { ...body, metadata };
      const kind = String(body.kind);
      const name = String(metadata.name);
      const namespace = typeof metadata.namespace === "string" ? `/namespaces/${metadata.namespace}` : "";
      const apiGroup: Record<string, string> = {
        Namespace: "/api/v1", ResourceQuota: "/api/v1", LimitRange: "/api/v1",
        PersistentVolumeClaim: "/api/v1", ServiceAccount: "/api/v1",
        Secret: "/api/v1", Pod: "/api/v1", Service: "/api/v1",
        Job: "/apis/batch/v1", Deployment: "/apis/apps/v1",
        Ingress: "/apis/networking.k8s.io/v1",
      };
      const prefix = apiGroup[kind] ?? "/api/v1";
      const plural: Record<string, string> = { Namespace: "namespaces", ResourceQuota: "resourcequotas", LimitRange: "limitranges", PersistentVolumeClaim: "persistentvolumeclaims", ServiceAccount: "serviceaccounts", Secret: "secrets", Pod: "pods", Job: "jobs", Deployment: "deployments", Service: "services", Ingress: "ingresses" };
      const pathKey = `${prefix}${kind === "Namespace" ? "" : namespace}/${plural[kind]}/${name}`;
      if (kind === "Job") resource.status = { succeeded: 1 };
      if (kind === "Deployment") resource.status = { availableReplicas: 1, updatedReplicas: 1 };
      resources.set(pathKey, resource);
      return { status: 201, headers: {}, body: JSON.stringify(resource) };
    }
    if (request.method === "DELETE") {
      const basePath = path;
      resources.delete(basePath);
      return { status: 200, headers: {}, body: "{}" };
    }
    throw new Error(`unexpected ${key}`);
  };
  return { transport, resources, requests };
}

describe("Kubernetes workflow executor", () => {
  it.each([
    { mode: "local" as const, expected: /^service:\/\/pr-run-[a-z0-9-]+\/[a-z0-9-]+$/ },
    { mode: "ssh" as const, expected: /^service:\/\/pr-run-[a-z0-9-]+\/[a-z0-9-]+$/ },
    { mode: "ingress" as const, expected: /^https:\/\/[^/]+$/ },
  ])("returns a persisted Preview reference for $mode after resources reconcile", async ({ mode, expected }) => {
    const cluster = fakeCluster();
    const client = new KubernetesApiClient({ server: "https://kube.test", token: "worker", transport: cluster.transport });
    const executor = new KubernetesStepExecutor({
      client,
      runnerImage: `registry.example.test/platform/runner@${digest}`,
      previewImage: `registry.example.test/course/app@${digest}`,
      giteaBaseUrl: "https://gitea.example.test",
      previewMode: mode,
      ...(mode === "ingress" ? { previewBaseUrl: "https://preview.example.test", previewTlsSecretName: "preview-tls" } : {}),
      pollIntervalMs: 0,
      sleep: async () => undefined,
    });

    const result = await executor.execute(context("preview"));
    expect(result).toMatchObject({ status: "PASSED", details: { mode: "kubernetes" } });
    const details = result.details as Record<string, unknown>;
    expect(details.previewHost).toEqual(expect.stringMatching(expected));
    expect(new Date(String(details.previewExpiresAt)).getTime()).toBeGreaterThan(Date.now());
  });

  it("reports an application health failure after the Preview process is ready", async () => {
    const cluster = fakeCluster();
    const healthRequests: string[] = [];
    const client = new KubernetesApiClient({ server: "https://kube.test", token: "worker", transport: cluster.transport });
    const executor = new KubernetesStepExecutor({
      client,
      runnerImage: `registry.example.test/platform/runner@${digest}`,
      previewImage: `registry.example.test/course/app@${digest}`,
      giteaBaseUrl: "https://gitea.example.test",
      previewMode: "ssh",
      pollIntervalMs: 0,
      sleep: async () => undefined,
      fetch: async (url) => {
        healthRequests.push(url.toString());
        return { ok: false, status: 500 } as Response;
      },
    });

    await expect(executor.execute(context("preview"))).resolves.toMatchObject({ status: "PASSED" });
    await expect(executor.execute(context("health"))).resolves.toMatchObject({
      status: "FAILED",
      failureKind: "application",
      errorCode: "PREVIEW_HEALTH_CHECK_FAILED",
      details: { status: 500, healthPath: "/health" },
    });
    expect(healthRequests).toEqual(["http://run-111111111111-a1-preview.pr-run-111111111111.svc.cluster.local/health"]);
  });

  it("parses current-head files and changed line ranges from a unified diff", () => {
    const evidence = parseUnifiedDiffEvidence([
      "diff --git a/app.js b/app.js",
      "--- a/app.js",
      "+++ b/app.js",
      "@@ -2,2 +2,4 @@",
      " context",
      "+added",
      "+added-again",
      " context",
      "diff --git a/removed.txt b/removed.txt",
      "--- a/removed.txt",
      "+++ /dev/null",
    ].join("\n"));
    expect(evidence.filePaths).toEqual(["app.js"]);
    expect(evidence.changedFiles["app.js"]).toEqual([{ lineStart: 3, lineEnd: 4 }]);
    expect(evidence.changedFiles["removed.txt"]).toBeUndefined();
  });

  it("creates a restricted Source Fetch Job, redacts logs, and deletes its short-lived Secret", async () => {
    const cluster = fakeCluster();
    const client = new KubernetesApiClient({ server: "https://kube.test", token: "worker", transport: cluster.transport });
    const executor = new KubernetesStepExecutor({
      client,
      runnerImage: `registry.example.test/platform/runner@${digest}`,
      previewImage: `registry.example.test/course/app@${digest}`,
      giteaBaseUrl: "https://gitea.example.test",
      giteaRunnerToken: "secret-token",
      previewMode: "ingress",
      previewBaseUrl: "https://preview.example.test",
      pollIntervalMs: 0,
      sleep: async () => undefined,
    });
    const result = await executor.execute(context("fetch"));
    expect(result).toMatchObject({ status: "PASSED", details: { mode: "kubernetes", jobName: expect.stringContaining("fetch") } });
    expect(JSON.stringify(result)).not.toContain("secret-token");
    expect(cluster.requests.some(({ method, path }) => method === "GET" && path.includes("/secrets/"))).toBe(false);
    expect([...cluster.resources.keys()].some((key) => key.includes("/secrets/source-token"))).toBe(false);
    expect([...cluster.resources.keys()].some((key) => key.includes("/jobs/run-"))).toBe(false);
  });

  it("detects a repository profile from the Gitea tree without accepting commands", async () => {
    const cluster = fakeCluster();
    const client = new KubernetesApiClient({ server: "https://kube.test", token: "worker", transport: cluster.transport });
    const executor = new KubernetesStepExecutor({
      client,
      runnerImage: `registry.example.test/platform/runner@${digest}`,
      previewImage: `registry.example.test/course/app@${digest}`,
      giteaBaseUrl: "https://gitea.example.test",
      previewMode: "ingress",
      previewBaseUrl: "https://preview.example.test",
      giteaClient: {
        async getPullRequestDiff() { return ""; },
        async listRepositoryFiles() { return ["requirements.txt", "main.py", "README.md"]; },
      },
    });
    const result = await executor.execute(context("detect"));
    expect(result).toMatchObject({
      status: "PASSED",
      details: {
        projectType: "python",
        profile: "python-http",
        port: 8000,
        executionPlan: { testProfile: "python-basic", entrypoint: "main.py" },
      },
    });
    expect(JSON.stringify(result)).not.toContain("command");
  });

  it("fails closed when cleanup finds a namespace owned by another run", async () => {
    const cluster = fakeCluster();
    const namespacePath = "/api/v1/namespaces/pr-run-111111111111";
    cluster.resources.set(namespacePath, { apiVersion: "v1", kind: "Namespace", metadata: { name: "pr-run-111111111111", labels: { "platform.io/managed": "true", "platform.io/run-id": "other-run" } } });
    const client = new KubernetesApiClient({ server: "https://kube.test", token: "worker", transport: cluster.transport });
    const executor = new KubernetesStepExecutor({
      client,
      runnerImage: `registry.example.test/platform/runner@${digest}`,
      previewImage: `registry.example.test/course/app@${digest}`,
      giteaBaseUrl: "https://gitea.example.test",
      previewMode: "ingress",
      previewBaseUrl: "https://preview.example.test",
      pollIntervalMs: 0,
      sleep: async () => undefined,
    });
    const result = await executor.execute(context("cleanup"));
    expect(result).toMatchObject({ status: "INCOMPLETE", errorCode: "NAMESPACE_OWNERSHIP_CONFLICT" });
    expect(cluster.resources.has(namespacePath)).toBe(true);
  });

  it("makes a transient namespace lookup failure retryable", async () => {
    const cluster = fakeCluster();
    const namespacePath = "/api/v1/namespaces/pr-run-111111111111";
    const transport: KubernetesHttpTransport = async (request) => {
      if (request.method === "GET" && new URL(request.url).pathname === namespacePath) {
        return { status: 400, headers: {}, body: "" };
      }
      return cluster.transport(request);
    };
    const client = new KubernetesApiClient({ server: "https://kube.test", token: "worker", transport });
    const executor = new KubernetesStepExecutor({
      client,
      runnerImage: `registry.example.test/platform/runner@${digest}`,
      previewImage: `registry.example.test/course/app@${digest}`,
      giteaBaseUrl: "https://gitea.example.test",
      previewMode: "ingress",
      previewBaseUrl: "https://preview.example.test",
      pollIntervalMs: 0,
      sleep: async () => undefined,
    });
    await expect(executor.execute(context("cleanup"))).resolves.toMatchObject({
      status: "INCOMPLETE",
      errorCode: "NAMESPACE_LOOKUP_UNAVAILABLE",
    });
  });

  it("does not mark a namespace cleaned when the delete request fails", async () => {
    const cluster = fakeCluster();
    const namespacePath = "/api/v1/namespaces/pr-run-111111111111";
    cluster.resources.set(namespacePath, {
      apiVersion: "v1",
      kind: "Namespace",
      metadata: {
        name: "pr-run-111111111111",
        uid: "namespace-uid",
        labels: { "platform.io/managed": "true", "platform.io/run-id": runId },
      },
    });
    const transport: KubernetesHttpTransport = async (request) => {
      if (request.method === "DELETE" && new URL(request.url).pathname === namespacePath) {
        return { status: 400, headers: {}, body: "" };
      }
      return cluster.transport(request);
    };
    const client = new KubernetesApiClient({ server: "https://kube.test", token: "worker", transport });
    const executor = new KubernetesStepExecutor({
      client,
      runnerImage: `registry.example.test/platform/runner@${digest}`,
      previewImage: `registry.example.test/course/app@${digest}`,
      giteaBaseUrl: "https://gitea.example.test",
      previewMode: "ingress",
      previewBaseUrl: "https://preview.example.test",
      pollIntervalMs: 0,
      sleep: async () => undefined,
    });
    await expect(executor.execute(context("cleanup"))).resolves.toMatchObject({
      status: "INCOMPLETE",
      errorCode: "NAMESPACE_DELETE_REQUEST_FAILED",
    });
    expect(cluster.resources.has(namespacePath)).toBe(true);
  });

  it("turns an active Job past its deadline into an incomplete result and cleans it up", async () => {
    const cluster = fakeCluster();
    const transport: KubernetesHttpTransport = async (request) => {
      const response = await cluster.transport(request);
      if (request.method === "GET" && response.status === 200 && new URL(request.url).pathname.includes("/jobs/")) {
        const resource = JSON.parse(response.body) as Record<string, unknown>;
        return { ...response, body: JSON.stringify({ ...resource, status: { active: 1 } }) };
      }
      return response;
    };
    const client = new KubernetesApiClient({ server: "https://kube.test", token: "worker", transport });
    const executor = new KubernetesStepExecutor({
      client,
      runnerImage: `registry.example.test/platform/runner@${digest}`,
      previewImage: `registry.example.test/course/app@${digest}`,
      giteaBaseUrl: "https://gitea.example.test",
      previewMode: "ingress",
      pollIntervalMs: 0,
      jobTimeoutMs: 1,
      sleep: async () => undefined,
    });
    const result = await executor.execute(context("test"));
    expect(result).toMatchObject({ status: "INCOMPLETE", errorCode: "JOB_TIMEOUT" });
    expect([...cluster.resources.keys()].some((key) => key.includes("/jobs/"))).toBe(false);
  });
});
