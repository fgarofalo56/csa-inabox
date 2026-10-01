/**
 * #4805 — operator decision 2026-09-30, "Guardrails in-product" (d): a custom-app
 * Eventstream source provisioned from a CLI / VS Code device-code session does
 * NOT hand back the Send SAS connection string (a durable credential). The rule
 * is still created, `auth` still reports 'sas', and the SAME claims in a browser
 * session still receive the string.
 *
 * Real session crypto and the real route; the Event Hubs and Kusto clients and
 * the cookie store are faked.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret-0123456789';

// A placeholder, not connection-string shaped: the route passes it through
// untouched, and a realistic shape would only trip the secret scanners.
const FAKE_CS = 'placeholder-connection-string-for-tests';
let ruleCreated = 0;
vi.mock('@/lib/azure/eventhubs-client', () => {
  class EventHubsArmError extends Error { status = 500; }
  return {
    EventHubsArmError,
    eventhubsConfigGate: () => null,
    readEventHubsConfig: () => ({}),
    createEventHub: async () => ({}),
    ensureEventHub: async () => ({}),
    createEventHubAuthRule: async () => { ruleCreated += 1; return {}; },
    listEventHubKeys: async () => ({ localAuthDisabled: false, primaryConnectionString: FAKE_CS }),
  };
});
vi.mock('@/lib/azure/eventhubs-data-client', () => ({
  readEventHubsDataConfig: () => ({ fullyQualifiedNamespace: 'ns.servicebus.windows.net' }),
}));
vi.mock('@/lib/azure/kusto-client', () => {
  class KustoError extends Error { status = 500; }
  return {
    KustoError,
    loadKustoItem: async () => ({ id: 'es1', state: {} }),
    saveItemState: async () => undefined,
  };
});
let cookieValue: string | undefined;
vi.mock('next/headers', () => ({
  cookies: () => ({ get: (name: string) => (cookieValue ? { name, value: cookieValue } : undefined) }),
}));

import { encodeSessionCookie, type SessionPayload } from '@/lib/auth/session';
import { POST } from '../[id]/source/route';

const claims = { oid: 'aaaaaaaa-0000-0000-0000-0000000000e1', tid: 'bbbbbbbb-0000-0000-0000-000000000002', name: 'Eve', upn: 'eve@contoso.com' };
const exp = () => Math.floor(Date.now() / 1000) + 600;
const browser = (): SessionPayload => ({ claims: { ...claims }, exp: exp() });
const deviceCode = (): SessionPayload => ({ claims: { ...claims }, exp: exp(), authVia: 'device_code' });

const customApp = () =>
  new NextRequest('https://loom.example/api/items/eventstream/es1/source', {
    method: 'POST',
    body: JSON.stringify({ kind: 'custom-app', config: { name: 'orders' } }),
  });
const ctx = { params: Promise.resolve({ id: 'es1' }) } as any;

beforeEach(() => {
  ruleCreated = 0;
});

describe('#4805 (d) custom-app Eventstream source from a device-code session', () => {
  it('the SAS connection string is withheld; the rule is still created and auth still reads sas', async () => {
    cookieValue = encodeSessionCookie(deviceCode());
    const res = await POST(customApp(), ctx);
    const body = await res.json();
    expect(res.status).toBe(200);
    // RED if the withhold is removed: the fake connection string would be returned.
    expect(body.endpoint.connectionString).toBeNull();
    expect(JSON.stringify(body)).not.toContain(FAKE_CS);
    expect(body.endpoint).toMatchObject({ auth: 'sas', localAuthDisabled: false });
    expect(body.hint).toMatch(/shown only to an interactive browser sign-in/);
    expect(ruleCreated).toBe(1);
  });

  it('control: the same claims in a browser session receive the connection string', async () => {
    cookieValue = encodeSessionCookie(browser());
    const body = await (await POST(customApp(), ctx)).json();
    expect(body.endpoint.connectionString).toBe(FAKE_CS);
    expect(body.hint).toMatch(/was issued/);
  });
});
