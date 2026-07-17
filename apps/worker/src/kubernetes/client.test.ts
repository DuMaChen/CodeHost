import { describe, expect, it } from "vitest";
import { KubernetesApiClient, KubernetesApiError, parseKubeconfig, type KubernetesHttpTransport } from "./client.js";

describe("Kubernetes API client", () => {
  it("parses the bearer-token subset of a k3d kubeconfig", () => {
    const result = parseKubeconfig(`
apiVersion: v1
clusters:
- cluster:
    certificate-authority-data: Y2E=
    server: https://127.0.0.1:6550
    tls-server-name: k3d-ai-platform-server-0
  name: local
contexts:
- context:
    cluster: local
    user: local-user
  name: local-context
current-context: local-context
users:
- name: local-user
  user:
    token: bearer-token
`);
    expect(result).toEqual({ server: "https://127.0.0.1:6550", serverName: "k3d-ai-platform-server-0", token: "bearer-token", certificateAuthority: "ca" });
  });

  it("passes the configured TLS server name to the transport", async () => {
    let serverName: string | undefined;
    const transport: KubernetesHttpTransport = async (request) => {
      serverName = request.serverName;
      return { status: 404, headers: {}, body: "" };
    };
    const client = new KubernetesApiClient({ server: "https://host.docker.internal:6550", serverName: "k3d-ai-platform-server-0", token: "token", transport });
    await expect(client.get({ apiVersion: "v1", kind: "Namespace", name: "pr-run-x" })).resolves.toBeNull();
    expect(serverName).toBe("k3d-ai-platform-server-0");
  });

  it("uses Kubernetes API paths and sends UID delete preconditions", async () => {
    const calls: Array<{ method: string; url: string; body?: string }> = [];
    const transport: KubernetesHttpTransport = async (request) => {
      calls.push({ method: request.method, url: request.url, ...(request.body === undefined ? {} : { body: request.body }) });
      if (request.method === "GET") return { status: 404, headers: {}, body: "" };
      if (request.method === "DELETE") return { status: 200, headers: {}, body: "{}" };
      return { status: 201, headers: {}, body: JSON.stringify({ apiVersion: "v1", kind: "Namespace", metadata: { name: "pr-run-x" } }) };
    };
    const client = new KubernetesApiClient({ server: "https://kube.test", token: "token", transport });
    await expect(client.get({ apiVersion: "v1", kind: "Namespace", name: "pr-run-x" })).resolves.toBeNull();
    await client.create({ apiVersion: "v1", kind: "Namespace", metadata: { name: "pr-run-x" } });
    await client.delete({ kind: "Namespace", name: "pr-run-x", uid: "uid-1" });
    expect(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
      "GET /api/v1/namespaces/pr-run-x",
      "POST /api/v1/namespaces",
      "DELETE /api/v1/namespaces/pr-run-x",
    ]);
    expect(calls[2]?.body).toBe(JSON.stringify({ preconditions: { uid: "uid-1" } }));
  });

  it("keeps non-404 API failures observable", async () => {
    const transport: KubernetesHttpTransport = async () => ({ status: 403, headers: {}, body: JSON.stringify({ message: "forbidden by policy", details: { secret: "must not be logged" } }) });
    const client = new KubernetesApiClient({ server: "https://kube.test", token: "token", transport });
    await expect(client.get({ apiVersion: "v1", kind: "Namespace", name: "pr-run-x" })).rejects.toMatchObject({
      status: 403,
      method: "GET",
      responseBody: expect.stringContaining("forbidden by policy"),
      message: expect.stringContaining("forbidden by policy"),
    } satisfies Partial<KubernetesApiError>);
  });
});
