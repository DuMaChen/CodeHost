# Agent Review Process

This process accepts a bounded and already-redacted review payload, calls the
selected `@platform/agent` Provider, and publishes results through pg-boss when
`DATABASE_URL` is configured. It has no Kubernetes or Gitea client.

## HTTP contract

- `GET /healthz` is a liveness check.
- `GET /readyz` reports Provider readiness.
- `POST /review` accepts strict JSON with `runId`, `attempt`, `headSha`,
  `inputHash`, and `reviewInput`.

`reviewInput` must already be sanitized by the Worker, match its SHA-256 hash,
and be no larger than 64 KiB in UTF-8 bytes. The process rejects input that
would change when passed through the shared sanitizer. A successful HTTP response
contains the correlation fields and a result from `runAgentReview`; model,
timeout, invalid-schema, secret, and size failures are returned as `INCOMPLETE`.

## Configuration

The default path is deterministic Mock Provider:

```text
AGENT_PROVIDER=mock
AGENT_REVIEW_HOST=0.0.0.0
AGENT_REVIEW_PORT=3002
```

The optional OpenAI-compatible path requires `AGENT_API_URL`,
`AGENT_MODEL_API_KEY`, and `AGENT_MODEL` with `AGENT_PROVIDER=openai-compatible`.
The API key is used only by the Provider and is never included in the response.

When `DATABASE_URL` is set, the process consumes `platform.agent-review` and
publishes validated results to `platform.agent-review-result`. The HTTP endpoint
remains available for health checks and local contract tests; the production
Worker uses the queue transport.
