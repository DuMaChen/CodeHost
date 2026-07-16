import { describe, expect, it } from "vitest";
import {
  InMemoryReportStore,
  MockProvider,
  persistAgentResult,
  runAgentReview,
} from "./index.js";

describe("report persistence", () => {
  it("persists a validated report and findings through the shared port", async () => {
    const result = await runAgentReview(new MockProvider(), { diff: "safe" });
    const store = new InMemoryReportStore();
    const saved = await persistAgentResult(
      store,
      {
        runId: "run-1",
        attempt: 1,
        headSha: "abc123",
      },
      result,
    );

    expect(saved.verdict).toBe("PASSED");
    expect(saved.reportJson.summary).toBe("Mock agent review completed.");
    expect(store.all()).toHaveLength(1);
  });

  it("persists incomplete results without allowing an invalid report shape", async () => {
    const result = await runAgentReview(new MockProvider({ failure: "PROVIDER_TIMEOUT" }), {});
    const store = new InMemoryReportStore();
    const saved = await persistAgentResult(
      store,
      { runId: "run-2", attempt: 1, headSha: "def456" },
      result,
    );

    expect(saved.verdict).toBe("INCOMPLETE");
    expect(saved.reportJson.findings).toEqual([]);
  });

  it("requires current-head evidence before persisting findings", async () => {
    const result = await runAgentReview(
      new MockProvider({
        response: {
          summary: "A finding is present.",
          riskLevel: "HIGH",
          confidence: 0.9,
          findings: [
            {
              severity: "HIGH",
              category: "security",
              file: "src/auth.ts",
              lineStart: 2,
              lineEnd: 2,
              title: "Token is logged",
              description: "A token is written to logs.",
              evidence: "logger.info(token)",
              recommendation: "Remove the token from logs.",
            },
          ],
        },
      }),
      { diff: "safe" },
    );
    const store = new InMemoryReportStore();

    await expect(
      persistAgentResult(store, { runId: "run-3", attempt: 1, headSha: "ghi789" }, result),
    ).rejects.toThrow("current head");
  });
});
