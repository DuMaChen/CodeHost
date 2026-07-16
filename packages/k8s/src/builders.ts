import {
  DEFAULT_SERVICE_ACCOUNT_NAME,
  JOB_LIFECYCLE,
  JOB_PROFILES,
  K8S_ANNOTATIONS,
  K8S_LABELS,
  LIMIT_RANGE_DEFAULTS,
  LIMIT_RANGE_DEFAULT_REQUESTS,
  RESOURCE_QUOTA_HARD,
  RESOURCES,
  RESTRICTED_CONTAINER_SECURITY_CONTEXT,
  RESTRICTED_POD_SECURITY_CONTEXT,
  WORKSPACE_CLAIM_NAME,
  type JobProfile,
} from "./constants.js";
import {
  assertAttempt,
  assertContainerPort,
  assertHealthPath,
  assertImageReference,
  assertLabelValue,
  assertNamespace,
  assertSafeSlug,
  assertStepKey,
  expirationIso,
  ingressHost,
} from "./validation.js";
import type {
  Annotations,
  Container,
  DeploymentObject,
  EnvironmentVariable,
  IngressObject,
  IngressPath,
  JobObject,
  KubernetesObject,
  Labels,
  LimitRangeObject,
  NamespaceObject,
  ObjectMeta,
  PersistentVolumeClaimObject,
  PodTemplateSpec,
  ResourceQuotaObject,
  ServiceAccountObject,
  ServiceObject,
  Volume,
} from "./types.js";

export interface RunIdentity {
  readonly runId: string;
  readonly runShortId: string;
  readonly attempt: number;
}

export interface ResourceIdentity extends RunIdentity {
  readonly stepKey: string;
}

export type ResourceStepKey = "fetch" | "analyze" | "test" | "build" | "preview";

export function namespaceName(runShortId: string): string {
  assertSafeSlug(runShortId, "runShortId", 32);
  return `pr-run-${runShortId}`;
}

export function resourceName(
  runShortId: string,
  attempt: number,
  stepKey: ResourceStepKey,
): string {
  assertSafeSlug(runShortId, "runShortId", 32);
  assertAttempt(attempt);
  assertStepKey(stepKey);
  const name = `run-${runShortId}-a${attempt}-${stepKey}`;
  if (name.length > 63) {
    throw new RangeError("resource name exceeds the Kubernetes DNS label limit");
  }
  return name;
}

export function workspaceClaimName(): typeof WORKSPACE_CLAIM_NAME {
  return WORKSPACE_CLAIM_NAME;
}

export function labelsForRun(run: RunIdentity, resource: string): Labels {
  const runId = assertLabelValue(run.runId, "runId");
  assertSafeSlug(run.runShortId, "runShortId", 32);
  const attempt = assertAttempt(run.attempt);
  assertLabelValue(resource, "resource");
  return {
    [K8S_LABELS.managed]: "true",
    [K8S_LABELS.runId]: runId,
    [K8S_LABELS.attempt]: String(attempt),
    [K8S_LABELS.resource]: resource,
  };
}

export function labelsForResource(run: ResourceIdentity, resource: string): Labels {
  return {
    ...labelsForRun(run, resource),
    [K8S_LABELS.stepKey]: assertStepKey(run.stepKey),
  };
}

function namespaceMetadata(run: RunIdentity): ObjectMeta {
  return {
    name: namespaceName(run.runShortId),
    labels: {
      [K8S_LABELS.managed]: "true",
      [K8S_LABELS.runId]: assertLabelValue(run.runId, "runId"),
      "pod-security.kubernetes.io/enforce": "restricted",
      "pod-security.kubernetes.io/audit": "restricted",
      "pod-security.kubernetes.io/warn": "restricted",
    },
  };
}

export function buildNamespace(run: RunIdentity): NamespaceObject {
  return {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: namespaceMetadata(run),
  };
}

export function buildDefaultServiceAccount(run: RunIdentity): ServiceAccountObject {
  const namespace = namespaceName(run.runShortId);
  return {
    apiVersion: "v1",
    kind: "ServiceAccount",
    metadata: {
      name: DEFAULT_SERVICE_ACCOUNT_NAME,
      namespace,
      labels: labelsForRun(run, "service-account"),
    },
    automountServiceAccountToken: false,
  };
}

export function buildResourceQuota(run: RunIdentity): ResourceQuotaObject {
  const namespace = namespaceName(run.runShortId);
  return {
    apiVersion: "v1",
    kind: "ResourceQuota",
    metadata: {
      name: "run-quota",
      namespace,
      labels: labelsForRun(run, "quota"),
    },
    spec: { hard: RESOURCE_QUOTA_HARD },
  };
}

export function buildLimitRange(run: RunIdentity): LimitRangeObject {
  const namespace = namespaceName(run.runShortId);
  return {
    apiVersion: "v1",
    kind: "LimitRange",
    metadata: {
      name: "run-defaults",
      namespace,
      labels: labelsForRun(run, "limit-range"),
    },
    spec: {
      limits: [
        {
          type: "Container",
          defaultRequest: LIMIT_RANGE_DEFAULT_REQUESTS,
          default: LIMIT_RANGE_DEFAULTS,
        },
      ],
    },
  };
}

export function buildWorkspaceClaim(run: RunIdentity, storageClassName = "local-path"): PersistentVolumeClaimObject {
  const namespace = namespaceName(run.runShortId);
  return {
    apiVersion: "v1",
    kind: "PersistentVolumeClaim",
    metadata: {
      name: WORKSPACE_CLAIM_NAME,
      namespace,
      labels: labelsForRun(run, "workspace"),
    },
    spec: {
      accessModes: ["ReadWriteOnce"],
      resources: { requests: { storage: "4Gi" } },
      storageClassName,
      volumeMode: "Filesystem",
    },
  };
}

export interface JobOptions extends ResourceIdentity {
  readonly profile: JobProfile;
  readonly image: string;
  readonly sourceCredentialSecretName?: string;
  readonly environment?: readonly EnvironmentVariable[];
}

export function buildJob(options: JobOptions): JobObject {
  const profile = JOB_PROFILES[options.profile];
  if (options.stepKey !== "fetch" && options.stepKey !== "analyze" && options.stepKey !== "test" && options.stepKey !== "build") {
    throw new RangeError("job stepKey must be fetch, analyze, test, or build");
  }
  const expectedStep = profile.stepKey;
  if (options.stepKey !== expectedStep && !(options.profile === "buildTest" && options.stepKey === "build")) {
    throw new RangeError(`${options.profile} must use stepKey ${expectedStep}`);
  }
  const image = assertImageReference(options.image);
  const run: RunIdentity = options;
  const namespace = namespaceName(options.runShortId);
  const name = resourceName(options.runShortId, options.attempt, options.stepKey as ResourceStepKey);
  const workspaceMount: Volume[] = [
    {
      name: "workspace",
      persistentVolumeClaim: { claimName: WORKSPACE_CLAIM_NAME },
    },
    { name: "tmp", emptyDir: { sizeLimit: profile.ephemeralStorageLimit } },
  ];

  if (options.profile === "analysisTools") {
    workspaceMount[0] = {
      name: "workspace",
      persistentVolumeClaim: { claimName: WORKSPACE_CLAIM_NAME, readOnly: true },
    };
    workspaceMount.push({
      name: "analysis-output",
      emptyDir: { sizeLimit: "1Gi" },
    });
  }

  if (options.sourceCredentialSecretName !== undefined) {
    if (options.profile !== "sourceFetch") {
      throw new RangeError("source credentials are only allowed on source-fetch jobs");
    }
    const secretName = assertSafeSlug(options.sourceCredentialSecretName, "sourceCredentialSecretName", 63);
    workspaceMount.push({
      name: "source-token",
      secret: { secretName, optional: false },
    });
  }

  const mounts = workspaceMount.map((volume) => {
    if (volume.name === "workspace") {
      return {
        name: volume.name,
        mountPath: "/work",
        ...(profile.workspaceReadOnly ? { readOnly: true } : {}),
      };
    }
    if (volume.name === "analysis-output") {
      return { name: volume.name, mountPath: "/work/analysis-output" };
    }
    if (volume.name === "source-token") {
      return { name: volume.name, mountPath: "/var/run/platform/source", readOnly: true };
    }
    return { name: volume.name, mountPath: "/tmp" };
  });

  const container: Container = {
    name: profile.containerName,
    image,
    imagePullPolicy: "IfNotPresent",
    command: profile.command,
    ...(options.environment === undefined ? {} : { env: options.environment }),
    resources: RESOURCES[options.profile],
    securityContext: RESTRICTED_CONTAINER_SECURITY_CONTEXT,
    volumeMounts: mounts,
  };

  const template: PodTemplateSpec = {
    metadata: {
      labels: labelsForResource(options, options.profile === "sourceFetch" ? "source-fetch" : options.profile === "analysisTools" ? "analysis-tools" : "build-test"),
    },
    spec: {
      serviceAccountName: DEFAULT_SERVICE_ACCOUNT_NAME,
      automountServiceAccountToken: false,
      restartPolicy: "Never",
      securityContext: RESTRICTED_POD_SECURITY_CONTEXT,
      containers: [container],
      volumes: workspaceMount,
    },
  };

  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: { name, namespace, labels: labelsForResource(options, "job") },
    spec: { ...JOB_LIFECYCLE, template },
  };
}

export interface PreviewOptions extends RunIdentity {
  readonly image: string;
  readonly containerPort: number;
  readonly healthPath: string;
}

function previewLabels(run: RunIdentity): Labels {
  return labelsForResource({ ...run, stepKey: "preview" }, "preview");
}

function previewTemplate(options: PreviewOptions): PodTemplateSpec {
  const labels = previewLabels(options);
  const container: Container = {
    name: "preview",
    image: assertImageReference(options.image),
    imagePullPolicy: "IfNotPresent",
    ports: [{ name: "http", containerPort: assertContainerPort(options.containerPort), protocol: "TCP" }],
    resources: RESOURCES.preview,
    securityContext: RESTRICTED_CONTAINER_SECURITY_CONTEXT,
    volumeMounts: [{ name: "tmp", mountPath: "/tmp" }],
    readinessProbe: {
      tcpSocket: { port: "http" },
      initialDelaySeconds: 2,
      periodSeconds: 5,
      timeoutSeconds: 2,
      failureThreshold: 6,
    },
  };
  return {
    metadata: { labels },
    spec: {
      serviceAccountName: DEFAULT_SERVICE_ACCOUNT_NAME,
      automountServiceAccountToken: false,
      restartPolicy: "Always",
      securityContext: RESTRICTED_POD_SECURITY_CONTEXT,
      containers: [container],
      volumes: [{ name: "tmp", emptyDir: { sizeLimit: "512Mi" } }],
    },
  };
}

export function buildPreviewDeployment(options: PreviewOptions): DeploymentObject {
  const namespace = namespaceName(options.runShortId);
  const name = resourceName(options.runShortId, options.attempt, "preview");
  const labels = previewLabels(options);
  return {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name, namespace, labels },
    spec: {
      replicas: 1,
      revisionHistoryLimit: 0,
      progressDeadlineSeconds: 60,
      selector: { matchLabels: labels },
      template: previewTemplate(options),
    },
  };
}

export function buildPreviewService(options: RunIdentity): ServiceObject {
  const namespace = namespaceName(options.runShortId);
  const name = resourceName(options.runShortId, options.attempt, "preview");
  const labels = previewLabels(options);
  return {
    apiVersion: "v1",
    kind: "Service",
    metadata: { name, namespace, labels },
    spec: {
      type: "ClusterIP",
      selector: labels,
      ports: [{ name: "http", port: 80, targetPort: "http", protocol: "TCP" }],
    },
  };
}

export interface PreviewIngressOptions extends RunIdentity {
  readonly baseUrl: string;
  readonly expiresAt: Date | string;
  readonly tlsSecretName?: string;
}

export function buildPreviewIngress(options: PreviewIngressOptions): IngressObject {
  const namespace = namespaceName(options.runShortId);
  const name = resourceName(options.runShortId, options.attempt, "preview");
  const address = ingressHost(options.baseUrl, namespace);
  const parsedBaseUrl = new URL(options.baseUrl);
  if (parsedBaseUrl.protocol === "https:" && !options.tlsSecretName) {
    throw new RangeError("HTTPS preview ingress requires tlsSecretName");
  }
  const serviceName = name;
  const path: IngressPath = {
    path: "/",
    pathType: "Prefix",
    backend: { service: { name: serviceName, port: { name: "http" } } },
  };
  const labels = previewLabels(options);
  const annotations: Annotations = {
    [K8S_ANNOTATIONS.expiresAt]: expirationIso(options.expiresAt),
  };
  return {
    apiVersion: "networking.k8s.io/v1",
    kind: "Ingress",
    metadata: { name, namespace, labels, annotations },
    spec: {
      ingressClassName: "traefik",
      rules: [{ host: address.host, http: { paths: [path] } }],
      ...(parsedBaseUrl.protocol === "https:" && options.tlsSecretName !== undefined ? { tls: [{ hosts: [address.host], secretName: options.tlsSecretName }] } : {}),
    },
  };
}

export type RunResource =
  | NamespaceObject
  | ServiceAccountObject
  | ResourceQuotaObject
  | LimitRangeObject
  | PersistentVolumeClaimObject
  | JobObject
  | DeploymentObject
  | ServiceObject
  | IngressObject;

export interface RunResourcePlanOptions {
  readonly run: RunIdentity;
  readonly storageClassName?: string;
  readonly preview?: PreviewOptions;
  readonly previewIngress?: PreviewIngressOptions;
}

function assertSameRunIdentity(
  expected: RunIdentity,
  actual: RunIdentity,
  field: string,
): void {
  if (
    expected.runId !== actual.runId ||
    expected.runShortId !== actual.runShortId ||
    expected.attempt !== actual.attempt
  ) {
    throw new RangeError(`${field} must belong to the same run identity`);
  }
}

export function buildRunResourcePlan(options: RunResourcePlanOptions): readonly RunResource[] {
  if (options.previewIngress !== undefined && options.preview === undefined) {
    throw new RangeError("previewIngress requires preview options");
  }
  if (options.preview !== undefined) {
    assertSameRunIdentity(options.run, options.preview, "preview");
  }
  if (options.previewIngress !== undefined) {
    assertSameRunIdentity(options.run, options.previewIngress, "previewIngress");
  }
  const resources: RunResource[] = [
    buildNamespace(options.run),
    buildDefaultServiceAccount(options.run),
    buildResourceQuota(options.run),
    buildLimitRange(options.run),
    buildWorkspaceClaim(options.run, options.storageClassName),
  ];
  if (options.preview !== undefined) {
    resources.push(
      buildPreviewDeployment(options.preview),
      buildPreviewService(options.preview),
    );
    if (options.previewIngress !== undefined) {
      resources.push(buildPreviewIngress(options.previewIngress));
    }
  }
  return resources;
}

export function resourceNamespace(resource: KubernetesObject): string | undefined {
  return resource.metadata.namespace;
}
