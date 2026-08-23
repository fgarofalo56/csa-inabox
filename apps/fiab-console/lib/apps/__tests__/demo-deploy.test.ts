/**
 * #3905 — the demo deploy must never report ACCEPTANCE as COMPLETION.
 *
 * The defect: `runDemoDeploy` set a sub-install to `status:'done'` the moment
 * POST /api/apps/{id}/install handed back a `jobId` — before provisioning had
 * started — and rolled that up to `status:'done', percentComplete:100`. Nothing
 * ever re-read `installJobId`. The banner rendered "14/14 apps installed · done"
 * over empty lakehouses.
 *
 * The REGRESSION TEST for that is the first one below: a fake install API that
 * hands back a jobId for every app and then reports a job that NEVER reaches a
 * terminal state. Before the fix that run ends `done` at 100% with 14 apps
 * "installed"; after it, every entry is `unknown`, the rollup is `partial`, and
 * the headline the banner would render is not "14/14 apps installed".
 *
 * The other cases cover each terminal state, a mixed run, the two ways
 * confirmation is LOST (a job that stops advancing, a job doc that never
 * appears), and the invariant that binds them: no flush, at any point in the
 * run, writes `status:'done'` while an app is still unresolved.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@/lib/azure/cosmos-client', () => ({ appInstallJobsContainer: vi.fn() }));

import { createDemoJob, runDemoDeploy, SHOWCASE_APPS, type PersistedDemoJob } from '../demo-deploy';
import { summarizeDemoSubJobs, type DemoSubJob } from '../demo-deploy-status';
import { appInstallJobsContainer } from '@/lib/azure/cosmos-client';

const OID = 'tenant-oid';
const TOTAL = SHOWCASE_APPS.length;

/** Every budget in milliseconds so the REAL loop runs, just fast. */
const FAST = { dispatchSpacingMs: 0, rateLimitBackoffMs: 0, pollIntervalMs: 1, pollBudgetMs: 250, stallMs: 100_000 };

type Outcome = 'running' | 'done' | 'partial' | 'failed' | 'no-job' | 'no-doc';

interface Harness {
  docs: Map<string, any>;
  /** Every demo-job doc written, in order — the progress history. */
  history: PersistedDemoJob[];
}

function jsonRes(body: unknown, status = 200): Response {
  return { status, ok: status < 400, json: async () => body } as unknown as Response;
}

function wireCosmos(): Harness {
  const docs = new Map<string, any>();
  const history: PersistedDemoJob[] = [];
  (appInstallJobsContainer as any).mockResolvedValue({
    items: {
      create: async (doc: any) => { docs.set(doc.id, structuredClone(doc)); return { resource: doc }; },
    },
    item: (id: string) => ({
      read: async () => ({ resource: docs.has(id) ? structuredClone(docs.get(id)) : undefined }),
      replace: async (doc: any) => {
        docs.set(doc.id, structuredClone(doc));
        if (doc.appId === 'demo-environment') history.push(structuredClone(doc));
        return { resource: doc };
      },
    }),
  });
  return { docs, history };
}

const installJobIdFor = (appId: string) => `ij-${appId}`;

function installJobDoc(appId: string, status: Exclude<Outcome, 'no-job' | 'no-doc'>) {
  return {
    id: installJobIdFor(appId), tenantId: OID, appId,
    status, phase: status === 'running' ? 'provisioning' : 'done',
    percentComplete: status === 'running' ? 40 : 100,
    updatedAt: '2026-08-22T00:00:00.000Z',
    ...(status === 'failed' ? { error: 'ADLS write denied for the install identity' } : {}),
  };
}

/**
 * Fake same-origin API: workspaces find-or-create + the install kickoff. The
 * install ACCEPTS (202 + jobId) and writes an install job doc whose status is
 * whatever the plan says — exactly the shape the real route produces.
 */
function wireFetch(h: Harness, plan: Partial<Record<string, Outcome>>, dflt: Outcome) {
  let wsSeq = 0;
  const fetchMock = vi.fn(async (url: any, init?: any) => {
    const u = String(url);
    if (/\/api\/workspaces$/.test(u)) {
      if (!init?.method) return jsonRes({ workspaces: [] });
      return jsonRes({ id: `ws-${++wsSeq}` });
    }
    const m = /\/api\/apps\/([^/]+)\/install$/.exec(u);
    if (m) {
      const appId = decodeURIComponent(m[1]);
      const outcome: Outcome = plan[appId] ?? dflt;
      if (outcome === 'no-job') return jsonRes({ ok: false, error: 'install refused: provisioner unavailable' }, 500);
      if (outcome !== 'no-doc') h.docs.set(installJobIdFor(appId), installJobDoc(appId, outcome));
      return jsonRes({ ok: true, jobId: installJobIdFor(appId) }, 202);
    }
    return jsonRes({});
  });
  (globalThis as any).fetch = fetchMock;
  return fetchMock;
}

async function deploy(timing: Partial<typeof FAST> = {}): Promise<{ final: PersistedDemoJob; jobId: string }> {
  const jobId = await createDemoJob(OID, 'tester@example.test');
  await runDemoDeploy({ jobId, tenantId: OID, cookie: 'loom_session=x', origin: 'http://localhost', timing: { ...FAST, ...timing } });
  const jobs = await (appInstallJobsContainer as any)();
  const { resource } = await jobs.item(jobId, OID).read();
  return { final: resource as PersistedDemoJob, jobId };
}

const byStatus = (sub: DemoSubJob[] | undefined, s: string) => (sub || []).filter((x) => x.status === s);

const realFetch = globalThis.fetch;
beforeEach(() => { vi.resetAllMocks(); });
afterEach(() => { (globalThis as any).fetch = realFetch; });

describe('runDemoDeploy — REGRESSION: a jobId is not an installation (#3905)', () => {
  it('14 accepted installs that never reach terminal roll up UNKNOWN — never done, never 14/14', async () => {
    const h = wireCosmos();
    wireFetch(h, {}, 'running');                  // every job doc stays `running` forever
    const { final } = await deploy({ pollBudgetMs: 120, stallMs: 100_000 });

    // The rollup the product persists.
    expect(final.status).not.toBe('done');
    expect(final.status).toBe('partial');
    expect(final.createdItems).toBe(0);
    expect(final.demoSummary?.succeeded).toBe(0);
    expect(final.demoSummary?.unknown).toBe(TOTAL);
    expect(final.demoSummary?.allSucceeded).toBe(false);

    // Every app: dispatched, tracked, and honestly unconfirmed.
    expect(byStatus(final.subJobs, 'unknown')).toHaveLength(TOTAL);
    expect(byStatus(final.subJobs, 'succeeded')).toHaveLength(0);
    for (const s of final.subJobs || []) {
      expect(s.installJobId).toBe(installJobIdFor(s.appId));
      expect(s.detail).toMatch(/not confirmed within the \d+s confirmation budget/);
    }

    // The exact claim the banner would render.
    expect(summarizeDemoSubJobs(final.subJobs).headline).toBe(`0/${TOTAL} installed · ${TOTAL} unconfirmed`);
    expect(summarizeDemoSubJobs(final.subJobs).headline).not.toBe(`${TOTAL}/${TOTAL} apps installed`);

    // INVARIANT: no intermediate flush ever claimed completion either.
    expect(h.history.filter((d) => d.status === 'done')).toHaveLength(0);
    expect(h.history.every((d) => (d.createdItems ?? 0) === 0)).toBe(true);
  });

  it('re-reads installJobId after dispatch — the poll actually happens', async () => {
    const h = wireCosmos();
    wireFetch(h, {}, 'running');
    const reads: string[] = [];
    const inner = await (appInstallJobsContainer as any)();
    const origItem = inner.item;
    inner.item = (id: string, pk: string) => { reads.push(id); return origItem(id, pk); };

    await deploy({ pollBudgetMs: 60, stallMs: 100_000 });
    for (const [appId] of SHOWCASE_APPS) {
      expect(reads.filter((r) => r === installJobIdFor(appId)).length).toBeGreaterThan(0);
    }
  });
});

describe('runDemoDeploy — terminal states', () => {
  it('every install terminal `done` → done, 14/14, and only then', async () => {
    const h = wireCosmos();
    wireFetch(h, {}, 'done');
    const { final } = await deploy();

    expect(final.status).toBe('done');
    expect(final.createdItems).toBe(TOTAL);
    expect(final.percentComplete).toBe(100);
    expect(byStatus(final.subJobs, 'succeeded')).toHaveLength(TOTAL);
    expect(final.subJobs?.every((s) => s.installStatus === 'done')).toBe(true);
    expect(summarizeDemoSubJobs(final.subJobs).headline).toBe(`${TOTAL}/${TOTAL} apps installed`);
  });

  it('every install terminal `failed` → failed, with the job\'s own error carried through', async () => {
    const h = wireCosmos();
    wireFetch(h, {}, 'failed');
    const { final } = await deploy();

    expect(final.status).toBe('failed');
    expect(final.createdItems).toBe(0);
    expect(byStatus(final.subJobs, 'failed')).toHaveLength(TOTAL);
    expect(final.subJobs?.[0].error).toMatch(/ADLS write denied/);
  });

  it('every install terminal `partial` → partial, NOT counted as installed', async () => {
    const h = wireCosmos();
    wireFetch(h, {}, 'partial');
    const { final } = await deploy();

    expect(final.status).toBe('partial');
    expect(final.createdItems).toBe(0);
    expect(byStatus(final.subJobs, 'partial')).toHaveLength(TOTAL);
    expect(final.demoSummary?.succeeded).toBe(0);
  });

  it('MIXED run reports the REAL per-outcome counts', async () => {
    const h = wireCosmos();
    wireFetch(h, {
      'app-supercharge-bronze': 'failed',
      'app-supercharge-silver': 'partial',
      'app-supercharge-gold': 'running',     // never terminal → unknown
      'app-direct-lake-replacement': 'no-job', // dispatch refused → failed
    }, 'done');
    const { final } = await deploy({ pollBudgetMs: 120, stallMs: 100_000 });

    expect(final.status).toBe('partial');
    expect(final.demoSummary).toMatchObject({
      total: TOTAL, succeeded: TOTAL - 4, partial: 1, failed: 2, unknown: 1, allSucceeded: false,
    });
    expect(final.createdItems).toBe(TOTAL - 4);

    const find = (id: string) => (final.subJobs || []).find((s) => s.appId === id)!;
    expect(find('app-supercharge-bronze').status).toBe('failed');
    expect(find('app-supercharge-silver').status).toBe('partial');
    expect(find('app-supercharge-gold').status).toBe('unknown');
    expect(find('app-direct-lake-replacement').status).toBe('failed');
    expect(find('app-direct-lake-replacement').error).toMatch(/install refused/);
    expect(find('app-finops-cost').status).toBe('succeeded');

    expect(summarizeDemoSubJobs(final.subJobs).headline)
      .toBe(`${TOTAL - 4}/${TOTAL} installed · 1 installed with gates · 2 failed · 1 unconfirmed`);
    expect(h.history.filter((d) => d.status === 'done')).toHaveLength(0);
  });

  it('observes a running → done transition instead of resolving early', async () => {
    const h = wireCosmos();
    wireFetch(h, {}, 'running');
    // Each install job reports `running` for its first two polls, then `done`.
    const jobs = await (appInstallJobsContainer as any)();
    const origItem = jobs.item;
    const reads = new Map<string, number>();
    jobs.item = (id: string, pk: string) => {
      if (!id.startsWith('ij-')) return origItem(id, pk);
      return {
        read: async () => {
          const n = (reads.get(id) || 0) + 1;
          reads.set(id, n);
          return { resource: installJobDoc(id.slice('ij-'.length), n >= 3 ? 'done' : 'running') };
        },
        replace: origItem(id, pk).replace,
      };
    };

    const { final } = await deploy({ pollBudgetMs: 3_000, stallMs: 100_000 });
    expect(final.status).toBe('done');
    expect(byStatus(final.subJobs, 'succeeded')).toHaveLength(TOTAL);
    // It went through `installing` on the way — i.e. it really polled.
    expect(h.history.some((d) => (d.subJobs || []).some((s) => s.status === 'installing'))).toBe(true);
    // …and never claimed done before every app resolved.
    for (const d of h.history) {
      if (d.status === 'done') expect(byStatus(d.subJobs, 'succeeded')).toHaveLength(TOTAL);
    }
  });
});

describe('runDemoDeploy — confirmation LOST is unknown, never success', () => {
  it('a job doc that stops advancing is UNKNOWN, and says so truthfully', async () => {
    const h = wireCosmos();
    wireFetch(h, {}, 'running');   // updatedAt/percent never change
    const { final } = await deploy({ pollBudgetMs: 5_000, stallMs: 5 });

    expect(final.status).toBe('partial');
    expect(byStatus(final.subJobs, 'unknown')).toHaveLength(TOTAL);
    expect(byStatus(final.subJobs, 'succeeded')).toHaveLength(0);
    expect(final.subJobs?.[0].detail).toMatch(/stopped advancing for \d+s at phase 'provisioning' \(40%\)/);
    expect(final.subJobs?.[0].detail).toMatch(/the outcome is not known/);
  });

  it('an install job doc that never appears is UNKNOWN after repeated misses', async () => {
    const h = wireCosmos();
    wireFetch(h, {}, 'no-doc');   // 202 + jobId, but no job doc is ever written
    const { final } = await deploy({ pollBudgetMs: 3_000, stallMs: 100_000 });

    expect(final.status).toBe('partial');
    expect(byStatus(final.subJobs, 'unknown')).toHaveLength(TOTAL);
    expect(final.subJobs?.[0].detail).toMatch(/no install job doc was found for this install after 3 attempts/);
  });

  it('a Cosmos read that keeps throwing is UNKNOWN — the error is reported, not swallowed', async () => {
    const h = wireCosmos();
    wireFetch(h, {}, 'running');
    const jobs = await (appInstallJobsContainer as any)();
    const origItem = jobs.item;
    jobs.item = (id: string, pk: string) => {
      if (id.startsWith('ij-')) {
        return { read: async () => { throw new Error('Cosmos 503 service unavailable'); }, replace: origItem(id, pk).replace };
      }
      return origItem(id, pk);
    };
    const { final } = await deploy({ pollBudgetMs: 3_000, stallMs: 100_000 });

    expect(byStatus(final.subJobs, 'unknown')).toHaveLength(TOTAL);
    expect(final.subJobs?.[0].detail).toMatch(/could not be read \(3 consecutive attempts\): Cosmos 503/);
  });

  it('a workspace that cannot be created FAILS that app and never blocks the rest', async () => {
    const h = wireCosmos();
    let created = 0;
    (globalThis as any).fetch = vi.fn(async (url: any, init?: any) => {
      const u = String(url);
      if (/\/api\/workspaces$/.test(u)) {
        if (!init?.method) return jsonRes({ workspaces: [] });
        created += 1;
        return created === 1 ? jsonRes({ ok: false, error: 'quota' }, 500) : jsonRes({ id: `ws-${created}` });
      }
      const m = /\/api\/apps\/([^/]+)\/install$/.exec(u);
      if (m) {
        const appId = decodeURIComponent(m[1]);
        h.docs.set(installJobIdFor(appId), installJobDoc(appId, 'done'));
        return jsonRes({ ok: true, jobId: installJobIdFor(appId) }, 202);
      }
      return jsonRes({});
    });

    const { final } = await deploy();
    expect(final.status).toBe('partial');
    expect(byStatus(final.subJobs, 'failed')).toHaveLength(1);
    expect(final.subJobs?.[0].error).toBe('workspace create failed');
    expect(byStatus(final.subJobs, 'succeeded')).toHaveLength(TOTAL - 1);
  });
});
