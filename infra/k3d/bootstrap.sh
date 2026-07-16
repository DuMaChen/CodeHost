#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
ROOT_DIR="$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)"

CLUSTER_NAME="${K3D_CLUSTER_NAME:-ai-platform}"
NETWORK_NAME="${K3D_NETWORK_NAME:-ai-platform-k3d}"
REGISTRY_NAME="${K3D_REGISTRY_NAME:-ai-registry}"
REGISTRY_PORT="${K3D_REGISTRY_PORT:-5000}"
REGISTRY_DEBUG_PORT="${K3D_REGISTRY_DEBUG_PORT:-5111}"
API_PORT="${K3D_API_PORT:-6550}"
AGENT_NODES="${K3D_AGENTS:-1}"
KUBECONFIG_PATH="${K3D_KUBECONFIG:-$SCRIPT_DIR/kubeconfig}"
WORKER_KUBECONFIG_PATH="${K3D_WORKER_KUBECONFIG:-${KUBECONFIG_PATH}.worker}"

die() {
  printf 'k3d bootstrap: %s\n' "$*" >&2
  exit 1
}

command -v docker >/dev/null 2>&1 || die "docker is required"
command -v k3d >/dev/null 2>&1 || die "k3d is required"
command -v kubectl >/dev/null 2>&1 || die "kubectl is required"

[[ "$AGENT_NODES" =~ ^[0-9]+$ ]] || die "K3D_AGENTS must be a non-negative integer"
[[ "$API_PORT" =~ ^[0-9]+$ ]] || die "K3D_API_PORT must be an integer"

registry_config_tmp="$(mktemp "${TMPDIR:-/tmp}/ai-platform-k3d-registries.XXXXXX")"
trap 'rm -f "$registry_config_tmp"' EXIT
sed "s/ai-registry:5000/${REGISTRY_NAME}:${REGISTRY_PORT}/g" \
  "$SCRIPT_DIR/registries.yaml" > "$registry_config_tmp"

if ! docker network inspect "$NETWORK_NAME" >/dev/null 2>&1; then
  docker network create "$NETWORK_NAME" >/dev/null
fi

if docker container inspect "$REGISTRY_NAME" >/dev/null 2>&1; then
  docker network connect --alias "$REGISTRY_NAME" "$NETWORK_NAME" "$REGISTRY_NAME" >/dev/null 2>&1 || true
  docker start "$REGISTRY_NAME" >/dev/null 2>&1 || true
else
  docker volume create ai-platform-k3d-registry >/dev/null
  docker run --detach \
    --name "$REGISTRY_NAME" \
    --restart unless-stopped \
    --network "$NETWORK_NAME" \
    --network-alias "$REGISTRY_NAME" \
    --publish "${REGISTRY_DEBUG_PORT}:${REGISTRY_PORT}" \
    --volume ai-platform-k3d-registry:/var/lib/registry \
    --env REGISTRY_STORAGE_DELETE_ENABLED=true \
    --env REGISTRY_HTTP_ADDR="0.0.0.0:${REGISTRY_PORT}" \
    registry:2.8.3 \
    /bin/registry serve /etc/docker/registry/config.yml >/dev/null
fi

if ! k3d cluster list --no-headers 2>/dev/null | awk '{print $1}' | grep -Fxq "$CLUSTER_NAME"; then
  k3d cluster create "$CLUSTER_NAME" \
    --servers 1 \
    --agents "$AGENT_NODES" \
    --api-port "0.0.0.0:${API_PORT}" \
    --network "$NETWORK_NAME" \
    --registry-config "$registry_config_tmp" \
    --wait
fi

if [[ -d "$KUBECONFIG_PATH" ]]; then
  rmdir "$KUBECONFIG_PATH" || die "K3D_KUBECONFIG points to a non-empty directory"
fi
if [[ -d "$WORKER_KUBECONFIG_PATH" ]]; then
  rmdir "$WORKER_KUBECONFIG_PATH" || die "K3D_WORKER_KUBECONFIG points to a non-empty directory"
fi
mkdir -p "$(dirname -- "$KUBECONFIG_PATH")" "$(dirname -- "$WORKER_KUBECONFIG_PATH")"
tmp_kubeconfig="${KUBECONFIG_PATH}.tmp.$$"
tmp_worker_kubeconfig="${WORKER_KUBECONFIG_PATH}.tmp.$$"
trap 'rm -f "$tmp_kubeconfig" "$tmp_worker_kubeconfig"' EXIT

# The host kubeconfig is for kubectl on the developer machine. The Worker
# receives a separate copy because it reaches the API through the Docker host
# gateway rather than the host's loopback interface.
raw_kubeconfig="$(k3d kubeconfig get "$CLUSTER_NAME")"
printf '%s\n' "$raw_kubeconfig" \
  | sed -E "s#https://(0\.0\.0\.0|127\.0\.0\.1|localhost):${API_PORT}#https://127.0.0.1:${API_PORT}#g" \
  > "$tmp_kubeconfig"
printf '%s\n' "$raw_kubeconfig" \
  | sed -E "s#https://(0\.0\.0\.0|127\.0\.0\.1|localhost):${API_PORT}#https://host.docker.internal:${API_PORT}#g" \
  | awk -v server="server: https://host.docker.internal:${API_PORT}" -v tls="    tls-server-name: k3d-${CLUSTER_NAME}-server-0" '{ print; if (index($0, server) > 0) print tls }' \
  > "$tmp_worker_kubeconfig"
chmod 600 "$tmp_kubeconfig"
chmod 600 "$tmp_worker_kubeconfig"
mv "$tmp_kubeconfig" "$KUBECONFIG_PATH"
mv "$tmp_worker_kubeconfig" "$WORKER_KUBECONFIG_PATH"
trap - EXIT

kubectl --kubeconfig "$KUBECONFIG_PATH" wait --for=condition=Ready nodes --all --timeout=120s >/dev/null

cat <<EOF
k3d cluster: ${CLUSTER_NAME}
registry for k3d Pods: ${REGISTRY_NAME}:${REGISTRY_PORT}
registry debug endpoint: http://127.0.0.1:${REGISTRY_DEBUG_PORT}
kubeconfig for trusted Worker: ${KUBECONFIG_PATH}
kubeconfig for trusted Worker container: ${WORKER_KUBECONFIG_PATH}
agent nodes: ${AGENT_NODES}
EOF
