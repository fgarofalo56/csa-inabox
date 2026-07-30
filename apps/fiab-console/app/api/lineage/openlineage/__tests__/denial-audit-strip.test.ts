/**
 * ROUND-3 — S1 CLASS at the INGEST producer's audit door.
 *
 * The author's own stated principle is "strip at the door because the value is
 * persisted". The Synapse harvests obeyed it (`uri: canonicalDatasetIdentity(
 * uri)`); `POST /api/lineage/openlineage` did not — it passed `edge.toUri`, the
 * RAW value from `datasetUri()`, which only lowercases. That URI is written to
 * the Cosmos audit document's `target` field and onto the SIEM stream, so a
 * SAS-bearing output dataset name that resolves to a foreign owner persisted
 * `sig=…` — the same store-a-credential defect, one door down.
 *
 * Both doors are now closed: the producer canonicalizes, AND
 * `auditCrossWorkspaceDenial` canonicalizes again at the sink, so no future
 * producer can reopen it. Each is mutation-verified independently below.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const auditRows: any[] = [];
const siemEvents: any[] = [];

const mocks = vi.hoisted(() => ({
  itemRows: vi.fn((_q: string) => ({ resources: [] as any[] })),
}));

vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: async () => ({
    items: { query: (s: any) => ({ fetchAll: async () => mocks.itemRows(String(s?.query || '')) }) },
  }),
  workspacesContainer: async () => ({
    items: { query: () => ({ fetchAll: async () => ({ resources: [{ id: 'ws-1', tenantId: 'owner-1' }] }) }) },
  }),
  auditLogContainer: async () => ({
    items: { create: async (d: any) => { auditRows.push(d); return { resource: d }; } },
  }),
}));
vi.mock('@/lib/admin/audit-stream', () => ({
  emitAuditEvent: (e: any) => { siemEvents.push(e); },
}));
vi.mock('@/lib/thread/thread-edges', () => ({ recordThreadEdge: vi.fn(async () => {}) }));

vi.mock('@/lib/azure/openlineage-auth', () => ({
  verifyOpenLineageAuth: async () => ({ ok: true, principal: 'pool-sp-1', workspaceId: 'ws-1' }),
}));
vi.mock('@/lib/azure/rate-limiter', () => ({ enforceRateLimitForKey: async () => null }));

import { NextRequest } from 'next/server';
import { POST } from '../route';
import { auditCrossWorkspaceDenial } from '@/lib/lineage/lineage-audit';

/** A real SAS on the OUTPUT dataset the event claims to have written. */
const SAS = 'sv=2024-11-04&ss=b&srt=sco&sp=rwdlac&sig=SUPERSECRETSIGNATURE';
const FOREIGN_ROOT = 'abfss://finance@stother.dfs.core.windows.net/payroll';

function runEvent() {
  return {
    eventType: 'COMPLETE',
    eventTime: '2026-07-28T00:00:00.000Z',
    producer: 'https://github.com/OpenLineage/OpenLineage',
    schemaURL: 'https://openlineage.io/spec/1-0-5/OpenLineage.json#/definitions/RunEvent',
    run: { runId: '11111111-2222-3333-4444-555555555555' },
    job: { namespace: 'spark', name: 'exfil' },
    inputs: [{ namespace: 'abfss://data@stloom.dfs.core.windows.net', name: '/bronze/x' }],
    // The forgery: an output naming ANOTHER workspace's root, with a SAS on it.
    outputs: [{ namespace: '', name: `${FOREIGN_ROOT}?${SAS}` }],
  };
}

function post(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/lineage/openlineage', {
    method: 'POST',
    headers: { authorization: 'Bearer x', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  auditRows.length = 0;
  siemEvents.length = 0;
  vi.clearAllMocks();
  mocks.itemRows.mockImplementation((q: string) =>
    // The forgery probe (`workspaceId != @w`) finds the foreign owner; the
    // in-workspace candidate load finds nothing.
    q.includes('!=')
      ? { resources: [{ id: 'lh-foreign', workspaceId: 'ws-2', itemType: 'lakehouse', displayName: 'Payroll', state: { adlsRoot: FOREIGN_ROOT } }] }
      : { resources: [] },
  );
});

describe('openlineage ingest: the denial audit must not persist the SAS', () => {
  // MUTATION: in the route, `uri: edge.toUri` in place of
  // `uri: canonicalDatasetIdentity(edge.toUri)` — AND revert the sink-side
  // strip in `auditCrossWorkspaceDenial` (both doors, since either alone
  // closes it; that redundancy is the point).
  // → observed: 2 failures — 'SUPERSECRETSIGNATURE' (lowercased) appears in
  //   the Cosmos audit row's `target` and in the SIEM event detail.
  it('403s the forged output and audits it', async () => {
    const r = await POST(post(runEvent()));
    expect(r.status).toBe(403);
    expect(auditRows).toHaveLength(1);
    expect(siemEvents).toHaveLength(1);
  });

  it('the persisted audit row carries NO signature', async () => {
    await POST(post(runEvent()));
    const blob = JSON.stringify(auditRows).toLowerCase();
    expect(blob).not.toContain('sig=');
    expect(blob).not.toContain('supersecret');
    // …and still carries the useful part: which asset was refused.
    expect(String(auditRows[0].target)).toContain('payroll');
  });

  it('the SIEM event carries NO signature', async () => {
    await POST(post(runEvent()));
    const blob = JSON.stringify(siemEvents).toLowerCase();
    expect(blob).not.toContain('sig=');
    expect(blob).not.toContain('supersecret');
  });
});

describe('the sink strips too — a future producer cannot reopen this', () => {
  // MUTATION: in `auditCrossWorkspaceDenial`, `target: opts.uri` and
  // `detail: { uri: opts.uri }` (i.e. trust the caller).
  // → observed: 2 failures — a caller that forgets to canonicalize leaks.
  it('canonicalizes a RAW uri handed to it directly', async () => {
    await auditCrossWorkspaceDenial({
      principal: 'p', producer: 'some-future-producer',
      authorizedWorkspaceId: 'ws-1', targetWorkspaceId: 'ws-2',
      uri: `${FOREIGN_ROOT}?${SAS}`, itemId: 'lh-foreign',
    });
    expect(JSON.stringify(auditRows).toLowerCase()).not.toContain('supersecret');
    expect(JSON.stringify(siemEvents).toLowerCase()).not.toContain('supersecret');
  });
});
