import { describe, expect, it, vi } from 'vitest';
import { WebhookService } from './webhook.service.js';

function stalePayload(): Record<string, unknown> {
  const createdAt = new Date(Date.now() - 16 * 60 * 1000).toISOString();
  return {
    action: 'opened',
    created_at: createdAt,
    repository: { id: 9001, full_name: 'course/demo' },
    pull_request: {
      id: 9004,
      number: 4,
      created_at: createdAt,
      updated_at: createdAt,
      head: { sha: 'f'.repeat(40) },
    },
  };
}

describe('WebhookService replay handling', () => {
  it('rejects stale events with an audit record instead of a server error', async () => {
    const values = vi.fn().mockResolvedValue([]);
    const database = {
      db: { insert: vi.fn(() => ({ values })) },
    };
    const service = new WebhookService(database as never, {
      webhookMaxAgeMinutes: 15,
      giteaAllowedRepositories: [],
    } as never);
    const payload = stalePayload();

    await expect(service.accept(Buffer.from(JSON.stringify(payload)), payload, 'stale-test-delivery'))
      .rejects.toMatchObject({ status: 409 });
    expect(values).toHaveBeenCalledWith(expect.objectContaining({
      action: 'WEBHOOK_REPLAY_REJECTED',
      entityId: 'stale-test-delivery',
      metadataJson: expect.objectContaining({ reason: 'stale-or-future-event' }),
    }));
  });
});
