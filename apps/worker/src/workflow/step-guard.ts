import type {
  FailureKind,
  StepExecutionResult,
  StepKey,
  StepRecord,
  StepStatus,
  TerminalStepStatus,
} from './types.js';

export interface StepGuardKey {
  readonly runId: string;
  readonly attempt: number;
  readonly stepKey: StepKey;
}

export type StepGuardResult =
  | { readonly outcome: 'executed'; readonly result: StepExecutionResult }
  | {
      readonly outcome: 'already-terminal';
      readonly status: TerminalStepStatus;
    }
  | { readonly outcome: 'busy' };

export interface StepGuard {
  /**
   * Acquire run_id + attempt + step_key exclusively, check run_steps, and
   * persist the returned terminal result atomically in the DB implementation.
   * A thrown error releases the lease without making a terminal step result,
   * allowing pg-boss delivery retry to recover from infrastructure failure.
   */
  runOnce(
    key: StepGuardKey,
    operation: () => Promise<StepExecutionResult>,
  ): Promise<StepGuardResult>;

  markSkipped(key: StepGuardKey, reason: string): Promise<void>;
  list(runId: string, attempt: number): Promise<readonly StepRecord[]>;
}

export class StepAlreadyRunningError extends Error {
  constructor(readonly key: StepGuardKey) {
    super(
      `workflow step is already running: ${key.runId}/${key.attempt}/${key.stepKey}`,
    );
    this.name = 'StepAlreadyRunningError';
  }
}

interface MutableStepRecord {
  stepKey: StepKey;
  status: StepRecord['status'];
  failureKind?: FailureKind;
  errorCode?: string;
  reason?: string;
}

function mapResult(
  stepKey: StepKey,
  result: StepExecutionResult,
): MutableStepRecord {
  return result.status === 'PASSED'
    ? { stepKey, status: 'PASSED' }
    : {
        stepKey,
        status: result.status,
        failureKind: result.failureKind,
        errorCode: result.errorCode,
      };
}

export function isTerminalStepForRetry(stepKey: StepKey, status: StepStatus): boolean {
  if (stepKey === 'cleanup' && (status === 'FAILED' || status === 'INCOMPLETE')) {
    return false;
  }
  return (
    status === 'PASSED' ||
    status === 'FAILED' ||
    status === 'SKIPPED' ||
    status === 'INCOMPLETE' ||
    status === 'CANCELLED'
  );
}

/** Process-local implementation for the boot skeleton and unit tests only. */
export class InMemoryStepGuard implements StepGuard {
  private readonly records = new Map<string, MutableStepRecord>();

  async runOnce(
    key: StepGuardKey,
    operation: () => Promise<StepExecutionResult>,
  ): Promise<StepGuardResult> {
    const recordKey = this.key(key);
    const existing = this.records.get(recordKey);
    if (existing !== undefined && isTerminalStepForRetry(key.stepKey, existing.status)) {
      return { outcome: 'already-terminal', status: existing.status as TerminalStepStatus };
    }

    if (existing?.status === 'RUNNING') {
      return { outcome: 'busy' };
    }

    this.records.set(recordKey, { stepKey: key.stepKey, status: 'RUNNING' });
    try {
      const result = await operation();
      this.records.set(recordKey, mapResult(key.stepKey, result));
      return { outcome: 'executed', result };
    } catch (error) {
      this.records.delete(recordKey);
      throw error;
    }
  }

  async markSkipped(key: StepGuardKey, reason: string): Promise<void> {
    const recordKey = this.key(key);
    const existing = this.records.get(recordKey);
    if (existing !== undefined && isTerminalStepForRetry(key.stepKey, existing.status)) {
      return;
    }
    if (existing?.status === 'RUNNING') {
      throw new StepAlreadyRunningError(key);
    }
    this.records.set(recordKey, {
      stepKey: key.stepKey,
      status: 'SKIPPED',
      reason,
    });
  }

  async list(runId: string, attempt: number): Promise<readonly StepRecord[]> {
    const prefix = `${runId}:${attempt}:`;
    return [...this.records.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, record]) => ({ ...record }));
  }

  private key(key: StepGuardKey): string {
    return `${key.runId}:${key.attempt}:${key.stepKey}`;
  }
}
