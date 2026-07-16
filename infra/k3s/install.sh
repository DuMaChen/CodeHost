#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

die() {
  printf 'k3s install: %s\n' "$*" >&2
  exit 1
}

command -v kubectl >/dev/null 2>&1 || die "kubectl is required"
command -v envsubst >/dev/null 2>&1 || die "envsubst is required (gettext)"

: "${REGISTRY_HOST:?set REGISTRY_HOST to a private DNS name or private IP}"
: "${PLATFORM_HOST:?set PLATFORM_HOST to the platform DNS name}"
: "${GITEA_HOST:?set GITEA_HOST to the Gitea DNS name}"
: "${PLATFORM_API_IMAGE:?set PLATFORM_API_IMAGE}"
: "${PLATFORM_WORKER_IMAGE:?set PLATFORM_WORKER_IMAGE}"
: "${PLATFORM_AGENT_IMAGE:?set PLATFORM_AGENT_IMAGE}"
: "${PLATFORM_WEB_IMAGE:?set PLATFORM_WEB_IMAGE}"
: "${PLATFORM_RUNNER_IMAGE:?set PLATFORM_RUNNER_IMAGE}"
: "${PLATFORM_PREVIEW_IMAGE:?set PLATFORM_PREVIEW_IMAGE}"
: "${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD outside the repository}"
: "${DATABASE_URL:?set DATABASE_URL outside the repository}"
: "${GITEA_WEBHOOK_SECRET:?set GITEA_WEBHOOK_SECRET outside the repository}"
: "${SESSION_ENCRYPTION_KEY:?set SESSION_ENCRYPTION_KEY outside the repository}"
: "${GITEA_RUNNER_TOKEN:?set GITEA_RUNNER_TOKEN outside the repository}"
: "${GITEA_PLATFORM_TOKEN:?set GITEA_PLATFORM_TOKEN outside the repository}"
: "${GITEA_OAUTH_CLIENT_ID:?set GITEA_OAUTH_CLIENT_ID outside the repository}"
: "${GITEA_OAUTH_CLIENT_SECRET:?set GITEA_OAUTH_CLIENT_SECRET outside the repository}"
: "${PLATFORM_TLS_SECRET_NAME:?set PLATFORM_TLS_SECRET_NAME to an existing TLS Secret}"

AGENT_REPLICAS="${AGENT_REPLICAS:-1}"
PREVIEW_MODE="${PREVIEW_MODE:-ingress}"
export PREVIEW_MODE

[[ "$PREVIEW_MODE" == "ingress" || "$PREVIEW_MODE" == "ssh" ]] || die "PREVIEW_MODE must be ingress or ssh"
if [[ "$PREVIEW_MODE" == "ingress" && -z "${PREVIEW_BASE_URL:-}" ]]; then
  die "PREVIEW_BASE_URL is required when PREVIEW_MODE=ingress"
fi
if [[ "$PREVIEW_MODE" == "ingress" && "${PREVIEW_BASE_URL:-}" == https:* && -z "${PREVIEW_TLS_SECRET_NAME:-}" ]]; then
  die "PREVIEW_TLS_SECRET_NAME is required for HTTPS Preview ingress"
fi
PREVIEW_SSH_HOST="${PREVIEW_SSH_HOST:-}"
PREVIEW_SSH_USER="${PREVIEW_SSH_USER:-}"
PREVIEW_SSH_PORT="${PREVIEW_SSH_PORT:-}"
PREVIEW_BASE_URL="${PREVIEW_BASE_URL:-}"
PREVIEW_TLS_SECRET_NAME="${PREVIEW_TLS_SECRET_NAME:-}"
if [[ "$PREVIEW_MODE" == "ssh" ]]; then
  [[ -n "$PREVIEW_SSH_HOST" ]] || die "PREVIEW_SSH_HOST is required when PREVIEW_MODE=ssh"
  [[ -n "$PREVIEW_SSH_USER" ]] || die "PREVIEW_SSH_USER is required when PREVIEW_MODE=ssh"
  PREVIEW_SSH_PORT="${PREVIEW_SSH_PORT:-22}"
  [[ "$PREVIEW_SSH_PORT" =~ ^[0-9]+$ ]] || die "PREVIEW_SSH_PORT must be an integer"
  (( PREVIEW_SSH_PORT >= 1 && PREVIEW_SSH_PORT <= 65535 )) || die "PREVIEW_SSH_PORT must be between 1 and 65535"
fi
export PREVIEW_SSH_HOST PREVIEW_SSH_USER PREVIEW_SSH_PORT

[[ "$REGISTRY_HOST" != *localhost* ]] || die "REGISTRY_HOST must not contain localhost"
[[ "$REGISTRY_HOST" != *127.0.0.1* ]] || die "REGISTRY_HOST must not contain 127.0.0.1"
[[ "$REGISTRY_HOST" != *0.0.0.0* ]] || die "REGISTRY_HOST must not contain 0.0.0.0"
[[ "$REGISTRY_HOST" != */* ]] || die "REGISTRY_HOST must not contain a path"
[[ "$REGISTRY_HOST" != *:* ]] || die "REGISTRY_HOST must not contain a port"
[[ "$REGISTRY_HOST" != *://* ]] || die "REGISTRY_HOST must not include a URL scheme"

[[ "$AGENT_REPLICAS" =~ ^[1-3]$ ]] || die "AGENT_REPLICAS must be 1, 2, or 3"
[[ "$PLATFORM_API_IMAGE" != *localhost* ]] || die "API image must not use localhost"
[[ "$PLATFORM_WORKER_IMAGE" != *localhost* ]] || die "Worker image must not use localhost"
[[ "$PLATFORM_AGENT_IMAGE" != *localhost* ]] || die "Agent image must not use localhost"
[[ "$PLATFORM_RUNNER_IMAGE" =~ @sha256:[0-9a-f]{64}$ ]] || die "PLATFORM_RUNNER_IMAGE must be digest-pinned"
[[ "$PLATFORM_PREVIEW_IMAGE" =~ @sha256:[0-9a-f]{64}$ ]] || die "PLATFORM_PREVIEW_IMAGE must be digest-pinned"

export REGISTRY_PUSH_HOST="${REGISTRY_HOST}:30500"
export REGISTRY_PULL_HOST="${REGISTRY_HOST}:30500"
export REGISTRY_API_URL="${REGISTRY_API_URL:-http://${REGISTRY_HOST}:30500}"
export AGENT_PROVIDER="${AGENT_PROVIDER:-mock}"
export K8S_JOB_TIMEOUT_MS="${K8S_JOB_TIMEOUT_MS:-900000}"

umask 077
rendered="$(mktemp "${TMPDIR:-/tmp}/ai-platform-k3s.XXXXXX.yaml")"
tmp_rendered="${rendered}.tmp"
trap 'rm -f "$tmp_rendered" "$rendered"' EXIT

envsubst '${REGISTRY_HOST} ${REGISTRY_PUSH_HOST} ${REGISTRY_PULL_HOST} ${REGISTRY_API_URL} ${PLATFORM_HOST} ${PLATFORM_PUBLIC_URL} ${GITEA_HOST} ${PREVIEW_MODE} ${PREVIEW_BASE_URL} ${PREVIEW_TLS_SECRET_NAME} ${PREVIEW_SSH_HOST} ${PREVIEW_SSH_USER} ${PREVIEW_SSH_PORT} ${PLATFORM_TLS_SECRET_NAME} ${PLATFORM_API_IMAGE} ${PLATFORM_WORKER_IMAGE} ${PLATFORM_AGENT_IMAGE} ${PLATFORM_WEB_IMAGE} ${PLATFORM_RUNNER_IMAGE} ${PLATFORM_PREVIEW_IMAGE} ${AGENT_REPLICAS} ${K8S_JOB_TIMEOUT_MS} ${POSTGRES_PASSWORD} ${DATABASE_URL} ${GITEA_WEBHOOK_SECRET} ${SESSION_ENCRYPTION_KEY} ${GITEA_RUNNER_TOKEN} ${GITEA_PLATFORM_TOKEN} ${GITEA_OAUTH_CLIENT_ID} ${GITEA_OAUTH_CLIENT_SECRET} ${AGENT_PROVIDER}' \
  < "$SCRIPT_DIR/platform.yaml.tmpl" > "$tmp_rendered"
mv "$tmp_rendered" "$rendered"

kubectl apply -f - <<'EOF'
apiVersion: v1
kind: Namespace
metadata:
  name: platform-system
  labels:
    app.kubernetes.io/part-of: ai-native-pr-platform
    pod-security.kubernetes.io/audit: restricted
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/warn: restricted
EOF
kubectl apply -f "$SCRIPT_DIR/rbac.yaml"
for deployment in platform-gitea platform-api platform-worker platform-agent-review platform-web; do
  if kubectl -n platform-system get deployment "$deployment" >/dev/null 2>&1; then
    kubectl -n platform-system scale deployment "$deployment" --replicas=0
  fi
done
kubectl -n platform-system delete job platform-migrate --ignore-not-found --wait=true
kubectl apply --selector='platform.io/start-phase!=runtime' -f "$rendered"

kubectl -n platform-system rollout status deployment/platform-postgres --timeout=5m
if ! kubectl -n platform-system wait --for=condition=complete job/platform-migrate --timeout=5m; then
  kubectl -n platform-system describe job/platform-migrate || true
  kubectl -n platform-system logs job/platform-migrate --all-containers=true --ignore-errors || true
  die "platform-migrate did not complete"
fi

kubectl apply --selector='platform.io/start-phase=runtime' -f "$rendered"
kubectl -n platform-system rollout status deployment/platform-api --timeout=5m
kubectl -n platform-system rollout status deployment/platform-worker --timeout=5m
kubectl -n platform-system rollout status deployment/platform-agent-review --timeout=5m
kubectl -n platform-system rollout status deployment/platform-web --timeout=5m

cat <<EOF
k3s resources applied in namespace platform-system
Registry for BuildKit and Preview: ${REGISTRY_PUSH_HOST}
Agent review replicas: ${AGENT_REPLICAS}
Database migration Job completed before application rollouts.
Rendered manifest was applied from a temporary mode-0600 file and removed on exit.

Before the first Run, verify:
  kubectl -n platform-system get pods,pvc
EOF
