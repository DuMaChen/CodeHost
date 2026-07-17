#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
NAMESPACE="${BUILDKIT_POC_NAMESPACE:-buildkit-poc}"
JOB_NAME="buildkit-rootless-poc"
BUILDKIT_IMAGE="${BUILDKIT_IMAGE:?set BUILDKIT_IMAGE to a digest-pinned rootless BuildKit image}"
BUILD_IMAGE="${BUILD_IMAGE:-ai-registry:5000/platform/buildkit-smoke}"
REGISTRY_DEBUG_URL="${REGISTRY_DEBUG_URL:-http://127.0.0.1:5111}"
KUBECTL=(kubectl)
if [[ -n "${KUBECONFIG:-}" ]]; then
  KUBECTL=(kubectl --kubeconfig "$KUBECONFIG")
fi

die() {
  printf 'BuildKit smoke test: %s\n' "$*" >&2
  exit 1
}

command -v kubectl >/dev/null 2>&1 || die "kubectl is required"
command -v curl >/dev/null 2>&1 || die "curl is required"
command -v envsubst >/dev/null 2>&1 || die "envsubst is required"
[[ "$BUILDKIT_IMAGE" == *@sha256:* ]] || die "BUILDKIT_IMAGE must be digest-pinned"
[[ "$BUILD_IMAGE" != *@* ]] || die "BUILD_IMAGE must be an untagged repository reference"
[[ "$BUILD_IMAGE" == */* ]] || die "BUILD_IMAGE must include a registry host and repository"

registry_repository="${BUILD_IMAGE#*/}"
[[ "$registry_repository" != *:* ]] || die "BUILD_IMAGE must not include a tag"
[[ "$registry_repository" =~ ^[a-z0-9][a-z0-9._/-]*$ ]] || die "BUILD_IMAGE repository is invalid"

rendered="$(mktemp "${TMPDIR:-/tmp}/buildkit-poc.XXXXXX.yaml")"
preview="$(mktemp "${TMPDIR:-/tmp}/buildkit-preview.XXXXXX.yaml")"
cleanup() {
  rm -f "$rendered" "$preview"
  if [[ "${KEEP_POC_RESOURCES:-0}" != "1" ]]; then
    "${KUBECTL[@]}" delete namespace "$NAMESPACE" --ignore-not-found >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

export BUILDKIT_IMAGE BUILD_IMAGE
envsubst '${BUILDKIT_IMAGE} ${BUILD_IMAGE}' \
  < "$SCRIPT_DIR/buildkit-rootless-poc.yaml.tmpl" > "$rendered"
"${KUBECTL[@]}" apply -f "$rendered"
started_at="$(date +%s)"
while true; do
  failed_count="$("${KUBECTL[@]}" -n "$NAMESPACE" get job "$JOB_NAME" -o jsonpath='{.status.failed}' 2>/dev/null || true)"
  if [[ "$failed_count" =~ ^[1-9][0-9]*$ ]]; then
    "${KUBECTL[@]}" -n "$NAMESPACE" logs "job/$JOB_NAME" --all-containers=true >&2 || true
    die "BuildKit POC Job failed"
  fi
  if "${KUBECTL[@]}" -n "$NAMESPACE" wait --for=condition=complete "job/$JOB_NAME" --timeout=1s >/dev/null 2>&1; then
    break
  fi
  (( $(date +%s) - started_at >= 900 )) && die "BuildKit POC Job timed out"
  sleep 5
done

manifest_url="${REGISTRY_DEBUG_URL%/}/v2/${registry_repository}/manifests/run-buildkit-poc"
digest="$(curl --fail --silent --show-error --location \
  --connect-timeout 5 --max-time 15 \
  -H 'Accept: application/vnd.oci.image.manifest.v1+json' \
  -H 'Accept: application/vnd.docker.distribution.manifest.v2+json' \
  -I "$manifest_url" \
  | awk 'tolower($1) == "docker-content-digest:" { print $2 }' \
  | tr -d '\r' \
  | tail -n 1)"
[[ "$digest" == sha256:* ]] || die "Registry did not return an immutable manifest digest"

cat > "$preview" <<EOF
apiVersion: apps/v1
kind: Deployment
metadata:
  name: buildkit-poc-preview
  namespace: ${NAMESPACE}
  labels:
    platform.io/managed: "true"
    platform.io/run-id: buildkit-poc
spec:
  replicas: 1
  revisionHistoryLimit: 0
  selector:
    matchLabels:
      platform.io/run-id: buildkit-poc
  template:
    metadata:
      labels:
        platform.io/run-id: buildkit-poc
    spec:
      automountServiceAccountToken: false
      securityContext:
        runAsNonRoot: true
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: preview
          image: ${BUILD_IMAGE}@${digest}
          imagePullPolicy: IfNotPresent
          command: ["sh", "-c", "sleep 300"]
          securityContext:
            runAsUser: 65532
            runAsGroup: 65532
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: [ALL]
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
              ephemeral-storage: 128Mi
            limits:
              cpu: 500m
              memory: 512Mi
              ephemeral-storage: 512Mi
          volumeMounts:
            - name: tmp
              mountPath: /tmp
      volumes:
        - name: tmp
          emptyDir:
            sizeLimit: 32Mi
EOF

"${KUBECTL[@]}" apply -f "$preview"
"${KUBECTL[@]}" -n "$NAMESPACE" rollout status deployment/buildkit-poc-preview --timeout=5m
printf 'BuildKit POC passed: pushed and pulled %s@%s\n' "$BUILD_IMAGE" "$digest"
