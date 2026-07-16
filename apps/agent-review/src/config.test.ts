import { describe, expect, it } from "vitest";
import { createConfiguredProvider, loadConfig } from "./config.js";

describe("agent-review configuration boundary", () => {
  it("defaults to the local Mock Provider", () => {
    const config = loadConfig({});
    const provider = createConfiguredProvider(config);
    expect(provider.name).toBe("mock");
    expect(provider.model).toBe("mock");
  });

  it("selects an OpenAI-compatible Provider without exposing unrelated credentials to the Provider", () => {
    const config = loadConfig({
      AGENT_PROVIDER: "openai-compatible",
      AGENT_API_URL: "https://model.example/v1",
      AGENT_MODEL_API_KEY: "model-secret",
      AGENT_MODEL: "review-model",
      DATABASE_URL: "database-secret-must-not-be-read",
      GITEA_TOKEN: "gitea-secret-must-not-be-read",
      KUBECONFIG: "/tmp/kubeconfig-must-not-be-read",
    });

    expect(config.provider).toEqual({
      provider: "openai-compatible",
      apiUrl: "https://model.example/v1",
      apiKey: "model-secret",
      model: "review-model",
      timeoutMs: 30_000,
    });
    expect(config.databaseUrl).toBe("database-secret-must-not-be-read");
    expect(JSON.stringify(config.provider)).not.toContain("database-secret-must-not-be-read");
    expect(JSON.stringify(config.provider)).not.toContain("gitea-secret-must-not-be-read");
    expect(JSON.stringify(config.provider)).not.toContain("kubeconfig-must-not-be-read");
  });

  it("fails closed for an unknown or incomplete Provider selection", () => {
    expect(() => loadConfig({ AGENT_PROVIDER: "other" })).toThrow(/AGENT_PROVIDER/);
    expect(() => loadConfig({ AGENT_PROVIDER: "openai-compatible" })).toThrow(/AGENT_API_URL/);
  });
});
