import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { signatureMatches } from './webhook.controller.js';

describe('Gitea webhook signature boundary', () => {
  afterEach(() => {
    delete process.env.GITEA_WEBHOOK_SECRET;
  });

  it('validates the exact raw request bytes', () => {
    const rawBody = '{"action":"synchronize","spacing":"preserved"}';
    const secret = 'test-webhook-secret';
    process.env.GITEA_WEBHOOK_SECRET = secret;
    const signature = createHmac('sha256', secret).update(rawBody).digest('hex');

    expect(signatureMatches(rawBody, signature)).toBe(true);
    expect(signatureMatches(`${rawBody}\n`, signature)).toBe(false);
    expect(signatureMatches(rawBody, `${signature}00`)).toBe(false);
  });

  it('fails closed when the secret or signature is absent', () => {
    expect(signatureMatches('{}', undefined)).toBe(false);
    process.env.GITEA_WEBHOOK_SECRET = 'secret';
    expect(signatureMatches('{}', undefined)).toBe(false);
  });
});
