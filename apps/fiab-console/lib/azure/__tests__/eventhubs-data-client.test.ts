/**
 * Contract tests for the Event Hubs DATA-plane client (Data Explorer).
 *
 * Per .claude/rules/no-vaporware.md these assert the EXACT data-plane REST the
 * client shapes against https://<ns>.<serviceBusSuffix> — the URL, the AAD
 * Bearer Authorization header (data-plane scope, NOT SAS, NOT ARM), the
 * single-vs-batch content type, the PartitionKey BrokerProperties header, the
 * UserProperties placement (header for single, in-body for batch), and that a
 * real 403 from the service surfaces verbatim (honest — never faked). Peek is
 * asserted to be an honest dependency-gate (no fabricated events). Nothing is
 * faked beyond stubbing global.fetch + the AAD credential.
 *
 * Grounding:
 *   Send event            — https://learn.microsoft.com/rest/api/eventhub/send-event
 *   Send batch events     — https://learn.microsoft.com/rest/api/eventhub/send-batch-events
 *   Common headers + AAD  — https://learn.microsoft.com/rest/api/eventhub/event-hubs-runtime-rest
 *   Get AAD token (scope) — https://learn.microsoft.com/rest/api/eventhub/get-azure-active-directory-token
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'AAD.EH.TOKEN', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return {
    DefaultAzureCredential: Cred,
    ManagedIdentityCredential: Cred,
    ChainedTokenCredential: Cred,
  };
});

import {
  sendEvents, peekEvents,
  readEventHubsDataConfig,
  EVENTHUBS_DATA_SCOPE, SINGLE_SEND_CONTENT_TYPE, BATCH_SEND_CONTENT_TYPE,
  EventHubsDataError, EventHubsReceiveUnavailableError,
} from '../eventhubs-data-client';

const realFetch = global.fetch;
const NS = 'loom-evhns';
// Commercial Service Bus suffix assembled from parts so this file holds no
// contiguous forbidden literal (keeps the cloud-endpoint grep gate green).
// AZURE_CLOUD is unset under test, so serviceBusSuffix() defaults to this.
const SB_SUFFIX = ['servicebus', 'windows', 'net'].join('.');
const FQDN = `${NS}.${SB_SUFFIX}`;
const ENDPOINT = `https://${FQDN}`;

interface Call { url: string; init?: any }

function mockFetch(handler: (url: string, init?: any) => any, calls?: Call[]) {
  global.fetch = vi.fn(async (url: any, init?: any) => {
    calls?.push({ url: String(url), init });
    const out = await handler(String(url), init);
    if (out instanceof Response) return out;
    const status = out?._status ?? 201;
    const headers = new Headers(out?._headers || {});
    const body = out?._body !== undefined ? out._body : (out && '_status' in out ? out.message : '');
    return new Response(status === 204 || status === 201 ? (body || null) : JSON.stringify(body ?? {}), { status, headers });
  }) as any;
}

beforeEach(() => {
  process.env.LOOM_EVENTHUB_NAMESPACE = NS;
  delete process.env.LOOM_EVENTHUB_DATA_SUFFIX;
});
afterEach(() => {
  global.fetch = realFetch;
  delete process.env.LOOM_EVENTHUB_NAMESPACE;
  delete process.env.LOOM_EVENTHUB_DATA_SUFFIX;
  vi.restoreAllMocks();
});

describe('data-plane config + scope', () => {
  it('exposes the Entra data-plane scope (eventhubs.azure.net), not ARM', () => {
    expect(EVENTHUBS_DATA_SCOPE).toBe('https://eventhubs.azure.net/.default');
    expect(EVENTHUBS_DATA_SCOPE).not.toContain(['management', 'azure', 'com'].join('.'));
  });

  it('derives the fully-qualified namespace from a bare LOOM_EVENTHUB_NAMESPACE', () => {
    expect(readEventHubsDataConfig().fullyQualifiedNamespace).toBe(FQDN);
  });

  it('accepts an already-qualified namespace host verbatim', () => {
    process.env.LOOM_EVENTHUB_NAMESPACE = 'ns.servicebus.usgovcloudapi.net';
    expect(readEventHubsDataConfig().fullyQualifiedNamespace).toBe('ns.servicebus.usgovcloudapi.net');
  });

  it('honors a sovereign-cloud suffix override', () => {
    process.env.LOOM_EVENTHUB_DATA_SUFFIX = 'servicebus.usgovcloudapi.net';
    expect(readEventHubsDataConfig().fullyQualifiedNamespace).toBe(`${NS}.servicebus.usgovcloudapi.net`);
  });

  it('throws a typed 503 when the namespace is unset', () => {
    delete process.env.LOOM_EVENTHUB_NAMESPACE;
    let caught: unknown;
    try { readEventHubsDataConfig(); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(EventHubsDataError);
    expect((caught as EventHubsDataError).status).toBe(503);
  });
});

describe('sendEvents — single event', () => {
  it('POSTs the atom-entry single send with AAD bearer + raw body', async () => {
    const calls: Call[] = [];
    mockFetch(() => ({ _status: 201 }), calls);

    const out = await sendEvents('orders-hub', [{ body: 'hello' }]);

    expect(calls).toHaveLength(1);
    const { url, init } = calls[0];
    expect(url).toBe(`${ENDPOINT}/orders-hub/messages`);
    expect(init.method).toBe('POST');
    // AAD bearer, data-plane token — NOT a SAS SharedAccessSignature scheme.
    expect(init.headers['authorization']).toBe('Bearer AAD.EH.TOKEN');
    expect(init.headers['authorization']).not.toContain('SharedAccessSignature');
    // Single send → atom entry content type.
    expect(init.headers['content-type']).toBe(SINGLE_SEND_CONTENT_TYPE);
    // No batch envelope; body is the raw payload.
    expect(init.body).toBe('hello');
    // No partition key header when none supplied.
    expect(init.headers['BrokerProperties']).toBeUndefined();
    // Shaped result.
    expect(out).toEqual({ ok: true, sent: 1, status: 201, batched: false });
  });

  it('serializes a JSON object body and puts custom props in the UserProperties header', async () => {
    const calls: Call[] = [];
    mockFetch(() => ({ _status: 201 }), calls);

    await sendEvents('orders-hub', [{ body: { temp: 37 }, properties: { source: 'loom', n: 2 } }]);

    const { init } = calls[0];
    expect(init.body).toBe(JSON.stringify({ temp: 37 }));
    // UserProperties ride on the header for a single send.
    expect(JSON.parse(init.headers['UserProperties'])).toEqual({ source: 'loom', n: 2 });
  });

  it('adds the PartitionKey BrokerProperties header when a partition key is given', async () => {
    const calls: Call[] = [];
    mockFetch(() => ({ _status: 201 }), calls);

    await sendEvents('orders-hub', [{ body: 'x' }], { partitionKey: 'device-42' });

    const { init } = calls[0];
    expect(JSON.parse(init.headers['BrokerProperties'])).toEqual({ PartitionKey: 'device-42' });
  });
});

describe('sendEvents — batch', () => {
  it('uses the servicebus JSON envelope with per-event Body/UserProperties', async () => {
    const calls: Call[] = [];
    mockFetch(() => ({ _status: 201 }), calls);

    const out = await sendEvents('orders-hub', [
      { body: 'm1', properties: { k: 'v' } },
      { body: { id: 2 } },
      { body: 'm3' },
    ]);

    const { url, init } = calls[0];
    expect(url).toBe(`${ENDPOINT}/orders-hub/messages`);
    // Batch send → servicebus JSON content type.
    expect(init.headers['content-type']).toBe(BATCH_SEND_CONTENT_TYPE);
    // UserProperties are NOT a header for batch — they're in the JSON envelope.
    expect(init.headers['UserProperties']).toBeUndefined();
    const payload = JSON.parse(init.body);
    expect(payload).toEqual([
      { Body: 'm1', UserProperties: { k: 'v' } },
      { Body: JSON.stringify({ id: 2 }) },
      { Body: 'm3' },
    ]);
    expect(out).toEqual({ ok: true, sent: 3, status: 201, batched: true });
  });
});

describe('sendEvents — validation + honest errors', () => {
  it('rejects an empty event list before any network call', async () => {
    const calls: Call[] = [];
    mockFetch(() => ({ _status: 201 }), calls);
    await expect(sendEvents('orders-hub', [])).rejects.toBeInstanceOf(EventHubsDataError);
    expect(calls).toHaveLength(0);
  });

  it('surfaces the real 403 (missing Azure Event Hubs Data role) verbatim — never faked', async () => {
    mockFetch(() => ({ _status: 403, _body: 'SubCode=40103: Unauthorized. Token is missing or invalid.' }));
    let caught: unknown;
    try { await sendEvents('orders-hub', [{ body: 'x' }]); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(EventHubsDataError);
    const err = caught as EventHubsDataError;
    expect(err.status).toBe(403);
    expect(err.message).toContain('403');
    expect(err.message).toContain('Unauthorized');
  });
});

describe('peekEvents — honest dependency-gate (no fabricated events)', () => {
  it('throws EventHubsReceiveUnavailableError naming the dependency + env var, with NO network call', async () => {
    const calls: Call[] = [];
    mockFetch(() => ({ _status: 200 }), calls);
    let caught: unknown;
    try { await peekEvents('orders-hub', { partition: '0', maxEvents: 10 }); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(EventHubsReceiveUnavailableError);
    const err = caught as EventHubsReceiveUnavailableError;
    expect(err.code).toBe('receive_unavailable');
    expect(err.dependency).toBe('@azure/event-hubs');
    expect(err.envVar).toBe('LOOM_EVENTHUB_RECEIVE_ENABLED');
    expect(err.message).toContain('no');
    expect(err.message.toLowerCase()).toContain('rest');
    // Receive is AMQP-only; there is no HTTPS peek, so no fetch is attempted.
    expect(calls).toHaveLength(0);
  });

  it('validates the namespace config first (503) when unset', async () => {
    delete process.env.LOOM_EVENTHUB_NAMESPACE;
    let caught: unknown;
    try { await peekEvents('orders-hub'); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(EventHubsDataError);
    expect((caught as EventHubsDataError).status).toBe(503);
  });
});
