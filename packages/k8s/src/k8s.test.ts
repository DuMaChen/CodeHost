import { describe, expect, it } from "vitest";
import {
  buildDefaultServiceAccount,
  buildJob,
  buildLimitRange,
  buildNamespace,
  buildPreviewDeployment,
  buildPreviewIngress,
  buildPreviewService,
  buildResourceQuota,
  buildRunResourcePlan,
  buildWorkerClusterRole,
  buildWorkerClusterRoleBinding,
  buildWorkspaceClaim,
  immutableImageReference,
  namespaceName,
  reconcileResource,
  reconcileResources,
  resourceName,
  ResourceOwnershipConflictError,
  type KubernetesResourceClient,
  type ManagedKubernetesObject,
} from "./index.js";

const IMAGE = immutableImageReference(
  "ai-registry:5000",
  "preview/course-run",
  "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
);
const RUN = { runId: "run-1234567890abcdef", runShortId: "1234567890abcdef", attempt: 1 } as const;

describe("controlled Kubernetes builders", () => {
  it("uses deterministic names and restricted namespace labels", () => {
    expect(namespaceName(RUN.runShortId)).toBe("pr-run-1234567890abcdef");
    expect(resourceName(RUN.runShortId, 1, "preview")).toBe("run-1234567890abcdef-a1-preview");

    const namespace = buildNamespace(RUN);
    expect(namespace.metadata.name).toBe("pr-run-1234567890abcdef");
    expect(namespace.metadata.labels).toMatchObject({
      "platform.io/managed": "true",
      "platform.io/run-id": RUN.runId,
      "pod-security.kubernetes.io/enforce": "restricted",
      "pod-security.kubernetes.io/audit": "restricted",
      "pod-security.kubernetes.io/warn": "restricted",
    });
  });

  it("hard-codes the per-run quota, defaults, workspace and tokenless account", () => {
    const quota = buildResourceQuota(RUN);
    expect(quota.spec.hard).toMatchObject({
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
    });
    expect(buildLimitRange(RUN).spec.limits[0]).toEqual({
      type: "Container",
      defaultRequest: { cpu: "100m", memory: "128Mi", "ephemeral-storage": "128Mi" },
      default: { cpu: "1", memory: "1Gi", "ephemeral-storage": "1Gi" },
    });
    expect(buildDefaultServiceAccount(RUN).automountServiceAccountToken).toBe(false);
    expect(buildWorkspaceClaim(RUN).spec).toMatchObject({
      accessModes: ["ReadWriteOnce"],
      volumeMode: "Filesystem",
      storageClassName: "local-path",
      resources: { requests: { storage: "4Gi" } },
    });
    expect(buildWorkspaceClaim(RUN, "platform-local-path").spec.storageClassName).toBe("platform-local-path");
  });

  it("creates fixed-profile jobs with explicit bounded resources and no host access", () => {
    const job = buildJob({ ...RUN, stepKey: "analyze", profile: "analysisTools", image: IMAGE });
    expect(job.metadata.name).toBe("run-1234567890abcdef-a1-analyze");
    expect(job.spec).toMatchObject({
      completions: 1,
      parallelism: 1,
      backoffLimit: 0,
      activeDeadlineSeconds: 900,
      ttlSecondsAfterFinished: 604800,
    });
    const pod = job.spec.template.spec;
    expect(pod.automountServiceAccountToken).toBe(false);
    expect(pod.securityContext).toEqual({
      runAsNonRoot: true,
      runAsUser: 1000,
      runAsGroup: 1000,
      fsGroup: 1000,
      seccompProfile: { type: "RuntimeDefault" },
    });
    expect(pod.containers[0].securityContext).toEqual({
      runAsNonRoot: true,
      runAsUser: 1000,
      runAsGroup: 1000,
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      capabilities: { drop: ["ALL"] },
    });
    expect(pod.containers[0].resources.limits["ephemeral-storage"]).toBe("1Gi");
    expect(pod.containers[0].command).toEqual(["/platform/run", "analyze"]);
    expect(pod.volumes.find((volume) => volume.name === "workspace")?.persistentVolumeClaim).toEqual({
      claimName: "workspace",
      readOnly: true,
    });
    expect(JSON.stringify(job)).not.toMatch(/hostPath|privileged|hostNetwork|hostPID|hostIPC|docker\.sock/);
  });

  it("keeps source credentials scoped to a read-only Source Fetch mount", () => {
    const job = buildJob({
      ...RUN,
      stepKey: "fetch",
      profile: "sourceFetch",
      image: IMAGE,
      sourceCredentialSecretName: "source-token",
    });
    expect(job.spec.template.spec.containers[0].command).toEqual(["/platform/run", "fetch"]);
    expect(job.spec.template.spec.containers[0].volumeMounts).toContainEqual({
      name: "source-token",
      mountPath: "/var/run/platform/source",
      readOnly: true,
    });
    expect(() => buildJob({ ...RUN, stepKey: "analyze", profile: "analysisTools", image: IMAGE, sourceCredentialSecretName: "source-token" })).toThrow(/source-fetch/);
  });

  it("uses the project Build/Test resource envelope", () => {
    const job = buildJob({ ...RUN, stepKey: "test", profile: "buildTest", image: IMAGE });
    expect(job.spec.template.spec.containers[0].resources).toEqual({
      requests: { cpu: "1", memory: "1Gi", "ephemeral-storage": "1Gi" },
      limits: { cpu: "2", memory: "4Gi", "ephemeral-storage": "4Gi" },
    });
  });

  it("exposes only the trusted Worker's minimal RBAC surface", () => {
    const role = buildWorkerClusterRole();
    const binding = buildWorkerClusterRoleBinding();
    const permissions = role.rules.flatMap((rule) => rule.resources.map((resource) => `${rule.apiGroups[0]}:${resource}`));
    const secretRule = role.rules.find((rule) => rule.resources.includes("secrets"));
    expect(permissions).toContain(":namespaces");
    expect(permissions).toContain("batch:jobs");
    expect(permissions).toContain(":pods/log");
    expect(permissions).not.toContain(":pods/exec");
    expect(permissions).not.toContain(":serviceaccounts");
    expect(secretRule?.verbs).toEqual(["create", "delete"]);
    expect(role.rules.flatMap((rule) => rule.resources)).not.toEqual(expect.arrayContaining(["nodes", "crds", "clusterroles", "clusterrolebindings"]));
    expect(binding.subjects[0]).toEqual({ kind: "ServiceAccount", name: "platform-worker", namespace: "platform-system" });
    expect(binding.roleRef).toEqual({ apiGroup: "rbac.authorization.k8s.io", kind: "ClusterRole", name: "platform-worker" });
  });

  it("creates a restricted preview and a Traefik ingress with an expiry", () => {
    const preview = {
      ...RUN,
      image: IMAGE,
      containerPort: 8000,
      healthPath: "/health",
    } as const;
    const deployment = buildPreviewDeployment(preview);
    const service = buildPreviewService(preview);
    const ingress = buildPreviewIngress({
      ...RUN,
      baseUrl: "https://preview.example.test",
      expiresAt: "2030-01-01T00:00:00.000Z",
      tlsSecretName: "preview-tls",
    });

    expect(deployment.spec.replicas).toBe(1);
    expect(deployment.spec.revisionHistoryLimit).toBe(0);
    expect(deployment.spec.progressDeadlineSeconds).toBe(60);
    expect(service.spec).toEqual({
      type: "ClusterIP",
      selector: deployment.spec.selector.matchLabels,
      ports: [{ name: "http", port: 80, targetPort: "http", protocol: "TCP" }],
    });
    expect(ingress.spec.ingressClassName).toBe("traefik");
    expect(ingress.spec.rules[0].host).toBe("pr-run-1234567890abcdef.preview.example.test");
    expect(ingress.metadata.annotations?.["platform.io/expires-at"]).toBe("2030-01-01T00:00:00.000Z");
    expect(ingress.spec.tls).toEqual([{ hosts: ["pr-run-1234567890abcdef.preview.example.test"], secretName: "preview-tls" }]);
    expect(deployment.spec.template.spec.containers[0].readinessProbe?.tcpSocket?.port).toBe("http");
  });

  it("keeps local k3d registry addresses cluster-reachable and rejects localhost", () => {
    expect(immutableImageReference("ai-registry:5000", "course/run", "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")).toContain("ai-registry:5000");
    expect(immutableImageReference("registry.example.test:30500", "course/run", "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")).toContain("30500");
    expect(() => immutableImageReference("localhost:5111", "course/run", "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")).toThrow(/localhost/);
    expect(() => buildPreviewIngress({ ...RUN, baseUrl: "http://localhost:8080", expiresAt: new Date() })).toThrow(/localhost/);
  });

  it("returns an ordered run plan and rejects an ingress without a preview", () => {
    const plan = buildRunResourcePlan({
      run: RUN,
      preview: { ...RUN, image: IMAGE, containerPort: 8000, healthPath: "/health" },
      previewIngress: { ...RUN, baseUrl: "https://preview.example.test", expiresAt: new Date("2030-01-01"), tlsSecretName: "preview-tls" },
    });
    expect(plan.map((resource) => resource.kind)).toEqual([
      "Namespace",
      "ServiceAccount",
      "ResourceQuota",
      "LimitRange",
      "PersistentVolumeClaim",
      "Deployment",
      "Service",
      "Ingress",
    ]);
    expect(() => buildRunResourcePlan({ run: RUN, previewIngress: { ...RUN, baseUrl: "https://preview.example.test", expiresAt: new Date() } })).toThrow(/preview options/);
    expect(() => buildRunResourcePlan({
      run: RUN,
      preview: { ...RUN, image: IMAGE, containerPort: 8000, healthPath: "/health" },
      previewIngress: { ...RUN, runShortId: "other-run", baseUrl: "https://preview.example.test", expiresAt: new Date() },
    })).toThrow(/same run identity/);
  });
});

describe("idempotent ownership reconciliation", () => {
  function fakeClient(existing: ManagedKubernetesObject | null): KubernetesResourceClient & { calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      async get() {
        calls.push("get");
        return existing;
      },
      async create(resource) {
        calls.push(`create:${resource.kind}`);
        return resource;
      },
      async update(resource) {
        calls.push(`update:${resource.kind}`);
        return resource;
      },
    };
  }

  it("does not create an already-owned identical object", async () => {
    const desired = buildResourceQuota(RUN);
    const client = fakeClient(desired);
    const result = await reconcileResource(client, desired);
    expect(result.action).toBe("unchanged");
    expect(client.calls).toEqual(["get"]);
  });

  it("reconciles the complete ordered plan, including the namespace", async () => {
    const plan = buildRunResourcePlan({ run: RUN });
    const client = fakeClient(null);
    const results = await reconcileResources(client, plan);
    expect(results.every((result) => result.action === "created")).toBe(true);
    expect(client.calls.filter((call) => call.startsWith("create:")).length).toBe(plan.length);
  });

  it("updates drift only after ownership labels match", async () => {
    const desired = buildResourceQuota(RUN);
    const existing = { ...desired, spec: { hard: { ...desired.spec.hard, "count/pods": "7" } }, metadata: { ...desired.metadata, resourceVersion: "9" } };
    const client = fakeClient(existing);
    const result = await reconcileResource(client, desired);
    expect(result.action).toBe("updated");
    expect(client.calls).toEqual(["get", "update:ResourceQuota"]);
  });

  it("adopts an owned Job without attempting an immutable spec update", async () => {
    const desired = buildJob({ ...RUN, stepKey: "test", profile: "buildTest", image: IMAGE });
    const existing = {
      ...desired,
      metadata: { ...desired.metadata, uid: "job-uid", resourceVersion: "9" },
      spec: { ...desired.spec, template: { ...desired.spec.template, metadata: { ...desired.spec.template.metadata, labels: { ...desired.spec.template.metadata.labels, "controller-generated": "true" } } } },
    };
    const client = fakeClient(existing);
    const result = await reconcileResource(client, desired);
    expect(result.action).toBe("unchanged");
    expect(client.calls).toEqual(["get"]);
  });

  it("adopts an owned workspace PVC without attempting an immutable spec update", async () => {
    const desired = buildWorkspaceClaim(RUN, "platform-run-local-path");
    const existing = {
      ...desired,
      metadata: { ...desired.metadata, uid: "pvc-uid", resourceVersion: "9" },
      spec: { ...desired.spec, volumeName: "local-path-pv" },
    };
    const client = fakeClient(existing);
    const result = await reconcileResource(client, desired);
    expect(result.action).toBe("unchanged");
    expect(client.calls).toEqual(["get"]);
  });

  it("fails closed when a same-name object belongs to another run", async () => {
    const desired = buildResourceQuota(RUN);
    const existing = { ...desired, metadata: { ...desired.metadata, labels: { ...desired.metadata.labels, "platform.io/run-id": "other-run" } } };
    await expect(reconcileResource(fakeClient(existing), desired)).rejects.toBeInstanceOf(ResourceOwnershipConflictError);
  });
});
