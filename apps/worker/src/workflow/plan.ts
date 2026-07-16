import {
  WORKFLOW_STEPS,
  type StepKey,
  type StepRecord,
} from './types.js';

export type StepAction =
  | { readonly action: 'run'; readonly stepKey: StepKey }
  | {
      readonly action: 'skip';
      readonly stepKey: StepKey;
      readonly reason: 'SKIPPED_UPSTREAM';
    };

const APPLICATION_GATE_SKIP: Readonly<
  Partial<Record<StepKey, readonly StepKey[]>>
> = {
  detect: ['fetch', 'analyze', 'test', 'build', 'preview', 'health'],
  test: ['build', 'preview', 'health'],
  build: ['preview', 'health'],
  preview: ['health'],
};

const ASSEMBLE_STEP_INDEX = WORKFLOW_STEPS.indexOf('assemble-review-input');

function hasFailure(
  records: readonly StepRecord[],
  stepKey: StepKey,
  failureKind?: StepRecord['failureKind'],
): boolean {
  return records.some(
    (record) =>
      record.stepKey === stepKey &&
      record.status === 'FAILED' &&
      (failureKind === undefined || record.failureKind === failureKind),
  );
}

function hasHardFailureBeforeAssemble(records: readonly StepRecord[]): boolean {
  return records.some(
    (record) =>
      (record.status === 'INCOMPLETE' ||
        (record.status === 'FAILED' && record.failureKind !== 'application')) &&
      WORKFLOW_STEPS.indexOf(record.stepKey) < ASSEMBLE_STEP_INDEX,
  );
}

function shouldSkip(
  stepKey: StepKey,
  records: readonly StepRecord[],
): boolean {
  const gateFailure = Object.entries(APPLICATION_GATE_SKIP).some(
    ([failedStep, skippedSteps]) =>
      hasFailure(records, failedStep as StepKey, 'application') &&
      skippedSteps?.includes(stepKey),
  );

  if (gateFailure) {
    return true;
  }

  if (
    stepKey !== 'assemble-review-input' &&
    stepKey !== 'agent-review' &&
    stepKey !== 'report' &&
    stepKey !== 'cleanup' &&
    hasHardFailureBeforeAssemble(records)
  ) {
    return true;
  }

  return stepKey === 'agent-review' && hasFailure(
    records,
    'assemble-review-input',
  );
}

export function nextStepAction(
  records: readonly StepRecord[],
): StepAction | undefined {
  const cleanup = records.find((record) => record.stepKey === 'cleanup');
  if (cleanup?.status === 'FAILED' || cleanup?.status === 'INCOMPLETE') {
    return { action: 'run', stepKey: 'cleanup' };
  }

  for (const stepKey of WORKFLOW_STEPS) {
    const record = records.find((candidate) => candidate.stepKey === stepKey);
    const cleanupRetryable =
      stepKey === 'cleanup' &&
      (record?.status === 'FAILED' || record?.status === 'INCOMPLETE');
    if (
      !cleanupRetryable && (
        record?.status === 'PASSED' ||
        record?.status === 'FAILED' ||
        record?.status === 'SKIPPED' ||
        record?.status === 'INCOMPLETE' ||
        record?.status === 'CANCELLED'
      )
    ) {
      continue;
    }

    if (shouldSkip(stepKey, records)) {
      return { action: 'skip', reason: 'SKIPPED_UPSTREAM', stepKey };
    }

    return { action: 'run', stepKey };
  }

  return undefined;
}
