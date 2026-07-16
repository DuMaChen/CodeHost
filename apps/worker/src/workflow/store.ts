import type {
  CleanupStatus,
  RunSnapshot,
  RunStatus,
} from './types.js';

export interface GiteaSyncInput {
  readonly runId: string;
  readonly attempt: number;
  readonly headSha: string;
  readonly repositoryFullName: string;
  readonly pullRequestNumber: number;
  readonly artifactType: 'status' | 'comment';
  readonly context: string;
  readonly desiredHash: string;
  readonly desiredState: string;
  readonly desiredDescription: string;
  readonly desiredTargetUrl?: string;
  readonly desiredBody: string;
}

export interface WorkflowStore {
  /**
   * The production implementation belongs in @platform/db. It must perform
   * status transitions atomically and reject stale attempt/head SHA updates.
   */
  getRun(runId: string): Promise<RunSnapshot | null>;
  transitionRun(input: {
    readonly runId: string;
    readonly attempt: number;
    readonly headSha: string;
    readonly to: RunStatus;
    readonly reason?: string;
  }): Promise<void>;
  setCleanupStatus(input: {
    readonly runId: string;
    readonly attempt: number;
    readonly headSha: string;
    readonly status: CleanupStatus;
    readonly errorCode?: string;
  }): Promise<void>;
  saveReport?(input: {
    readonly runId: string;
    readonly attempt: number;
    readonly headSha: string;
    readonly provider: string;
    readonly model: string;
    readonly inputHash: string;
    readonly verdict: 'PASSED' | 'INCOMPLETE';
    readonly summary: string;
    readonly reportJson: Record<string, unknown>;
    readonly expiresAt?: Date;
  }): Promise<void>;
  setPreview?(input: {
    readonly runId: string;
    readonly attempt: number;
    readonly headSha: string;
    readonly previewHost: string;
    readonly expiresAt: Date;
  }): Promise<void>;
  setExecutionPlan?(input: {
    readonly runId: string;
    readonly attempt: number;
    readonly headSha: string;
    readonly plan: Record<string, unknown>;
  }): Promise<void>;
  recordKubernetesResource?(input: {
    readonly runId: string;
    readonly attempt: number;
    readonly stepKey: string;
    readonly namespace: string;
    readonly kind: string;
    readonly name: string;
    readonly uid?: string | undefined;
    readonly phase: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'DELETING' | 'DELETED' | 'UNKNOWN';
  }): Promise<void>;
  markKubernetesResourceDeleted?(input: {
    readonly runId: string;
    readonly attempt: number;
    readonly stepKey: string;
    readonly kind: string;
    readonly name: string;
    readonly uid: string;
  }): Promise<void>;
  enqueueGiteaSync?(input: GiteaSyncInput): Promise<void>;
  saveStepLog?(input: {
    readonly runId: string;
    readonly attempt: number;
    readonly headSha: string;
    readonly stepKey: string;
    readonly logPath: string;
    readonly expiresAt: Date;
  }): Promise<void>;
}

export class WorkflowStoreNotConfiguredError extends Error {
  constructor() {
    super(
      'workflow store is not configured; connect the @platform/db adapter before consuming workflow jobs',
    );
    this.name = 'WorkflowStoreNotConfiguredError';
  }
}

/** Explicit failure boundary until the database target supplies its adapter. */
export class UnconfiguredWorkflowStore implements WorkflowStore {
  getRun(): Promise<RunSnapshot | null> {
    return Promise.reject(new WorkflowStoreNotConfiguredError());
  }

  transitionRun(): Promise<void> {
    return Promise.reject(new WorkflowStoreNotConfiguredError());
  }

  setCleanupStatus(): Promise<void> {
    return Promise.reject(new WorkflowStoreNotConfiguredError());
  }
}
