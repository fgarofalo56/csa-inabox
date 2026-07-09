/**
 * Contract tests for the Loom-native HTTP source ingester (FGC-14).
 * Mocks the Event Hubs data-plane send boundary and asserts auth, validation,
 * curated-sample emission, webhook forwarding, and the honest infra gate.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));

vi.mock('@/lib/azure/eventhubs-data-client', () => {
  class EventHubsDataError extends Error {
    status: number; body: unknown;
    constructor(status: number, body?: unknown, message?: string) {
      super(message || `eh error ${status}`);
      this.name = 'EventHubsDataError'; this.status = status; this.body = body;
    }
  }
  return { EventHubsDataError, sendEvents: vi.fn() };
});

import { getSession } from '@/lib/auth/session';
import { sendEvents, EventHubsDataError } from '@/lib/azure/eventhubs-data-client';
import { POST } from '../route';

function req(body: unknown, ct = 'application/json'): any {
  return {
    headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? ct : null) },
    json: async () => body,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (getSession as any).mockReturnValue({ claims: { oid: 'u1' } });
  (sendEvents as any).mockResolvedValue({ ok: true, sent: 10, status: 201, batched: true });
});

describe('auth + validation', () => {
  it('401 without a session', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await POST(req({ eventHubName: 'h', sampleStream: 'Buses' }));
    expect(res.status).toBe(401);
  });
  it('415 on non-JSON', async () => {
    const res = await POST(req({}, 'text/plain'));
    expect(res.status).toBe(415);
  });
  it('400 without an eventHubName', async () => {
    const res = await POST(req({ sampleStream: 'Buses' }));
    expect(res.status).toBe(400);
  });
  it('400 on unknown sample stream', async () => {
    const res = await POST(req({ eventHubName: 'h', sampleStream: 'nope' }));
    expect(res.status).toBe(400);
  });
  it('400 when neither sampleStream nor events supplied', async () => {
    const res = await POST(req({ eventHubName: 'h' }));
    expect(res.status).toBe(400);
  });
});

describe('publish', () => {
  it('generates + sends curated sample events', async () => {
    const res = await POST(req({ eventHubName: 'weather', sampleStream: 'Buses', count: 12 }));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.sampleStream).toBe('Buses');
    const [hub, events] = (sendEvents as any).mock.calls[0];
    expect(hub).toBe('weather');
    expect(events).toHaveLength(12);
    expect(events[0]).toHaveProperty('body');
  });
  it('forwards a webhook events array', async () => {
    const res = await POST(req({ eventHubName: 'ingest', events: [{ a: 1 }, { body: { b: 2 } }] }));
    expect((await res.json()).ok).toBe(true);
    const [, events] = (sendEvents as any).mock.calls[0];
    expect(events).toHaveLength(2);
    // bare object wrapped as { body }, {body} passthrough preserved
    expect(events[0].body).toEqual({ a: 1 });
    expect(events[1].body).toEqual({ b: 2 });
  });
});

describe('honest infra gate', () => {
  it('surfaces a 503 with the LOOM_EVENTHUBS_NAMESPACE hint', async () => {
    (sendEvents as any).mockRejectedValue(new EventHubsDataError(503, undefined, 'Event Hubs namespace not configured'));
    const res = await POST(req({ eventHubName: 'h', sampleStream: 'Buses' }));
    expect(res.status).toBe(503);
    const j = await res.json();
    expect(j.ok).toBe(false);
    expect(j.hint).toMatch(/LOOM_EVENTHUBS_NAMESPACE/);
  });
  it('maps 403 to a role-grant hint', async () => {
    (sendEvents as any).mockRejectedValue(new EventHubsDataError(403, undefined, 'forbidden'));
    const res = await POST(req({ eventHubName: 'h', sampleStream: 'Buses' }));
    expect(res.status).toBe(403);
    expect((await res.json()).hint).toMatch(/Data Sender/);
  });
});
