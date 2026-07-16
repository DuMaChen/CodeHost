export type GiteaStatusState = "pending" | "success" | "failure" | "error";

export interface GiteaCommitStatus {
  readonly id: number;
  readonly context: string;
  readonly state: string;
  readonly description: string;
  readonly targetUrl?: string;
}

export interface GiteaIssueComment {
  readonly id: number;
  readonly body: string;
}

export class GiteaApiError extends Error {
  readonly status: number;
  readonly method: string;
  readonly path: string;

  constructor(input: { readonly status: number; readonly method: string; readonly path: string }) {
    super(`Gitea API ${input.method} ${input.path} failed with HTTP ${input.status}`);
    this.name = "GiteaApiError";
    this.status = input.status;
    this.method = input.method;
    this.path = input.path;
  }
}

export interface GiteaFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
  text?(): Promise<string>;
}

export type GiteaFetch = (url: string, init: RequestInit) => Promise<GiteaFetchResponse>;
const MAX_PULL_REQUEST_DIFF_BYTES = 2 * 1024 * 1024;
const MAX_REPOSITORY_FILES = 10_000;

function requiredId(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error(`Gitea ${field} is invalid`);
  return value;
}

function stringField(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`Gitea ${field} is invalid`);
  return value;
}

function parseStatus(value: unknown): GiteaCommitStatus {
  if (typeof value !== "object" || value === null) throw new Error("Gitea status response is invalid");
  const item = value as Record<string, unknown>;
  const targetUrl = item.target_url ?? item.targetUrl;
  return {
    id: requiredId(item.id, "status.id"),
    context: stringField(item.context, "status.context"),
    state: stringField(item.status ?? item.state, "status.state"),
    description: stringField(item.description, "status.description"),
    ...(typeof targetUrl === "string" && targetUrl.length > 0 ? { targetUrl } : {}),
  };
}

function parseComment(value: unknown): GiteaIssueComment {
  if (typeof value !== "object" || value === null) throw new Error("Gitea comment response is invalid");
  const item = value as Record<string, unknown>;
  return { id: requiredId(item.id, "comment.id"), body: stringField(item.body, "comment.body") };
}

function encodeSegment(value: string, field: string): string {
  if (value.length === 0 || value === "." || value === ".." || value.includes("/") || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`Gitea ${field} is invalid`);
  }
  return encodeURIComponent(value);
}

function boundedDescription(value: string): string {
  const bytes = Buffer.from(value, "utf8");
  return bytes.length <= 140 ? value : `${bytes.subarray(0, 137).toString("utf8")}...`;
}

export class GiteaClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetch: GiteaFetch;
  private readonly timeoutMs: number;

  constructor(options: {
    readonly baseUrl: string;
    readonly token: string;
    readonly fetch?: GiteaFetch;
    readonly timeoutMs?: number;
  }) {
    const baseUrl = new URL(options.baseUrl);
    if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") throw new Error("Gitea base URL must use HTTP(S)");
    if (baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) throw new Error("Gitea base URL must not contain credentials, query, or fragment");
    this.baseUrl = baseUrl.toString().replace(/\/$/, "");
    this.token = options.token;
    this.fetch = options.fetch ?? ((url, init) => globalThis.fetch(url, init) as Promise<GiteaFetchResponse>);
    this.timeoutMs = options.timeoutMs ?? 15_000;
    if (this.token.length === 0 || this.token.length > 16_384) throw new Error("Gitea token is invalid");
  }

  async listCommitStatuses(owner: string, repository: string, sha: string): Promise<readonly GiteaCommitStatus[]> {
    const values: GiteaCommitStatus[] = [];
    for (let page = 1; page <= 10; page += 1) {
      const payload = await this.request<unknown>("GET", this.statusPath(owner, repository, sha, page));
      if (!Array.isArray(payload)) throw new Error("Gitea status list response is invalid");
      values.push(...payload.map(parseStatus));
      if (payload.length < 50) break;
    }
    return values;
  }

  async createCommitStatus(input: {
    readonly owner: string;
    readonly repository: string;
    readonly sha: string;
    readonly context: string;
    readonly state: GiteaStatusState;
    readonly description: string;
    readonly targetUrl?: string;
  }): Promise<GiteaCommitStatus> {
    const payload = await this.request<unknown>("POST", this.statusPath(input.owner, input.repository, input.sha), {
      state: input.state,
      context: input.context,
      description: boundedDescription(input.description),
      ...(input.targetUrl === undefined ? {} : { target_url: input.targetUrl }),
    });
    return parseStatus(payload);
  }

  async getPullRequestDiff(owner: string, repository: string, issueNumber: number): Promise<string> {
    if (!Number.isSafeInteger(issueNumber) || issueNumber < 1 || issueNumber > 2_147_483_647) {
      throw new Error("Gitea issue number is invalid");
    }
    const diff = await this.requestText(
      "GET",
      `/api/v1/repos/${encodeSegment(owner, "owner")}/${encodeSegment(repository, "repository")}/pulls/${issueNumber}.diff`,
    );
    if (Buffer.byteLength(diff, "utf8") > MAX_PULL_REQUEST_DIFF_BYTES) {
      throw new Error("Gitea pull request diff exceeds the platform limit");
    }
    return diff;
  }

  async listRepositoryFiles(owner: string, repository: string, sha: string): Promise<readonly string[]> {
    if (!/^[0-9a-fA-F]{7,128}$/.test(sha)) throw new Error("Gitea tree SHA is invalid");
    const payload = await this.request<unknown>(
      "GET",
      `/api/v1/repos/${encodeSegment(owner, "owner")}/${encodeSegment(repository, "repository")}/git/trees/${encodeSegment(sha, "sha")}?recursive=true`,
    );
    if (typeof payload !== "object" || payload === null) throw new Error("Gitea tree response is invalid");
    const tree = (payload as Record<string, unknown>).tree;
    if (!Array.isArray(tree) || (payload as Record<string, unknown>).truncated === true) throw new Error("Gitea tree response is incomplete");
    const files: string[] = [];
    for (const entry of tree) {
      if (typeof entry !== "object" || entry === null) throw new Error("Gitea tree entry is invalid");
      const item = entry as Record<string, unknown>;
      if (item.type !== "blob") continue;
      if (typeof item.path !== "string" || item.path.length === 0 || item.path.length > 1024 || item.path.startsWith("/") || item.path.includes("\\") || item.path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
        throw new Error("Gitea tree path is invalid");
      }
      files.push(item.path);
      if (files.length > MAX_REPOSITORY_FILES) throw new Error("Gitea repository has too many files");
    }
    return files;
  }

  async listIssueComments(owner: string, repository: string, issueNumber: number): Promise<readonly GiteaIssueComment[]> {
    if (!Number.isSafeInteger(issueNumber) || issueNumber < 1 || issueNumber > 2_147_483_647) throw new Error("Gitea issue number is invalid");
    const values: GiteaIssueComment[] = [];
    for (let page = 1; page <= 10; page += 1) {
      const path = `/api/v1/repos/${encodeSegment(owner, "owner")}/${encodeSegment(repository, "repository")}/issues/${issueNumber}/comments?limit=50&page=${page}`;
      const payload = await this.request<unknown>("GET", path);
      if (!Array.isArray(payload)) throw new Error("Gitea comment list response is invalid");
      values.push(...payload.map(parseComment));
      if (payload.length < 50) break;
    }
    return values;
  }

  async createIssueComment(input: { readonly owner: string; readonly repository: string; readonly issueNumber: number; readonly body: string }): Promise<GiteaIssueComment> {
    if (!Number.isSafeInteger(input.issueNumber) || input.issueNumber < 1 || input.issueNumber > 2_147_483_647) throw new Error("Gitea issue number is invalid");
    const payload = await this.request<unknown>("POST", `/api/v1/repos/${encodeSegment(input.owner, "owner")}/${encodeSegment(input.repository, "repository")}/issues/${input.issueNumber}/comments`, { body: input.body });
    return parseComment(payload);
  }

  async updateIssueComment(input: { readonly commentId: number; readonly body: string }): Promise<GiteaIssueComment> {
    if (!Number.isSafeInteger(input.commentId) || input.commentId < 1) throw new Error("Gitea comment ID is invalid");
    const payload = await this.request<unknown>("PATCH", `/api/v1/repos/issues/comments/${input.commentId}`, { body: input.body });
    return parseComment(payload);
  }

  private statusPath(owner: string, repository: string, sha: string, page?: number): string {
    const encoded = `/api/v1/repos/${encodeSegment(owner, "owner")}/${encodeSegment(repository, "repository")}/statuses/${encodeSegment(sha, "sha")}`;
    return page === undefined ? encoded : `${encoded}?limit=50&page=${page}`;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetch(`${this.baseUrl}${path}`, {
        method,
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          Authorization: `token ${this.token}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) throw new GiteaApiError({ status: response.status, method, path });
      return await response.json() as T;
    } finally {
      clearTimeout(timer);
    }
  }

  private async requestText(method: string, path: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetch(`${this.baseUrl}${path}`, {
        method,
        signal: controller.signal,
        headers: {
          Accept: "text/plain",
          Authorization: `token ${this.token}`,
        },
      });
      if (!response.ok) throw new GiteaApiError({ status: response.status, method, path });
      if (typeof response.text !== "function") throw new Error("Gitea diff response does not provide text()");
      return await response.text();
    } finally {
      clearTimeout(timer);
    }
  }
}
