import type {
  ContainerSecurityContext,
  PodSecurityContext,
  ResourceQuantities,
  ResourceRequirements,
} from "./types.js";

export const K8S_LABELS = Object.freeze({
  managed: "platform.io/managed",
  runId: "platform.io/run-id",
  attempt: "platform.io/attempt",
  stepKey: "platform.io/step-key",
  resource: "platform.io/resource",
} as const);

export const K8S_ANNOTATIONS = Object.freeze({
  expiresAt: "platform.io/expires-at",
} as const);

export const RESOURCE_QUOTA_HARD = Object.freeze({
  "requests.cpu": "2",
  "limits.cpu": "4",
  "requests.memory": "3Gi",
  "limits.memory": "6Gi",
  "requests.ephemeral-storage": "4Gi",
  "limits.ephemeral-storage": "6Gi",
  "count/pods": "8",
  "count/jobs.batch": "4",
  "count/deployments.apps": "1",
  "count/services": "2",
  "count/persistentvolumeclaims": "1",
} as const satisfies ResourceQuantities);

export const LIMIT_RANGE_DEFAULT_REQUESTS = Object.freeze({
  cpu: "100m",
  memory: "128Mi",
  "ephemeral-storage": "128Mi",
} as const satisfies ResourceQuantities);

export const LIMIT_RANGE_DEFAULTS = Object.freeze({
  cpu: "1",
  memory: "1Gi",
  "ephemeral-storage": "1Gi",
} as const satisfies ResourceQuantities);

export const RESOURCES = Object.freeze({
  sourceFetch: {
    requests: { cpu: "100m", memory: "128Mi", "ephemeral-storage": "256Mi" },
    limits: { cpu: "1", memory: "1Gi", "ephemeral-storage": "1Gi" },
  },
  analysisTools: {
    requests: { cpu: "100m", memory: "128Mi", "ephemeral-storage": "256Mi" },
    limits: { cpu: "1", memory: "1Gi", "ephemeral-storage": "1Gi" },
  },
  buildTest: {
    requests: { cpu: "1", memory: "1Gi", "ephemeral-storage": "1Gi" },
    limits: { cpu: "2", memory: "4Gi", "ephemeral-storage": "4Gi" },
  },
  preview: {
    requests: { cpu: "100m", memory: "128Mi", "ephemeral-storage": "128Mi" },
    limits: { cpu: "500m", memory: "512Mi", "ephemeral-storage": "512Mi" },
  },
} as const satisfies Record<string, ResourceRequirements>);

export const RESTRICTED_POD_SECURITY_CONTEXT: PodSecurityContext = Object.freeze({
  runAsNonRoot: true,
  runAsUser: 1000,
  runAsGroup: 1000,
  fsGroup: 1000,
  seccompProfile: { type: "RuntimeDefault" as const },
});

export const RESTRICTED_CONTAINER_SECURITY_CONTEXT: ContainerSecurityContext = Object.freeze({
  runAsNonRoot: true,
  runAsUser: 1000,
  runAsGroup: 1000,
  allowPrivilegeEscalation: false,
  readOnlyRootFilesystem: true,
  capabilities: { drop: ["ALL"] as ["ALL"] },
});

export const JOB_LIFECYCLE = Object.freeze({
  completions: 1,
  parallelism: 1,
  backoffLimit: 0,
  activeDeadlineSeconds: 900,
  ttlSecondsAfterFinished: 604800,
} as const);

export const WORKSPACE_CLAIM_NAME = "workspace";
export const DEFAULT_SERVICE_ACCOUNT_NAME = "default";
export const PLATFORM_NAMESPACE = "platform-system";
export const WORKER_SERVICE_ACCOUNT_NAME = "platform-worker";
export const WORKER_CLUSTER_ROLE_NAME = "platform-worker";

export const JOB_PROFILES = Object.freeze({
  sourceFetch: {
    stepKey: "fetch",
    containerName: "source-fetch",
    command: ["/platform/run", "fetch"] as const,
    workspaceReadOnly: false,
    ephemeralStorageLimit: "1Gi",
  },
  analysisTools: {
    stepKey: "analyze",
    containerName: "analysis-tools",
    command: ["/platform/run", "analyze"] as const,
    workspaceReadOnly: true,
    ephemeralStorageLimit: "1Gi",
  },
  buildTest: {
    stepKey: "test",
    containerName: "build-test",
    command: ["/platform/run", "build-test"] as const,
    workspaceReadOnly: false,
    ephemeralStorageLimit: "4Gi",
  },
} as const);

export type JobProfile = keyof typeof JOB_PROFILES;

export const FIXED_PROFILE_STEP_KEYS = new Set(
  Object.values(JOB_PROFILES).map((profile) => profile.stepKey),
);
