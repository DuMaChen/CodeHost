import { describe, expect, it } from "vitest";
import { findMatchingStatus } from "./sync.js";

describe("Gitea sync identity", () => {
  it("adopts only an exact status state, context, description, and target URL", () => {
    const statuses = [
      { id: 1, context: "platform/test", state: "failure", description: "old", targetUrl: "https://platform/run/1" },
      { id: 2, context: "platform/test", state: "success", description: "ok", targetUrl: "https://platform/run/1" },
    ];
    expect(findMatchingStatus(statuses, {
      id: "sync",
      runId: "run",
      attempt: 1,
      headSha: "sha",
      context: "platform/test",
      artifactType: "status",
      desiredState: "success",
      desiredDescription: "ok",
      desiredTargetUrl: "https://platform/run/1",
      desiredBody: "",
      attempts: 0,
      leaseUntil: null,
    })).toEqual(statuses[1]);
  });
});
