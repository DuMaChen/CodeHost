import { describe, expect, it } from "vitest";
import {
  buildPreviewPortForwardCommand,
  buildPreviewSshTunnelCommand,
  loadConfig,
  parseEnvironment,
  parsePreviewServiceReference,
} from "./index.js";

const localEnvironment = {
  NODE_ENV: "test",
  PORT: "3100",
  DATABASE_URL: "postgresql://user:password@localhost:5432/platform",
  GITEA_BASE_URL: "http://gitea.local",
  GITEA_WEBHOOK_SECRET: "webhook-secret",
  SESSION_ENCRYPTION_KEY: "12345678901234567890123456789012",
  K8S_MODE: "local",
  KUBECONFIG: "/tmp/kubeconfig",
  REGISTRY_PUSH_HOST: "ai-registry:5000",
  REGISTRY_PULL_HOST: "ai-registry:5000",
};

describe("environment configuration", () => {
  it("parses the local defaults and returns typed application config", () => {
    const config = loadConfig(localEnvironment);

    expect(config).toMatchObject({
      nodeEnv: "test",
      port: 3100,
      k8sMode: "local",
      maxActiveRuns: 1,
      maxQueuedRuns: 3,
      webhookMaxAgeMinutes: 15,
      reportMaxBytes: 262144,
      reviewInputMaxBytes: 65536,
      retentionDays: 7,
      agentProvider: "mock",
      giteaAllowedRepositories: [],
    });
  });

  it("parses and maps a comma-separated repository allowlist", () => {
    const config = loadConfig({
      ...localEnvironment,
      GITEA_ALLOWED_REPOSITORIES: " course/example,teacher/demo,course/example ",
    });

    expect(config.giteaAllowedRepositories).toEqual(["course/example", "teacher/demo"]);
  });

  it("rejects malformed repository names and empty list entries", () => {
    expect(() =>
      parseEnvironment({ ...localEnvironment, GITEA_ALLOWED_REPOSITORIES: "course/example,,teacher/demo" }),
    ).toThrow(/owner\/name/);
    expect(() =>
      parseEnvironment({ ...localEnvironment, GITEA_ALLOWED_REPOSITORIES: "course" }),
    ).toThrow(/owner\/name/);
    expect(() =>
      parseEnvironment({ ...localEnvironment, GITEA_ALLOWED_REPOSITORIES: "course/example,../demo" }),
    ).toThrow(/Repository/);
  });

  it("accepts the existing .env.example aliases", () => {
    const config = loadConfig({
      ...localEnvironment,
      WEBHOOK_SECRET: localEnvironment.GITEA_WEBHOOK_SECRET,
      GITEA_WEBHOOK_SECRET: undefined,
      PREVIEW_MODE: "local",
      K8S_MODE: undefined,
    });

    expect(config.giteaWebhookSecret).toBe(localEnvironment.GITEA_WEBHOOK_SECRET);
    expect(config.previewMode).toBe("local");
  });

  it("rejects conflicting canonical and compatibility aliases", () => {
    expect(() =>
      parseEnvironment({
        ...localEnvironment,
        WEBHOOK_SECRET: "a-different-secret",
      }),
    ).toThrow(/WEBHOOK_SECRET/);
    expect(() =>
      parseEnvironment({
        ...localEnvironment,
        PREVIEW_MODE: "ingress",
      }),
    ).toThrow(/PREVIEW_MODE/);
  });

  it("requires the deployment-specific Kubernetes and preview settings", () => {
    expect(() => parseEnvironment({ ...localEnvironment, KUBECONFIG: undefined })).toThrow(
      /KUBECONFIG/,
    );
    expect(() =>
      parseEnvironment({
        ...localEnvironment,
        K8S_MODE: "server",
        KUBECONFIG: undefined,
        PREVIEW_BASE_URL: undefined,
        PREVIEW_MODE: "ingress",
      }),
    ).toThrow(/PREVIEW_BASE_URL/);
    expect(
      parseEnvironment({
        ...localEnvironment,
        K8S_MODE: "server",
        KUBECONFIG: undefined,
        PREVIEW_BASE_URL: "https://preview.example.test",
        PREVIEW_MODE: "ingress",
      }).K8S_MODE,
    ).toBe("server");
  });

  it("enforces resource limits from the plan and registry host syntax", () => {
    expect(() => parseEnvironment({ ...localEnvironment, MAX_ACTIVE_RUNS: "2" })).toThrow();
    expect(() => parseEnvironment({ ...localEnvironment, MAX_QUEUED_RUNS: "4" })).toThrow();
    expect(() =>
      parseEnvironment({ ...localEnvironment, REGISTRY_PUSH_HOST: "https://registry.local" }),
    ).toThrow();
    expect(() =>
      parseEnvironment({ ...localEnvironment, REPORT_MAX_BYTES: "262145" }),
    ).toThrow();
    expect(() =>
      parseEnvironment({ ...localEnvironment, REGISTRY_PUSH_HOST: "localhost:5000" }),
    ).toThrow();
    expect(() =>
      parseEnvironment({ ...localEnvironment, REGISTRY_PULL_HOST: "127.0.0.1:0" }),
    ).toThrow();
  });

  it("requires complete credentials for explicitly selected providers", () => {
    expect(() =>
      parseEnvironment({ ...localEnvironment, GITEA_OAUTH_CLIENT_ID: "client-id" }),
    ).toThrow(/OAuth/);
    expect(() =>
      parseEnvironment({ ...localEnvironment, AGENT_PROVIDER: "openai-compatible" }),
    ).toThrow(/AGENT_API/);
    expect(() =>
      parseEnvironment({
        ...localEnvironment,
        AGENT_PROVIDER: "openai-compatible",
        AGENT_API_URL: "https://api.example.test/v1",
        AGENT_API_KEY: "secret",
        AGENT_MODEL: "model-name",
      }),
    ).not.toThrow();
  });

  it("parses SSH Preview settings and builds commands only from safe Service references", () => {
    const config = loadConfig({
      ...localEnvironment,
      K8S_MODE: "server",
      KUBECONFIG: undefined,
      PREVIEW_MODE: "ssh",
      PREVIEW_SSH_HOST: "registrar.example.test",
      PREVIEW_SSH_USER: "registrar",
      PREVIEW_SSH_PORT: "2222",
    });
    expect(config).toMatchObject({
      previewMode: "ssh",
      previewSshHost: "registrar.example.test",
      previewSshUser: "registrar",
      previewSshPort: 2222,
    });

    const reference = parsePreviewServiceReference("service://pr-run-abc123/preview-a1")
      ?? (() => { throw new Error("test reference should parse"); })();
    expect(buildPreviewPortForwardCommand(reference)).toContain("kubectl -n 'pr-run-abc123' port-forward");
    expect(buildPreviewSshTunnelCommand(reference, {
      host: config.previewSshHost!,
      user: config.previewSshUser!,
      ...(config.previewSshPort === undefined ? {} : { port: config.previewSshPort }),
    })).toContain("ssh -p 2222 -o ExitOnForwardFailure=yes");
    expect(parsePreviewServiceReference("service://pr-run-abc123/preview%2Fa1")).toBeUndefined();
    expect(() => buildPreviewSshTunnelCommand(reference, {
      host: "registrar.example.test;touch /tmp/pwned",
      user: "registrar",
    })).toThrow(/unsupported shell characters/);
  });

  it("rejects partial or misplaced SSH Preview settings", () => {
    expect(() => parseEnvironment({
      ...localEnvironment,
      K8S_MODE: "server",
      KUBECONFIG: undefined,
      PREVIEW_MODE: "ssh",
      PREVIEW_SSH_HOST: "registrar.example.test",
    })).toThrow(/PREVIEW_SSH_USER/);
    expect(() => parseEnvironment({
      ...localEnvironment,
      PREVIEW_SSH_HOST: "registrar.example.test",
      PREVIEW_SSH_USER: "registrar",
    })).toThrow(/SSH Preview settings/);
  });
});
