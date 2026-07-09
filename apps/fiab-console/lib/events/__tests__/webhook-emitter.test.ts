import { describe, it, expect, vi } from 'vitest';
import { deliverDirect, type WebhookEnvelope } from '../webhook-emitter';
import { verifyWebhookSignature } from '../webhook-signing';

/**
 * deliverDirect — retry/backoff + HMAC signing behaviour with an injected fetch
 * (no real network, no Cosmos). The registry/emitter fan-out that touches Cosmos
 * is exercised in deployment; here we pin the delivery state machine.
 */

const HOOK = { id: 'hook-1', tenantId: 'tid-1', url: 'https://example.com/hook', secret: 'shh-secret-value' };
const ENVELOPE: WebhookEnvelope = {
  id: 'evt-1',
  type: 'item.created',
  tenantId: 'tid-1',
  subject: 'item-1',
  data: { itemType: 'lakehouse' },
  createdAt: '2026-07-08T00:00:00.000Z',
};
const noSleep = () => Promise.resolve();
const fastBackoff = { baseMs: 0, factor: 1, capMs: 0 };

function res(status: number, body = 'ok') {
  return { status, text: () => Promise.resolve(body) } as unknown as Response;
}

describe('deliverDirect', () => {
  it('delivers on first 2xx and signs the request with a verifiable HMAC', async () => {
    let capturedHeaders: Record<string, string> = {};
    let capturedBody = '';
    const fetchImpl = vi.fn(async (_url: string, init: any) => {
      capturedHeaders = init.headers;
      capturedBody = init.body;
      return res(200);
    });
    const d = await deliverDirect(HOOK, ENVELOPE, { fetchImpl: fetchImpl as any, sleep: noSleep, backoff: fastBackoff });
    expect(d.outcome).toBe('delivered');
    expect(d.status).toBe(200);
    expect(d.attempts).toBe(1);
    expect(d.transport).toBe('direct');
    // Signature header verifies against the body + timestamp.
    const ts = Number(capturedHeaders['x-loom-timestamp']);
    const sig = capturedHeaders['x-loom-signature'];
    expect(capturedHeaders['x-loom-event']).toBe('item.created');
    expect(verifyWebhookSignature(HOOK.secret, capturedBody, ts, sig, 0)).toBe(true);
  });

  it('retries on 5xx then succeeds, counting attempts', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(res(503, 'unavailable'))
      .mockResolvedValueOnce(res(500, 'boom'))
      .mockResolvedValueOnce(res(200, 'ok'));
    const d = await deliverDirect(HOOK, ENVELOPE, { fetchImpl: fetchImpl as any, sleep: noSleep, backoff: fastBackoff });
    expect(d.outcome).toBe('delivered');
    expect(d.attempts).toBe(3);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('stops immediately on a non-retriable 4xx', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(400, 'bad signature'));
    const d = await deliverDirect(HOOK, ENVELOPE, { fetchImpl: fetchImpl as any, sleep: noSleep, backoff: fastBackoff });
    expect(d.outcome).toBe('failed');
    expect(d.status).toBe(400);
    expect(d.attempts).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('exhausts retries on persistent failure and reports failed', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(500, 'boom'));
    const d = await deliverDirect(HOOK, ENVELOPE, {
      fetchImpl: fetchImpl as any, sleep: noSleep, backoff: fastBackoff, maxRetries: 2,
    });
    expect(d.outcome).toBe('failed');
    expect(d.attempts).toBe(3); // 1 initial + 2 retries
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('treats a thrown network error as retriable (status 0)', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(res(204));
    const d = await deliverDirect(HOOK, ENVELOPE, { fetchImpl: fetchImpl as any, sleep: noSleep, backoff: fastBackoff });
    expect(d.outcome).toBe('delivered');
    expect(d.attempts).toBe(2);
  });
});
