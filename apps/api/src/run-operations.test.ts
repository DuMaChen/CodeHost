import { describe, expect, it } from 'vitest';
import { hasRetryCapacity, isCancellableRunStatus, isRetryEligible } from './run-operations.js';

describe('run operation policy', () => {
  it('allows cancellation only while a run can still execute', () => {
    expect(isCancellableRunStatus('QUEUED')).toBe(true);
    expect(isCancellableRunStatus('REPORTING')).toBe(true);
    expect(isCancellableRunStatus('PASSED')).toBe(false);
    expect(isCancellableRunStatus('CANCEL_REQUESTED')).toBe(false);
  });

  it('requires cleanup confirmation before retrying', () => {
    expect(isRetryEligible('FAILED', 'CLEANED')).toBe(true);
    expect(isRetryEligible('INCOMPLETE', 'FAILED')).toBe(false);
    expect(isRetryEligible('INCOMPLETE', 'FAILED', true)).toBe(true);
    expect(isRetryEligible('PASSED', 'CLEANED')).toBe(false);
  });

  it('keeps the retry queue strictly below its configured capacity', () => {
    expect(hasRetryCapacity(0, 2, 3)).toBe(true);
    expect(hasRetryCapacity(0, 3, 3)).toBe(false);
    expect(hasRetryCapacity(1, 0, 3)).toBe(false);
    expect(hasRetryCapacity(0, 0, 0)).toBe(false);
    expect(hasRetryCapacity(0, -1, 3)).toBe(false);
    expect(hasRetryCapacity(-1, 0, 3)).toBe(false);
  });
});
