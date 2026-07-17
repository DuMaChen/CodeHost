import {
  BadRequestException,
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, isNull, lte } from 'drizzle-orm';
import { auditEvents, oauthStates, sessions } from '@platform/db';
import type { AppConfig } from '@platform/config';
import { DatabaseHandle, PLATFORM_DB } from './database.provider.js';
import { PLATFORM_CONFIG } from './tokens.js';

const SESSION_COOKIE = '__Host-platform_session';
const OAUTH_STATE_COOKIE = 'platform_oauth_state';
const OAUTH_NONCE_COOKIE = 'platform_oauth_nonce';
const OAUTH_BROWSER_COOKIE = 'platform_oauth_browser';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const OAUTH_STATE_TTL_SECONDS = 5 * 60;
const OAUTH_STATE_TTL_MS = OAUTH_STATE_TTL_SECONDS * 1000;
const REQUEST_TIMEOUT_MS = 10_000;

export interface GiteaUser {
  readonly id: number;
  readonly login: string;
  readonly fullName?: string;
}

export interface AuthenticatedSession {
  readonly id: string;
  readonly giteaUserId: number;
  readonly accessToken: string;
}

function encode(value: Buffer): string {
  return value.toString('base64url');
}

function decode(value: string): Buffer {
  return Buffer.from(value, 'base64url');
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const item of header.split(';')) {
    const separator = item.indexOf('=');
    if (separator <= 0) continue;
    const key = item.slice(0, separator).trim();
    if (key !== name) continue;
    try {
      return decodeURIComponent(item.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function uuid(value: string | undefined): string | undefined {
  return value !== undefined && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : undefined;
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function cookieHeader(name: string, value: string, maxAge: number, secure: boolean): string {
  return [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
    secure ? 'Secure' : '',
  ].filter(Boolean).join('; ');
}

function publicOrigin(request: FastifyRequest, fallbackPort: number): string {
  const forwardedProto = request.headers['x-forwarded-proto'];
  const forwardedHost = request.headers['x-forwarded-host'];
  const protocol = (typeof forwardedProto === 'string' ? forwardedProto.split(',')[0] : undefined)
    ?? (request.protocol || 'http');
  const host = (typeof forwardedHost === 'string' ? forwardedHost.split(',')[0] : undefined)
    ?? request.headers.host
    ?? `localhost:${fallbackPort}`;
  return `${protocol}://${host}`;
}

function parseGiteaUser(value: unknown): GiteaUser {
  if (typeof value !== 'object' || value === null) {
    throw new ServiceUnavailableException('Gitea user response is invalid');
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.id !== 'number' ||
    !Number.isInteger(candidate.id) ||
    candidate.id < 1 ||
    typeof candidate.login !== 'string' ||
    candidate.login.trim().length === 0
  ) {
    throw new ServiceUnavailableException('Gitea user response is invalid');
  }
  const fullName = typeof candidate.full_name === 'string' && candidate.full_name.trim().length > 0
    ? candidate.full_name
    : undefined;
  return { id: candidate.id, login: candidate.login, ...(fullName ? { fullName } : {}) };
}

@Injectable()
export class AuthService {
  private readonly encryptionKey: Buffer;

  constructor(
    @Inject(PLATFORM_DB) private readonly database: DatabaseHandle,
    @Inject(PLATFORM_CONFIG) private readonly config: AppConfig,
  ) {
    this.encryptionKey = createHash('sha256').update(config.sessionEncryptionKey).digest();
  }

  get sessionCookieName(): string {
    return SESSION_COOKIE;
  }

  get secureCookies(): boolean {
    return this.config.nodeEnv === 'production';
  }

  isOAuthConfigured(): boolean {
    return Boolean(this.config.giteaOAuthClientId && this.config.giteaOAuthClientSecret);
  }

  private encrypt(value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return `v1.${encode(iv)}.${encode(cipher.getAuthTag())}.${encode(ciphertext)}`;
  }

  private decrypt(value: string): string {
    const parts = value.split('.');
    if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('invalid encrypted session token');
    const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey, decode(parts[1] ?? ''));
    decipher.setAuthTag(decode(parts[2] ?? ''));
    return Buffer.concat([decipher.update(decode(parts[3] ?? '')), decipher.final()]).toString('utf8');
  }

  private giteaUrl(path: string): string {
    return new URL(path, this.config.giteaBaseUrl).toString();
  }

  private giteaPublicUrl(path: string): string {
    return new URL(path, this.config.giteaPublicUrl ?? this.config.giteaBaseUrl).toString();
  }

  private async giteaFetch(path: string, accessToken: string, init: RequestInit = {}): Promise<Response> {
    try {
      return await fetch(this.giteaUrl(path), {
        ...init,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: {
          Accept: 'application/json',
          Authorization: `token ${accessToken}`,
          ...(init.headers ?? {}),
        },
      });
    } catch {
      throw new ServiceUnavailableException('Gitea is unavailable');
    }
  }

  private clearStateCookie(reply: FastifyReply): void {
    reply.header('set-cookie', [
      cookieHeader(OAUTH_STATE_COOKIE, '', 0, this.secureCookies),
      cookieHeader(OAUTH_NONCE_COOKIE, '', 0, this.secureCookies),
      cookieHeader(OAUTH_BROWSER_COOKIE, '', 0, this.secureCookies),
    ]);
  }

  private async audit(action: string, metadataJson: Record<string, unknown>): Promise<void> {
    try {
      await this.database.db.insert(auditEvents).values({
        action,
        entityType: 'auth',
        metadataJson,
      });
    } catch {
      // Authentication failures must remain deterministic even if audit storage is unavailable.
    }
  }

  async beginLogin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!this.isOAuthConfigured()) {
      throw new ServiceUnavailableException('Gitea OAuth is not configured');
    }
    const state = randomBytes(32).toString('hex');
    const nonce = randomBytes(32).toString('hex');
    const browserBinding = randomBytes(32).toString('hex');
    await this.database.db.delete(oauthStates).where(lte(oauthStates.expiresAt, new Date()));
    await this.database.db.insert(oauthStates).values({
      stateHash: hash(state),
      nonceHash: hash(nonce),
      browserBindingHash: hash(browserBinding),
      expiresAt: new Date(Date.now() + OAUTH_STATE_TTL_MS),
    });
    const redirectUri = `${this.config.platformPublicUrl ?? publicOrigin(request, this.config.port)}/auth/callback`;
    const authorizeUrl = new URL(this.giteaPublicUrl('/login/oauth/authorize'));
    authorizeUrl.searchParams.set('client_id', this.config.giteaOAuthClientId!);
    authorizeUrl.searchParams.set('redirect_uri', redirectUri);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('state', state);
    authorizeUrl.searchParams.set('nonce', nonce);
    reply.header('set-cookie', [
      cookieHeader(OAUTH_STATE_COOKIE, state, OAUTH_STATE_TTL_SECONDS, this.secureCookies),
      cookieHeader(OAUTH_NONCE_COOKIE, nonce, OAUTH_STATE_TTL_SECONDS, this.secureCookies),
      cookieHeader(OAUTH_BROWSER_COOKIE, browserBinding, OAUTH_STATE_TTL_SECONDS, this.secureCookies),
    ]);
    await this.audit('OAUTH_LOGIN_INITIATED', {});
    reply.redirect(authorizeUrl.toString());
  }

  async finishLogin(
    request: FastifyRequest,
    reply: FastifyReply,
    code: string | undefined,
    state: string | undefined,
  ): Promise<void> {
    if (!this.isOAuthConfigured()) throw new ServiceUnavailableException('Gitea OAuth is not configured');
    const expectedState = readCookie(request.headers.cookie, OAUTH_STATE_COOKIE);
    const expectedNonce = readCookie(request.headers.cookie, OAUTH_NONCE_COOKIE);
    const browserBinding = readCookie(request.headers.cookie, OAUTH_BROWSER_COOKIE);
    this.clearStateCookie(reply);
    if (!code || !state || !expectedState || !expectedNonce || !browserBinding) {
      await this.audit('OAUTH_CALLBACK_REJECTED', { reason: 'incomplete' });
      throw new BadRequestException('OAuth callback is incomplete');
    }
    const expected = Buffer.from(expectedState, 'utf8');
    const actual = Buffer.from(state, 'utf8');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      await this.audit('OAUTH_CALLBACK_REJECTED', { reason: 'state-mismatch' });
      throw new UnauthorizedException('OAuth state validation failed');
    }
    const stateRows = await this.database.db.select().from(oauthStates).where(eq(oauthStates.stateHash, hash(state))).limit(1);
    const stateRow = stateRows[0];
    const validState = stateRow !== undefined
      && stateRow.consumedAt === null
      && stateRow.expiresAt.getTime() > Date.now()
      && hash(expectedNonce) === stateRow.nonceHash
      && hash(browserBinding) === stateRow.browserBindingHash;
    if (!validState || stateRow === undefined) {
      await this.audit('OAUTH_CALLBACK_REJECTED', { reason: 'state-expired-or-binding-mismatch' });
      throw new UnauthorizedException('OAuth state validation failed');
    }
    const consumed = await this.database.db.update(oauthStates)
      .set({ consumedAt: new Date() })
      .where(and(eq(oauthStates.id, stateRow.id), isNull(oauthStates.consumedAt)))
      .returning({ id: oauthStates.id });
    if (consumed.length !== 1) {
      await this.audit('OAUTH_CALLBACK_REJECTED', { reason: 'state-replayed' });
      throw new UnauthorizedException('OAuth state validation failed');
    }

    const tokenResponse = await fetch(this.giteaUrl('/login/oauth/access_token'), {
      method: 'POST',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.config.giteaOAuthClientId!,
        client_secret: this.config.giteaOAuthClientSecret!,
        code,
        redirect_uri: `${this.config.platformPublicUrl ?? publicOrigin(request, this.config.port)}/auth/callback`,
      }),
    }).catch(() => { throw new ServiceUnavailableException('Gitea OAuth token exchange failed'); });
    if (!tokenResponse.ok) throw new UnauthorizedException('Gitea OAuth token exchange was rejected');
    const tokenPayload = await tokenResponse.json() as { access_token?: unknown };
    if (typeof tokenPayload.access_token !== 'string' || tokenPayload.access_token.length < 1) {
      throw new UnauthorizedException('Gitea OAuth did not return an access token');
    }
    const user = await this.fetchUser(tokenPayload.access_token);
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    const inserted = await this.database.db.insert(sessions).values({
      giteaUserId: user.id,
      encryptedAccessToken: this.encrypt(tokenPayload.access_token),
      expiresAt,
    }).returning({ id: sessions.id });
    const session = inserted[0];
    if (!session) throw new ServiceUnavailableException('Session creation failed');
    await this.audit('OAUTH_LOGIN_SUCCEEDED', { giteaUserId: user.id });
    reply.header('set-cookie', [
      cookieHeader(OAUTH_STATE_COOKIE, '', 0, this.secureCookies),
      cookieHeader(SESSION_COOKIE, session.id, Math.floor(SESSION_TTL_MS / 1000), true),
    ]);
    reply.redirect('/');
  }

  async current(cookieHeaderValue: string | undefined): Promise<AuthenticatedSession | null> {
    const sessionId = uuid(readCookie(cookieHeaderValue, SESSION_COOKIE));
    if (!sessionId) return null;
    const rows = await this.database.db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    const row = rows[0];
    if (!row || row.revokedAt !== null || row.expiresAt.getTime() <= Date.now()) return null;
    try {
      return { id: row.id, giteaUserId: row.giteaUserId, accessToken: this.decrypt(row.encryptedAccessToken) };
    } catch {
      return null;
    }
  }

  async require(cookieHeaderValue: string | undefined): Promise<AuthenticatedSession> {
    const session = await this.current(cookieHeaderValue);
    if (!session) {
      await this.audit('AUTH_REQUIRED', { reason: 'missing-or-invalid-session' });
      throw new UnauthorizedException('authentication required');
    }
    return session;
  }

  async csrfToken(cookieHeaderValue: string | undefined): Promise<string> {
    const session = await this.require(cookieHeaderValue);
    return createHmac('sha256', this.encryptionKey)
      .update(`platform-csrf:${session.id}`)
      .digest('hex');
  }

  async requireCsrf(cookieHeaderValue: string | undefined, token: string | undefined): Promise<AuthenticatedSession> {
    const session = await this.require(cookieHeaderValue);
    if (token === undefined || !/^[0-9a-f]{64}$/i.test(token)) {
      await this.audit('CSRF_REJECTED', { giteaUserId: session.giteaUserId, reason: 'missing-or-malformed-token' });
      throw new UnauthorizedException('CSRF token is invalid');
    }
    const expected = createHmac('sha256', this.encryptionKey)
      .update(`platform-csrf:${session.id}`)
      .digest('hex');
    const expectedBytes = Buffer.from(expected, 'utf8');
    const actualBytes = Buffer.from(token, 'utf8');
    if (expectedBytes.length !== actualBytes.length || !timingSafeEqual(expectedBytes, actualBytes)) {
      await this.audit('CSRF_REJECTED', { giteaUserId: session.giteaUserId, reason: 'token-mismatch' });
      throw new UnauthorizedException('CSRF token is invalid');
    }
    return session;
  }

  async fetchUser(accessToken: string): Promise<GiteaUser> {
    const response = await this.giteaFetch('/api/v1/user', accessToken);
    if (response.status === 401 || response.status === 403) throw new UnauthorizedException('Gitea session is invalid');
    if (!response.ok) throw new ServiceUnavailableException('Gitea user lookup failed');
    return parseGiteaUser(await response.json());
  }

  async accessibleRepositories(session: AuthenticatedSession): Promise<ReadonlySet<string>> {
    const names = new Set<string>();
    for (let page = 1; page <= 10; page += 1) {
      const response = await this.giteaFetch(`/api/v1/user/repos?limit=50&page=${page}`, session.accessToken);
      if (response.status === 401 || response.status === 403) throw new UnauthorizedException('Gitea session is invalid');
      if (!response.ok) throw new ServiceUnavailableException('Gitea repository lookup failed');
      const payload = await response.json();
      if (!Array.isArray(payload)) throw new ServiceUnavailableException('Gitea repository response is invalid');
      for (const item of payload) {
        const fullName = typeof item === 'object' && item !== null
          ? (item as Record<string, unknown>).full_name
          : undefined;
        if (typeof fullName === 'string') names.add(fullName);
      }
      if (payload.length < 50) break;
    }
    return names;
  }

  async isRepositoryMaintainer(session: AuthenticatedSession, fullName: string): Promise<boolean> {
    const separator = fullName.indexOf('/');
    if (separator <= 0 || separator === fullName.length - 1 || fullName.indexOf('/', separator + 1) !== -1) return false;
    const owner = encodeURIComponent(fullName.slice(0, separator));
    const repository = encodeURIComponent(fullName.slice(separator + 1));
    const response = await this.giteaFetch(`/api/v1/repos/${owner}/${repository}`, session.accessToken);
    if (response.status === 401 || response.status === 403) throw new UnauthorizedException('Gitea session is invalid');
    if (!response.ok) throw new ServiceUnavailableException('Gitea repository lookup failed');
    const payload = await response.json();
    if (typeof payload !== 'object' || payload === null) throw new ServiceUnavailableException('Gitea repository response is invalid');
    const permissions = (payload as Record<string, unknown>).permissions;
    if (typeof permissions !== 'object' || permissions === null) return false;
    const values = permissions as Record<string, unknown>;
    return values.admin === true || values.push === true;
  }

  async logout(cookieHeaderValue: string | undefined): Promise<void> {
    const session = await this.current(cookieHeaderValue);
    if (session) {
      await this.database.db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, session.id));
      await this.audit('SESSION_REVOKED', { sessionId: session.id });
    }
  }

  setLoggedOutCookie(reply: FastifyReply): void {
    reply.header('set-cookie', cookieHeader(SESSION_COOKIE, '', 0, true));
  }
}
