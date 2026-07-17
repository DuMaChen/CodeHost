import { describe, expect, it, vi } from 'vitest';
import { AuthService } from './auth.service.js';
import { auditEvents, oauthStates, sessions } from '@platform/db';

function service() {
  const values = vi.fn().mockResolvedValue([]);
  const database = {
    db: {
      select: vi.fn(),
      insert: vi.fn(() => ({ values })),
    },
  };
  const auth = new AuthService(database as never, {
    sessionEncryptionKey: '12345678901234567890123456789012',
    nodeEnv: 'test',
  } as never);
  return { auth, values };
}

describe('AuthService session boundary', () => {
  it('treats malformed and undecodable session cookies as anonymous', async () => {
    const { auth } = service();

    await expect(auth.current('__Host-platform_session=not-a-uuid')).resolves.toBeNull();
    await expect(auth.current('__Host-platform_session=%')).resolves.toBeNull();
    await expect(auth.current('__Host-platform_session=v1.bad')).resolves.toBeNull();
  });

  it('audits and rejects protected requests without a valid session', async () => {
    const { auth, values } = service();

    await expect(auth.require('__Host-platform_session=not-a-uuid')).rejects.toMatchObject({ status: 401 });
    expect(values).toHaveBeenCalledWith(expect.objectContaining({
      action: 'AUTH_REQUIRED',
      entityType: 'auth',
    }));
  });

  it('consumes OAuth state once, creates a session, and validates CSRF', async () => {
    const values = vi.fn().mockResolvedValue([]);
    const stateRows: Array<Record<string, unknown>> = [];
    const sessionRows: Array<Record<string, unknown>> = [];
    const database = {
      db: {
        delete: vi.fn(() => ({ where: vi.fn().mockResolvedValue([]) })),
        insert: vi.fn((table: unknown) => ({
          values: vi.fn((value: Record<string, unknown>) => {
            if (table === oauthStates) {
              stateRows.push({ ...value, id: 'oauth-state-1', consumedAt: null });
              return Promise.resolve([]);
            }
            if (table === sessions) {
              sessionRows.push({ ...value, id: '11111111-1111-4111-8111-111111111111', revokedAt: null });
              return { returning: vi.fn().mockResolvedValue([{ id: '11111111-1111-4111-8111-111111111111' }]) };
            }
            return { values };
          }),
        })),
        select: vi.fn(() => ({
          from: vi.fn((table: unknown) => ({
            where: vi.fn(() => ({
              limit: vi.fn().mockResolvedValue(table === oauthStates ? stateRows : table === sessions ? sessionRows : []),
            })),
          })),
        })),
        update: vi.fn((table: unknown) => ({
          set: vi.fn(() => ({
            where: vi.fn(() => ({
              returning: vi.fn().mockImplementation(async () => {
                if (table === oauthStates && stateRows[0]?.consumedAt === null) {
                  stateRows[0].consumedAt = new Date();
                  return [{ id: 'oauth-state-1' }];
                }
                return [];
              }),
            })),
          })),
        })),
      },
    };
    const auth = new AuthService(database as never, {
      sessionEncryptionKey: '12345678901234567890123456789012',
      nodeEnv: 'test',
      giteaOAuthClientId: 'client-id',
      giteaOAuthClientSecret: 'client-secret',
      giteaBaseUrl: 'http://gitea.test',
      giteaPublicUrl: 'https://gitea.test',
      platformPublicUrl: 'https://platform.test',
      port: 3000,
    } as never);
    const loginReply = {
      headers: [] as unknown[],
      header(name: string, value: unknown) { if (name === 'set-cookie') this.headers = value as unknown[]; return this; },
      redirect: vi.fn(),
    };
    await auth.beginLogin({ headers: { host: 'platform.test' }, protocol: 'https' } as never, loginReply as never);
    const cookies = loginReply.headers.map(String).map((value) => value.split(';', 1)[0]).join('; ');
    const state = cookies.match(/platform_oauth_state=([^;]+)/)?.[1];
    expect(state).toBeTruthy();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/login/oauth/access_token')) return new Response(JSON.stringify({ access_token: 'access-token' }), { status: 200 });
      if (url.endsWith('/api/v1/user')) return new Response(JSON.stringify({ id: 7, login: 'student', full_name: 'Student' }), { status: 200 });
      throw new Error(`unexpected OAuth URL: ${url}`);
    });
    const callbackReply = { headers: [] as unknown[], header(name: string, value: unknown) { if (name === 'set-cookie') this.headers = value as unknown[]; return this; }, redirect: vi.fn() };
    await auth.finishLogin({ headers: { cookie: cookies, host: 'platform.test' }, protocol: 'https' } as never, callbackReply as never, state, state);
    expect(sessionRows).toHaveLength(1);
    const sessionCookie = '__Host-platform_session=11111111-1111-4111-8111-111111111111';
    const csrf = await auth.csrfToken(sessionCookie);
    await expect(auth.requireCsrf(sessionCookie, csrf)).resolves.toMatchObject({ giteaUserId: 7 });
    await expect(auth.requireCsrf(sessionCookie, '0'.repeat(64))).rejects.toMatchObject({ status: 401 });
    await expect(auth.finishLogin({ headers: { cookie: cookies } } as never, callbackReply as never, state, state)).rejects.toMatchObject({ status: 401 });
    fetchMock.mockRestore();
  });

  it('rejects an expired OAuth state', async () => {
    const stateRows: Array<Record<string, unknown>> = [];
    const database = {
      db: {
        delete: vi.fn(() => ({ where: vi.fn().mockResolvedValue([]) })),
        insert: vi.fn((table: unknown) => ({
          values: vi.fn((value: Record<string, unknown>) => {
            if (table === oauthStates) {
              stateRows.push({ ...value, id: 'oauth-state-expired', consumedAt: null });
              return Promise.resolve([]);
            }
            return { values: vi.fn().mockResolvedValue([]) };
          }),
        })),
        select: vi.fn(() => ({
          from: vi.fn((table: unknown) => ({
            where: vi.fn(() => ({
              limit: vi.fn().mockResolvedValue(table === oauthStates ? stateRows : []),
            })),
          })),
        })),
      },
    };
    const auth = new AuthService(database as never, {
      sessionEncryptionKey: '12345678901234567890123456789012',
      nodeEnv: 'test',
      giteaOAuthClientId: 'client-id',
      giteaOAuthClientSecret: 'client-secret',
      giteaBaseUrl: 'http://gitea.test',
      giteaPublicUrl: 'https://gitea.test',
      platformPublicUrl: 'https://platform.test',
      port: 3000,
    } as never);
    const loginReply = {
      headers: [] as unknown[],
      header(name: string, value: unknown) { if (name === 'set-cookie') this.headers = value as unknown[]; return this; },
      redirect: vi.fn(),
    };
    await auth.beginLogin({ headers: { host: 'platform.test' }, protocol: 'https' } as never, loginReply as never);
    const cookies = loginReply.headers.map(String).map((value) => value.split(';', 1)[0]).join('; ');
    const state = cookies.match(/platform_oauth_state=([^;]+)/)?.[1];
    expect(state).toBeTruthy();

    // Mark the state as expired
    stateRows[0]!.expiresAt = new Date(Date.now() - 60_000);

    const callbackReply = { headers: [] as unknown[], header(name: string, value: unknown) { if (name === 'set-cookie') this.headers = value as unknown[]; return this; }, redirect: vi.fn() };
    await expect(auth.finishLogin({ headers: { cookie: cookies, host: 'platform.test' }, protocol: 'https' } as never, callbackReply as never, state, state)).rejects.toMatchObject({ status: 401 });
  });
});
