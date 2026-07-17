import { randomBytes } from "node:crypto";

const baseUrl = new URL(process.env.GITEA_BASE_URL ?? "http://gitea:3000");
const token = process.env.GITEA_PLATFORM_TOKEN;
const webhookSecret = process.env.GITEA_WEBHOOK_SECRET;
const webhookUrl = process.env.PLATFORM_WEBHOOK_URL ?? "http://platform-api:3000/webhooks/gitea";
const owner = process.env.GITEA_FIXTURE_OWNER ?? "courseadmin";
const name = process.env.GITEA_FIXTURE_NAME ?? `course-node-good-${Date.now()}`;

if (!token || !webhookSecret) throw new Error("GITEA_PLATFORM_TOKEN and GITEA_WEBHOOK_SECRET are required");

function pathFor(path) {
  return new URL(`/api/v1${path}`, baseUrl).toString();
}

async function request(method, path, body) {
  const response = await fetch(pathFor(path), {
    method,
    headers: {
      Accept: "application/json",
      Authorization: `token ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let value;
  try {
    value = text.length === 0 ? undefined : JSON.parse(text);
  } catch {
    value = text;
  }
  if (!response.ok) throw new Error(`${method} ${path} failed with HTTP ${response.status}: ${text.slice(0, 1000)}`);
  return value;
}

const repositoryPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
const repository = await request("POST", "/user/repos", {
  name,
  description: "Remote course fixture for the AI-native PR quality platform",
  private: true,
  auto_init: true,
  default_branch: "main",
});

const nodePackage = {
  name,
  version: "0.1.0",
  private: true,
  scripts: { test: "node --check server.js" },
};
const server = [
  'const http = require("node:http");',
  'const port = Number(process.env.PORT || 3000);',
  'const server = http.createServer((request, response) => {',
  '  if (request.url === "/health" || request.url === "/healthz") {',
  '    response.writeHead(200, { "content-type": "application/json" });',
  '    response.end(JSON.stringify({ status: "ok" }));',
  '    return;',
  '  }',
  '  response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });',
  '  response.end("remote-node-good\\n");',
  '});',
  'server.listen(port, "0.0.0.0");',
  "",
].join("\n");

async function createFile(filePath, content, message) {
  return request("POST", `${repositoryPath}/contents/${filePath}`, {
    branch: "main",
    content: Buffer.from(content, "utf8").toString("base64"),
    message,
  });
}

await createFile("package.json", `${JSON.stringify(nodePackage, null, 2)}\n`, "Add Node fixture package");
await createFile("server.js", server, "Add Node fixture server");
await request("POST", `${repositoryPath}/branches`, { new_branch_name: "fixture", old_branch_name: "main" });

const source = await request("GET", `${repositoryPath}/contents/server.js?ref=main`);
const changedServer = server.replace("remote-node-good", "remote-node-good-pr");
await request("PUT", `${repositoryPath}/contents/server.js`, {
  branch: "fixture",
  sha: source.sha,
  content: Buffer.from(changedServer, "utf8").toString("base64"),
  message: "Update Node fixture response",
});

await request("POST", `${repositoryPath}/hooks`, {
  type: "gitea",
  config: { url: webhookUrl, content_type: "json", secret: webhookSecret },
  events: ["pull_request"],
  active: true,
});

const pullRequest = await request("POST", `${repositoryPath}/pulls`, {
  head: "fixture",
  base: "main",
  title: "Remote Node fixture",
  body: "Automated course fixture PR for the platform lifecycle verification.",
});

console.log(JSON.stringify({
  owner,
  name,
  fullName: `${owner}/${name}`,
  repositoryId: repository.id,
  pullRequestId: pullRequest.id,
  pullRequestNumber: pullRequest.number,
  headSha: pullRequest.head?.sha,
  webhookUrl,
  fixtureNonce: randomBytes(4).toString("hex"),
}));
