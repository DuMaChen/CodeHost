import { K8S_LABELS } from "./constants.js";
import type { KubernetesObject, Labels, ManagedKubernetesObject } from "./types.js";

export interface KubernetesResourceClient {
  get(input: {
    readonly apiVersion: string;
    readonly kind: string;
    readonly namespace?: string;
    readonly name: string;
  }): Promise<ManagedKubernetesObject | null | undefined>;
  create(resource: ManagedKubernetesObject): Promise<ManagedKubernetesObject>;
  update(resource: ManagedKubernetesObject): Promise<ManagedKubernetesObject>;
}

export type ReconcileAction = "created" | "updated" | "unchanged";

export interface ReconcileResult {
  readonly action: ReconcileAction;
  readonly desired: ManagedKubernetesObject;
  readonly resource: ManagedKubernetesObject;
}

export class ResourceOwnershipConflictError extends Error {
  readonly kind: string;
  readonly resourceName: string;
  readonly namespace: string | undefined;

  constructor(resource: KubernetesObject, message: string) {
    super(message);
    this.name = "ResourceOwnershipConflictError";
    this.kind = resource.kind;
    this.resourceName = resource.metadata.name;
    this.namespace = resource.metadata.namespace;
  }
}

export async function reconcileResource(
  client: KubernetesResourceClient,
  desired: ManagedKubernetesObject,
): Promise<ReconcileResult> {
  const lookup: {
    readonly apiVersion: string;
    readonly kind: string;
    readonly name: string;
    readonly namespace?: string;
  } = {
    apiVersion: desired.apiVersion,
    kind: desired.kind,
    name: desired.metadata.name,
    ...(desired.metadata.namespace !== undefined ? { namespace: desired.metadata.namespace } : {}),
  };
  const existing = await client.get(lookup);
  if (existing === null || existing === undefined) {
    const created = await client.create(desired);
    return { action: "created", desired, resource: created };
  }

  assertSameIdentity(desired, existing);
  // Job specs are effectively immutable after creation and Kubernetes adds
  // controller-owned selector fields. Adopt an owned Job and observe its
  // status instead of attempting an update that the API will reject.
  if (desired.kind === "Job" || desired.kind === "PersistentVolumeClaim") {
    return { action: "unchanged", desired, resource: existing };
  }
  if (sameSpecAndManagedMetadata(desired, existing)) {
    return { action: "unchanged", desired, resource: existing };
  }

  const update = withResourceVersion(desired, existing.metadata.resourceVersion);
  const updated = await client.update(update);
  return { action: "updated", desired, resource: updated };
}

export async function reconcileResources(
  client: KubernetesResourceClient,
  desired: readonly ManagedKubernetesObject[],
): Promise<readonly ReconcileResult[]> {
  const results: ReconcileResult[] = [];
  for (const resource of desired) {
    results.push(await reconcileResource(client, resource));
  }
  return results;
}

export function assertSameIdentity(
  desired: KubernetesObject,
  existing: KubernetesObject,
): void {
  if (desired.apiVersion !== existing.apiVersion || desired.kind !== existing.kind) {
    throw new ResourceOwnershipConflictError(
      desired,
      `resource identity mismatch for ${desired.kind}/${desired.metadata.name}`,
    );
  }
  if (
    desired.metadata.name !== existing.metadata.name ||
    desired.metadata.namespace !== existing.metadata.namespace
  ) {
    throw new ResourceOwnershipConflictError(
      desired,
      `resource metadata identity mismatch for ${desired.kind}/${desired.metadata.name}`,
    );
  }
  const desiredLabels = desired.metadata.labels ?? {};
  const existingLabels = existing.metadata.labels ?? {};
  const requiredLabels: string[] = [K8S_LABELS.managed, K8S_LABELS.runId];
  if (desired.kind !== "Namespace") requiredLabels.push(K8S_LABELS.resource, K8S_LABELS.attempt);
  if (desiredLabels[K8S_LABELS.stepKey] !== undefined) {
    requiredLabels.push(K8S_LABELS.stepKey);
  }
  const mismatch = requiredLabels.find(
    (label) => desiredLabels[label] === undefined || existingLabels[label] !== desiredLabels[label],
  );
  if (mismatch !== undefined) {
    throw new ResourceOwnershipConflictError(
      desired,
      `resource ${desired.kind}/${desired.metadata.name} is not owned by this run (${mismatch} mismatch)`,
    );
  }
}

function withResourceVersion(
  desired: ManagedKubernetesObject,
  resourceVersion: string | undefined,
): ManagedKubernetesObject {
  if (resourceVersion === undefined) return desired;
  return {
    ...desired,
    metadata: { ...desired.metadata, resourceVersion },
  } as ManagedKubernetesObject;
}

function sameSpecAndManagedMetadata(
  desired: ManagedKubernetesObject,
  existing: ManagedKubernetesObject,
): boolean {
  return stableJson(stripServerFields(desired)) === stableJson(stripServerFields(existing));
}

function stripServerFields(resource: ManagedKubernetesObject): unknown {
  const metadata = { ...resource.metadata } as Record<string, unknown>;
  delete metadata.uid;
  delete metadata.resourceVersion;
  delete metadata.creationTimestamp;
  delete metadata.deletionTimestamp;
  delete metadata.generation;
  delete metadata.managedFields;
  const result = { ...resource, metadata } as Record<string, unknown>;
  delete result.status;
  return result;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  return Object.keys(record)
    .sort()
    .reduce<Record<string, unknown>>((sorted, key) => {
      sorted[key] = sortKeys(record[key]);
      return sorted;
    }, {});
}

export function ownershipLabels(resource: KubernetesObject): Labels {
  return resource.metadata.labels ?? {};
}
