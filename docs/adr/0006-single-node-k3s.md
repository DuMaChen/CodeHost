# ADR 0006: Use a Single-Node k3s Server for the Server Demo

- Status: Accepted
- Date: 2026-07-15

## Context

The course needs a server demonstration that can host Gitea, PostgreSQL,
Registry, the platform services and one or more Run namespaces on a budget-
limited machine. High availability and multi-node scheduling would require
additional machines and are outside the course acceptance scope.

## Decision

Use one k3s server/node with Traefik, local-path storage and a private Registry
for the server demonstration. Platform components and Run resources share the
node, with explicit requests, limits and a reservation for k3s system
components. Gitea, PostgreSQL, Registry and platform logs use persistent
volumes; Run workspace volumes are short-lived and cleaned with the Run.

When `PREVIEW_BASE_URL` and stable DNS/hosts mapping are configured, Preview
uses an expiring Traefik Ingress URL. Without that stable address, the accepted
server access mode is an SSH tunnel. A server-side port-forward is never
presented as a URL that exists on the user's workstation.

This is not an HA or production isolation claim. In the available remote
rootless Docker environment, k3s reached `Ready` and `/readyz` returned `ok`,
but creating a Preview Pod failed with user-namespace/cgroup runtime
permission errors. The remote test therefore proves control-plane startup only,
not the complete server Preview path.

## Consequences

The topology is affordable and easy to explain in a course demo. A node or
local storage failure takes down the whole platform, and Preview execution
requires a standard container runtime with the permissions expected by k3s.
Before claiming G-16 or G-17, the deployment must be repeated on a supported
server runtime and the Ingress and persistence checks must pass.

## Verification

- `infra/k3s/install.sh`, `platform.yaml.tmpl` and `infra/k3s/README.md` define
  the single-node installation and access modes.
- The remote check on 2026-07-15 observed container `ai-platform-k3s` running,
  one `Ready` control-plane node and `ok` from `/readyz` via the container
  network namespace.
- The same check observed no residual `platform-smoke` namespace or Pods after
  the failed Preview smoke test.
