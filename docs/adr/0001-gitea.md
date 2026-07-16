# ADR 0001: Use Gitea as the Git Host

- Status: Accepted
- Date: 2026-07-15

## Context

The course project needs real repositories, pull requests, reviews, branch
protection and provider status checks, but implementing a Git hosting service
would consume the project budget and move the learning objective away from AI
native quality automation. The first release also needs one authoritative
source for repository permissions and user identity.

## Decision

Use Gitea as the only supported Git host for the course release. The platform
uses Gitea for:

- OAuth login, user identity and repository membership;
- pull requests, reviews, branch protection and merge decisions;
- signed pull-request webhooks; and
- commit statuses and redacted pull-request comments.

The API accepts the configured repositories. In the course development
fixture, an empty allowlist means "allow the local fixture"; a server
deployment must set an explicit non-empty `GITEA_ALLOWED_REPOSITORIES` value
before it accepts public traffic. Webhook delivery IDs, payload hashes,
repository IDs, pull-request numbers and head SHAs are persisted so duplicate
deliveries and stale attempts cannot create or overwrite unrelated runs. A
merge still requires Gitea branch protection to enforce the platform checks
and a non-author human approval; the platform writes evidence but does not
implement Gitea's merge policy internally. Forgejo and GitHub adapters are
outside P0.

## Consequences

Gitea provides the mature Git and review surface, so the platform can focus on
workflow evidence, Agent review and Kubernetes execution. The trade-off is a
provider-specific integration and a dependency on Gitea's API and OAuth
configuration. Provider portability is deliberately deferred until the
workflow and evidence contracts are stable.

## Verification

- `apps/api/src/webhook.controller.test.ts` verifies raw-byte signature checks.
- `apps/api/src/webhook.service.test.ts` verifies stale-event rejection.
- `apps/api/src/auth.service.test.ts` covers invalid session boundaries.
- `apps/worker/src/gitea/client.test.ts` and `sync.test.ts` cover API encoding
  and exact status identity.
- `apps/api/src/run-operations.test.ts` covers maintainer-only operation policy
  helpers.
