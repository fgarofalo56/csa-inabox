/**
 * ROUND-3 ROUTE SPEC — S3: attribution must gate DISCLOSURE, not only the write.
 *
 * Round 2 computed `batchBelongsToItem(item, job)` and passed it ONLY as
 * `attributed:` to the lineage harvest, then returned the whole `SparkBatchJob`
 * to any caller for any integer `?runId=`. Livy batch ids are POOL-scoped and
 * this estate runs one shared pool, so removing `?pool=` bounded nothing: the
 * response still carried another team's `livyInfo.jobCreationRequest` (their
 * argv + Spark conf — storage paths, and any SAS passed as a job argument),
 * their driver `log[]`, `errorInfo`, `submitterName` and `tags`.
 *
 * `batchBelongsToItem` itself was unit-tested; nothing asserted what the ROUTE
 * did with the answer. That is the gap these specs close.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const state = {
  item: null as any,
  job: null as any,
};

vi.mock('@/lib/auth/session', () => ({
  getSession: () => ({ claims: { oid: 'oid-1', upn: 'u@loom.test' } }),
}));

// `withWorkspaceOwner` resolves the item through the workspace guard; hand it
// the fixture and let the REAL route body run.
vi.mock('@/lib/api/route-toolkit', () => ({
  withWorkspaceOwner: (_type: string, fn: any) => (req: any, ctx: any) =>
    fn(req, {
      session: { claims: { oid: 'oid-1', upn: 'u@loom.test' } },
      params: ctx?.params instanceof Promise ? undefined : ctx?.params,
      item: state.item,
    }),
}));

const synapse = vi.hoisted(() => ({ getSparkBatchJob: vi.fn(async () => state.job) }));
vi.mock('@/lib/azure/synapse-dev-client', () => synapse);

const harvest = vi.hoisted(() => ({
  harvestSparkBatchLineage: vi.fn(async () => ({ ok: true, events: 0, written: 0, skipped: 0, denied: 0 })),
}));
vi.mock('@/lib/lineage/synapse-lineage-harvest', () => harvest);

import { GET, batchBelongsToItem, redactUnattributedBatch } from '../route';

const SECRET_ARG = 'abfss://finance@stother.dfs.core.windows.net/payroll?sig=SUPERSECRET';

function foreignJob() {
  return {
    id: 41,
    name: 'loom-Some_Other_Job-1700000000000',
    state: 'success',
    result: 'Succeeded',
    appId: 'app-1',
    submittedAt: '2026-07-01T00:00:00Z',
    sparkPoolName: 'loompool2',
    submitterName: 'someone.else@contoso.com',
    tags: { costCenter: 'FIN-9', project: 'payroll-migration' },
    log: ['stderr: reading ' + SECRET_ARG, 'stderr: wrote 12M rows'],
    errorInfo: [{ message: 'at ' + SECRET_ARG }],
    livyInfo: {
      currentState: 'success',
      jobCreationRequest: {
        args: ['--input', SECRET_ARG, '--output', 'abfss://finance@stother.dfs.core.windows.net/gold'],
        conf: { 'spark.hadoop.fs.azure.sas.finance.stother': 'sv=2024&sig=SUPERSECRET' },
      },
    },
  };
}

function req(): NextRequest {
  return new NextRequest('http://localhost/api/items/spark-job-definition/guid-1/runs/41');
}
const CTX = { params: { id: 'guid-1', runId: '41' } };

beforeEach(() => {
  vi.clearAllMocks();
  state.item = {
    id: 'guid-1', workspaceId: 'ws-1', itemType: 'spark-job-definition',
    displayName: 'My Job', state: { spec: { pool: 'loompool2' } },
  };
  state.job = foreignJob();
  synapse.getSparkBatchJob.mockImplementation(async () => state.job);
});

describe('spark run route: an unattributed pool-scoped batch is redacted', () => {
  // MUTATION: `job: attributed ? job : redactUnattributedBatch(job)`
  //        →  `job,`
  // → observed: 4 failures — the foreign job's argv, conf, driver log and
  //   submitter all appear in the response body.
  it('the batch is genuinely not this item\'s (the premise of the test)', () => {
    expect(batchBelongsToItem(state.item, state.job)).toBe(false);
  });

  it('never returns the other job\'s submitted arguments or conf', async () => {
    const r = await GET(req(), CTX as any);
    const body = JSON.stringify(await r.json());
    expect(body).not.toContain('SUPERSECRET');
    expect(body).not.toContain('payroll');
    expect(body).not.toContain('jobCreationRequest');
  });

  it('never returns the other job\'s driver log, errorInfo, tags or submitter', async () => {
    const r = await GET(req(), CTX as any);
    const body = JSON.stringify(await r.json());
    expect(body).not.toContain('someone.else@contoso.com');
    expect(body).not.toContain('FIN-9');
    expect(body).not.toContain('wrote 12M rows');
  });

  it('still reports status honestly, and SAYS it redacted', async () => {
    const r = await GET(req(), CTX as any);
    const j = await r.json();
    expect(r.status).toBe(200);
    expect(j.job.id).toBe(41);
    expect(j.job.state).toBe('success');
    expect(j.job.redacted).toBe(true);
    expect(String(j.job.redactedReason)).toMatch(/not submitted by this/i);
  });

  it('and still writes no lineage for it', async () => {
    await GET(req(), CTX as any);
    expect(harvest.harvestSparkBatchLineage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ attributed: false }),
    );
  });
});

describe('spark run route: the item\'s OWN batch is returned in full', () => {
  // The redaction must not be a blanket nerf — the Runs tab's log viewer is a
  // real feature and must keep working for the item that submitted the batch.
  it('returns livyInfo and the driver log for an attributed batch', async () => {
    state.job = { ...foreignJob(), name: 'loom-My_Job-1700000000000' };
    expect(batchBelongsToItem(state.item, state.job)).toBe(true);
    const r = await GET(req(), CTX as any);
    const j = await r.json();
    expect(j.job.livyInfo?.jobCreationRequest?.args).toBeTruthy();
    expect(j.job.log).toHaveLength(2);
    expect(j.job.redacted).toBeUndefined();
  });
});

describe('redactUnattributedBatch is an ALLOW-list', () => {
  // A deny-list would silently start disclosing any field added to
  // SparkBatchJob upstream. Assert the shape directly.
  it('exposes only scheduling facts', () => {
    const keys = Object.keys(redactUnattributedBatch(foreignJob() as any)).sort();
    expect(keys).toEqual([
      'appId', 'id', 'redacted', 'redactedReason', 'result', 'sparkPoolName', 'state', 'submittedAt',
    ]);
  });
});

describe('spark run route: `?pool=` cannot override the item\'s pool', () => {
  // The S3 remediation removed the override; nothing asserted it. Livy batches
  // are visible to anyone who can read the pool, so an override is a reach
  // into pools the item was never bound to.
  //
  // MUTATION: reintroduce
  //   const pool = req.nextUrl.searchParams.get('pool') || (item.state as any)?.spec?.pool;
  // → observed: 2 failures — getSparkBatchJob is called with 'other-teams-pool'.
  it('reads the item\'s spec.pool even when ?pool= is supplied', async () => {
    const r = new NextRequest('http://localhost/api/items/spark-job-definition/guid-1/runs/41?pool=other-teams-pool');
    const res = await GET(r, CTX as any);
    expect(synapse.getSparkBatchJob).toHaveBeenCalledWith('loompool2', 41);
    expect((await res.json()).pool).toBe('loompool2');
  });

  it('400s rather than falling back to ?pool= when spec.pool is unset', async () => {
    state.item = { ...state.item, state: { spec: {} } };
    const r = new NextRequest('http://localhost/api/items/spark-job-definition/guid-1/runs/41?pool=other-teams-pool');
    const res = await GET(r, CTX as any);
    expect(res.status).toBe(400);
    expect(synapse.getSparkBatchJob).not.toHaveBeenCalled();
  });
});
