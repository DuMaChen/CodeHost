import { describe, expect, it } from 'vitest';
import { InMemoryStepGuard } from './step-guard.js';

const key = { runId: 'run-1', attempt: 1, stepKey: 'cleanup' as const };

describe('cleanup step retry semantics', () => {
  it('retries cleanup after an incomplete attempt but keeps ordinary terminal steps idempotent', async () => {
    const guard = new InMemoryStepGuard();
    const first = await guard.runOnce(key, async () => ({
      status: 'INCOMPLETE',
      failureKind: 'infrastructure',
      errorCode: 'NAMESPACE_DELETE_TIMEOUT',
    }));
    expect(first.outcome).toBe('executed');
    const second = await guard.runOnce(key, async () => ({ status: 'PASSED' }));
    expect(second).toEqual({ outcome: 'executed', result: { status: 'PASSED' } });
  });
});
