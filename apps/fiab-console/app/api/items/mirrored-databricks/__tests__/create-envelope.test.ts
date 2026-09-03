/**
 * POST /api/items/mirrored-databricks — create response envelope (#4183).
 *
 * Before the fix every failed pairing returned `ok:true`, so a caller that read
 * only the envelope learned "created and queryable" for a mirror that is
 * neither pairable nor queryable. The three prerequisite gates and the failed
 * provisioner now answer `ok:false, created:true` with a `gateId` the UI can
 * turn into a Fix-it (ux-baseline G2), while a genuine success is unchanged.
 *
 * The gate text is asserted for what it does NOT claim as much as for what it
 * does: `resolved.error` already names the variable databricksConfigGate()
 * actually found missing, so the route must not re-assert a hard-coded one
 * (deploy-integrity R7).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { resolveUcMirrorTables, createOwnedItem, synapseSqlPoolProvisioner, itemsCreate, itemsReplace } =
  vi.hoisted(() => ({
    resolveUcMirrorTables: vi.fn(),
    createOwnedItem: vi.fn(),
    synapseSqlPoolProvisioner: vi.fn(),
    itemsCreate: vi.fn(),
    itemsReplace: vi.fn(),
  }));

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/azure/databricks-uc-mirror', () => ({ resolveUcMirrorTables }));
vi.mock('@/app/api/items/_lib/item-crud', () => ({ createOwnedItem }));
vi.mock('@/lib/install/provisioners/synapse-serverless-sql-pool', () => ({ synapseSqlPoolProvisioner }));
vi.mock('@/lib/install/provisioning-engine', () => ({ resolveTarget: () => ({ kind: 'shared' }) }));
vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: async () => ({
    items: { create: itemsCreate },
    item: () => ({ replace: itemsReplace }),
  }),
  workspacesContainer: async () => ({
    item: () => ({ read: async () => ({ resource: { id: 'ws1', tenantId: 'u-oid' } }) }),
  }),
}));

import { POST } from '../route';
import { getSession } from '@/lib/auth/session';

function postReq(body: any) {
  return {
    nextUrl: { searchParams: new URLSearchParams('workspaceId=ws1') },
    json: async () => body,
  } as any;
}

const BODY = { displayName: 'Sales mirror', catalogName: 'sales' };

beforeEach(() => {
  vi.resetAllMocks();
  (getSession as any).mockReturnValue({ claims: { oid: 'u-oid', upn: 'u@x' } });
  itemsCreate.mockResolvedValue({ resource: { id: 'm1', workspaceId: 'ws1', state: {} } });
  itemsReplace.mockResolvedValue({});
  process.env.LOOM_SYNAPSE_WORKSPACE = 'syn-ws';
});

describe('POST /api/items/mirrored-databricks create envelope', () => {
  it('reports ok:false + created:true + gateId when Databricks is not configured', async () => {
    resolveUcMirrorTables.mockResolvedValue({
      ok: false,
      code: 'NO_DATABRICKS',
      error: 'Databricks workspace not configured (set LOOM_DATABRICKS_HOSTNAME).',
      tables: [],
      skipped: 0,
    });
    const res = await POST(postReq(BODY));
    const j = await res.json();
    // HTTP 200: the mirror item really was created, so a 4xx/5xx would
    // misdescribe the server's own outcome.
    expect(res.status).toBe(200);
    expect(j.ok).toBe(false);
    expect(j.created).toBe(true);
    expect(j.code).toBe('NO_DATABRICKS');
    expect(j.gateId).toBe('svc-databricks');
    expect(j.mirror?.id).toBe('m1');
    expect(j.pairing?.ok).toBe(false);
    // The message carries the variable the resolver actually found missing…
    expect(j.error).toContain('LOOM_DATABRICKS_HOSTNAME');
    // …and says an unset value is an opt-out or brownfield state, not a step
    // every install performs by hand (auto-bind-by-default).
    expect(j.error).toMatch(/opted out|brownfield/i);
  });

  it('does not re-assert a hard-coded variable when the resolver named a different one', async () => {
    resolveUcMirrorTables.mockResolvedValue({
      ok: false,
      code: 'NO_DATABRICKS',
      error: 'Databricks workspace not configured (set LOOM_DATABRICKS_TOKEN).',
      tables: [],
      skipped: 0,
    });
    const res = await POST(postReq(BODY));
    const j = await res.json();
    expect(j.error).toContain('LOOM_DATABRICKS_TOKEN');
    expect(j.error).not.toContain('LOOM_DATABRICKS_HOSTNAME');
  });

  it('reports ok:false + gateId svc-synapse when Synapse is not configured', async () => {
    delete process.env.LOOM_SYNAPSE_WORKSPACE;
    resolveUcMirrorTables.mockResolvedValue({
      ok: true, code: undefined, tables: [{ schema: 's', table: 't' }], skipped: 0,
    });
    const res = await POST(postReq(BODY));
    const j = await res.json();
    expect(j.ok).toBe(false);
    expect(j.created).toBe(true);
    expect(j.code).toBe('NO_SYNAPSE');
    expect(j.gateId).toBe('svc-synapse');
  });

  it('reports ok:false with NO gateId when the paired item create fails', async () => {
    resolveUcMirrorTables.mockResolvedValue({
      ok: true, tables: [{ schema: 's', table: 't' }], skipped: 0,
    });
    createOwnedItem.mockResolvedValue({ ok: false, error: 'quota exceeded' });
    const res = await POST(postReq(BODY));
    const j = await res.json();
    expect(j.ok).toBe(false);
    expect(j.created).toBe(true);
    expect(j.code).toBe('PAIR_CREATE_FAILED');
    expect(j.error).toBe('quota exceeded');
    // No registry entry for this code — the response must not name a gate that
    // would not resolve to a Fix-it (deploy-integrity R7).
    expect(j.gateId).toBeUndefined();
  });

  it('reports ok:false when the provisioner ran but did not reach created/exists', async () => {
    resolveUcMirrorTables.mockResolvedValue({
      ok: true, tables: [{ schema: 's', table: 't' }], skipped: 0,
    });
    createOwnedItem.mockResolvedValue({ ok: true, item: { id: 'p1' } });
    synapseSqlPoolProvisioner.mockResolvedValue({
      status: 'remediation', steps: [], gate: { remediation: 'grant Synapse SQL admin' },
    });
    const res = await POST(postReq(BODY));
    const j = await res.json();
    expect(j.ok).toBe(false);
    expect(j.created).toBe(true);
    expect(j.error).toBe('grant Synapse SQL admin');
  });

  it('positive control — a fully paired mirror still returns ok:true', async () => {
    resolveUcMirrorTables.mockResolvedValue({
      ok: true, tables: [{ schema: 's', table: 't' }], skipped: 0,
    });
    createOwnedItem.mockResolvedValue({ ok: true, item: { id: 'p1' } });
    synapseSqlPoolProvisioner.mockResolvedValue({
      status: 'created', steps: [],
      secondaryIds: { database: 'db', endpoint: 'ep', viewCount: 1 },
    });
    const res = await POST(postReq(BODY));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.created).toBe(true);
    expect(j.pairing?.ok).toBe(true);
    expect(j.mirror?.state?.sqlEndpoint).toBe('ep');
  });
});
