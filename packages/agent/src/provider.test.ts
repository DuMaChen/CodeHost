import { describe, expect, it } from "vitest";
import {
  MockProvider,
  OpenAICompatibleProvider,
  runAgentReview,
} from "./index.js";

const validReport = {
  summary: "The change is low risk.",
  riskLevel: "LOW",
  confidence: 0.75,
  findings: [],
};

describe("agent providers", () => {
  it("provides a deterministic valid default report", async () => {
    const result = await runAgentReview(new MockProvider(), { diff: "safe" });

    expect(result.verdict).toBe("PASSED");
    expect(result.report.summary).toBe("Mock agent review completed.");
  });

  it("sends only prepared review data to an OpenAI-compatible endpoint", async () => {
    const secret = "provider-secret-789";
    let requestBody: Record<string, unknown> | undefined;
    const provider = new OpenAICompatibleProvider({
      apiUrl: "https://agent.example/v1",
      apiKey: "api-key-is-not-review-data",
      model: "test-model",
      fetch: async (url, init) => {
        expect(url).toBe("https://agent.example/v1/chat/completions");
        requestBody = JSON.parse(init.body) as Record<string, unknown>;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [{ message: { content: JSON.stringify(validReport) } }],
          }),
        };
      },
    });

    const result = await runAgentReview(provider, {
      diff: `token = "${secret}"`,
      gitleaks: { findings: [{ Secret: secret }] },
    });

    expect(result.verdict).toBe("PASSED");
    expect(JSON.stringify(requestBody)).not.toContain(secret);
  });
});
