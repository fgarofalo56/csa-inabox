/**
 * getDiagnosticsCoverage is paced and labeled (2026-10-21 unlabeled-ARM burst:
 * ~450 simultaneous diagnosticSettings GETs from the detached install job).
 *
 * Each assertion names the input that breaks it in its message/comment.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'tk', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

const LAW = '/subscriptions/sub-1/resourceGroups/rg-admin/providers/Microsoft.OperationalInsights/workspaces/loom-law';
const N = 450;
const rid = (i: number) =>
  `/subscriptions/sub-1/resourceGroups/rg-admin/providers/Microsoft.App/containerApps/aca${String(i).padStart(4, '0')}`;

beforeEach(() => {
  process.env.LOOM_SUBSCRIPTION_ID = 'sub-1';
  process.env.LOOM_ADMIN_RG = 'rg-admin';
  process.env.LOOM_ACA_RG = 'rg-aca';
  process.env.LOOM_LOG_ANALYTICS_RESOURCE_ID = LAW;
  delete process.env.LOOM_DIAG_COVERAGE_CONCURRENCY;
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetModules(); });

/** Stub fetch: lists N resources, answers each diag GET after a macrotask, tracks peak in-flight. */
function stub(opts: { throttle?: (url: string) => boolean; n?: number } = {}) {
  const total = opts.n ?? N;
  const st = { inFlight: 0, max: 0, diagGets: 0 };
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = String(url);
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
    if (u.includes('/resourceGroups/rg-admin/resources')) {
      return json(200, { value: Array.from({ length: total }, (_, i) => ({ id: rid(i), name: `aca${String(i).padStart(4, '0')}`, type: 'Microsoft.App/containerApps', location: 'eastus2' })) });
    }
    if (u.includes('/resourceGroups/rg-aca/resources')) return json(200, { value: [] });
    if (u.includes('/diagnosticSettings')) {
      st.diagGets += 1;
      st.inFlight += 1;
      st.max = Math.max(st.max, st.inFlight);
      await new Promise((r) => setTimeout(r, 1));
      st.inFlight -= 1;
      if (opts.throttle?.(u)) {
        return json(429, { error: { code: 'SubscriptionRequestsThrottled', message: 'slow down' } }, { 'retry-after': '30' });
      }
      return json(200, { value: [{ name: 'loom-diagnostics', properties: { workspaceId: LAW } }] });
    }
    return json(200, {});
  }));
  return st;
}

describe('getDiagnosticsCoverage pacing', () => {
  it('450 resources never exceed the default cap of 10 in flight, the cap IS reached, and all 450 rows return in order', async () => {
    const st = stub();
    const { getDiagnosticsCoverage } = await import('../monitor-client');
    const rows = await getDiagnosticsCoverage();
    // Breaks at max=450 when the fan-out is an unbounded Promise.all.
    expect(st.max).toBeLessThanOrEqual(10);
    // Breaks at max=1 if the pool were serialised / the cap never used.
    expect(st.max).toBeGreaterThanOrEqual(10);
    expect(st.diagGets).toBe(N);
    expect(rows).toHaveLength(N);
    // Breaks if results come back in completion order rather than input order.
    expect(rows.map((r) => r.id)).toEqual(Array.from({ length: N }, (_, i) => rid(i)));
    expect(rows.every((r) => r.routesToLoomLaw === true)).toBe(true);
  });

  it('LOOM_DIAG_COVERAGE_CONCURRENCY is honoured at runtime (4 in flight, not 10)', async () => {
    process.env.LOOM_DIAG_COVERAGE_CONCURRENCY = '4';
    const st = stub();
    const { getDiagnosticsCoverage } = await import('../monitor-client');
    await getDiagnosticsCoverage();
    expect(st.max).toBe(4);
  });

  it('the env value clamps: 0 and -3 -> 1, 999 -> 32, junk/empty/unset -> 10, 7.9 -> 7', async () => {
    const { diagCoverageConcurrency } = await import('../monitor-client');
    expect(diagCoverageConcurrency('0')).toBe(1);
    expect(diagCoverageConcurrency('-3')).toBe(1);
    expect(diagCoverageConcurrency('999')).toBe(32);
    expect(diagCoverageConcurrency('abc')).toBe(10);
    expect(diagCoverageConcurrency('')).toBe(10);
    expect(diagCoverageConcurrency(undefined)).toBe(10);
    expect(diagCoverageConcurrency('7.9')).toBe(7);
  });

  it('a 429 on one resource is a visible error row for THAT resource only, carrying the swallowed-ARM-error marker', async () => {
    stub({ throttle: (u) => u.includes('aca0123/') });
    const { getDiagnosticsCoverage } = await import('../monitor-client');
    const { readSwallowedArmError } = await import('../swallowed-arm-error');
    const rows = await getDiagnosticsCoverage();
    expect(rows).toHaveLength(N);
    const bad = rows.filter((r) => readSwallowedArmError(r) !== null);
    // Breaks if throttled reads are dropped, hidden as "supported:false", or smeared over other rows.
    expect(bad.map((r) => r.name)).toEqual(['aca0123']);
    const err = readSwallowedArmError(bad[0]!)!;
    expect(err.status).toBe(429);
    expect(err.code).toBe('SubscriptionRequestsThrottled');
    expect(err.retryAfterSeconds).toBe(30);
    expect(bad[0]!.supported).toBe(true);
    expect(bad[0]!.note).toBeTruthy();
  });

  it('warmer guard survives: inside a guarded warmer cycle a 429 still abandons the cycle (gate not replaced by the plain label)', async () => {
    stub({ n: 40, throttle: (u) => u.includes('aca0003/') });
    const { getDiagnosticsCoverage } = await import('../monitor-client');
    const gate = await import('../arm-read-gate');
    gate.resetArmReadCounts();
    const guard = new gate.WarmerCycleGuard();
    const g = gate.createArmReadGate({ maxConcurrent: 10, readsPerSec: 25 });
    const rows = await gate.runWithArmCaller('warmer.diagnostics', () => getDiagnosticsCoverage(), { guard, gate: g });
    const snap = gate.getArmReadCounts();
    // Breaks (reads land under 'diagnostics.coverage') if the sweep replaces the warmer ctx.
    expect(snap.reads['warmer.diagnostics']).toBeGreaterThan(0);
    expect(snap.reads['diagnostics.coverage']).toBeUndefined();
    // Breaks if the guard was dropped: the 429 would not abandon the remaining queued reads.
    expect(guard.abandoned).toBeTruthy();
    expect(rows).toHaveLength(40);
    // Queued reads behind the throttled one were dropped unsent, still visible as rows.
    expect(rows.filter((r) => r.note?.includes('Read not sent')).length).toBeGreaterThan(0);
  });
});

describe('ARM read labels', () => {
  it('an interactive sweep is counted as diagnostics.coverage, never unlabeled', async () => {
    stub();
    const { getDiagnosticsCoverage } = await import('../monitor-client');
    const gate = await import('../arm-read-gate');
    gate.resetArmReadCounts();
    await getDiagnosticsCoverage();
    const { reads } = gate.getArmReadCounts();
    // Breaks (all N land in `unlabeled`) if the sweep is not wrapped.
    // 450 diag GETs + 2 resource-group list reads (rg-admin, rg-aca) = 452, the measured live size.
    expect(reads['diagnostics.coverage']).toBe(N + 2);
    expect(reads.unlabeled ?? 0).toBe(0);
  });

  it('label context propagates into a void fire-and-forget job across awaits and timers (the install route pattern)', async () => {
    const gate = await import('../arm-read-gate');
    gate.resetArmReadCounts();
    let finished!: () => void;
    const done = new Promise<void>((r) => { finished = r; });
    // Same shape as route.ts: floating promise, returns before the work happens.
    void gate.runWithArmCaller('install.job', async () => {
      await new Promise((r) => setTimeout(r, 5));
      (await gate.beginArmRead()).done(200);
      await Promise.all([1, 2].map(async () => (await gate.beginArmRead()).done(429)));
      finished();
    });
    expect(gate.getArmReadCounts().reads).toEqual({}); // route "returned" before any read
    await done;
    const snap = gate.getArmReadCounts();
    // Breaks (3 land in `unlabeled`) if the context is lost across the detached job.
    expect(snap.reads).toEqual({ 'install.job': 3 });
    expect(snap.s429).toEqual({ 'install.job': 2 });
  });

  it('the install route actually wraps runInstallJob (regression guard on the call site, not a behaviour test)', () => {
    const src = readFileSync(join(process.cwd(), 'app/api/apps/[id]/install/route.ts'), 'utf8');
    // Breaks if the wrapper is removed and the bare `void runInstallJob(` returns.
    expect(src).toMatch(/void runWithArmCaller\('install\.job'/);
    expect(src).not.toMatch(/void runInstallJob\(/);
  });
});
