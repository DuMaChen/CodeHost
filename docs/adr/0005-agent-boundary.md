# ADR 0005: Keep Agent Review Read-Only and Evidence-Bounded

- Status: Accepted
- Date: 2026-07-15

## Context

An Agent can help explain a pull request, but giving it repository write
access, Kubernetes credentials or unrestricted command execution would make a
model failure a platform control-plane failure. Its output also contains
untrusted text and must not be treated as a merge decision by itself.

## Decision

The default course provider is a deterministic Mock Provider. An optional
OpenAI-compatible provider is configured only at the `agent-review` service
boundary and is not required for local or P0 acceptance.

The Worker sends the Agent a bounded, sanitized summary of the diff, fixed
profile result, test output, health result and security evidence. Sensitive
values, Gitleaks fields, prompt delimiters and terminal controls are removed or
redacted, and input/output sizes are capped. The Agent returns only the strict
report schema. Report validation rejects invalid JSON, oversized output,
secret values, prohibited command/patch/merge fields and findings that cannot
be tied to the current file and changed-line evidence.

The Agent cannot modify code, create branches, write Gitea statuses, call the
Kubernetes API or decide a merge. The deployed HTTP path has no `DATABASE_URL`
or platform log volume and therefore no database or raw-log credential; the
optional pg-boss worker path is a separate compatibility mode and is not used
by the Compose or k3s templates.
The Worker persists valid reports and writes redacted provider evidence;
invalid or unavailable review results are `INCOMPLETE` and block quality
approval. A human Reviewer remains required.

The Analysis Tools Job prints a redacted Gitleaks summary to stdout, so the
Worker's bounded Pod-log evidence can reach the review input. The raw redacted
report remains in the Run workspace and is not sent to the Agent. A real
Secret-Canary run through the full Kubernetes path is still required before
claiming end-to-end Gitleaks evidence; unit tests and a Fixture log are not a
substitute for that runtime proof.

## Consequences

The design makes model behavior auditable and keeps the P0 path runnable
without a GPU or paid API. It limits the Agent's ability to perform broad
autonomous remediation, and a report may be incomplete even when deterministic
tests pass. Automatic code changes and real-model quality evaluation are
deferred until a separate permission and approval design exists.

## Verification

- `packages/agent/src/sanitize.ts` and its tests cover secret and prompt-data
  redaction and bounded input.
- `packages/agent/src/result.ts` validates strict reports, prohibited fields,
  secret leakage and evidence.
- `packages/agent/src/provider.test.ts`, `result.test.ts`, `evidence.test.ts`
  and `sanitize.test.ts` cover provider and report boundaries.
- `apps/agent-review/src/http.test.ts` covers the service HTTP contract and
  report size behavior.
