import { describe, expect, it } from 'vitest';
import { FixtureStepExecutor } from './executor.js';
import type { StepExecutionContext } from './types.js';

const context = (stepKey: StepExecutionContext['job']['stepKey']): StepExecutionContext => ({
  run: {
    id: '11111111-1111-4111-8111-111111111111',
    attempt: 1,
    headSha: 'a'.repeat(40),
    status: 'QUEUED',
    cleanupStatus: 'NOT_SCHEDULED',
  },
  job: {
    runId: '11111111-1111-4111-8111-111111111111',
    attempt: 1,
    headSha: 'a'.repeat(40),
    stepKey,
  },
  capacity: {
    maxActiveRuns: 1,
    maxQueuedRuns: 3,
    maxStepLogBytes: 20 * 1024 * 1024,
    maxReviewInputBytes: 64 * 1024,
  },
});

describe('fixture workflow executor', () => {
  it('completes the agent step with a strict report payload', async () => {
    const result = await new FixtureStepExecutor('success').execute(context('agent-review'));
    expect(result.status).toBe('PASSED');
    expect(result.details).toMatchObject({ provider: 'mock', model: 'mock' });
    expect(result.details?.report).toMatchObject({ riskLevel: 'LOW', findings: [] });
  });

  it('keeps application test failures distinct from infrastructure failures', async () => {
    const application = await new FixtureStepExecutor('test-failure').execute(context('test'));
    const health = await new FixtureStepExecutor('health-failure').execute(context('health'));
    const infrastructure = await new FixtureStepExecutor('infrastructure-failure').execute(context('fetch'));
    expect(application).toMatchObject({ status: 'FAILED', failureKind: 'application', errorCode: 'FIXTURE_TESTS_FAILED' });
    expect(health).toMatchObject({ status: 'FAILED', failureKind: 'application', errorCode: 'FIXTURE_HEALTH_FAILED' });
    expect(infrastructure).toMatchObject({ status: 'INCOMPLETE', failureKind: 'infrastructure', errorCode: 'FIXTURE_K8S_UNAVAILABLE' });
  });

  it('emits a constrained Python execution plan for the second fixture profile', async () => {
    const result = await new FixtureStepExecutor('success', 'python').execute(context('detect'));
    expect(result).toMatchObject({
      status: 'PASSED',
      details: {
        projectType: 'python',
        profile: 'python-http',
        port: 8000,
        testProfile: 'python-basic',
        executionPlan: { entrypoint: 'main.py' },
      },
    });
  });
});
