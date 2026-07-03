/**
 * BFF contract tests for /api/items/event-schema-set/[id]/check-compat.
 *
 * Per .claude/rules/no-vaporware.md these exercise the real route handler with a
 * mocked Cosmos container + eventhubs-client (real Avro validator logic runs;
 * external I/O is replaced). They pin the dry-run-vs-authoritative backend
 * selection that powers the editor's live compatibility check:
 *
 *   - 401 unauthenticated / 400 missing params
 *   - first version under a subject is always compatible
 *   - in-process Avro validator blocks an add-without-default under BACKWARD
 *   - dryRunInProcess:true uses the in-process validator EVEN WHEN EH SR is
 *     configured (the live/debounced editor check never PUTs into EH SR)
 *   - dryRunInProcess absent → delegates to EH SR when configured
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const getSessionMock = vi.fn(() => ({ claims: { oid: 'o', upn: 'a@b.com' }, exp: Date.now() / 1000 + 3600 }) as any);
vi.mock('@/lib/auth/session', () => ({ getSession: () => getSessionMock() }));

let cosmosItem: any = null;
const readMock = vi.fn(async () => ({ resource: cosmosItem }));
vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: async () => ({ item: () => ({ read: readMock }) }),
  // #1602 gates the route with assertOwner(workspaceId, tenantId), which
  // point-reads the workspace on (id, ownerOid) and checks tenantId. Return an
  // owned workspace (tenantId === the session oid 'o') so the guard passes.
  workspacesContainer: async () => ({
    item: () => ({ read: async () => ({ resource: { id: 'ws-1', tenantId: 'o' } }) }),
  }),
}));

// EH SR gate: null = configured (the gate returns null when env is present).
// vi.mock factories are hoisted above all module-level statements, so anything
// they reference must be created inside vi.hoisted() (which runs first). The EH
// SR mock returns the EventHubsArmError CLASS directly (not lazily), so it can't
// be a plain top-level declaration — it would be in the temporal-dead-zone when
// the hoisted factory runs. Bundle the shared mock state here.
const ehMocks = vi.hoisted(() => {
  class EventHubsArmError extends Error {
    status: number; body: unknown;
    constructor(message: string, status: number, body?: unknown) { super(message); this.status = status; this.body = body; }
  }
  return {
    state: { srGate: { missing: 'LOOM_EH_SCHEMA_GROUP' } as { missing: string } | null },
    putSchemaVersion: vi.fn(async (..._a: any[]) => ({})),
    EventHubsArmError,
  };
});
const putSchemaVersion = ehMocks.putSchemaVersion;
const EventHubsArmError = ehMocks.EventHubsArmError;
vi.mock('@/lib/azure/eventhubs-client', () => ({
  schemaRegistryConfigGate: () => ehMocks.state.srGate,
  putSchemaVersion: (...a: any[]) => ehMocks.putSchemaVersion(...a),
  EventHubsArmError: ehMocks.EventHubsArmError,
}));

import { POST } from '../route';

const avro = (fields: unknown[]) =>
  JSON.stringify({ type: 'record', name: 'Ev', namespace: 'loom', fields });

function makeSet(opts: { compatibility?: string; latest?: string; subject?: string } = {}) {
  const subject = opts.subject ?? 'orders.OrderEvent';
  return {
    id: 'ess-1',
    itemType: 'event-schema-set',
    state: {
      compatibility: opts.compatibility ?? 'BACKWARD',
      subjects: opts.latest
        ? [{ name: subject, format: 'AVRO', versions: [{ id: 1, schema: opts.latest }] }]
        : [],
    },
  };
}

function req(body: unknown) {
  return new NextRequest('http://x/api/items/event-schema-set/ess-1/check-compat?workspaceId=ws-1', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}
const ctx = { params: Promise.resolve({ id: 'ess-1' }) };

describe('check-compat route', () => {
  beforeEach(() => {
    cosmosItem = makeSet();
    ehMocks.state.srGate = { missing: 'LOOM_EH_SCHEMA_GROUP' }; // EH SR NOT configured by default
    putSchemaVersion.mockClear();
    readMock.mockClear();
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('401 when unauthenticated', async () => {
    getSessionMock.mockReturnValueOnce(null);
    const res = await POST(req({ subject: 's', newSchema: avro([]) }), ctx);
    expect(res.status).toBe(401);
  });

  it('400 when subject missing', async () => {
    const res = await POST(req({ newSchema: avro([]) }), ctx);
    expect(res.status).toBe(400);
  });

  it('first version under a subject is always compatible', async () => {
    cosmosItem = makeSet(); // no existing versions
    const res = await POST(req({ subject: 'orders.OrderEvent', newSchema: avro([{ name: 'a', type: 'string' }]) }), ctx);
    const j = await res.json();
    expect(j).toMatchObject({ ok: true, compatible: true, checkedVia: 'cosmos-inprocess' });
  });

  it('in-process validator blocks add-without-default under BACKWARD', async () => {
    cosmosItem = makeSet({ latest: avro([{ name: 'a', type: 'string' }]) });
    const newSchema = avro([{ name: 'a', type: 'string' }, { name: 'b', type: 'int' }]); // no default
    const res = await POST(req({ subject: 'orders.OrderEvent', newSchema }), ctx);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.compatible).toBe(false);
    expect(j.checkedVia).toBe('cosmos-inprocess');
    expect(j.violations.length).toBeGreaterThan(0);
  });

  it('dryRunInProcess:true uses in-process validator even when EH SR is configured', async () => {
    ehMocks.state.srGate = null; // EH SR IS configured
    cosmosItem = makeSet({ latest: avro([{ name: 'a', type: 'string' }]) });
    const newSchema = avro([{ name: 'a', type: 'string' }, { name: 'b', type: 'int', default: 0 }]); // safe add
    const res = await POST(req({ subject: 'orders.OrderEvent', newSchema, dryRunInProcess: true }), ctx);
    const j = await res.json();
    expect(j).toMatchObject({ ok: true, compatible: true, checkedVia: 'cosmos-inprocess' });
    expect(putSchemaVersion).not.toHaveBeenCalled(); // never PUTs into EH SR on the live path
  });

  it('without dryRun, delegates to EH SR when configured', async () => {
    ehMocks.state.srGate = null; // EH SR IS configured
    cosmosItem = makeSet({ latest: avro([{ name: 'a', type: 'string' }]) });
    const newSchema = avro([{ name: 'a', type: 'string' }, { name: 'b', type: 'int', default: 0 }]);
    const res = await POST(req({ subject: 'orders.OrderEvent', newSchema }), ctx);
    const j = await res.json();
    expect(j).toMatchObject({ ok: true, compatible: true, checkedVia: 'eventhubs-sr' });
    expect(putSchemaVersion).toHaveBeenCalledTimes(1);
  });

  it('EH SR 400 → incompatible with the service detail (authoritative path)', async () => {
    ehMocks.state.srGate = null;
    cosmosItem = makeSet({ latest: avro([{ name: 'a', type: 'string' }]) });
    putSchemaVersion.mockRejectedValueOnce(new EventHubsArmError('bad', 400, 'incompatible: field b removed'));
    const res = await POST(req({ subject: 'orders.OrderEvent', newSchema: avro([{ name: 'a', type: 'string' }]) }), ctx);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.compatible).toBe(false);
    expect(j.checkedVia).toBe('eventhubs-sr');
    expect(j.violations[0]).toContain('incompatible');
  });
});
