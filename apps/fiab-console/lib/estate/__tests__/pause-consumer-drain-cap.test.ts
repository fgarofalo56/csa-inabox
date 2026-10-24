/**
 * #5099 phase C review fix: the consumer read-back is CONCURRENT and its total wait is CAPPED.
 * Every `it` names the input that breaks it (assertion-design.md).
 */
import { describe, it, expect } from 'vitest';
import { CONSUMER_DRAIN_BUDGET_MS, confirmConsumersStopped } from '../pause-resume';
import { armPowerReading } from '../pause-state';

const idOf = (name: string) => `/subscriptions/s/resourceGroups/rg/providers/Microsoft.App/containerApps/${name}`;
const acts = ['app-a', 'app-b', 'app-c'].map((n) => ({
  resourceId: idOf(n), name: n, resourceType: 'microsoft.app/containerapps', status: 'dispatched',
}));
const online = (resourceId: string) => armPowerReading({ resourceId, powerState: 'Online', armApiVersion: 'x' });

describe('consumer read-back: concurrent and capped', () => {
  // Breaks if: consumers are confirmed one after another again (maxInFlight would be 1, not 3).
  it('three stuck consumers are read in parallel: 3 reads in flight at once', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const actuator = {
      readPower: async (r: { resourceId: string }) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((res) => setTimeout(res, 15));
        inFlight -= 1;
        return { reading: online(r.resourceId), replicaCount: 2 };
      },
    };
    const out = await confirmConsumersStopped(['app-a', 'app-b', 'app-c'], acts, actuator, { attempts: 2, delayMs: 0 });
    expect(out.ok).toBe(false);
    expect(maxInFlight).toBe(3);
  });

  // Breaks if: the wait budget is removed. With attempts=1000 and a 20 ms delay an uncapped loop would make
  // ~1000 reads (20 s); the 120 ms budget must stop it at a handful, and say it was the budget.
  it('the total wait is capped by budgetMs: far fewer reads than attempts, reason names the budget', async () => {
    let reads = 0;
    const actuator = { readPower: async (r: { resourceId: string }) => { reads += 1; return { reading: online(r.resourceId), replicaCount: 1 }; } };
    const t0 = Date.now();
    const out = await confirmConsumersStopped(['app-a'], acts, actuator, { attempts: 1000, delayMs: 20, budgetMs: 120 });
    const elapsed = Date.now() - t0;
    expect(out.ok).toBe(false);
    expect(reads).toBeGreaterThan(1); // positive: it did keep reading until the budget
    expect(reads).toBeLessThan(15); // 120 ms / 20 ms = at most ~7 reads
    expect(elapsed).toBeLessThan(2000);
    expect((out as { reason: string }).reason).toContain('read-back budget');
  });

  // Breaks if: the default budget is raised to or past the route timeout (a 30 s route would time out mid-pause).
  it('the default per-request budget is 20 s, under 30 s', () => {
    expect(CONSUMER_DRAIN_BUDGET_MS).toBeLessThan(30_000);
    expect(CONSUMER_DRAIN_BUDGET_MS).toBe(20_000);
  });

  // Breaks if: the deadline is per database instead of per request: a second database must find the budget spent.
  it('a shared deadline already in the past fails immediately: one read, no sleep (one budget per request)', async () => {
    let reads = 0;
    const actuator = { readPower: async (r: { resourceId: string }) => { reads += 1; return { reading: online(r.resourceId), replicaCount: 1 }; } };
    const out = await confirmConsumersStopped(['app-a'], acts, actuator, { attempts: 50, delayMs: 10 }, Date.now() - 1);
    expect(out.ok).toBe(false);
    expect(reads).toBe(1);
  });

  // Positive control: a consumer that drains inside the budget still confirms.
  it('a consumer that reads stopped on the 2nd read confirms ok', async () => {
    let n = 0;
    const actuator = {
      readPower: async (r: { resourceId: string }) => {
        n += 1;
        return n < 2 ? { reading: online(r.resourceId), replicaCount: 1 } : { reading: online(r.resourceId), replicaCount: 0 };
      },
    };
    expect(await confirmConsumersStopped(['app-a'], acts, actuator, { attempts: 5, delayMs: 1 })).toEqual({ ok: true });
  });
});
