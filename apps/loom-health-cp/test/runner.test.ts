import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { JobRunner, jobIdFor, LEASE_MS } from '../src/jobs/runner.js';
import { JobFailure, type JobDoc } from '../src/jobs/types.js';
import { MemoryCollection } from './helpers.js';

function setup(now = () => new Date('2026-10-24T00:00:00Z')) {
  const store = new MemoryCollection<JobDoc>();
  const logs: string[] = [];
  const runner = new JobRunner(store, async (_t, id) => id !== 'missing', (e, f) => logs.push(JSON.stringify({ e, ...f })), now);
  return { store, runner, logs };
}
const req = (over: Record<string, unknown> = {}) => ({
  kind: 'test.job', subjectType: 'stamp' as const, subjectId: 'stamp-a', idempotencyKey: 'k1', requestedBy: 'caller', ...over,
});

describe('JobRunner', () => {
  it('runs a handler to success and persists its receipts in order', async () => {
    const { runner } = setup();
    runner.register({
      kind: 'test.job', subjectType: 'stamp',
      async run(ctx) {
        await ctx.receipt('step-1', 'rg=rg-a');
        await ctx.receipt('step-2', 'db=db-a');
      },
    });
    const { job } = await runner.submit(req());
    await runner.idle();
    const done = await runner.get(job.id);
    expect(done.state).toBe('succeeded');
    expect(done.attempts).toBe(1);
    expect(done.receipts.map((r) => r.step)).toEqual(['step-1', 'step-2']); // order matters for audit
    expect(done.finishedAt).toBeDefined();
  });

  it('is idempotent: the same (kind, subject, key) runs the handler once', async () => {
    const { runner } = setup();
    let runs = 0;
    runner.register({ kind: 'test.job', subjectType: 'stamp', async run() { runs++; } });
    const a = await runner.submit(req());
    const b = await runner.submit(req());
    await runner.idle();
    expect(b.created).toBe(false);
    expect(b.job.id).toBe(a.job.id);
    expect(runs).toBe(1); // 2 would mean the dedupe is broken
    const c = await runner.submit(req({ idempotencyKey: 'k2' }));
    await runner.idle();
    expect(c.job.id).not.toBe(a.job.id);
    expect(runs).toBe(2);
  });

  it('job id is derived from kind, subject AND key (changing any one changes it)', () => {
    const base = jobIdFor('a', 's', 'k');
    expect(jobIdFor('b', 's', 'k')).not.toBe(base);
    expect(jobIdFor('a', 't', 'k')).not.toBe(base);
    expect(jobIdFor('a', 's', 'j')).not.toBe(base);
  });

  it('a JobFailure surfaces its code and message; any other error is generic', async () => {
    const { runner, logs } = setup();
    runner.register({ kind: 'test.fail', subjectType: 'stamp', async run() { throw new JobFailure('quota_exceeded', 'stamp has no headroom'); } });
    runner.register({ kind: 'test.crash', subjectType: 'stamp', async run() { throw new Error('conn string Password=hunter2 refused'); } });
    const f = await runner.submit(req({ kind: 'test.fail' }));
    const c = await runner.submit(req({ kind: 'test.crash' }));
    await runner.idle();
    expect((await runner.get(f.job.id)).error).toEqual({ code: 'quota_exceeded', message: 'stamp has no headroom' });
    const crashed = await runner.get(c.job.id);
    expect(crashed.state).toBe('failed');
    expect(crashed.error).toEqual({ code: 'internal', message: expect.stringMatching(/^job failed; see service logs \(ref: [0-9a-f]{8}\)$/) });
    expect(JSON.stringify(crashed)).not.toContain('hunter2'); // breaks if raw error text is stored
    expect(logs.join('\n')).not.toContain('hunter2'); // ...or logged
  });

  it('retry re-queues a failed job and clears the old error; refuses a non-failed one', async () => {
    const { runner } = setup();
    let fail = true;
    runner.register({ kind: 'test.job', subjectType: 'stamp', async run() { if (fail) throw new JobFailure('x', 'first try'); } });
    const { job } = await runner.submit(req());
    await runner.idle();
    expect((await runner.get(job.id)).state).toBe('failed');
    fail = false;
    await runner.retry(job.id);
    await runner.idle();
    const again = await runner.get(job.id);
    expect(again.state).toBe('succeeded');
    expect(again.attempts).toBe(2);
    expect(again.error).toBeUndefined(); // stale error must not survive a success
    await expect(runner.retry(job.id)).rejects.toMatchObject({ status: 409 });
  });

  it('cancel works on queued only', async () => {
    const { runner, store } = setup();
    runner.register({ kind: 'test.job', subjectType: 'stamp', async run() {} });
    const { job } = await runner.submit(req());
    await runner.idle(); // already succeeded
    await expect(runner.cancel(job.id)).rejects.toMatchObject({ status: 409 });
    const q = await store.create({ ...(await runner.get(job.id)), id: 'job-' + 'a'.repeat(32), state: 'queued', _etag: undefined });
    expect((await runner.cancel(q.id)).state).toBe('cancelled');
  });

  it('rejects unknown kind, wrong subject type, bad key, bad input, missing subject', async () => {
    const { runner } = setup();
    runner.register({ kind: 'test.job', subjectType: 'stamp', inputSchema: z.strictObject({ size: z.number() }), async run() {} });
    await expect(runner.submit(req({ kind: 'nope' }))).rejects.toMatchObject({ status: 400 });
    await expect(runner.submit(req({ subjectType: 'tenant', input: { size: 1 } }))).rejects.toMatchObject({ status: 400 });
    await expect(runner.submit(req({ idempotencyKey: 'has space', input: { size: 1 } }))).rejects.toMatchObject({ status: 400 });
    await expect(runner.submit(req({ input: { size: 'big' } }))).rejects.toMatchObject({ status: 400 });
    await expect(runner.submit(req({ subjectId: 'missing', input: { size: 1 } }))).rejects.toMatchObject({ status: 404 });
  });

  it('two replicas ticking the same queued job run it exactly once (etag claim)', async () => {
    const store = new MemoryCollection<JobDoc>();
    let runs = 0;
    const handler = { kind: 'test.job', subjectType: 'stamp' as const, async run() { runs++; } };
    const mk = () => {
      const r = new JobRunner(store, async () => true);
      r.register(handler);
      return r;
    };
    const [r1, r2] = [mk(), mk()];
    await store.create({
      id: 'job-' + '4'.repeat(32), kind: 'test.job', subjectType: 'stamp', subjectId: 'stamp-a', idempotencyKey: 'k', state: 'queued',
      attempts: 0, input: {}, receipts: [], requestedBy: 'c', createdAt: 'x', updatedAt: 'x',
    });
    await Promise.all([r1.tick(), r2.tick()]);
    await Promise.all([r1.idle(), r2.idle()]);
    expect(runs).toBe(1); // 2 means the claim is not etag-guarded
    expect((await store.get('job-' + '4'.repeat(32)))?.attempts).toBe(1);
  });

  it('tick fails a running job whose lease expired and leaves a fresh one alone', async () => {
    let t = new Date('2026-10-24T00:00:00Z');
    const { runner, store } = setup(() => t);
    runner.register({ kind: 'test.job', subjectType: 'stamp', async run() {} });
    const base: JobDoc = {
      id: 'job-' + '1'.repeat(32), kind: 'test.job', subjectType: 'stamp', subjectId: 'stamp-a', idempotencyKey: 'k', state: 'running',
      attempts: 1, input: {}, receipts: [], requestedBy: 'c', createdAt: t.toISOString(), updatedAt: t.toISOString(),
    };
    await store.create(base);
    await store.create({ ...base, id: 'job-' + '2'.repeat(32), idempotencyKey: 'k2' });
    t = new Date(t.getTime() + LEASE_MS + 1000);
    // refresh the second job's heartbeat so only the first is expired
    const second = await store.get('job-' + '2'.repeat(32));
    await store.replace({ ...second!, updatedAt: t.toISOString() });
    await runner.tick();
    expect((await store.get(base.id))?.state).toBe('failed');
    expect((await store.get(base.id))?.error?.code).toBe('interrupted');
    expect((await store.get('job-' + '2'.repeat(32)))?.state).toBe('running');
  });

  it('tick picks up a queued job left behind by a crashed process', async () => {
    const { runner, store } = setup();
    let ran = false;
    runner.register({ kind: 'test.job', subjectType: 'stamp', async run() { ran = true; } });
    await store.create({
      id: 'job-' + '3'.repeat(32), kind: 'test.job', subjectType: 'stamp', subjectId: 'stamp-a', idempotencyKey: 'k', state: 'queued',
      attempts: 0, input: {}, receipts: [], requestedBy: 'c', createdAt: 'x', updatedAt: 'x',
    });
    await runner.tick();
    await runner.idle();
    expect(ran).toBe(true);
  });
});

describe('JobRunner exclusive groups (#5442)', () => {
  /** A handler that records how many jobs of its kind are inside run() at once, and waits for `release`. */
  function gated(kind: string, group: string | undefined, log: { inside: number; max: number; started: string[] }, gate: { open: () => void; wait: Promise<void> }) {
    return {
      kind, subjectType: 'tenant' as const, ...(group ? { exclusiveGroup: group } : {}),
      async run(ctx: { job: { id: string } }) {
        log.inside++; log.max = Math.max(log.max, log.inside); log.started.push(kind);
        await gate.wait;
        log.inside--;
      },
    };
  }
  const gate = () => { let open!: () => void; const wait = new Promise<void>((r) => { open = r; }); return { open, wait }; };
  const tenantReq = (kind: string, key: string, subjectId = 't1') => ({ kind, subjectType: 'tenant' as const, subjectId, idempotencyKey: key, requestedBy: 'c' });
  const tick = () => new Promise((r) => setTimeout(r, 15));

  it('two jobs of one group on ONE subject never overlap: the second waits queued, then runs after the first ends', async () => {
    const { runner, store } = setup();
    const log = { inside: 0, max: 0, started: [] as string[] };
    const g = gate();
    runner.register(gated('a.create', 'grp', log, g));
    runner.register(gated('b.destroy', 'grp', log, g));
    const a = await runner.submit(tenantReq('a.create', 'k1'));
    const b = await runner.submit(tenantReq('b.destroy', 'k2'));
    await tick();
    // Breaks if serialisation is removed: both are inside run() (max 2) and b is running, not queued.
    expect(log.max).toBe(1);
    expect((await store.get(b.job.id))?.state).toBe('queued');
    expect((await store.get(a.job.id))?.state).toBe('running');
    g.open();
    await runner.idle();
    expect((await runner.get(a.job.id)).state).toBe('succeeded');
    expect((await runner.get(b.job.id)).state).toBe('succeeded');
    expect(log.started).toEqual(['a.create', 'b.destroy']);
    expect(log.max).toBe(1);
  });

  it('control: a different subject, and a handler with no group, run at the same time', async () => {
    const { runner } = setup();
    const log = { inside: 0, max: 0, started: [] as string[] };
    const g = gate();
    runner.register(gated('a.create', 'grp', log, g));
    runner.register(gated('free.job', undefined, log, g));
    await runner.submit(tenantReq('a.create', 'k1', 't1'));
    await runner.submit(tenantReq('a.create', 'k2', 't2'));
    await runner.submit(tenantReq('free.job', 'k3', 't1'));
    await tick();
    expect(log.max).toBe(3); // 2 or fewer means the lock is wider than one (group, subject)
    g.open();
    await runner.idle();
  });

  it('a running job whose lease expired does NOT block: crash recovery must not wedge the tenant', async () => {
    let t = new Date('2026-10-24T00:00:00Z');
    const { runner, store } = setup(() => t);
    const log = { inside: 0, max: 0, started: [] as string[] };
    const g = gate();
    runner.register(gated('a.create', 'grp', log, g));
    const stale = await store.create({ id: 'job-stale', kind: 'a.create', subjectType: 'tenant', subjectId: 't1', idempotencyKey: 'old', state: 'running', attempts: 1, input: {}, receipts: [], requestedBy: 'c', createdAt: t.toISOString(), updatedAt: t.toISOString() });
    expect(stale.state).toBe('running');
    t = new Date(t.getTime() + LEASE_MS + 1000);
    const b = await runner.submit(tenantReq('a.create', 'k9'));
    await tick();
    expect((await store.get(b.job.id))?.state).toBe('running'); // 'queued' would mean a dead lease blocks forever
    g.open();
    await runner.idle();
  });
});

describe('JobRunner exclusive groups: simultaneous submits (#5442)', () => {
  it('five jobs of one group submitted AT ONCE for one subject still run strictly one at a time (breaks if check and claim are not one step per subject)', async () => {
    const { runner } = setup();
    let inside = 0;
    let max = 0;
    let ran = 0;
    runner.register({ kind: 'g.job', subjectType: 'tenant', exclusiveGroup: 'grp', async run() { inside++; max = Math.max(max, inside); await new Promise((r) => setTimeout(r, 10)); inside--; ran++; } });
    await Promise.all([1, 2, 3, 4, 5].map((n) => runner.submit({ kind: 'g.job', subjectType: 'tenant', subjectId: 't1', idempotencyKey: `k${n}`, requestedBy: 'c' })));
    await runner.idle();
    expect(ran).toBe(5); // fewer means a job was left queued forever (wake lost)
    expect(max).toBe(1); // 2+ means two jobs claimed in the same window
  });
});
