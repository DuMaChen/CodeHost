# Verification Record

Date: 2026-07-16

This record distinguishes executable local evidence from claims that still
require a real Gitea/PostgreSQL/Kubernetes deployment. Passing unit tests do
not by themselves prove the complete PR workflow.

## Local Evidence

The following checks passed after the Preview, logging, Outbox and deployment
boundary changes:

| Check | Result |
|---|---|
| TypeScript build for 5 packages and 4 apps | Passed |
| TypeScript no-emit checks for all 9 package/app projects | Passed |
| Vitest, one worker | 31 files, 123 tests passed |
| Compiled Nest/Fastify API smoke | `/healthz` 200; invalid Webhook 401 |
| Preview config and command-injection tests | Passed for local, SSH and Ingress modes |
| Kubernetes runtime tests | 8 tests passed, including local/SSH service references |
| Workflow Outbox recovery test | Failure -> retry -> publish once passed |
| Web API tests | Port-forward command and logs contract passed |
| `docker compose config --quiet` | Passed |
| Shell syntax for Compose/k3d/k3s/runner scripts | Passed |
| ADR completeness check | 7 files present |
| Rendered k3s template YAML parse and phase checks | 26 documents; migration Job and 5 runtime Deployments present |

The standard pnpm wrapper in the Codex runtime may pause in its dependency
install phase. The build and test evidence above uses the already-installed
workspace TypeScript and Vitest binaries directly; it is equivalent source
verification, but does not claim that the wrapper issue is fixed.

## Remote Evidence

On the invited Ubuntu 22.04 notebook, the prepared rootful k3s harness showed:

- Docker 29.3.0 and Docker Compose 2.40.3 available;
- the `ai-platform-k3s-rootful` container running k3s v1.35.5 with one `Ready`
  control-plane node;
- amd64 API, Worker and Agent Review images imported into k3s containerd, plus
  digest-pinned Runner and Preview images;
- `infra/k3s/install.sh` completed the migration-first deployment with
  PostgreSQL, Gitea, Registry, API, Worker, Agent Review and Web available;
- 4/4 platform PVCs `Bound` and `platform-migrate` `Complete` with 12 migration
  records;
- internal API `/healthz` and `/readyz`, Gitea, Registry `/v2/` and Web all
  returned HTTP 200; an unsigned Webhook request returned HTTP 401;
- PostgreSQL, Gitea and Registry were restarted individually and rolled out
  successfully; the migration record count remained 12.

The original rootless k3s harness still logs user-namespace cgroup permission
errors and the earlier Preview Pod sandbox failure (`fork/exec ... permission
denied`). The successful deployment evidence therefore uses the separate
rootful single-node harness and does not claim production-grade sandboxing.
Because the nested local-path volume was created as `root:root`, the remote
test required a one-time owner fix for the fresh PostgreSQL test volume before
the non-root PostgreSQL container could initialize it.

## Implemented In This Record

- local Preview returns a persisted `service://` reference and the API returns
  a bounded `kubectl port-forward` command;
- SSH Preview validates host/user/port configuration and returns a bounded
  SSH tunnel command;
- current-attempt logs are served through an authenticated API endpoint after
  log-root and symlink checks;
- Fixture build mode is persisted in the execution plan;
- Gitleaks emits only a redacted summary to the Analysis log and findings fail
  the Analysis Job;
- the deployed Agent Review HTTP path no longer receives `DATABASE_URL`;
- Outbox retry and no-duplicate behavior has an automated test;
- API smoke E2E uses the compiled application rather than a slow module
  transform path.
- k3s now has a restricted `platform-migrate` Job that runs the compiled
  migration entrypoint after PostgreSQL readiness;
- k3s installation applies non-runtime resources first, waits for migration
  completion, then applies the Gitea/API/Worker/Agent/Web runtime Deployments;
- runtime init gates prevent application containers from starting before the
  migration table is available, including when the full template is applied
  manually.
- runtime images support target-scoped Docker builds through `BUILD_SCOPE`, and
  expose the API workspace `pg` dependency to the root-level Kubernetes inline
  gates.
- API and Gitea migration gates query the Drizzle-owned
  `drizzle.__drizzle_migrations` table and run as init containers.
- Kubernetes API requests disable Node 22's global keep-alive agent; this
  prevents stale k3s TLS connections from surfacing as plain-text HTTP 400
  responses during long Job polling sequences.
- Preview creation no longer reconciles the same Deployment twice in one
  step, avoiding a resource-version race with the Deployment controller.

## Remote Workflow Evidence (2026-07-16)

The prepared rootful single-node k3s harness completed both live Node fixture
paths after the two Worker fixes above. The Worker used the digest-pinned
Runner and Preview images already recorded in this file; the platform API,
Gitea, PostgreSQL and Registry data were not reset between runs.

| Gate | Run | Result | Evidence |
|---|---|---|---|
| G-01 Node success PR | `42e19861-ae6e-471c-93b9-bbf00c0394fd` | Passed | `detect` through `report` all passed; `BUILD_MODE=FIXTURE`; Preview Service reference persisted; Report and six Gitea sync artifacts were `SYNCED`; Namespace/PVC cleanup completed |
| G-02 Node test failure | `3be66b84-ed46-46b2-93d9-fc593f9165c3` | Passed | `test=FAILED/JOB_FAILED`; `build`, `preview`, `health` skipped; Run and report verdict `FAILED`; `platform/test` and `platform/quality-review` were Gitea failures; cleanup was `CLEANED` |
| Recovery to success | `085eef63-59b6-4464-9c62-048d5494e2f0` | Passed | The temporary failing fixture file was removed; the full success path passed again and cleanup was `CLEANED` |

The success PR head was `d691e973851ad3c22575bffcb925e22a69eff7f9` for the first
success evidence, and the final restored head was
`e677c695a78157f8ae300d1389faed10faa609ae`. Gitea returned five current-head
platform statuses and a quality comment tied to the exact head SHA. The
failure path used head `b7b3f921aa6ceea77bc58311d7d1984bad61d06d` and its
quality comment listed the skipped downstream steps.

The first two pre-fix Runs (`e96da798-0219-4444-97f1-ef4ab5c7c491` and
`d4262c0b-e171-46e8-b47a-1996962f178c`) stopped at `test` with a Namespace
GET HTTP 400. A direct replay of the same ServiceAccount request against an
Active Namespace returned 200, while the long workflow sequence reused
Node 22's stale global HTTPS connection. After setting `agent: false`, the
next Run created and completed the real Test Job. The following Run exposed
and fixed the separate duplicate Preview Deployment reconcile (HTTP 409).

Namespace deletion initially reported a stale unavailable metrics APIService;
the prepared harness removed that non-P0 addon, after which Namespace
discovery completed normally. The local-path PVC protection finalizer can
delay cleanup for about one minute, but the success and failure Runs both
eventually reached `CLEANED` and their Run Namespaces disappeared.

## G-04 Health Failure Evidence (2026-07-16)

The rootful single-node k3s harness ran a health-failure Preview Fixture after
deploying the current amd64 Worker image `platform-worker:g04-20260716`.
The Preview image was digest-pinned and intentionally returned HTTP 500 from
`/health`; this is a verification fixture, not a project application image.

| Gate | Run | Result | Evidence |
|---|---|---|---|
| G-04 Python/Preview health failure | `809602a1-db92-4899-aa4a-ac788a2e564f` | Passed | `preview=PASSED`; `health=FAILED/PREVIEW_HEALTH_CHECK_FAILED`; `report=PASSED`; Mock Agent Review passed; final Run `FAILED/CLEANED`; the Namespace was deleted |

The Run head was `ee48fbc23d372834df8c1c3728c3f89d9f2aae52`. The six Gitea
sync artifacts were all `SYNCED`: build success, test success, security
success, preview failure, quality-review failure and the quality comment.
The Worker image used the new TCP readiness plus bounded Service HTTP health
check path. Local TypeScript/Vitest commands were attempted separately but
hung in the current workstation runtime; the amd64 Docker build and remote
workflow evidence are the authoritative evidence for this Target.

## G-03 Python Success Evidence (2026-07-16)

The prepared rootful k3s harness ran the independent Python Fixture repository
through the full workflow. The persisted execution plan selected the Python
profile, fixed port 8000, `main.py`, `python:3.12-slim`, and
`python-basic` tests.

| Gate | Run | Result | Evidence |
|---|---|---|---|
| G-03 Python success PR | `838bcb17-fa39-4d55-90d9-a65df4b74b13` | Passed | All 11 steps passed; Run `PASSED/CLEANED`; Python execution plan persisted; Namespace deleted; six Gitea status/comment artifacts were `SYNCED` |

## G-05 Duplicate Webhook Evidence (2026-07-16)

The same valid Webhook body and delivery ID were sent twice to the live API.
The first request returned `202` with the existing Run as a duplicate; the
second returned `202` as a delivery duplicate. The database contained one
`PROCESSED` `webhook_events` row for delivery
`g05-duplicate-1784170225023`, one Run for the head SHA, and no new Namespace.

## G-06 Task Timeout Evidence (2026-07-16)

For a bounded live test, the Worker was deployed with
`K8S_JOB_TIMEOUT_MS=5000` (the normal default remains 900000 ms), and a
Python Fixture containing a 30-second unittest was submitted. The timeout
was observed in the real Kubernetes Source Fetch Job path before the slow
test itself could complete; this still exercises the same per-step timeout,
log collection, Job deletion and cleanup contract.

| Gate | Run | Result | Evidence |
|---|---|---|---|
| G-06 task timeout | `b22cd5fc-8760-4d80-a28c-8f523315ffa4` | Passed | Run `INCOMPLETE/CLEANED`; `fetch=INCOMPLETE/JOB_TIMEOUT`; downstream `test`, `build`, `preview` and `health` were `SKIPPED_UPSTREAM`; six Gitea sync artifacts were `SYNCED`; Namespace was deleted |

After the test, the temporary slow file was removed, the timeout was restored
to 900000 ms, the success Preview digest was restored, and recovery Run
`6d038330-0f20-4daf-8276-8786c7a3d0d6` completed `PASSED/CLEANED`.

## G-07/G-08 Gitea Branch Protection Evidence (2026-07-16)

The live Gitea Fixture repository
`courseadmin/course-python-good-20260716-1784161808236` was configured with
`main` protection, `enable_push=false`, five Required Checks and
`required_approvals=1`.

| Gate | Result | Evidence |
|---|---|---|
| G-07 direct push to `main` | Passed | Gitea Contents API returned HTTP 403: `user cannot commit to repo` |
| G-08 merge without approval | Passed | Gitea merge API returned HTTP 405: `not allowed to merge [reason: Does not have enough approvals]` |

## G-19 Worker RBAC Evidence (2026-07-16)

Live `kubectl auth can-i` checks were run against
`system:serviceaccount:platform-system:platform-worker` in the rootful k3s
harness. The Worker can get Namespaces, create Jobs and read Pod logs. It was
denied access to Secrets (`get` and `list`), Nodes, CRDs and ClusterRoles.
The generated ClusterRole and static tests additionally constrain Secret
access to `create/delete` and omit `pods/exec`, ServiceAccounts and RBAC
administration.

## G-11 Sandbox Secret Boundary Evidence (2026-07-16)

A live Restricted PSA smoke Namespace ran Runner, Analysis and Preview Pods
with the same non-root, read-only-rootfs and tokenless boundaries used by the
course resources. All three Pods reached Ready. Inside each container the
ServiceAccount token path was absent and no `GITEA`, `DATABASE`, `OPENAI`,
`KUBECONFIG`, `TOKEN`, `SECRET` or `KEY` environment variable was present.
The Pod specs reported `automountServiceAccountToken=false` and
`readOnlyRootFilesystem=true`, with only the bounded `/tmp` emptyDir mounted.
The Source Fetch Secret remains the explicit trusted exception; static Job
builder tests restrict it to the read-only `/var/run/platform/source` mount.

## G-18/G-20 Partial Evidence (2026-07-16)

Live API checks returned anonymous `/api/me` for no cookie, HTTP 401 for the
protected Run GET and cancel POST, a Gitea OAuth authorize redirect for
`/auth/login`, and a rejected forged callback. The remaining successful OAuth
callback, state replay/expiry, CSRF with a valid session, and eight-location
Gitleaks Canary remain separate tests to complete. The new AuthService unit
flow now covers mock token exchange, one-time state consumption, Session
creation, valid CSRF, malformed CSRF and state replay (3 tests passed in the
amd64 runtime); this is code-level evidence, not a browser/real OAuth
exchange.

The amd64 Worker runtime container ran the relevant reliability tests
individually: Outbox recovery, workflow planning, StepGuard, timeout config,
Fixture executor, Run operation policy, Webhook contracts and Run status
contracts passed (28 tests). A larger aggregate run triggered the known
esbuild Go runtime crash under local ARM-to-amd64 emulation; this is recorded
as an environment limitation rather than a passing full-suite claim.

## Still Unverified or Deferred

- G-00 dynamic rootless BuildKit remains P1 after the failed POC. A fixed
  Fixture `push -> pull -> digest deployment` run is still needed for a P0
  BuildKit evidence claim.
- G-03 through G-06 are verified above.
- The platform writes Required Checks and review evidence; Gitea remains the
  enforcement point for branch protection and human approval.
- G-12 is verified for the rootful single-node course harness with prepared
  amd64 images and digest-pinned Runner/Preview images. A fresh unprepared
  server run is still deferred.
- G-17 is verified for the prepared rootful course harness: API, Worker,
  Agent Review and Web were rolled, while PostgreSQL/Gitea/Registry PVCs
  remained Bound; the previously recorded Runs and Reports remained readable,
  Registry `/v2/` returned 200, and platform log paths/expires_at records
  remained present after restart. A full platform data backup/restore drill
  remains deferred.
- G-15 now has a max-retry circuit breaker (3 attempts) in the retention
  worker. The complete Registry image reference write path and orphan PVC/PV
  scan are still deferred.
- G-18 now has `__Host-` prefixed session cookie, `OAUTH_LOGIN_INITIATED`,
  `OAUTH_LOGIN_SUCCEEDED`, and `SESSION_REVOKED` audit events. The full
  browser-level OAuth flow and Secret Canary tests remain to be completed.
- G-20 now has `pg_advisory_xact_lock` in worker `transitionRun`, retry
  capacity now checks active runs, and `saveReport` has headSha CAS in its
  `onConflictDoUpdate`. Broader concurrency stress tests remain to be written.
- G-13 API permissions analysis shows authentication guards, repository read
  authorization with anti-enumeration, maintainer-only retry/cancel, and CSRF
  protection are well-implemented. Rate limiting and security headers
  (Helmet) remain gaps.
- G-19 RBAC is verified above.
- k3d/k3s remains a course execution environment, not a production untrusted
  code sandbox, HA cluster or multi-tenant boundary.
