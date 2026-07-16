import { describe, expect, it } from "vitest";
import { buildControlledDockerfile, detectProjectProfile } from "./profiles.js";

describe("fixed project profiles", () => {
  it("recognizes a Node HTTP project with a constrained plan", () => {
    const result = detectProjectProfile(["package.json", "server.js", "README.md"]);
    expect(result).toEqual({
      status: "SUPPORTED",
      plan: {
        projectType: "node",
        profile: "node-http",
        port: 3000,
        healthPath: "/health",
        testProfile: "node-basic",
        entrypoint: "server.js",
        baseImage: "node:22-bookworm-slim",
      },
    });
  });

  it("recognizes a Python HTTP project without accepting unsafe paths", () => {
    const result = detectProjectProfile(["pyproject.toml", "app.py", "../escape.py", "/absolute.py"]);
    expect(result).toMatchObject({ status: "SUPPORTED", plan: { projectType: "python", port: 8000, entrypoint: "app.py" } });
  });

  it("rejects ambiguous and incomplete repositories", () => {
    expect(detectProjectProfile(["package.json", "main.py"])).toMatchObject({ status: "UNSUPPORTED", errorCode: "AMBIGUOUS_PROFILE" });
    expect(detectProjectProfile(["package.json", "README.md"])).toMatchObject({ status: "UNSUPPORTED", errorCode: "UNSUPPORTED_ENTRYPOINT" });
    expect(detectProjectProfile(["README.md"])).toMatchObject({ status: "UNSUPPORTED", errorCode: "UNSUPPORTED_PROFILE" });
  });

  it("renders only the selected fixed image, port, and entrypoint", () => {
    const detected = detectProjectProfile(["requirements.txt", "main.py"]);
    if (detected.status !== "SUPPORTED") throw new Error("expected a supported profile");
    expect(buildControlledDockerfile(detected.plan)).toBe([
      "FROM python:3.12-slim",
      "WORKDIR /app",
      "COPY . /app",
      "USER 1000:1000",
      "EXPOSE 8000",
      'CMD ["python3", "/app/main.py"]',
      "",
    ].join("\n"));
  });
});
