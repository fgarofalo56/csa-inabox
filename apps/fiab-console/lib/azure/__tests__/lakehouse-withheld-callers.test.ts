/**
 * Callers of the lakehouse resolver that answer "no location" must say WHY.
 *
 * `resolveLakehouseStorage` withholds a location for two reasons that are not
 * "storage is not configured": `root-shared` (another lakehouse uses the same
 * directory; resolved on Admin > Readiness) and `root-unverified` (the other
 * lakehouses could not be read; retried). A caller that words either as "set
 * LOOM_*_URL" sends an operator to the wrong fix.
 *
 * This spec covers the callers with no route spec of their own:
 *   - GET /api/thread/lakehouse-delta-tables,
 *   - POST /api/items/loom-app-runtime/[id]/resources (through the REAL
 *     `attachLakehouseItemResource`),
 *   - `resolveIndexPlan` (the index-my-data wizard's plan).
 * (materialize-to-kql, promote-medallion and publishable-tables carry the same
 * assertion in their own route specs.)
 *
 * The resolver is replaced by a switchable stub; its withheld wording, the
 * fields helper and the error class are the REAL ones, so the text asserted is
 * the resolver module's own. Each `it` names the value that breaks it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

let RESOLUTION: any = { ok: false, reason: 'root-shared' };
vi.mock('@/lib/azure/lakehouse-abfss', async () => {
  const actual: any = await vi.importActual('@/lib/azure/lakehouse-abfss');
  return { ...actual, resolveLakehouseStorage: async () => RESOLUTION };
});

vi.mock('@/lib/auth/session', () => ({ getSession: () => ({ claims: { oid: 'oid-1', upn: 'u@x', tid: 't' } }) }));
vi.mock('@/app/api/items/_lib/item-crud', () => ({
  loadOwnedItem: async (id: string) => ({ id, displayName: 'Sales', workspaceId: 'ws-1', itemType: 'lakehouse' }),
}));
const scanLakehouseTables = vi.fn(async () => []);
vi.mock('@/lib/azure/synapse-catalog-client', () => ({ scanLakehouseTables: (...a: any[]) => scanLakehouseTables(...a) }));
vi.mock('@/lib/auth/item-access', () => ({
  resolveItemAccessByOid: async () => ({ item: { id: 'app-1', workspaceId: 'ws-1', state: {} }, canWrite: true }),
}));
const saveAppRuntime = vi.fn();
vi.mock('@/lib/apps/runtime-store', () => ({
  readAppRuntime: () => ({ resources: [], env: [] }),
  saveAppRuntime: (...a: any[]) => saveAppRuntime(...a),
  LOOM_APP_RUNTIME_TYPE: 'loom-app-runtime',
}));
vi.mock('@/lib/azure/copilot-orchestrator', () => ({
  resolveAoaiTarget: async () => ({ endpoint: 'https://aoai.example' }),
}));
vi.mock('@/lib/azure/search-index-client', () => ({ isSearchConfigured: () => true }));
vi.mock('@/lib/azure/resource-graph-coords', () => ({ discoverResourceCoordsByName: async () => null }));

import { GET as deltaTables } from '@/app/api/thread/lakehouse-delta-tables/route';
import { POST as attachResource } from '@/app/api/items/loom-app-runtime/[id]/resources/route';
import { resolveIndexPlan } from '@/lib/azure/index-my-data-plan';
import { LAKEHOUSE_SHARED_ROOTS_CHECK_TITLE } from '@/lib/admin/env-checks/lakehouse-shared-roots';
import { lakehouseStorageWithheldMessage } from '@/lib/azure/lakehouse-abfss';

const SHARED = { ok: false, reason: 'root-shared' };
const UNVERIFIED = { ok: false, reason: 'root-unverified' };
const NO_STORAGE = { ok: false, reason: 'no-storage' };

const deltaReq = () => new NextRequest('http://localhost/api/thread/lakehouse-delta-tables?fromId=lh-1');
const attachReq = () => new NextRequest('http://localhost/api/items/loom-app-runtime/app-1/resources', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ kind: 'lakehouse', itemId: 'lh-1', itemName: 'Sales' }),
});

let savedAccount: string | undefined;
beforeEach(() => {
  RESOLUTION = SHARED;
  scanLakehouseTables.mockClear();
  saveAppRuntime.mockClear();
  // The resources route offers the `lakehouse` kind only when an ADLS account
  // is configured; without it the request stops at that gate (503).
  savedAccount = process.env.LOOM_ADLS_ACCOUNT;
  process.env.LOOM_ADLS_ACCOUNT = 'dlzacct';
});
afterEach(() => {
  if (savedAccount === undefined) delete process.env.LOOM_ADLS_ACCOUNT;
  else process.env.LOOM_ADLS_ACCOUNT = savedAccount;
});

describe('GET /api/thread/lakehouse-delta-tables', () => {
  // FAILS IF root-shared is worded as the LOOM_*_URL gate, loses the readiness
  // check title, or loses the link; or if the lakehouse is scanned anyway.
  it('answers a shared storage root with the true reason and the readiness link', async () => {
    const j = await (await deltaTables(deltaReq())).json();
    expect(j.ok).toBe(false);
    expect(j.error).not.toContain('LOOM_');
    expect(j.error).toContain(LAKEHOUSE_SHARED_ROOTS_CHECK_TITLE);
    expect(j.fixHref).toBe('/admin/readiness');
    expect(scanLakehouseTables).not.toHaveBeenCalled();
  });

  // Paired positive: unconfigured storage keeps its own gate. FAILS IF every
  // null resolution is now worded as a withheld one.
  it('keeps the storage-configuration gate for no-storage', async () => {
    RESOLUTION = NO_STORAGE;
    const j = await (await deltaTables(deltaReq())).json();
    expect(j.error).toContain('LOOM_{BRONZE,SILVER,GOLD,LANDING}_URL');
    expect(j.fixHref).toBeUndefined();
  });
});

describe('POST /api/items/loom-app-runtime/[id]/resources (lakehouse item)', () => {
  // Before: the attach threw a plain Error and the route answered a generic 500
  // ("failed to attach resource"). FAILS IF the withheld reason is not carried
  // to the response (status 500, text without the check title, no link), or if
  // the app runtime is saved with the attach.
  it('answers a shared storage root with 409, the true reason and the readiness link', async () => {
    const res = await attachResource(attachReq(), { params: Promise.resolve({ id: 'app-1' }) });
    const j = await res.json();
    expect(res.status).toBe(409);
    expect(j.code).toBe('lakehouse_storage_withheld');
    expect(j.reason).toBe('root-shared');
    expect(j.error).toContain(LAKEHOUSE_SHARED_ROOTS_CHECK_TITLE);
    expect(j.error).not.toContain('LOOM_');
    expect(j.fixHref).toBe('/admin/readiness');
    expect(saveAppRuntime).not.toHaveBeenCalled();
  });

  // root-unverified is retried, so it carries no link. FAILS IF it gains one.
  it('answers root-unverified with its own wording and no link', async () => {
    RESOLUTION = UNVERIFIED;
    const j = await (await attachResource(attachReq(), { params: Promise.resolve({ id: 'app-1' }) })).json();
    expect(j.error).toContain(lakehouseStorageWithheldMessage('root-unverified')!);
    expect(j.fixHref).toBeUndefined();
  });
});

describe('resolveIndexPlan (lakehouse source)', () => {
  // FAILS IF the plan's connection gate says "not provisioned / set
  // LOOM_LANDING_URL" for a shared root, or drops the link the wizard renders.
  it('gates a shared storage root with the true reason and the readiness link', async () => {
    const plan = await resolveIndexPlan({ sourceType: 'lakehouse', itemId: 'lh-1', tenantId: 'oid-1' });
    expect(plan.connection).toBeNull();
    expect(plan.connectionGate).toContain(LAKEHOUSE_SHARED_ROOTS_CHECK_TITLE);
    expect(plan.connectionGate).not.toContain('LOOM_');
    expect(plan.connectionGateHref).toBe('/admin/readiness');
  });

  // Paired positive. FAILS IF no-storage loses its configuration text or
  // gains the readiness link.
  it('keeps the storage-configuration gate for no-storage', async () => {
    RESOLUTION = NO_STORAGE;
    const plan = await resolveIndexPlan({ sourceType: 'lakehouse', itemId: 'lh-1', tenantId: 'oid-1' });
    expect(plan.connectionGate).toContain('LOOM_LANDING_URL');
    expect(plan.connectionGateHref).toBeNull();
  });
});
