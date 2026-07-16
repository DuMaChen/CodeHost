export type ProjectType = "node" | "python";
export type ProjectProfile = "node-http" | "python-http";
export type TestProfile = "node-basic" | "python-basic";

export interface ProjectProfilePlan {
  readonly projectType: ProjectType;
  readonly profile: ProjectProfile;
  readonly port: 3000 | 8000;
  readonly healthPath: "/health";
  readonly testProfile: TestProfile;
  readonly entrypoint: string;
  readonly baseImage: "node:22-bookworm-slim" | "python:3.12-slim";
}

export type ProfileDetectionResult =
  | { readonly status: "SUPPORTED"; readonly plan: ProjectProfilePlan }
  | {
      readonly status: "UNSUPPORTED";
      readonly errorCode: "UNSUPPORTED_PROFILE" | "AMBIGUOUS_PROFILE" | "UNSUPPORTED_ENTRYPOINT";
      readonly candidates: readonly ProjectType[];
    };

const NODE_ENTRYPOINTS = [
  "server.js",
  "index.js",
  "main.js",
  "server.mjs",
  "index.mjs",
  "main.mjs",
  "server.cjs",
  "index.cjs",
  "main.cjs",
] as const;

const PYTHON_ENTRYPOINTS = ["app.py", "server.py", "main.py"] as const;

function isSafeTreePath(value: string): boolean {
  if (value.length === 0 || value.length > 1024 || value.startsWith("/") || value.includes("\\")) return false;
  if (/[^\x20-\x7e]/.test(value)) return false;
  return !value.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
}

function hasRootFile(files: ReadonlySet<string>, name: string): boolean {
  return files.has(name);
}

function firstEntrypoint(files: ReadonlySet<string>, candidates: readonly string[]): string | undefined {
  return candidates.find((candidate) => hasRootFile(files, candidate));
}

export function detectProjectProfile(paths: readonly string[]): ProfileDetectionResult {
  const files = new Set(paths.filter(isSafeTreePath));
  const nodeCandidate = hasRootFile(files, "package.json") || firstEntrypoint(files, NODE_ENTRYPOINTS) !== undefined;
  const pythonCandidate =
    hasRootFile(files, "pyproject.toml") ||
    hasRootFile(files, "requirements.txt") ||
    firstEntrypoint(files, PYTHON_ENTRYPOINTS) !== undefined;
  const candidates: ProjectType[] = [];
  if (nodeCandidate) candidates.push("node");
  if (pythonCandidate) candidates.push("python");
  if (candidates.length === 0) return { status: "UNSUPPORTED", errorCode: "UNSUPPORTED_PROFILE", candidates };
  if (candidates.length > 1) return { status: "UNSUPPORTED", errorCode: "AMBIGUOUS_PROFILE", candidates };

  if (candidates[0] === "node") {
    const entrypoint = firstEntrypoint(files, NODE_ENTRYPOINTS);
    if (entrypoint === undefined) return { status: "UNSUPPORTED", errorCode: "UNSUPPORTED_ENTRYPOINT", candidates };
    return {
      status: "SUPPORTED",
      plan: {
        projectType: "node",
        profile: "node-http",
        port: 3000,
        healthPath: "/health",
        testProfile: "node-basic",
        entrypoint,
        baseImage: "node:22-bookworm-slim",
      },
    };
  }

  const entrypoint = firstEntrypoint(files, PYTHON_ENTRYPOINTS);
  if (entrypoint === undefined) return { status: "UNSUPPORTED", errorCode: "UNSUPPORTED_ENTRYPOINT", candidates };
  return {
    status: "SUPPORTED",
    plan: {
      projectType: "python",
      profile: "python-http",
      port: 8000,
      healthPath: "/health",
      testProfile: "python-basic",
      entrypoint,
      baseImage: "python:3.12-slim",
    },
  };
}

export function buildControlledDockerfile(plan: ProjectProfilePlan): string {
  const command = plan.projectType === "node" ? `["node", "/app/${plan.entrypoint}"]` : `["python3", "/app/${plan.entrypoint}"]`;
  return [
    `FROM ${plan.baseImage}`,
    "WORKDIR /app",
    "COPY . /app",
    "USER 1000:1000",
    `EXPOSE ${plan.port}`,
    `CMD ${command}`,
    "",
  ].join("\n");
}
