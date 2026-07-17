import { readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { IncomingHttpHeaders } from "node:http";
import type { KubernetesObject, KubernetesResourceClient, ManagedKubernetesObject } from "@platform/k8s";

export interface KubernetesHttpRequest {
  readonly method: string;
  readonly url: string;
  readonly serverName?: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly ca?: string;
  readonly cert?: string;
  readonly key?: string;
  readonly timeoutMs: number;
}

export interface KubernetesHttpResponse {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

export type KubernetesHttpTransport = (
  request: KubernetesHttpRequest,
) => Promise<KubernetesHttpResponse>;

export class KubernetesApiError extends Error {
  readonly status: number;
  readonly method: string;
  readonly path: string;
  readonly responseBody: string;

  constructor(input: {
    readonly status: number;
    readonly method: string;
    readonly path: string;
    readonly responseBody?: string;
  }) {
    const responseBody = input.responseBody?.trim().slice(0, 4096) ?? "";
    let detail = responseBody;
    try {
      const parsed = JSON.parse(responseBody) as { readonly message?: unknown };
      if (typeof parsed.message === "string") detail = parsed.message.slice(0, 1024);
    } catch {
      // Keep a bounded raw response for non-JSON API gateways.
    }
    super(`Kubernetes API ${input.method} ${input.path} failed with HTTP ${input.status}${detail.length === 0 ? "" : `: ${detail}`}`);
    this.name = "KubernetesApiError";
    this.status = input.status;
    this.method = input.method;
    this.path = input.path;
    this.responseBody = responseBody;
  }
}

interface KubeconfigCluster {
  server: string;
  certificateAuthority?: string;
  tlsServerName?: string;
}

interface KubeconfigUser {
  token?: string;
  certificate?: string;
  privateKey?: string;
}

interface KubeconfigContext {
  cluster: string;
  user: string;
}

function scalar(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Kubeconfig is intentionally parsed as the small, stable subset emitted by
 * k3d/k3s. The worker accepts either a bearer token or the client certificate
 * pair emitted by local k3d kubeconfigs; neither credential is copied into a
 * user Job.
 */
export function parseKubeconfig(value: string): {
  readonly server: string;
  readonly serverName?: string;
  readonly token?: string;
  readonly certificateAuthority?: string;
  readonly certificate?: string;
  readonly privateKey?: string;
} {
  const lines = value.split(/\r?\n/);
  let section: "clusters" | "contexts" | "users" | undefined;
  let currentName: string | undefined;
  let currentCluster: Partial<KubeconfigCluster> | undefined;
  let currentContext: Partial<KubeconfigContext> | undefined;
  let currentUser: Partial<KubeconfigUser> | undefined;
  const clusters = new Map<string, KubeconfigCluster>();
  const contexts = new Map<string, KubeconfigContext>();
  const users = new Map<string, KubeconfigUser>();
  let currentContextName: string | undefined;

  const flush = (): void => {
    if (section === "clusters" && currentName !== undefined && currentCluster?.server !== undefined) {
      clusters.set(currentName, currentCluster as KubeconfigCluster);
    }
    if (section === "contexts" && currentName !== undefined && currentContext?.cluster !== undefined && currentContext.user !== undefined) {
      contexts.set(currentName, currentContext as KubeconfigContext);
    }
    if (section === "users" && currentName !== undefined) {
      users.set(currentName, currentUser ?? {});
    }
    currentName = undefined;
    currentCluster = undefined;
    currentContext = undefined;
    currentUser = undefined;
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+#.*$/, "");
    if (/^clusters:\s*$/.test(line)) {
      flush();
      section = "clusters";
      continue;
    }
    if (/^contexts:\s*$/.test(line)) {
      flush();
      section = "contexts";
      continue;
    }
    if (/^users:\s*$/.test(line)) {
      flush();
      section = "users";
      continue;
    }
    const currentMatch = line.match(/^current-context:\s*(.+)$/);
    if (currentMatch) {
      currentContextName = scalar(currentMatch[1] ?? "");
      continue;
    }
    if (!section) continue;

    const itemMatch = line.match(/^\s*-\s+(cluster|context|user):\s*$/);
    if (itemMatch) {
      flush();
      if (itemMatch[1] === "cluster") currentCluster = {};
      if (itemMatch[1] === "context") currentContext = {};
      if (itemMatch[1] === "user") currentUser = {};
      continue;
    }
    const userNameItem = section === "users" ? line.match(/^\s*-\s+name:\s*(.+)$/) : null;
    if (userNameItem) {
      flush();
      currentName = scalar(userNameItem[1] ?? "");
      currentUser = {};
      continue;
    }
    const nameMatch = line.match(/^\s+name:\s*(.+)$/);
    if (nameMatch) {
      currentName = scalar(nameMatch[1] ?? "");
      continue;
    }
    const serverMatch = line.match(/^\s+server:\s*(.+)$/);
    if (serverMatch && currentCluster) {
      currentCluster.server = scalar(serverMatch[1] ?? "");
      continue;
    }
    const caMatch = line.match(/^\s+certificate-authority-data:\s*(.+)$/);
    if (caMatch && currentCluster) {
      currentCluster.certificateAuthority = Buffer.from(scalar(caMatch[1] ?? ""), "base64").toString("utf8");
      continue;
    }
    const tlsServerNameMatch = line.match(/^\s+tls-server-name:\s*(.+)$/);
    if (tlsServerNameMatch && currentCluster) {
      currentCluster.tlsServerName = scalar(tlsServerNameMatch[1] ?? "");
      continue;
    }
    const contextClusterMatch = line.match(/^\s+cluster:\s*(.+)$/);
    if (contextClusterMatch && currentContext) {
      currentContext.cluster = scalar(contextClusterMatch[1] ?? "");
      continue;
    }
    const contextUserMatch = line.match(/^\s+user:\s*(.+)$/);
    if (contextUserMatch && currentContext) {
      currentContext.user = scalar(contextUserMatch[1] ?? "");
      continue;
    }
    const tokenMatch = line.match(/^\s+token:\s*(.+)$/);
    if (tokenMatch && currentUser) {
      currentUser.token = scalar(tokenMatch[1] ?? "");
      continue;
    }
    const certificateMatch = line.match(/^\s+client-certificate-data:\s*(.+)$/);
    if (certificateMatch && currentUser) {
      currentUser.certificate = Buffer.from(scalar(certificateMatch[1] ?? ""), "base64").toString("utf8");
      continue;
    }
    const privateKeyMatch = line.match(/^\s+client-key-data:\s*(.+)$/);
    if (privateKeyMatch && currentUser) {
      currentUser.privateKey = Buffer.from(scalar(privateKeyMatch[1] ?? ""), "base64").toString("utf8");
    }
  }
  flush();

  if (!currentContextName) throw new Error("KUBECONFIG current-context is missing");
  const context = contexts.get(currentContextName);
  if (!context) throw new Error("KUBECONFIG current-context is unknown");
  const cluster = clusters.get(context.cluster);
  const user = users.get(context.user);
  if (!cluster?.server || (!user?.token && (!user?.certificate || !user.privateKey))) {
    throw new Error("KUBECONFIG must contain a bearer token or client certificate and cluster server");
  }
  return {
    server: cluster.server,
    ...(cluster.tlsServerName === undefined ? {} : { serverName: cluster.tlsServerName }),
    ...(user.token === undefined ? {} : { token: user.token }),
    ...(user.certificate === undefined ? {} : { certificate: user.certificate }),
    ...(user.privateKey === undefined ? {} : { privateKey: user.privateKey }),
    ...(cluster.certificateAuthority === undefined ? {} : { certificateAuthority: cluster.certificateAuthority }),
  };
}

function defaultTransport(input: KubernetesHttpRequest): Promise<KubernetesHttpResponse> {
  const url = new URL(input.url);
  if (url.protocol !== "https:") throw new Error("Kubernetes transport requires HTTPS");
  const requestFactory = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const requestOptions = {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port === "" ? undefined : Number(url.port),
      path: `${url.pathname}${url.search}`,
      method: input.method,
      // k3s may close an API connection while a Job is being polled. Do not
      // let Node 22's keep-alive global agent reuse that stale TLS socket.
      agent: false,
      headers: input.headers,
      timeout: input.timeoutMs,
      ...(input.ca === undefined ? {} : { ca: input.ca }),
      ...(input.cert === undefined ? {} : { cert: input.cert }),
      ...(input.key === undefined ? {} : { key: input.key }),
      ...(input.serverName === undefined ? {} : { servername: input.serverName }),
    };
    const request = requestFactory(requestOptions, (response) => {
      const chunks: Buffer[] = [];
      let length = 0;
      response.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        length += buffer.length;
        if (length <= 16 * 1024 * 1024) chunks.push(buffer);
      });
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
      response.on("error", reject);
    });
    request.on("error", reject);
    request.on("timeout", () => request.destroy(new Error("Kubernetes API request timed out")));
    if (input.body !== undefined) request.write(input.body);
    request.end();
  });
}

type ResourceDescriptor = {
  readonly group?: string;
  readonly version: string;
  readonly plural: string;
  readonly clusterScoped?: boolean;
};

const RESOURCE_DESCRIPTORS: Readonly<Record<string, ResourceDescriptor>> = {
  Namespace: { version: "v1", plural: "namespaces", clusterScoped: true },
  ServiceAccount: { version: "v1", plural: "serviceaccounts" },
  ResourceQuota: { version: "v1", plural: "resourcequotas" },
  LimitRange: { version: "v1", plural: "limitranges" },
  PersistentVolumeClaim: { version: "v1", plural: "persistentvolumeclaims" },
  Secret: { version: "v1", plural: "secrets" },
  Pod: { version: "v1", plural: "pods" },
  Service: { version: "v1", plural: "services" },
  Job: { group: "batch", version: "v1", plural: "jobs" },
  Deployment: { group: "apps", version: "v1", plural: "deployments" },
  Ingress: { group: "networking.k8s.io", version: "v1", plural: "ingresses" },
};

function descriptor(kind: string): ResourceDescriptor {
  const result = RESOURCE_DESCRIPTORS[kind];
  if (!result) throw new Error(`unsupported Kubernetes resource kind: ${kind}`);
  return result;
}

function resourcePath(input: {
  readonly apiVersion?: string;
  readonly kind: string;
  readonly namespace?: string;
  readonly name?: string;
}): string {
  const pathSegment = (value: string, field: string): string => {
    if (value.length === 0 || value === "." || value === ".." || value.includes("/") || value.includes("\\") || /[\u0000-\u001f\u007f]/.test(value)) {
      throw new Error(`${field} is not a safe Kubernetes path segment`);
    }
    return encodeURIComponent(value);
  };
  const resource = descriptor(input.kind);
  const apiRoot = resource.group === undefined ? `/api/${resource.version}` : `/apis/${resource.group}/${resource.version}`;
  const namespaceSegment = resource.clusterScoped
    ? ""
    : input.namespace === undefined
      ? ""
      : `/namespaces/${pathSegment(input.namespace, "namespace")}`;
  const nameSegment = input.name === undefined ? "" : `/${pathSegment(input.name, "name")}`;
  return `${apiRoot}${namespaceSegment}/${resource.plural}${nameSegment}`;
}

function parseJson<T>(body: string): T {
  if (body.trim() === "") return undefined as T;
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new Error("Kubernetes API returned invalid JSON");
  }
}

export interface KubernetesListResponse<T> {
  readonly items: readonly T[];
}

export class KubernetesApiClient implements KubernetesResourceClient {
  private readonly baseUrl: string;
  private readonly serverName: string | undefined;
  private readonly token: string;
  private readonly ca: string | undefined;
  private readonly certificate: string | undefined;
  private readonly privateKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly transport: KubernetesHttpTransport;

  constructor(options: {
    readonly server: string;
    readonly serverName?: string;
    readonly token?: string;
    readonly certificateAuthority?: string;
    readonly certificate?: string;
    readonly privateKey?: string;
    readonly timeoutMs?: number;
    readonly transport?: KubernetesHttpTransport;
  }) {
    const server = new URL(options.server);
    if (server.protocol !== "https:") throw new Error("Kubernetes server must use HTTPS");
    if (server.username || server.password) throw new Error("Kubernetes server must not contain credentials");
    if (server.pathname !== "/" || server.search || server.hash) throw new Error("Kubernetes server must not contain a path, query, or fragment");
    this.baseUrl = server.toString().replace(/\/$/, "");
    this.serverName = options.serverName;
    this.token = options.token ?? "";
    this.ca = options.certificateAuthority;
    this.certificate = options.certificate;
    this.privateKey = options.privateKey;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.transport = options.transport ?? defaultTransport;
    if ((this.token.length === 0 || this.token.length > 16_384) && (!this.certificate || !this.privateKey)) {
      throw new Error("Kubernetes credentials must contain a bearer token or client certificate");
    }
  }

  static async fromEnvironment(env: NodeJS.ProcessEnv = process.env): Promise<KubernetesApiClient> {
    const tokenFile = env.KUBERNETES_TOKEN_FILE ?? "/var/run/secrets/kubernetes.io/serviceaccount/token";
    if (env.KUBERNETES_SERVICE_HOST !== undefined) {
      const token = (await readFile(tokenFile, "utf8")).trim();
      const caPath = env.KUBERNETES_CA_FILE ?? "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt";
      const certificateAuthority = await readFile(caPath, "utf8");
      return new KubernetesApiClient({
        server: env.KUBERNETES_API_URL ?? `https://${env.KUBERNETES_SERVICE_HOST}:${env.KUBERNETES_SERVICE_PORT_HTTPS ?? "443"}`,
        token,
        ...(env.KUBERNETES_TLS_SERVER_NAME === undefined ? {} : { serverName: env.KUBERNETES_TLS_SERVER_NAME }),
        ...(certificateAuthority === undefined ? {} : { certificateAuthority }),
      });
    }
    if (env.KUBERNETES_API_URL !== undefined && env.KUBERNETES_TOKEN !== undefined) {
      const certificateAuthority = env.KUBERNETES_CA_FILE === undefined
        ? undefined
        : await readFile(env.KUBERNETES_CA_FILE, "utf8");
      return new KubernetesApiClient({
        server: env.KUBERNETES_API_URL,
        token: env.KUBERNETES_TOKEN,
        ...(env.KUBERNETES_TLS_SERVER_NAME === undefined ? {} : { serverName: env.KUBERNETES_TLS_SERVER_NAME }),
        ...(certificateAuthority === undefined ? {} : { certificateAuthority }),
      });
    }
    const kubeconfigPath = env.KUBECONFIG;
    if (!kubeconfigPath) throw new Error("Kubernetes credentials are not configured");
    const parsed = parseKubeconfig(await readFile(kubeconfigPath, "utf8"));
      return new KubernetesApiClient(parsed);
  }

  async get(input: {
    readonly apiVersion: string;
    readonly kind: string;
    readonly namespace?: string;
    readonly name: string;
  }): Promise<ManagedKubernetesObject | null> {
    const response = await this.raw("GET", resourcePath(input), undefined, true);
    return response === undefined ? null : parseJson<ManagedKubernetesObject>(response.body);
  }

  async create(resource: ManagedKubernetesObject): Promise<ManagedKubernetesObject> {
    return parseJson<ManagedKubernetesObject>(
      (await this.raw("POST", resourcePath({ kind: resource.kind, ...(resource.metadata.namespace === undefined ? {} : { namespace: resource.metadata.namespace }) }), resource))!.body,
    );
  }

  async update(resource: ManagedKubernetesObject): Promise<ManagedKubernetesObject> {
    return parseJson<ManagedKubernetesObject>(
      (await this.raw("PUT", resourcePath({ kind: resource.kind, ...(resource.metadata.namespace === undefined ? {} : { namespace: resource.metadata.namespace }), name: resource.metadata.name }), resource))!.body,
    );
  }

  async createRaw(resource: KubernetesObject): Promise<Record<string, unknown>> {
    return parseJson<Record<string, unknown>>(
      (await this.raw("POST", resourcePath({ kind: resource.kind, ...(resource.metadata.namespace === undefined ? {} : { namespace: resource.metadata.namespace }) }), resource))!.body,
    );
  }

  async getRaw(input: { readonly kind: string; readonly namespace?: string; readonly name: string }): Promise<Record<string, unknown> | null> {
    const response = await this.raw("GET", resourcePath(input), undefined, true);
    return response === undefined ? null : parseJson<Record<string, unknown>>(response.body);
  }

  async listRaw(input: { readonly kind: string; readonly namespace?: string; readonly labelSelector?: string }): Promise<KubernetesListResponse<Record<string, unknown>>> {
    const query = input.labelSelector === undefined ? "" : `?labelSelector=${encodeURIComponent(input.labelSelector)}`;
    return parseJson<KubernetesListResponse<Record<string, unknown>>>(
      (await this.raw("GET", `${resourcePath({ kind: input.kind, ...(input.namespace === undefined ? {} : { namespace: input.namespace }) })}${query}`))!.body,
    );
  }

  async delete(input: { readonly kind: string; readonly namespace?: string; readonly name: string; readonly uid: string }): Promise<boolean> {
    const body = { preconditions: { uid: input.uid } };
    const response = await this.raw("DELETE", resourcePath(input), body, true);
    return response !== undefined;
  }

  async logs(input: { readonly namespace: string; readonly podName: string; readonly containerName?: string; readonly tailLines?: number }): Promise<string> {
    const query = new URLSearchParams();
    if (input.containerName) query.set("container", input.containerName);
    if (input.tailLines !== undefined) query.set("tailLines", String(Math.max(1, Math.min(50_000, Math.floor(input.tailLines)))));
    query.set("timestamps", "true");
    const suffix = query.toString();
    return (await this.raw("GET", `${resourcePath({ kind: "Pod", namespace: input.namespace, name: input.podName })}/log?${suffix}`))!.body;
  }

  async listPods(namespace: string, labelSelector: string): Promise<readonly Record<string, unknown>[]> {
    return (await this.listRaw({ kind: "Pod", namespace, labelSelector })).items;
  }

  private async raw(method: string, path: string, body?: unknown, allowNotFound = false): Promise<KubernetesHttpResponse | undefined> {
    const response = await this.transport({
      method,
      url: `${this.baseUrl}${path}`,
      ...(this.serverName === undefined ? {} : { serverName: this.serverName }),
      headers: {
        ...(this.token.length === 0 ? {} : { authorization: `Bearer ${this.token}` }),
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(this.ca === undefined ? {} : { ca: this.ca }),
      ...(this.certificate === undefined ? {} : { cert: this.certificate }),
      ...(this.privateKey === undefined ? {} : { key: this.privateKey }),
      timeoutMs: this.timeoutMs,
    });
    if (allowNotFound && response.status === 404) return undefined;
    if (response.status < 200 || response.status >= 300) {
      throw new KubernetesApiError({ status: response.status, method, path, responseBody: response.body });
    }
    return response;
  }
}
