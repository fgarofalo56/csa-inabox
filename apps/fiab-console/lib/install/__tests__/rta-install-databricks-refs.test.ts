/**
 * Install-time regression guard for the RTA (app-azure-realtime-analytics) +
 * ml-pipeline bundles' `data-pipeline` items, plus the provisioner-level
 * Databricks linked-service normalization that fixes them.
 *
 * Root cause (fixed here): both bundles' data-pipeline items emit
 * `DatabricksNotebook` / `DatabricksSparkPython` activities with only
 * type-properties (notebookPath / pythonFile) and NO `linkedServiceName`. The
 * default Synapse-pipeline backend's dev-plane PUT rejects such an activity
 * with a schema-validation 400 whose body doesn't match the honest-gate regex,
 * so it fell through to a genuine, ungated `status:'failed'` on EVERY estate.
 *
 * The fix (lib/install/provisioners/_seed-dev-pipeline.ts) normalizes every
 * Databricks-family activity to carry a canonical linkedServiceName and either
 * (a) auto-stubs the AzureDatabricks linked service when Databricks is bound
 * (LOOM_DATABRICKS_HOSTNAME), or (b) returns a precise, honest remediation gate
 * when it isn't — NEVER a hard failure. This benefits ALL bundles routed
 * through the Synapse/ADF dev-pipeline seeder.
 *
 * No real Azure traffic — fetch + @azure/identity are stubbed (per the
 * neighboring pipeline-designer-provisioners.test.ts pattern).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { getBundle } from '@/lib/apps/content-bundles';
import { provisionerSupportsItemType } from '@/lib/install/provisioning-engine';
import {
  normalizePipelineContent,
  CANONICAL_DATABRICKS_LS,
} from '@/lib/install/provisioners/_seed-dev-pipeline';

vi.mock('@azure/identity', async () => {
  class Cred {
    async getToken() { return { token: 'test-token', expiresOnTimestamp: Date.now() + 3600_000 }; }
  }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

function captureFetch(router: (url: string, init?: RequestInit) => { status?: number; body?: any }) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchMock = vi.fn(async (url: any, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url.toString();
    calls.push({ url: u, init });
    const r = router(u, init) || { status: 200, body: {} };
    return new Response(JSON.stringify(r.body ?? {}), {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, calls };
}

const SYN_ENV = { LOOM_SUBSCRIPTION_ID: 'sub-x', LOOM_DLZ_RG: 'rg-x', LOOM_SYNAPSE_WORKSPACE: 'syn-x' };
const DBX_KEYS = [
  'LOOM_DATABRICKS_HOSTNAME', 'LOOM_DATABRICKS_WORKSPACE_URL',
  'LOOM_DATABRICKS_LINKED_SERVICE', 'LOOM_DATABRICKS_WORKSPACE_RESOURCE_ID',
];
function clearEnv() {
  for (const k of [...Object.keys(SYN_ENV), ...DBX_KEYS]) delete process.env[k];
}
beforeEach(() => { clearEnv(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); clearEnv(); });

const baseInput = (content: any, displayName: string) => ({
  session: { claims: { oid: 't', name: 'n', upn: 'u', groups: [] }, exp: 0 } as any,
  target: { mode: 'shared' as const, pipelineBackend: 'synapse' as const },
  cosmosItemId: 'c1',
  workspaceId: 'lw1',
  displayName,
  content,
  appId: 'app-azure-realtime-analytics',
});

/** Pull an item's { content, displayName } out of a bundle by itemType. */
async function itemOf(bundleId: string, itemType: string): Promise<{ content: any; displayName: string }> {
  const bundle = await getBundle(bundleId);
  const item = (bundle!.items || []).find((i: any) => i.itemType === itemType);
  if (!item) throw new Error(`no ${itemType} item in ${bundleId}`);
  return { content: (item as any).content, displayName: item.displayName };
}

// ── 1) Dispatch: every RTA item type maps to a registered provisioner ─────────
describe('RTA bundle install dispatch', () => {
  it('all 11 RTA items dispatch to a registered provisioner (none silently unhandled)', async () => {
    const bundle = await getBundle('app-azure-realtime-analytics');
    const items = bundle!.items || [];
    expect(items.length).toBe(11);
    for (const item of items) {
      expect(
        provisionerSupportsItemType(item.itemType),
        `item "${item.displayName}" (${item.itemType}) has no provisioner`,
      ).toBe(true);
    }
  });
});

// ── 2) The previously-failing data-pipeline item: honest gate vs created ──────
describe('data-pipeline Databricks linked-service fix (RTA + ml-pipeline)', () => {
  it('RTA "Daily Batch Processing Pipeline" → honest remediation gate (NOT failed) when no Databricks is bound', async () => {
    for (const [k, v] of Object.entries(SYN_ENV)) process.env[k] = v;
    // Default fetch would 200, but the gate must fire BEFORE any pipeline PUT.
    const { calls } = captureFetch(() => ({ status: 200, body: {} }));
    const { dataPipelineProvisioner } = await import('../provisioners/data-pipeline');
    const { content, displayName } = await itemOf('app-azure-realtime-analytics', 'data-pipeline');
    const r = await dataPipelineProvisioner(baseInput(content, displayName) as any);
    expect(r.status).toBe('remediation');
    expect(r.status).not.toBe('failed');
    expect(r.gate?.remediation).toMatch(/LOOM_DATABRICKS_HOSTNAME/);
    // No pipeline document was PUT (we gated before authoring it).
    expect(calls.some((c) => c.url.includes('/pipelines/') && c.init?.method === 'PUT')).toBe(false);
  });

  it('ml-pipeline "MLOps Orchestration Pipeline" → same honest gate (cross-app benefit)', async () => {
    for (const [k, v] of Object.entries(SYN_ENV)) process.env[k] = v;
    captureFetch(() => ({ status: 200, body: {} }));
    const { dataPipelineProvisioner } = await import('../provisioners/data-pipeline');
    const { content, displayName } = await itemOf('app-ml-pipeline', 'data-pipeline');
    const r = await dataPipelineProvisioner(baseInput(content, displayName) as any);
    expect(r.status).toBe('remediation');
    expect(r.status).not.toBe('failed');
    expect(r.gate?.remediation).toMatch(/LOOM_DATABRICKS_HOSTNAME/);
  });

  it('RTA data-pipeline installs (created) when Databricks IS bound — LS auto-stubbed + pipeline authored + run triggered', async () => {
    for (const [k, v] of Object.entries(SYN_ENV)) process.env[k] = v;
    process.env.LOOM_DATABRICKS_HOSTNAME = 'adb-1.2.azuredatabricks.net';
    const { calls } = captureFetch((u, init) => {
      if (u.includes('/createRun')) return { status: 200, body: { runId: 'rta-run-1' } };
      if (u.includes('/pipelineruns/')) return { status: 200, body: { runId: 'rta-run-1', status: 'InProgress' } };
      if (u.includes('/pipelines/') && init?.method === 'PUT') return { status: 200, body: { name: 'x' } };
      if (u.includes('/linkedservices/') && init?.method === 'PUT') return { status: 200, body: { name: 'ls' } };
      return { status: 200, body: {} };
    });
    const { dataPipelineProvisioner } = await import('../provisioners/data-pipeline');
    const { content, displayName } = await itemOf('app-azure-realtime-analytics', 'data-pipeline');
    const r = await dataPipelineProvisioner(baseInput(content, displayName) as any);
    expect(r.status).toBe('created');
    expect(r.secondaryIds?.lastRunId).toBe('rta-run-1');
    // The AzureDatabricks linked service was auto-authored before the pipeline PUT.
    const lsPut = calls.find((c) => c.url.includes('/linkedservices/') && c.init?.method === 'PUT');
    expect(lsPut, 'expected an AzureDatabricks linked-service PUT').toBeTruthy();
    expect(JSON.parse(lsPut!.init!.body as string).properties.type).toBe('AzureDatabricks');
    expect(calls.some((c) => c.url.includes('/pipelines/') && c.init?.method === 'PUT')).toBe(true);
  }, 20_000);
});

// ── 3) normalizePipelineContent unit behavior ─────────────────────────────────
describe('normalizePipelineContent', () => {
  it('injects a linkedServiceName on every Databricks-family activity without mutating the source', async () => {
    const { content: raw } = await itemOf('app-azure-realtime-analytics', 'data-pipeline');
    const { content, databricksLs } = normalizePipelineContent(raw);

    // Every Databricks* activity in the CLONE now carries a linkedServiceName…
    for (const a of content.activities) {
      if (String(a.type).startsWith('Databricks')) {
        expect(a.config.linkedServiceName?.referenceName).toBe(CANONICAL_DATABRICKS_LS);
        expect(a.config.linkedServiceName?.type).toBe('LinkedServiceReference');
      }
    }
    expect(databricksLs.has(CANONICAL_DATABRICKS_LS)).toBe(true);

    // …and the ORIGINAL bundle object is untouched (no cross-install leakage).
    for (const a of raw.activities) {
      if (String(a.type).startsWith('Databricks')) {
        expect(a.config.linkedServiceName).toBeUndefined();
      }
    }
  });

  it('normalizes the ml-pipeline DatabricksSparkPython + DatabricksNotebook mix', async () => {
    const { content: raw } = await itemOf('app-ml-pipeline', 'data-pipeline');
    const { content } = normalizePipelineContent(raw);
    const dbx = content.activities.filter((a: any) => String(a.type).startsWith('Databricks'));
    expect(dbx.length).toBeGreaterThanOrEqual(5);
    for (const a of dbx) {
      expect(a.config.linkedServiceName?.referenceName).toBe(CANONICAL_DATABRICKS_LS);
    }
  });

  it('honors an operator-registered linked service via LOOM_DATABRICKS_LINKED_SERVICE', async () => {
    process.env.LOOM_DATABRICKS_LINKED_SERVICE = 'MyExistingADB';
    const { content: raw } = await itemOf('app-azure-realtime-analytics', 'data-pipeline');
    const { databricksLs } = normalizePipelineContent(raw);
    expect(databricksLs.has('MyExistingADB')).toBe(true);
  });
});
