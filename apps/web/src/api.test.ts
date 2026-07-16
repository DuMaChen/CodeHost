import { afterEach, describe, expect, it, vi } from 'vitest';
import { cancelRun, getLogs, getPreview, retryRun } from './api';

describe('run action API contract', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends retry as a credentialed POST with the CSRF token', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ run: { status: 'QUEUED' } }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await retryRun('11111111-1111-4111-8111-111111111111', 'csrf-token');

    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(init?.method).toBe('POST');
    expect(init?.credentials).toBe('include');
    expect(new Headers(init?.headers).get('x-csrf-token')).toBe('csrf-token');
  });

  it('targets the cancel endpoint without sending a browser token in the body', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ run: { status: 'CANCEL_REQUESTED' } }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await cancelRun('11111111-1111-4111-8111-111111111111', 'csrf-token');

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toContain('/api/runs/11111111-1111-4111-8111-111111111111/cancel');
    expect(init?.body).toBeUndefined();
  });

  it('marks a cleanup-failure retry as an explicit human confirmation', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ run: { status: 'QUEUED' } }), { status: 202 }),
    );

    await retryRun('11111111-1111-4111-8111-111111111111', 'csrf-token', true);

    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(new Headers(init?.headers).get('x-confirm-cleanup-failure')).toBe('true');
  });

  it('accepts a local port-forward command without requiring a browser URL', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      preview: {
        accessMode: 'local',
        status: 'READY',
        portForwardCommand: "kubectl -n 'pr-run-abc' port-forward service/preview 8080:80",
        expiresAt: '2099-01-01T00:00:00.000Z',
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    await expect(getPreview('11111111-1111-4111-8111-111111111111')).resolves.toMatchObject({
      accessMode: 'local',
      portForwardCommand: expect.stringContaining('port-forward'),
    });
  });

  it('parses bounded step logs from the run API', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      logs: [{ stepKey: 'analyze', label: '静态分析与密钥扫描', content: 'redacted', truncated: false }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    await expect(getLogs('11111111-1111-4111-8111-111111111111')).resolves.toEqual([
      { stepKey: 'analyze', label: '静态分析与密钥扫描', content: 'redacted', truncated: false, expiresAt: undefined },
    ]);
  });
});
