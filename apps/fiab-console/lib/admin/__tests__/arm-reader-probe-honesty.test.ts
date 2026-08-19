/**
 * #3729 — the ARM control-plane probe must never assert a cause it did not
 * establish, and an unfinished check must never read as a proven failure.
 *
 * THE DEFECT THIS PINS. `/admin/readiness` reported "Azure subscription +
 * resource groups" as **Blocked** on the live Commercial console with the
 * diagnosis "Verify the Console can reach management.azure.com … and that the
 * UAMI token is being issued". Measured 2026-08-19 against that same console:
 * ARM was reachable, the UAMI token WAS being issued, and the probe returned
 * `pass` ("resource group rg-csa-loom-admin-centralus resolved (centralus)")
 * — while a sibling probe in the SAME self-audit run timed out at its own
 * budget. The Blocked verdict was this probe's own 6 s `withTimeout` firing,
 * reported as an established network/identity outage, and because the owning
 * `subscription` gate is `severity:'critical'` it took the entire Core
 * platform workload no-go.
 *
 * Two separate bugs are pinned here:
 *   1. UNKNOWN reported as a NEGATIVE (deploy-integrity.md R7). A timeout /
 *      throttle / 5xx now returns `warn` + `inconclusive`, worded as "could
 *      not establish", and is retried once before it is reported at all.
 *   2. The shared DENIED regex substring-matched '401'/'403' ANYWHERE in the
 *      error message — and that message carries the subscription GUID, so a
 *      subscription id containing those digits classified every failure as an
 *      authorization denial. Classification now parses ARM's HTTP status.
 *
 * The network edge (arm-client) is mocked; nothing above it is faked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const armMock = { armGet: vi.fn() };
vi.mock('@/lib/azure/arm-client', () => armMock);

import {
  runExtraProbes,
  classifyArmFailure,
  armStatusFromMessage,
  ARM_PROBE_BUDGET_MS,
  ARM_PROBE_RETRY_BUDGET_MS,
  type ProbeHelpers,
} from '../health-probes';

const h: ProbeHelpers = {
  ctx: { app: 'loom-console', adminRg: 'rg-admin', dlzRg: 'rg-dlz', sub: 'sub-1', uamiClientId: 'uami-1', tenant: 'tid', cosmosAccount: 'cosmos' },
  envVarFix: (vars: string[]) => ({ portalSteps: [`set ${vars.join(', ')}`], fixScript: `# set ${vars.join(' ')}` }),
};

/** A subscription id that CONTAINS '403' — the false-positive the old
 *  substring match produced. This is a shape, not a real subscription. */
const SUB_WITH_403 = '40312345-1111-2222-3333-444455556666';
const RG = 'rg-csa-loom-admin-centralus';

const ENV_KEYS = ['LOOM_SUBSCRIPTION_ID', 'LOOM_ADMIN_RG', 'LOOM_DLZ_RG'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.LOOM_SUBSCRIPTION_ID = SUB_WITH_403;
  process.env.LOOM_ADMIN_RG = RG;
  delete process.env.LOOM_DLZ_RG;
  armMock.armGet.mockReset();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
});

async function armProbe() {
  const results = await runExtraProbes(h);
  return results.find((r) => r.id === 'probe-arm-reader')!;
}

describe('classifyArmFailure — the status is parsed, never substring-matched', () => {
  it('reads the HTTP status ARM actually returned', () => {
    expect(armStatusFromMessage(`ARM GET /subscriptions/${SUB_WITH_403}/resourcegroups/${RG}?api-version=2021-04-01 failed 500: boom`)).toBe(500);
    expect(armStatusFromMessage('timed out after 6000ms')).toBeNull();
  });

  it('a 5xx on a subscription id containing "403" is INCONCLUSIVE, not denied', () => {
    // The old DENIED regex matched '403' inside the GUID and reported an
    // authorization denial for a server-side error.
    const msg = `ARM GET /subscriptions/${SUB_WITH_403}/resourcegroups/${RG}?api-version=2021-04-01 failed 500: internal`;
    expect(classifyArmFailure(msg)).toBe('inconclusive');
  });

  it('classifies each provable outcome from the status', () => {
    const p = (code: number) => `ARM GET /subscriptions/${SUB_WITH_403}/resourcegroups/${RG}?api-version=2021-04-01 failed ${code}: body`;
    expect(classifyArmFailure(p(403))).toBe('denied');
    expect(classifyArmFailure(p(401))).toBe('denied');
    expect(classifyArmFailure(p(404))).toBe('not-found');
    expect(classifyArmFailure(p(400))).toBe('rejected');
    expect(classifyArmFailure(p(429))).toBe('inconclusive');
    expect(classifyArmFailure(p(503))).toBe('inconclusive');
  });

  it('classifies pre-HTTP failures without inventing a cause', () => {
    expect(classifyArmFailure('Failed to acquire ARM token')).toBe('no-token');
    expect(classifyArmFailure('ManagedIdentityCredential authentication failed')).toBe('no-token');
    expect(classifyArmFailure('getaddrinfo ENOTFOUND management.azure.com')).toBe('unreachable');
    expect(classifyArmFailure('fetch failed')).toBe('unreachable');
    // Our own budget, and anything we do not recognise: NOT established.
    expect(classifyArmFailure(`timed out after ${ARM_PROBE_BUDGET_MS}ms`)).toBe('inconclusive');
    expect(classifyArmFailure('something nobody has seen before')).toBe('inconclusive');
  });
});

describe('probe-arm-reader — an unfinished check establishes nothing', () => {
  it('a timeout is warn + inconclusive, and claims neither unreachability nor a token failure', async () => {
    armMock.armGet.mockRejectedValue(new Error(`timed out after ${ARM_PROBE_BUDGET_MS}ms`));
    const r = await armProbe();

    // Before #3729 this was `status: 'fail'` — which drove Core platform to Blocked.
    expect(r.status).toBe('warn');
    expect(r.inconclusive).toBe(true);
    expect(r.detail).toMatch(/could not establish/i);
    // The detail must say, in words, what it did NOT observe.
    expect(r.detail).toMatch(/NOT a finding that ARM is unreachable/i);
    expect(r.remediation).toMatch(/No operator action is known to be required/i);
    // It must NOT hand back the role-grant fix for a failure it never saw.
    expect(r.portalSteps).toBeUndefined();
    expect(r.fixScript).toBeUndefined();
  });

  it('retries ONCE on a not-established failure and reports the pass it then gets', async () => {
    armMock.armGet
      .mockRejectedValueOnce(new Error(`timed out after ${ARM_PROBE_BUDGET_MS}ms`))
      .mockResolvedValueOnce({ name: RG, location: 'centralus' });
    const r = await armProbe();

    expect(r.status).toBe('pass');
    expect(r.detail).toContain(RG);
    // Honest about the retry rather than silently swallowing the first attempt.
    expect(r.detail).toMatch(/first attempt did not complete/i);
    expect(armMock.armGet).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry a proven failure — a denial repeats identically', async () => {
    armMock.armGet.mockRejectedValue(new Error(`ARM GET /subscriptions/${SUB_WITH_403}/resourcegroups/${RG}?api-version=2021-04-01 failed 403: AuthorizationFailed`));
    const r = await armProbe();

    expect(r.status).toBe('fail');
    expect(r.inconclusive).toBeUndefined();
    expect(armMock.armGet).toHaveBeenCalledTimes(1);
    expect(r.remediation).toMatch(/Reader/);
    expect(r.portalSteps?.join(' ')).toMatch(/Access control/i);
    expect(r.fixScript).toMatch(/az role assignment create/);
  });

  it('a 404 names the resource group as the problem — the env Fix-it IS the fix here', async () => {
    armMock.armGet.mockRejectedValue(new Error(`ARM GET /subscriptions/${SUB_WITH_403}/resourcegroups/${RG}?api-version=2021-04-01 failed 404: ResourceGroupNotFound`));
    const r = await armProbe();

    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/the identity WAS accepted/i);
    expect(r.remediation).toMatch(/LOOM_ADMIN_RG/);
    expect(r.remediation).not.toMatch(/reach management\.azure\.com/i);
  });

  it('a transport failure says the endpoint was unreachable AND that a token was acquired', async () => {
    armMock.armGet.mockRejectedValue(new Error('getaddrinfo ENOTFOUND management.azure.com'));
    const r = await armProbe();

    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/transport error/i);
    expect(r.remediation).toMatch(/A token WAS acquired/);
  });

  it('a credential failure says the request never left the app — it does not blame the network', async () => {
    armMock.armGet.mockRejectedValue(new Error('Failed to acquire ARM token'));
    const r = await armProbe();

    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/never left the Console/i);
    expect(r.remediation).toMatch(/ARM reachability was NOT tested/);
  });

  it('a clean read passes with the resolved resource group', async () => {
    armMock.armGet.mockResolvedValue({ name: RG, location: 'centralus' });
    const r = await armProbe();

    expect(r.status).toBe('pass');
    expect(r.detail).toContain('centralus');
    expect(r.inconclusive).toBeUndefined();
    expect(armMock.armGet).toHaveBeenCalledTimes(1);
  });

  it('genuinely-missing config still fails hard, and ships the env Fix-it for it', async () => {
    delete process.env.LOOM_SUBSCRIPTION_ID;
    armMock.armGet.mockResolvedValue({ name: RG, location: 'centralus' });
    const r = await armProbe();

    expect(r.status).toBe('fail');
    expect(r.inconclusive).toBeUndefined();
    expect(r.detail).toMatch(/LOOM_SUBSCRIPTION_ID/);
    expect(r.portalSteps?.join(' ')).toMatch(/LOOM_SUBSCRIPTION_ID/);
    // The probe never reached ARM at all.
    expect(armMock.armGet).not.toHaveBeenCalled();
  });

  it('the retry budget is strictly larger than the first attempt', () => {
    expect(ARM_PROBE_RETRY_BUDGET_MS).toBeGreaterThan(ARM_PROBE_BUDGET_MS);
  });
});
