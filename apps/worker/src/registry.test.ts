import { describe, expect, it } from "vitest";
import { parseRegistryManifestReference } from "./registry.js";

describe("registry retention reference", () => {
  it("accepts only run-scoped immutable manifests", () => {
    const runId = "11111111-1111-4111-8111-111111111111";
    expect(parseRegistryManifestReference(`registry.example.test/course/${runId}/preview@sha256:${"a".repeat(64)}`, runId)).toMatchObject({ registryHost: "registry.example.test", repository: `course/${runId}/preview` });
    expect(() => parseRegistryManifestReference("registry.example.test/course/base@sha256:" + "a".repeat(64), runId)).toThrow();
  });
});
