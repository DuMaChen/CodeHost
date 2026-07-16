import {
  K8S_LABELS,
  PLATFORM_NAMESPACE,
  WORKER_CLUSTER_ROLE_NAME,
  WORKER_SERVICE_ACCOUNT_NAME,
} from "./constants.js";
import type { ClusterRoleBindingObject, ClusterRoleObject, PolicyRule } from "./types.js";

const WORKER_RULES: readonly PolicyRule[] = [
  { apiGroups: [""], resources: ["namespaces"], verbs: ["get", "list", "watch", "create", "update", "delete"] },
  { apiGroups: [""], resources: ["resourcequotas", "limitranges"], verbs: ["get", "create", "update", "delete"] },
  { apiGroups: ["batch"], resources: ["jobs"], verbs: ["get", "list", "watch", "create", "delete"] },
  { apiGroups: [""], resources: ["pods"], verbs: ["get", "list", "watch", "create", "delete"] },
  { apiGroups: [""], resources: ["pods/log"], verbs: ["get"] },
  { apiGroups: ["apps"], resources: ["deployments"], verbs: ["get", "list", "watch", "create", "update", "delete"] },
  { apiGroups: [""], resources: ["services"], verbs: ["get", "list", "watch", "create", "update", "delete"] },
  { apiGroups: ["networking.k8s.io"], resources: ["ingresses"], verbs: ["get", "list", "watch", "create", "update", "delete"] },
  { apiGroups: [""], resources: ["persistentvolumeclaims"], verbs: ["get", "create", "delete"] },
  // Worker creates and deletes the one-shot source-fetch Secret; it never
  // reads Secret metadata or data. The kubelet performs the mount for the
  // fetch Job, and deletion uses the UID returned by creation as a precondition.
  { apiGroups: [""], resources: ["secrets"], verbs: ["create", "delete"] },
];

const PLATFORM_LABELS = Object.freeze({
  [K8S_LABELS.managed]: "true",
  "platform.io/component": "worker",
});

export function buildWorkerClusterRole(): ClusterRoleObject {
  return {
    apiVersion: "rbac.authorization.k8s.io/v1",
    kind: "ClusterRole",
    metadata: {
      name: WORKER_CLUSTER_ROLE_NAME,
      labels: PLATFORM_LABELS,
    },
    rules: WORKER_RULES,
  };
}

export function buildWorkerClusterRoleBinding(): ClusterRoleBindingObject {
  return {
    apiVersion: "rbac.authorization.k8s.io/v1",
    kind: "ClusterRoleBinding",
    metadata: {
      name: WORKER_CLUSTER_ROLE_NAME,
      labels: PLATFORM_LABELS,
    },
    subjects: [
      {
        kind: "ServiceAccount",
        name: WORKER_SERVICE_ACCOUNT_NAME,
        namespace: PLATFORM_NAMESPACE,
      },
    ],
    roleRef: {
      apiGroup: "rbac.authorization.k8s.io",
      kind: "ClusterRole",
      name: WORKER_CLUSTER_ROLE_NAME,
    },
  };
}

export function workerRbacRules(): readonly PolicyRule[] {
  return WORKER_RULES;
}
