import { describe, expect, it } from "vitest";
import { GiteaApiError, GiteaClient, type GiteaFetch } from "./client.js";

function response(value: unknown, status = 200): { ok: boolean; status: number; json(): Promise<unknown>; text?(): Promise<string> } {
  return { ok: status >= 200 && status < 300, status, async json() { return value; } };
}

describe("Gitea client", () => {
  it("creates statuses and updates comments with token authentication", async () => {
    const requests: Request[] = [];
    const fetch: GiteaFetch = async (_url, init) => {
      requests.push(new Request(_url, init));
      if (init.method === "POST" && _url.includes("statuses")) return response({ id: 3, context: "platform/test", status: "success", description: "ok" });
      return response({ id: 4, body: "updated" });
    };
    const client = new GiteaClient({ baseUrl: "https://gitea.example.test", token: "secret", fetch });
    const status = await client.createCommitStatus({ owner: "course", repository: "demo", sha: "a".repeat(40), context: "platform/test", state: "success", description: "ok" });
    const comment = await client.updateIssueComment({ commentId: 4, body: "updated" });
    expect(status.id).toBe(3);
    expect(comment.id).toBe(4);
    expect(requests.every((request) => request.headers.get("authorization") === "token secret")).toBe(true);
    expect(requests[0]?.url).toContain("/api/v1/repos/course/demo/statuses/");
  });

  it("parses lists and exposes only safe API error metadata", async () => {
    const fetch: GiteaFetch = async (url) => {
      if (url.includes("statuses")) return response([{ id: 1, context: "platform/build", status: "failure", description: "failed" }]);
      return response("forbidden", 403);
    };
    const client = new GiteaClient({ baseUrl: "https://gitea.example.test", token: "secret", fetch });
    await expect(client.listCommitStatuses("course", "demo", "a".repeat(40))).resolves.toMatchObject([{ id: 1, state: "failure" }]);
    await expect(client.listIssueComments("course", "demo", 1)).rejects.toBeInstanceOf(GiteaApiError);
    await expect(client.listIssueComments("course", "demo", 1)).rejects.not.toThrow("forbidden");
  });

  it("fetches a pull request diff as text with token authentication", async () => {
    const requests: Request[] = [];
    const fetch: GiteaFetch = async (url, init) => {
      requests.push(new Request(url, init));
      return {
        ok: true,
        status: 200,
        async json() { return null; },
        async text() { return "diff --git a/app.js b/app.js\n+++ b/app.js\n@@ -1 +1 @@\n+ok\n"; },
      };
    };
    const client = new GiteaClient({ baseUrl: "https://gitea.example.test", token: "secret", fetch });
    await expect(client.getPullRequestDiff("course", "demo", 7)).resolves.toContain("+++ b/app.js");
    expect(requests[0]?.url).toContain("/api/v1/repos/course/demo/pulls/7.diff");
    expect(requests[0]?.headers.get("accept")).toBe("text/plain");
    expect(requests[0]?.headers.get("authorization")).toBe("token secret");
  });

  it("rejects an oversized pull request diff before it reaches the Agent", async () => {
    const fetch: GiteaFetch = async () => ({
      ok: true,
      status: 200,
      async json() { return null; },
      async text() { return "x".repeat(2 * 1024 * 1024 + 1); },
    });
    const client = new GiteaClient({ baseUrl: "https://gitea.example.test", token: "secret", fetch });
    await expect(client.getPullRequestDiff("course", "demo", 7)).rejects.toThrow(/exceeds/);
  });

  it("lists only safe blob paths for profile detection", async () => {
    const requests: Request[] = [];
    const fetch: GiteaFetch = async (url, init) => {
      requests.push(new Request(url, init));
      return response({ tree: [
        { path: "package.json", type: "blob" },
        { path: "server.js", type: "blob" },
        { path: "src", type: "tree" },
      ] });
    };
    const client = new GiteaClient({ baseUrl: "https://gitea.example.test", token: "secret", fetch });
    await expect(client.listRepositoryFiles("course", "demo", "a".repeat(40))).resolves.toEqual(["package.json", "server.js"]);
    expect(requests[0]?.url).toContain("/git/trees/" + "a".repeat(40) + "?recursive=true");
  });
});
