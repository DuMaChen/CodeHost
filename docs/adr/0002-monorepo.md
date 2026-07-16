# ADR 0002: Keep the Course Release in a pnpm Monorepo

- Status: Accepted
- Date: 2026-07-15

## Context

The platform has shared contracts, database schema, Agent validation, K8s
builders, API, Worker, review service and Web code. Splitting those pieces into
separate repositories would make a small student team spend its time on
versioning and release coordination instead of the end-to-end workflow.

## Decision

Use one pnpm workspace with TypeScript projects under `packages/*` and
`apps/*`. Shared runtime contracts live in `packages/contracts`, configuration
in `packages/config`, database code in `packages/db`, Agent policy in
`packages/agent`, and Kubernetes resource policy in `packages/k8s`. The
application boundaries are `apps/api`, `apps/worker`, `apps/agent-review` and
`apps/web`.

Each package has its own TypeScript project and tests, while the root scripts
provide the build, typecheck and test entry points. Logical modules such as
workflow and Gitea integration remain inside the owning application until
extracting them removes real coupling.

## Consequences

Changes to a shared contract can be reviewed and tested with all consumers in
one pull request. A monorepo also makes the Compose, k3d and k3s examples
reproducible from one checkout. The repository has a larger dependency graph
and a full build is slower; CI must therefore keep package checks focused and
run the complete matrix before release.

## Verification

- `pnpm-workspace.yaml` declares the workspace and explicitly allows the
  required Nest and esbuild build scripts.
- Root `package.json` defines `build`, `typecheck`, `test` and `ci` entry points.
- The direct workspace verification on 2026-07-15 passed all 9 package and app
  TypeScript projects and emitted their `dist` artifacts.
- The test suite contains 30 test files and 115 passing tests.
