# ADR 0007: Give the Worker the Minimum Run-Lifecycle RBAC

- Status: Accepted
- Date: 2026-07-15

## Context

The Worker must create and observe Run resources, collect logs and remove
expired resources. User task containers must not inherit the Worker credential
or any Kubernetes API token. Kubernetes cannot express every desired
label-selected namespace restriction in a ClusterRole, so the remaining
permissions must be explicit and the trusted Worker code must enforce Run
ownership and UID preconditions.

## Decision

In server mode, bind only `platform-worker` in `platform-system` to the
`platform-worker` ClusterRole. The role is limited to:

- managed Namespaces;
- ResourceQuota and LimitRange;
- Jobs, Pods and `pods/log`;
- Deployments, Services and Ingresses;
- Run workspace PVCs; and
- create/delete of the one-shot Source Fetch Secret, without Secret read.

The Worker does not receive Node, CRD, RBAC, arbitrary Secret read, or
container-runtime permissions. Kubernetes creates the Run Namespace's default
ServiceAccount automatically; the Worker intentionally has no
`serviceaccounts` permission. Run Pods use that ServiceAccount with
`automountServiceAccountToken=false`; Runner, Analysis and Preview do not bind
Roles. Local k3d uses a dedicated Worker kubeconfig, while server k3s uses the
in-cluster ServiceAccount.

Resource deletion requires the expected managed label, Run identity and
resource UID. Secret deletion uses the UID returned at creation. Namespace
ownership conflicts fail closed and are recorded as incomplete cleanup rather
than deleting another Run's resources.

The create/delete Secret exception is a deliberate P0 compromise: Kubernetes
RBAC cannot scope those verbs to a dynamically selected Namespace. The Worker
is the only trusted subject bound to this ClusterRole, and the Source Fetch
Secret is deleted immediately after the fetch Job is created.

## Consequences

The Worker can complete the required Run lifecycle without exposing a general
cluster administrator credential to user code. The ClusterRole remains broader
than a per-namespace role for Namespaces and one-shot Secret creation, so the
Worker implementation and deployment trust boundary are part of the security
assumption. A future controller or admission policy can narrow this further.

## Verification

- `infra/k3s/rbac.yaml` is the server manifest and matches
  `packages/k8s/src/rbac.ts`.
- `packages/k8s/src/k8s.test.ts` checks the exact role resources and verbs.
- `apps/worker/src/kubernetes/runtime.test.ts` checks ownership-conflict and
  cleanup behavior.
- `apps/worker/src/kubernetes/client.test.ts` checks the request paths used by
  the Worker client.
- `infra/k3s/run-policy.template.yaml` disables token mounting in Run
  namespaces.
