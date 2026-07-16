# Controlled Runner Image

This image is the course MVP fallback for `K8S_RUNNER_IMAGE`. It has a fixed
entrypoint and does not accept a user command or Kubernetes manifest. Build it,
push it to the private registry, record the resulting SHA-256 digest, and set
`PLATFORM_RUNNER_IMAGE` to the digest-pinned reference before applying k3s.

Build the image with a digest-pinned Gitleaks image that exposes the binary at
`/usr/bin/gitleaks`, for example:

```sh
docker build --build-arg GITLEAKS_IMAGE=zricethezav/gitleaks@sha256:<verified-digest> \
  -t registry.example.test/platform/runner:fixture \
  infra/runner
```

The image must contain a pinned `gitleaks` binary. The `analyze` step fails
closed when that binary is missing or cannot produce a redacted report; it
never treats a missing scanner as a passing fixture. The `fetch` step reads only the one-time Secret mounted at
`/var/run/platform/source/token`, removes `.git` after checkout, and never
passes the token as a command-line argument. `analyze` writes only redacted
summaries to the workspace and stdout. A Gitleaks finding fails the Analysis
Job without printing the raw match. `test` and `build` run bounded Node/Python
syntax checks; this is
`BUILD_MODE=FIXTURE`, not the rootless BuildKit dynamic image path. Node and
Python checks never install dependencies from the public network.
