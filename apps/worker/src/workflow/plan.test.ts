import { describe, expect, it } from 'vitest';
import { nextStepAction } from './plan.js';

describe('workflow step plan', () => {
  it('starts with detect and keeps the review path after application failure', () => {
    expect(nextStepAction([])).toEqual({ action: 'run', stepKey: 'detect' });
    expect(
      nextStepAction([
        { stepKey: 'detect', status: 'PASSED' },
        { stepKey: 'fetch', status: 'PASSED' },
        { stepKey: 'analyze', status: 'PASSED' },
        { stepKey: 'test', status: 'FAILED', failureKind: 'application', errorCode: 'TEST_FAILED' },
      ]),
    ).toEqual({ action: 'skip', stepKey: 'build', reason: 'SKIPPED_UPSTREAM' });
  });

  it('skips execution gates after infrastructure failure but still assembles review evidence', () => {
    const records = [
      { stepKey: 'detect' as const, status: 'PASSED' as const },
      { stepKey: 'fetch' as const, status: 'PASSED' as const },
      { stepKey: 'analyze' as const, status: 'INCOMPLETE' as const, failureKind: 'infrastructure' as const },
    ];
    expect(nextStepAction(records)).toEqual({ action: 'skip', stepKey: 'test', reason: 'SKIPPED_UPSTREAM' });
    expect(nextStepAction([...records, { stepKey: 'test', status: 'SKIPPED' }])).toEqual({ action: 'skip', stepKey: 'build', reason: 'SKIPPED_UPSTREAM' });
    expect(
      nextStepAction([
        ...records,
        { stepKey: 'test', status: 'SKIPPED' },
        { stepKey: 'build', status: 'SKIPPED' },
        { stepKey: 'preview', status: 'SKIPPED' },
        { stepKey: 'health', status: 'SKIPPED' },
      ]),
    ).toEqual({ action: 'run', stepKey: 'assemble-review-input' });
  });

  it('requeues cleanup after a failed cleanup attempt', () => {
    const records = [
      { stepKey: 'detect' as const, status: 'PASSED' as const },
      { stepKey: 'cleanup' as const, status: 'INCOMPLETE' as const, failureKind: 'infrastructure' as const },
    ];
    expect(nextStepAction(records)).toEqual({ action: 'run', stepKey: 'cleanup' });
  });

  it('skips execution profiles after an unsupported project detection', () => {
    expect(nextStepAction([{ stepKey: 'detect', status: 'FAILED', failureKind: 'application', errorCode: 'UNSUPPORTED_PROFILE' }])).toEqual({ action: 'skip', stepKey: 'fetch', reason: 'SKIPPED_UPSTREAM' });
  });
});
