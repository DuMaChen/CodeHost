# ADR 0003: Use PostgreSQL and pg-boss for Asynchronous Work

- Status: Accepted
- Date: 2026-07-15

## Context

Webhook handling, Kubernetes jobs, Agent review and Gitea synchronization are
asynchronous. The course deployment supports one active Run and a small
bounded queue, so adding Redis, RabbitMQ or Kafka would add operational cost
without improving the target workflow.

## Decision

Use PostgreSQL as the durable source of workflow state and pg-boss as the
database-backed job queue. pg-boss owns its own `pgboss` schema and migration
lifecycle; Drizzle manages only the platform schema.

The API writes the webhook event, pull request state, Run and
`workflow_outbox` record transactionally. The Worker publishes the outbox
record to pg-boss and uses leases, retries and step guards so delivery is
at-least-once but terminal workflow steps are idempotent. The database keeps
Run attempts, step status, cleanup state, evidence and provider-sync intent.
The optional queue transport for Agent Review still waits for its result in a
Worker process; the production templates currently select the direct HTTP
transport instead, so a Worker restart during the optional queue path is not
yet a fully recoverable review workflow.

## Consequences

There is one persistence system to back up, inspect and run locally. A database
outage affects both business state and queue progress, and PostgreSQL is not a
replacement for a high-throughput message broker. The course release accepts
that trade-off because capacity is intentionally bounded; Redis or another
queue is a later scaling decision, not a hidden dependency.

## Verification

- `packages/db/src/schema.ts` keeps platform tables separate from the pg-boss
  schema.
- `apps/worker/src/workflow/outbox.ts` and `db-adapter.ts` persist and publish
  workflow intent.
- `apps/worker/src/workflow/step-guard.test.ts` verifies cleanup retry
  semantics.
- `apps/worker/src/workflow/executor.test.ts` and `plan.test.ts` cover the
  executable plan and step outcomes.
- `apps/api/src/run-operations.test.ts` covers retry and cancellation policy.
