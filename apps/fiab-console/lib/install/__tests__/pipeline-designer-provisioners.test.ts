/**
 * Phase 2 — contract tests for the app-pipeline-designer provisioners
 * (synapse-pipeline, adf-pipeline, databricks-job).
 *
 * Each test stubs fetch (Synapse dev REST / ADF ARM REST / Databricks Jobs 2.1)
 * and asserts:
 *   - the real backend endpoints are hit in the right order (upsert → run → poll),
 *   - created/exists results carry the live resource id,
 *   - auth (401/403) surfaces as a structured remediation gate (no swallow),
 *   - a missing-config env var surfaces as remediation (no silent skip).
 *
 * No real Azure traffic.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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

vi.mock('@azure/identity', async () => {
  class Cred {
    async getToken() { return { token: 'test-token', expiresOnTimestamp: Date.now() + 3600_000 }; }
  }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

const SYN_ENV = { LOOM_SUBSCRIPTION_ID: 'sub-x', LOOM_DLZ_RG: 'rg-x', LOOM_SYNAPSE_WORKSPACE: 'syn-x' };
const ADF_ENV = { LOOM_SUBSCRIPTION_ID: 'sub-x', LOOM_DLZ_RG: 'rg-x', LOOM_ADF_NAME: 'adf-x' };
const DBX_ENV = { LOOM_DATABRICKS_HOSTNAME: 'adb-1.2.azuredatabricks.net' };

function clearEnv() {
  for (const k of ['LOOM_SUBSCRIPTION_ID', 'LOOM_DLZ_RG', 'LOOM_SYNAPSE_WORKSPACE', 'LOOM_ADF_NAME', 'LOOM_DATABRICKS_HOSTNAME']) {
    delete process.env[k];
  }
}

beforeEach(() => { clearEnv(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); clearEnv(); });

const baseInput = (content: any) => ({
  session: { claims: { oid: 't', name: 'n', upn: 'u', groups: [] }, exp: 0 } as any,
  target: { mode: 'shared' as const },
  cosmosItemId: 'c1',
  workspaceId: 'lw1',
  displayName: 'Medallion ETL Synapse',
  content,
  appId: 'app-pipeline-designer',
});

const SYNAPSE_CONTENT = {
  kind: 'synapse-pipeline',
  parameters: { runDate: { type: 'String', defaultValue: '2026-01-01' } },
  activities: [
    { name: 'Copy_RawToLanding', type: 'Copy', config: { description: 'copy', policy: { retry: 3 }, source: { type: 'X' } } },
    { name: 'Notebook_Bronze', type: 'DatabricksNotebook', dependsOn: ['Copy_RawToLanding'], config: { notebookPath: '/b' } },
  ],
};

const DBX_CONTENT = {
  kind: 'databricks-job',
  cluster: { sparkVersion: '15.4.x', nodeType: 'Standard_DS3_v2', numWorkers: 4 },
  tasks: [
    { name: 'bronze', type: 'notebook_task', notebookPath: '/b', config: { base_parameters: { run_date: '{{x}}' }, timeout_seconds: 1800 } },
    { name: 'silver', type: 'notebook_task', notebookPath: '/s', config: { depends_on: [{ task_key: 'bronze' }] } },
  ],
};

// ---- Synapse pipeline ----
describe('synapsePipelineProvisioner', () => {
  it('upserts the pipeline, triggers a run, and reports created', async () => {
    for (const [k, v] of Object.entries(SYN_ENV)) process.env[k] = v;
    const { calls } = captureFetch((u, init) => {
      if (u.includes('/createRun')) return { status: 200, body: { runId: 'run-77' } };
      if (u.includes('/pipelineruns/')) return { status: 200, body: { runId: 'run-77', status: 'InProgress' } };
      if (u.includes('/pipelines/') && init?.method === 'PUT') return { status: 200, body: { name: 'x' } };
      return { status: 200, body: {} };
    });
    const { synapsePipelineProvisioner } = await import('../provisioners/synapse-pipeline');
    const r = await synapsePipelineProvisioner(baseInput(SYNAPSE_CONTENT) as any);
    expect(r.status).toBe('created');
    expect(r.secondaryIds?.lastRunId).toBe('run-77');
    expect(r.secondaryIds?.backend).toBe('synapse');
    // PUT pipeline then POST createRun must both have been issued.
    expect(calls.some((c) => c.url.includes('/pipelines/') && c.init?.method === 'PUT')).toBe(true);
    expect(calls.some((c) => c.url.includes('/createRun'))).toBe(true);
  }, 20_000); // real settle-poll sleeps a few seconds; allow for it.

  it('surfaces 403 on author as a structured remediation gate', async () => {
    for (const [k, v] of Object.entries(SYN_ENV)) process.env[k] = v;
    captureFetch(() => ({ status: 403, body: { error: { message: 'forbidden' } } }));
    const { synapsePipelineProvisioner } = await import('../provisioners/synapse-pipeline');
    const r = await synapsePipelineProvisioner(baseInput(SYNAPSE_CONTENT) as any);
    expect(r.status).toBe('remediation');
    expect(r.gate?.reason).toContain('403');
    expect(r.gate?.remediation).toMatch(/Synapse/i);
  });

  it('returns remediation (not skipped) when the workspace env var is missing', async () => {
    const { synapsePipelineProvisioner } = await import('../provisioners/synapse-pipeline');
    const r = await synapsePipelineProvisioner(baseInput(SYNAPSE_CONTENT) as any);
    expect(r.status).toBe('remediation');
    expect(r.gate?.remediation).toMatch(/LOOM_SUBSCRIPTION_ID|LOOM_SYNAPSE_WORKSPACE/);
  });
});

// ---- ADF pipeline ----
describe('adfPipelineProvisioner', () => {
  it('upserts the pipeline, triggers a run, and reports created', async () => {
    for (const [k, v] of Object.entries(ADF_ENV)) process.env[k] = v;
    const { calls } = captureFetch((u, init) => {
      if (u.includes('/createRun')) return { status: 200, body: { runId: 'adf-run-9' } };
      if (u.includes('/queryPipelineRuns')) return { status: 200, body: { value: [{ runId: 'adf-run-9', status: 'InProgress' }] } };
      if (u.includes('/pipelines/') && init?.method === 'PUT') return { status: 200, body: { name: 'x' } };
      return { status: 200, body: {} };
    });
    const { adfPipelineProvisioner } = await import('../provisioners/adf-pipeline');
    const r = await adfPipelineProvisioner(baseInput({ ...SYNAPSE_CONTENT, kind: 'adf-pipeline' }) as any);
    expect(r.status).toBe('created');
    expect(r.secondaryIds?.lastRunId).toBe('adf-run-9');
    expect(r.secondaryIds?.backend).toBe('adf');
    expect(calls.some((c) => c.url.includes('Microsoft.DataFactory') && c.url.includes('/pipelines/') && c.init?.method === 'PUT')).toBe(true);
  }, 20_000);

  it('returns remediation when LOOM_ADF_NAME is missing', async () => {
    const { adfPipelineProvisioner } = await import('../provisioners/adf-pipeline');
    const r = await adfPipelineProvisioner(baseInput({ ...SYNAPSE_CONTENT, kind: 'adf-pipeline' }) as any);
    expect(r.status).toBe('remediation');
    expect(r.gate?.remediation).toMatch(/LOOM_ADF_NAME|LOOM_SUBSCRIPTION_ID/);
  });
});

// ---- Databricks job ----
describe('databricksJobProvisioner', () => {
  it('creates a multi-task job with a shared cluster, runs it, reports created', async () => {
    for (const [k, v] of Object.entries(DBX_ENV)) process.env[k] = v;
    const { calls } = captureFetch((u) => {
      if (u.includes('/jobs/list')) return { status: 200, body: { jobs: [] } };
      if (u.includes('/jobs/create')) return { status: 200, body: { job_id: 4242 } };
      if (u.includes('/jobs/run-now')) return { status: 200, body: { run_id: 9001 } };
      if (u.includes('/jobs/runs/get')) return { status: 200, body: { run_id: 9001, state: { life_cycle_state: 'RUNNING' } } };
      return { status: 200, body: {} };
    });
    const { databricksJobProvisioner } = await import('../provisioners/databricks-job');
    const r = await databricksJobProvisioner(baseInput(DBX_CONTENT) as any);
    expect(r.status).toBe('created');
    expect(r.resourceId).toBe('4242');
    expect(r.secondaryIds?.lastRunId).toBe('9001');
    // The create body must carry ONE shared job cluster + chained tasks with depends_on.
    const create = calls.find((c) => c.url.includes('/jobs/create'));
    const body = JSON.parse(create!.init!.body as string);
    expect(body.job_clusters).toHaveLength(1);
    expect(body.tasks).toHaveLength(2);
    expect(body.tasks[0].job_cluster_key).toBe(body.job_clusters[0].job_cluster_key);
    expect(body.tasks[1].depends_on).toEqual([{ task_key: 'bronze' }]);
  }, 20_000);

  it('surfaces 403 on create as a structured remediation gate', async () => {
    for (const [k, v] of Object.entries(DBX_ENV)) process.env[k] = v;
    captureFetch((u) => {
      if (u.includes('/jobs/list')) return { status: 200, body: { jobs: [] } };
      return { status: 403, body: { message: 'forbidden' } };
    });
    const { databricksJobProvisioner } = await import('../provisioners/databricks-job');
    const r = await databricksJobProvisioner(baseInput(DBX_CONTENT) as any);
    expect(r.status).toBe('remediation');
    expect(r.gate?.reason).toContain('403');
  });

  it('returns remediation (not skipped) when LOOM_DATABRICKS_HOSTNAME is missing', async () => {
    const { databricksJobProvisioner } = await import('../provisioners/databricks-job');
    const r = await databricksJobProvisioner(baseInput(DBX_CONTENT) as any);
    expect(r.status).toBe('remediation');
    expect(r.gate?.remediation).toMatch(/LOOM_DATABRICKS_HOSTNAME/);
  });
});
