// W1-8: PostgreSQL 7-day restart scheduler + job. Each assertion names the input that breaks it.
import { describe, expect, it } from 'vitest';
import { JobRunner } from '../src/jobs/runner.js';
import {
  POSTGRES_AUTO_RESTART_DAYS,
  POSTGRES_RESTART_KIND,
  RESTART_INTERVAL_MS,
  RestPostgresPower,
  postgresRestartHandler,
  restartWindow,
  scheduleStampRestarts,
  type PostgresPower,
  type PostgresState,
} from '../src/jobs/stamp-power.js';
import type { JobDoc } from '../src/jobs/types.js';
import type { StampDoc } from '../src/registry/types.js';
import { MemoryCollection } from './helpers.js';

const SERVER = '/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg-csa-loom-health-dev01-eastus2/providers/Microsoft.DBforPostgreSQL/flexibleServers/pg-lhds-dev01';
const DAY = 24 * 60 * 60 * 1000;

const stamp = (id: string, status: StampDoc['status']): StampDoc => ({
  id, displayName: id, cloud: 'commercial', region: 'eastus2', class: 'S', status, baseUrl: 'https://x.example',
  engineVersions: {}, createdAt: 't', updatedAt: 't', updatedBy: 'u',
});

class FakePower implements PostgresPower {
  state: PostgresState = 'Stopped';
  starts = 0;
  startLeavesStopped = false;
  async getState() { return this.state; }
  async start() { this.starts++; if (!this.startLeavesStopped) this.state = 'Ready'; }
}

function setup(at = new Date('2026-10-26T00:00:00Z')) {
  let clock = at;
  const stamps = new MemoryCollection<StampDoc>();
  const jobsStore = new MemoryCollection<JobDoc>();
  const runner = new JobRunner(jobsStore, async (_t, id) => stamps.docs.has(id), () => {}, () => clock);
  const power = new FakePower();
  let manifest: Awaited<ReturnType<Parameters<typeof postgresRestartHandler>[0]['getStampManifest']>> = {
    state: 'found', value: { postgresServerId: SERVER },
  };
  runner.register(postgresRestartHandler({ stamps, power, getStampManifest: async () => manifest }));
  return {
    stamps, runner, power, jobsStore,
    setClock: (d: Date) => { clock = d; },
    now: () => clock,
    setManifest: (m: typeof manifest) => { manifest = m; },
  };
}

describe('restart interval', () => {
  it('is strictly inside the 7-day auto-restart (breaks if the interval is raised to 7 days or more)', () => {
    expect(RESTART_INTERVAL_MS).toBeLessThan(POSTGRES_AUTO_RESTART_DAYS * DAY);
    expect(RESTART_INTERVAL_MS).toBe(6 * DAY);
  });
  it('a server stopped at any instant sees a window boundary within 6 days (breaks if windows are wider)', () => {
    for (const offset of [0, 1, DAY, 3 * DAY, 6 * DAY - 1]) {
      const stopped = new Date(1_800_000_000_000 + offset);
      const next = new Date((restartWindow(stopped) + 1) * RESTART_INTERVAL_MS);
      expect(next.getTime() - stopped.getTime()).toBeLessThanOrEqual(6 * DAY);
      expect(next.getTime()).toBeGreaterThan(stopped.getTime());
    }
  });
});

describe('scheduleStampRestarts', () => {
  it('submits only for PAUSED stamps (breaks if a healthy stamp is scheduled)', async () => {
    const s = setup();
    await s.stamps.create(stamp('p1', 'paused'));
    await s.stamps.create(stamp('h1', 'healthy'));
    const r = await scheduleStampRestarts({ stamps: s.stamps, jobs: s.runner, now: s.now });
    await s.runner.idle();
    expect(r.submitted).toEqual(['p1']);
    const jobs = await s.runner.list();
    expect(jobs.map((j) => j.subjectId)).toEqual(['p1']);
    expect(jobs[0]?.kind).toBe(POSTGRES_RESTART_KIND);
  });

  it('is idempotent inside a window and fires again in the next one (breaks if the key ignores the window)', async () => {
    const s = setup();
    await s.stamps.create(stamp('p1', 'paused'));
    await scheduleStampRestarts({ stamps: s.stamps, jobs: s.runner, now: s.now });
    await s.runner.idle();
    const again = await scheduleStampRestarts({ stamps: s.stamps, jobs: s.runner, now: s.now });
    expect(again.submitted).toEqual([]);
    expect(again.alreadyDone).toEqual(['p1']);
    s.setClock(new Date(s.now().getTime() + RESTART_INTERVAL_MS));
    const next = await scheduleStampRestarts({ stamps: s.stamps, jobs: s.runner, now: s.now });
    await s.runner.idle();
    expect(next.submitted).toEqual(['p1']);
    expect((await s.runner.list()).length).toBe(2);
  });

  it('retries a failed job of the same window (breaks if failure costs the stamp its restart)', async () => {
    const s = setup();
    await s.stamps.create(stamp('p1', 'paused'));
    s.power.state = 'Updating'; // handler throws transient
    await scheduleStampRestarts({ stamps: s.stamps, jobs: s.runner, now: s.now });
    await s.runner.idle();
    expect((await s.runner.list())[0]?.state).toBe('failed');
    s.power.state = 'Stopped';
    const r = await scheduleStampRestarts({ stamps: s.stamps, jobs: s.runner, now: s.now });
    await s.runner.idle();
    expect(r.retried).toEqual(['p1']);
    expect((await s.runner.list())[0]?.state).toBe('succeeded');
    expect(s.power.starts).toBe(1);
  });
});

describe('stamp.postgres-restart handler', () => {
  const run = async (s: ReturnType<typeof setup>) => {
    await scheduleStampRestarts({ stamps: s.stamps, jobs: s.runner, now: s.now });
    await s.runner.idle();
    return (await s.runner.list())[0]!;
  };

  it('starts a Stopped server and records before/after receipts', async () => {
    const s = setup();
    await s.stamps.create(stamp('p1', 'paused'));
    const j = await run(s);
    expect(j.state).toBe('succeeded');
    expect(s.power.starts).toBe(1); // 0 = the start was never issued
    expect(j.receipts.map((r) => r.step)).toEqual(['postgres.state.before', 'postgres.state.after']);
    expect(j.receipts[1]?.detail).toContain('state=Ready');
  });

  it('does not start a server that is already Ready (breaks if start is unconditional)', async () => {
    const s = setup();
    await s.stamps.create(stamp('p1', 'paused'));
    s.power.state = 'Ready';
    const j = await run(s);
    expect(j.state).toBe('succeeded');
    expect(s.power.starts).toBe(0);
  });

  it('fails when the read-back is not Ready (breaks if success is reported on the start call alone)', async () => {
    const s = setup();
    await s.stamps.create(stamp('p1', 'paused'));
    s.power.startLeavesStopped = true;
    const j = await run(s);
    expect(j.state).toBe('failed');
    expect(j.error?.code).toBe('start_unverified');
  });

  it('fails closed when the server cannot be identified', async () => {
    const s = setup();
    await s.stamps.create(stamp('p1', 'paused'));
    s.setManifest({ state: 'found', value: {} });
    expect((await run(s)).error?.code).toBe('stamp_manifest_incomplete');
    expect(s.power.starts).toBe(0);
  });

  it('skips a stamp that was resumed before the job ran (breaks if it starts anyway)', async () => {
    const s = setup();
    await s.stamps.create(stamp('p1', 'paused'));
    // The estate resumed the stamp after the schedule listed it but before the job read it.
    const get = s.stamps.get.bind(s.stamps);
    s.stamps.get = async (id) => {
      const d = await get(id);
      return d ? { ...d, status: 'healthy' } : d;
    };
    await scheduleStampRestarts({ stamps: s.stamps, jobs: s.runner, now: s.now });
    await s.runner.idle();
    const j = (await s.runner.list())[0]!;
    expect(j.state).toBe('succeeded');
    expect(j.receipts[0]?.step).toBe('postgres.restart.skipped');
    expect(s.power.starts).toBe(0);
  });
});

describe('RestPostgresPower', () => {
  const mk = (responses: Array<{ status: number; body?: unknown }>) => {
    const calls: Array<{ method: string; url: string }> = [];
    const fetchFn = (async (url: string, init: { method: string }) => {
      calls.push({ method: init.method, url });
      const r = responses.shift() ?? { status: 200, body: { properties: { state: 'Ready' } } };
      return { status: r.status, json: async () => r.body ?? {} };
    }) as unknown as typeof fetch;
    const p = new RestPostgresPower({ armEndpoint: 'https://management.azure.com', token: async () => 't', fetchFn, sleep: async () => {}, pollMs: 0 });
    return { p, calls };
  };

  it('POSTs /start then polls until Ready', async () => {
    const { p, calls } = mk([{ status: 202 }, { status: 200, body: { properties: { state: 'Starting' } } }, { status: 200, body: { properties: { state: 'Ready' } } }]);
    await p.start(SERVER);
    expect(calls[0]).toMatchObject({ method: 'POST' });
    expect(calls[0]?.url).toContain('/start?api-version=');
    expect(calls.length).toBe(3);
  });

  it('maps 403 to a permission failure and rejects a non-PostgreSQL id before any call', async () => {
    const { p, calls } = mk([{ status: 403 }]);
    await expect(p.getState(SERVER)).rejects.toMatchObject({ code: 'permission' });
    await expect(p.getState('/subscriptions/x/resourceGroups/r/providers/Microsoft.Storage/storageAccounts/a')).rejects.toMatchObject({ code: 'bad_server_id' });
    expect(calls.length).toBe(1);
  });

  it('reports absent on 404', async () => {
    const { p } = mk([{ status: 404 }]);
    expect(await p.getState(SERVER)).toBe('absent');
  });
});
