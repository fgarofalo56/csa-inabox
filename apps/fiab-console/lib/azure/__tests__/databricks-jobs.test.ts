/**
 * Contract tests for the Databricks Jobs API 2.1 client functions that back
 * the DatabricksJobEditor: list / get / create / update(reset) / delete /
 * run-now / runs-list / run-get / run-get-output, plus the honest infra gate
 * (LOOM_DATABRICKS_HOSTNAME unset).
 *
 * Per .claude/rules/no-vaporware.md these assert the EXACT REST URL + payload
 * the client sends to the real workspace — no behaviour is faked beyond
 * stubbing global.fetch + the AAD credential.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'STUB.TOKEN', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return {
    DefaultAzureCredential: Cred,
    ManagedIdentityCredential: Cred,
    ChainedTokenCredential: Cred,
  };
});

import {
  listJobs, getJob, createJob, updateJob, deleteJob,
  runJob, listJobRuns, listJobRunsPage, JOB_RUNS_PAGE_MAX, getJobRun, getRunOutput,
} from '../databricks-client';

const realFetch = global.fetch;
const HOST = 'adb-123.19.azuredatabricks.net';

function mockFetch(handler: (url: string, init?: RequestInit) => any) {
  global.fetch = vi.fn(async (url: any, init?: any) => {
    const body = await handler(String(url), init);
    if (body instanceof Response) return body;
    const status = body?._status || 200;
    return new Response(JSON.stringify(body), { status });
  }) as any;
}

beforeEach(() => { process.env.LOOM_DATABRICKS_HOSTNAME = HOST; });
afterEach(() => { global.fetch = realFetch; delete process.env.LOOM_DATABRICKS_HOSTNAME; });

describe('listJobs', () => {
  it('GETs /api/2.1/jobs/list and returns the jobs array', async () => {
    let url = '';
    mockFetch((u) => { url = u; return { jobs: [{ job_id: 7, settings: { name: 'etl' } }] }; });
    const jobs = await listJobs(100);
    expect(url).toBe(`https://${HOST}/api/2.1/jobs/list?limit=100&expand_tasks=false`);
    expect(jobs[0].job_id).toBe(7);
  });
});

describe('getJob', () => {
  it('GETs /api/2.1/jobs/get?job_id=', async () => {
    let url = '';
    mockFetch((u) => { url = u; return { job_id: 7, settings: { name: 'etl', tasks: [] } }; });
    const job = await getJob(7);
    expect(url).toBe(`https://${HOST}/api/2.1/jobs/get?job_id=7`);
    expect(job.settings?.name).toBe('etl');
  });
});

describe('createJob', () => {
  it('POSTs /api/2.1/jobs/create with the spec body and returns job_id', async () => {
    let url = ''; let body: any;
    mockFetch((u, init) => { url = u; body = JSON.parse((init?.body as string) || '{}'); return { job_id: 42 }; });
    const spec = {
      name: 'multi',
      tasks: [
        { task_key: 'a', existing_cluster_id: 'c1', notebook_task: { notebook_path: '/Workspace/a' } },
        { task_key: 'b', existing_cluster_id: 'c1', spark_python_task: { python_file: 'dbfs:/b.py' }, depends_on: [{ task_key: 'a' }] },
      ],
      max_concurrent_runs: 1,
    };
    const r = await createJob(spec);
    expect(url).toBe(`https://${HOST}/api/2.1/jobs/create`);
    expect(body.name).toBe('multi');
    expect(body.tasks).toHaveLength(2);
    expect(body.tasks[1].depends_on[0].task_key).toBe('a');
    expect(r.job_id).toBe(42);
  });
});

describe('updateJob (reset)', () => {
  it('POSTs /api/2.1/jobs/reset with job_id + new_settings', async () => {
    let url = ''; let body: any;
    mockFetch((u, init) => { url = u; body = JSON.parse((init?.body as string) || '{}'); return {}; });
    await updateJob(42, { name: 'renamed', tasks: [] });
    expect(url).toBe(`https://${HOST}/api/2.1/jobs/reset`);
    expect(body.job_id).toBe(42);
    expect(body.new_settings.name).toBe('renamed');
  });
});

describe('deleteJob', () => {
  it('POSTs /api/2.1/jobs/delete with job_id', async () => {
    let url = ''; let body: any;
    mockFetch((u, init) => { url = u; body = JSON.parse((init?.body as string) || '{}'); return {}; });
    await deleteJob(42);
    expect(url).toBe(`https://${HOST}/api/2.1/jobs/delete`);
    expect(body.job_id).toBe(42);
  });
});

describe('runJob (run-now param shaping)', () => {
  it('POSTs /api/2.1/jobs/run-now with just job_id when no params', async () => {
    let url = ''; let body: any;
    mockFetch((u, init) => { url = u; body = JSON.parse((init?.body as string) || '{}'); return { run_id: 100 }; });
    const r = await runJob(42);
    expect(url).toBe(`https://${HOST}/api/2.1/jobs/run-now`);
    expect(body).toEqual({ job_id: 42 });
    expect(r.run_id).toBe(100);
  });

  it('treats a bare Record<string,string> as notebook_params (back-compat)', async () => {
    let body: any;
    mockFetch((_, init) => { body = JSON.parse((init?.body as string) || '{}'); return { run_id: 1 }; });
    await runJob(42, { region: 'eus' });
    expect(body).toEqual({ job_id: 42, notebook_params: { region: 'eus' } });
  });

  it('passes shaped run-now params through verbatim', async () => {
    let body: any;
    mockFetch((_, init) => { body = JSON.parse((init?.body as string) || '{}'); return { run_id: 1 }; });
    await runJob(42, {
      job_parameters: { env: 'prod' },
      python_params: ['--flag', 'x'],
      dbt_commands: ['dbt run'],
    });
    expect(body.job_id).toBe(42);
    expect(body.job_parameters).toEqual({ env: 'prod' });
    expect(body.python_params).toEqual(['--flag', 'x']);
    expect(body.dbt_commands).toEqual(['dbt run']);
    // No accidental notebook_params wrapping for shaped input.
    expect(body.notebook_params).toBeUndefined();
  });
});

describe('listJobRuns', () => {
  it('GETs /api/2.1/jobs/runs/list?job_id=&limit=', async () => {
    let url = '';
    mockFetch((u) => { url = u; return { runs: [{ run_id: 5, state: { result_state: 'SUCCESS' } }] }; });
    const runs = await listJobRuns(42, 25);
    expect(url).toContain('/api/2.1/jobs/runs/list?');
    expect(url).toContain('job_id=42');
    expect(url).toContain('limit=25');
    expect(url).toContain('expand_tasks=false');
    expect(runs[0].run_id).toBe(5);
  });

  /**
   * GHSA-v2g8-gp3r-rg4r. `items/databricks-notebook/[id]/runs` scopes the shared
   * workspace's run history down to THIS notebook's runs, and the only
   * coordinate that attributes a run to a notebook is
   * `tasks[].notebook_task.notebook_path` — which Databricks omits unless
   * `expand_tasks=true`. If this parameter stops being sent, every run becomes
   * unattributable and the route (which fails closed) returns an EMPTY history
   * for a legitimate owner. Asserted on the real URL, not on a mock of this
   * function, because the route-level suite mocks this module wholesale and so
   * cannot see the wire contract.
   */
  it('requests expand_tasks=true when asked — the notebook run scope depends on it', async () => {
    let url = '';
    mockFetch((u) => { url = u; return { runs: [] }; });
    await listJobRunsPage({ expandTasks: true, limit: JOB_RUNS_PAGE_MAX });
    expect(url).toContain('expand_tasks=true');
    expect(url).toContain(`limit=${JOB_RUNS_PAGE_MAX}`);
    expect(url).not.toContain('job_id=');
  });

  /**
   * Jobs 2.1 documents `runs/list` limit as "greater than 0 and less than 25".
   * The first version of the notebook run-scope fix asked for `limit=200`,
   * which the workspace either 400s (route dead for everyone) or clamps to 25 —
   * and on a busy shared workspace those 25 can all be foreign runs, which the
   * route then filters away, handing the owner an EMPTY history. The cap is
   * enforced HERE so no caller can reintroduce it.
   */
  it('clamps limit to the documented per-request maximum', async () => {
    let url = '';
    mockFetch((u) => { url = u; return { runs: [] }; });
    await listJobRunsPage({ limit: 200 });
    expect(url).toContain(`limit=${JOB_RUNS_PAGE_MAX}`);
    expect(url).not.toContain('limit=200');
  });

  it('threads page_token and returns next_page_token so a caller can page', async () => {
    let url = '';
    mockFetch((u) => { url = u; return { runs: [{ run_id: 1 }], next_page_token: 'tok2' }; });
    const page = await listJobRunsPage({ pageToken: 'tok1' });
    expect(url).toContain('page_token=tok1');
    expect(page.nextPageToken).toBe('tok2');
    expect(page.runs[0].run_id).toBe(1);
  });
});

describe('getJobRun', () => {
  it('GETs /api/2.1/jobs/runs/get?run_id=', async () => {
    let url = '';
    mockFetch((u) => { url = u; return { run_id: 5, state: { life_cycle_state: 'TERMINATED', result_state: 'SUCCESS' } }; });
    const run = await getJobRun(5);
    expect(url).toBe(`https://${HOST}/api/2.1/jobs/runs/get?run_id=5`);
    expect(run.state?.result_state).toBe('SUCCESS');
  });
});

describe('getRunOutput', () => {
  it('GETs /api/2.1/jobs/runs/get-output?run_id= and returns output', async () => {
    let url = '';
    mockFetch((u) => { url = u; return { notebook_output: { result: 'done' }, logs: 'stdout…' }; });
    const out = await getRunOutput(5);
    expect(url).toBe(`https://${HOST}/api/2.1/jobs/runs/get-output?run_id=5`);
    expect(out.notebook_output?.result).toBe('done');
    expect(out.logs).toBe('stdout…');
  });
});

describe('honest infra gate — LOOM_DATABRICKS_HOSTNAME unset', () => {
  it('throws a precise "not configured" error so the BFF can surface a gate', async () => {
    delete process.env.LOOM_DATABRICKS_HOSTNAME;
    mockFetch(() => ({ jobs: [] }));
    await expect(listJobs()).rejects.toThrow(/LOOM_DATABRICKS_HOSTNAME not configured/);
  });
});
