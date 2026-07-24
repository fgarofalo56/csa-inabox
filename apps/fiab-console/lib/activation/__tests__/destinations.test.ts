import { describe, it, expect, vi } from 'vitest';
import { sendWebhook, sendEventGrid, sendServiceBus, type ActivationOutRow } from '../destinations';

const rows: ActivationOutRow[] = [
  { dedupId: 'it:a:4', key: 'a', op: 'upsert', data: { name: 'A' } },
  { dedupId: 'it:b:4', key: 'b', op: 'delete', data: { name: 'B' } },
];

describe('destinations — webhook', () => {
  it('POSTs one envelope with all rows and tallies upserts/deletes', async () => {
    let body: any;
    const fetchImpl = vi.fn(async (_url: any, init?: any) => { body = JSON.parse(init.body); return { ok: true, status: 200, text: async () => '' } as any; });
    const res = await sendWebhook({ kind: 'webhook', url: 'https://h' }, rows, { itemId: 'it', mode: 'full', toVersion: 4 }, { fetchImpl: fetchImpl as any });
    expect(res.upserts).toBe(1);
    expect(res.deletes).toBe(1);
    expect(body.rows).toHaveLength(2);
    expect(body.rows[0]).toMatchObject({ dedupId: 'it:a:4', op: 'upsert' });
  });

  it('counts every row as an error on a non-2xx response', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 500, text: async () => 'nope' } as any));
    const res = await sendWebhook({ kind: 'webhook', url: 'https://h' }, rows, { itemId: 'it', mode: 'full' }, { fetchImpl: fetchImpl as any });
    expect(res.errors).toBe(2);
    expect(res.firstError).toContain('nope');
  });
});

describe('destinations — Event Grid', () => {
  it('publishes CloudEvents with the dedup id as the event id', async () => {
    let events: any[] = [];
    const fetchImpl = vi.fn(async (_url: any, init?: any) => { events = JSON.parse(init.body); return { ok: true, status: 200, text: async () => '' } as any; });
    const res = await sendEventGrid(
      { kind: 'event-grid', topicEndpoint: 'https://t.eventgrid.azure.net/api/events', eventType: 'Loom.VIP' },
      rows, { itemId: 'it', toVersion: 4 }, { fetchImpl: fetchImpl as any, getToken: async () => 'tok' },
    );
    expect(res.errors).toBe(0);
    expect(events[0].id).toBe('it:a:4');
    expect(events[0].type).toBe('Loom.VIP');
    expect(events[0].data).toMatchObject({ op: 'upsert', key: 'a' });
  });
});

describe('destinations — Service Bus', () => {
  it('sends one message per row with the dedup id as MessageId', async () => {
    const brokerProps: string[] = [];
    const fetchImpl = vi.fn(async (url: any, init?: any) => { brokerProps.push(init.headers.BrokerProperties); return { ok: true, status: 201, text: async () => '' } as any; });
    const res = await sendServiceBus(
      { kind: 'service-bus', namespace: 'ns', entity: 'q' },
      rows, { itemId: 'it', toVersion: 4 }, { fetchImpl: fetchImpl as any, getToken: async () => 'tok' },
    );
    expect(res.upserts + res.deletes).toBe(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(JSON.parse(brokerProps[0]).MessageId).toBe('it:a:4');
  });
});
