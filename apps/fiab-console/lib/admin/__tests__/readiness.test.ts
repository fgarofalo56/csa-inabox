/**
 * Unit tests for the readiness compute (WS-H).
 *
 * These pin the H1/H2/H3 derivation logic against the REAL gate registry
 * (lib/gates/registry) with synthetic status + probe inputs, so the
 * go/no-go rules and the tenant-profile export are exercised without any I/O.
 */
import { describe, it, expect } from 'vitest';
import { GATES, type GateStatus } from '@/lib/gates/registry';
import {
  WORKLOADS,
  GATE_PROBE_MAP,
  buildCapabilityNodes,
  computeWorkloads,
  scoreWorkload,
  buildReadiness,
  buildTenantProfile,
  renderProfileMarkdown,
  type ProbeLite,
} from '@/lib/admin/readiness';

const GATE_IDS = new Set(GATES.map((g) => g.id));

/** Build a GateStatus[] where the given ids are configured; the rest blocked. */
function statusesWith(configured: string[]): GateStatus[] {
  const set = new Set(configured);
  return GATES.map((g) => {
    const isConfigured = set.has(g.id);
    const missing = isConfigured ? [] : g.requiredSettings.map((r) => r.envVar);
    return {
      id: g.id,
      status: isConfigured ? 'configured' : 'blocked',
      missing,
      check: { id: g.id, category: g.category, title: g.title, severity: g.severity, status: isConfigured ? 'pass' : 'warn', detail: '' },
    } as GateStatus;
  });
}

describe('readiness — workload registry integrity', () => {
  it('every workload capability id exists in the real gate registry (no drift)', () => {
    for (const w of WORKLOADS) {
      for (const id of w.capabilityIds) {
        expect(GATE_IDS.has(id), `${w.id} → ${id}`).toBe(true);
      }
    }
  });

  it('every GATE_PROBE_MAP key is a real gate id', () => {
    for (const gateId of Object.keys(GATE_PROBE_MAP)) {
      expect(GATE_IDS.has(gateId), gateId).toBe(true);
    }
  });

  it('workload ids and titles are unique', () => {
    expect(new Set(WORKLOADS.map((w) => w.id)).size).toBe(WORKLOADS.length);
    expect(new Set(WORKLOADS.map((w) => w.title)).size).toBe(WORKLOADS.length);
  });
});

describe('buildCapabilityNodes — H1', () => {
  it('emits one node per gate with derived env presence', () => {
    const nodes = buildCapabilityNodes({ gates: GATES, statuses: statusesWith([]), probes: [] });
    expect(nodes.length).toBe(GATES.length);
    const cosmos = nodes.find((n) => n.id === 'cosmos-config')!;
    expect(cosmos.requiredEnv.length).toBeGreaterThan(0);
    // Blocked (nothing configured) → every required env var absent.
    expect(cosmos.requiredEnv.every((e) => !e.present || !e.required)).toBe(true);
  });

  it('a blocked critical gate is state=blocked with its missing vars', () => {
    const nodes = buildCapabilityNodes({ gates: GATES, statuses: statusesWith([]), probes: [] });
    const cosmos = nodes.find((n) => n.id === 'cosmos-config')!;
    expect(cosmos.gateStatus).toBe('blocked');
    expect(cosmos.state).toBe('blocked');
    expect(cosmos.missing.length).toBeGreaterThan(0);
    expect(cosmos.remediation).toBeTruthy();
  });

  it('a configured gate with no probe is ready but verified config-only', () => {
    const nodes = buildCapabilityNodes({ gates: GATES, statuses: statusesWith(['svc-airflow']), probes: [] });
    const n = nodes.find((x) => x.id === 'svc-airflow')!;
    expect(n.state).toBe('ready');
    expect(n.verified).toBe('config-only');
    expect(n.probe).toBeNull();
  });

  it('a configured gate with a passing probe is ready + live-probe verified', () => {
    const probes: ProbeLite[] = [{ id: GATE_PROBE_MAP['svc-adls'], status: 'pass', detail: 'lake reachable' }];
    const nodes = buildCapabilityNodes({ gates: GATES, statuses: statusesWith(['svc-adls']), probes });
    const n = nodes.find((x) => x.id === 'svc-adls')!;
    expect(n.state).toBe('ready');
    expect(n.verified).toBe('live-probe');
    expect(n.probe?.status).toBe('pass');
  });

  it('a configured gate with a warning probe is partial', () => {
    const probes: ProbeLite[] = [{ id: GATE_PROBE_MAP['svc-synapse'], status: 'warn', detail: 'denied', remediation: 'grant Synapse Administrator' }];
    const nodes = buildCapabilityNodes({ gates: GATES, statuses: statusesWith(['svc-synapse']), probes });
    const n = nodes.find((x) => x.id === 'svc-synapse')!;
    expect(n.state).toBe('partial');
    expect(n.remediation).toContain('Synapse Administrator');
  });

  it('a configured gate with a failing probe is blocked (configured-but-broken)', () => {
    const probes: ProbeLite[] = [{ id: GATE_PROBE_MAP['svc-adx'], status: 'fail', detail: 'unauthorized', remediation: 'grant AllDatabasesViewer' }];
    const nodes = buildCapabilityNodes({ gates: GATES, statuses: statusesWith(['svc-adx']), probes });
    const n = nodes.find((x) => x.id === 'svc-adx')!;
    expect(n.state).toBe('blocked');
    expect(n.verified).toBe('live-probe');
    expect(n.remediation).toContain('AllDatabasesViewer');
  });

  it('an auto-resolving optional-default gate with NO probe is ready (config-only) when unset', () => {
    // Only the PROBE-LESS auto-resolvable gates keep the config-only promotion
    // (D15): with no live signal, "the deploy fills this / the fallback is the
    // default" is the best-available truth — and it is disclosed as config-only.
    const autoGate = GATES.find((g) => g.canAutoResolve && !GATE_PROBE_MAP[g.id]);
    expect(autoGate, 'registry has at least one probe-less auto-resolvable gate').toBeTruthy();
    const nodes = buildCapabilityNodes({ gates: GATES, statuses: statusesWith([]), probes: [] });
    const n = nodes.find((x) => x.id === autoGate!.id)!;
    expect(n.state).toBe('ready');
    expect(n.verified).toBe('config-only');
  });

  it('a blocked auto-resolvable gate with a FAILING probe is NOT promoted to ready (D15)', () => {
    // Before this fix `blocked + canAutoResolve → ready` unconditionally: a
    // derived var the deploy never filled scored ready while the live probe
    // said fail. The probe result must decide.
    const autoGate = GATES.find((g) => g.canAutoResolve && GATE_PROBE_MAP[g.id]);
    expect(autoGate, 'registry has at least one probed auto-resolvable gate').toBeTruthy();
    const probeId = GATE_PROBE_MAP[autoGate!.id];
    const probes: ProbeLite[] = [{ id: probeId, status: 'fail', detail: 'backend unreachable', remediation: 'deploy the backing module' }];
    const nodes = buildCapabilityNodes({ gates: GATES, statuses: statusesWith([]), probes });
    const n = nodes.find((x) => x.id === autoGate!.id)!;
    expect(n.state).toBe('blocked');
    expect(n.verified).toBe('live-probe');
    expect(n.remediation).toContain('deploy the backing module');
  });

  it('a blocked auto-resolvable gate with a WARNING probe is partial, with a PASS it is ready + live-probe (D15)', () => {
    const autoGate = GATES.find((g) => g.canAutoResolve && GATE_PROBE_MAP[g.id]);
    expect(autoGate, 'registry has at least one probed auto-resolvable gate').toBeTruthy();
    const probeId = GATE_PROBE_MAP[autoGate!.id];
    const warn = buildCapabilityNodes({
      gates: GATES, statuses: statusesWith([]),
      probes: [{ id: probeId, status: 'warn', detail: 'degraded', remediation: 'grant the role' }],
    }).find((x) => x.id === autoGate!.id)!;
    expect(warn.state).toBe('partial');
    expect(warn.verified).toBe('live-probe');
    const pass = buildCapabilityNodes({
      gates: GATES, statuses: statusesWith([]),
      probes: [{ id: probeId, status: 'pass', detail: 'live' }],
    }).find((x) => x.id === autoGate!.id)!;
    expect(pass.state).toBe('ready');
    expect(pass.verified).toBe('live-probe');
  });

  it('an opt-in gate renders state=opt-in (not blocked) when its var is unset', () => {
    // issue #2753: an additive, non-default feature (the EXPLICIT `EnvSpec.optIn`
    // flag, e.g. svc-postgres) must NOT read as a red misconfiguration.
    // Its GateStatus is 'opt-in'; buildCapabilityNodes must preserve that.
    const target = GATES[0].id;
    const statuses = statusesWith([]).map((st) =>
      st.id === target
        ? ({ ...st, status: 'opt-in' as const, missing: ['LOOM_SOME_OPT_IN_URL'] })
        : st,
    );
    const nodes = buildCapabilityNodes({ gates: GATES, statuses, probes: [] });
    const n = nodes.find((x) => x.id === target)!;
    expect(n.state).toBe('opt-in');
    expect(n.gateStatus).toBe('opt-in');
    // Scores as healthy (1), so it never drags a workload verdict down.
    const others = nodes.filter((x) => x.id !== target && x.state === 'blocked');
    expect(others.length).toBeGreaterThan(0); // sanity: blocked still exists and differs
  });

  it('an opt-in gate with a PASSING live probe upgrades to ready', () => {
    // If the operator DID opt in and the backend answers, show ready.
    const target = GATES.find((g) => GATE_PROBE_MAP[g.id])?.id ?? GATES[0].id;
    const probeId = GATE_PROBE_MAP[target];
    const statuses = statusesWith([]).map((st) =>
      st.id === target ? ({ ...st, status: 'opt-in' as const }) : st,
    );
    const probes: ProbeLite[] = probeId
      ? [{ id: probeId, status: 'pass', detail: 'live', remediation: '' }]
      : [];
    const nodes = buildCapabilityNodes({ gates: GATES, statuses, probes });
    const n = nodes.find((x) => x.id === target)!;
    expect(n.state).toBe(probeId ? 'ready' : 'opt-in');
  });
});

describe('scoreWorkload / computeWorkloads — H2', () => {
  it('a workload with all capabilities configured + no probes is ready', () => {
    const core = WORKLOADS.find((w) => w.id === 'core-platform')!;
    const nodes = buildCapabilityNodes({ gates: GATES, statuses: statusesWith(core.capabilityIds), probes: [] });
    const score = scoreWorkload(core, nodes);
    expect(score.state).toBe('ready');
    expect(score.score).toBe(100);
    expect(score.blockers.length).toBe(0);
  });

  it('a critical-blocked capability forces the workload to blocked', () => {
    const core = WORKLOADS.find((w) => w.id === 'core-platform')!;
    // Configure all but the critical cosmos-config.
    const configured = core.capabilityIds.filter((id) => id !== 'cosmos-config');
    const nodes = buildCapabilityNodes({ gates: GATES, statuses: statusesWith(configured), probes: [] });
    const score = scoreWorkload(core, nodes);
    expect(score.state).toBe('blocked');
    expect(score.blockers.some((b) => b.id === 'cosmos-config')).toBe(true);
  });

  it('a partial mix (no critical block) is partial', () => {
    // Data Integration is all recommended/optional — configure some, not all.
    const di = WORKLOADS.find((w) => w.id === 'data-integration')!;
    const configured = di.capabilityIds.slice(0, 2);
    const nodes = buildCapabilityNodes({ gates: GATES, statuses: statusesWith(configured), probes: [] });
    const score = scoreWorkload(di, nodes);
    expect(score.state).toBe('partial');
    expect(score.summary.blocked).toBeGreaterThan(0);
    expect(score.summary.ready).toBeGreaterThan(0);
  });

  it('computeWorkloads returns a score per registered workload', () => {
    const nodes = buildCapabilityNodes({ gates: GATES, statuses: statusesWith([]), probes: [] });
    const scores = computeWorkloads(nodes);
    expect(scores.length).toBe(WORKLOADS.length);
  });
});

describe('buildReadiness / summary', () => {
  it('summarizes capability + workload counts and overall score', () => {
    const report = buildReadiness(
      { gates: GATES, statuses: statusesWith([]), probes: [] },
      { generatedAt: '2026-07-20T00:00:00.000Z', cloud: 'AzureCloud' },
    );
    expect(report.capabilities.length).toBe(GATES.length);
    expect(report.workloads.length).toBe(WORKLOADS.length);
    expect(report.summary.capabilities.total).toBe(GATES.length);
    expect(report.summary.score).toBeGreaterThanOrEqual(0);
    expect(report.summary.score).toBeLessThanOrEqual(100);
    expect(report.generatedAt).toBe('2026-07-20T00:00:00.000Z');
    expect(report.cloud).toBe('AzureCloud');
  });
});

describe('buildTenantProfile + renderProfileMarkdown — H3', () => {
  it('lists every non-ready capability as a blocker with remediation', () => {
    const profile = buildTenantProfile(
      { gates: GATES, statuses: statusesWith([]), probes: [] },
      { generatedAt: '2026-07-20T00:00:00.000Z', cloud: 'AzureCloud', environment: { app: 'loom-console', subscription: 'sub-123' } },
    );
    expect(profile.blockers.length).toBeGreaterThan(0);
    expect(profile.blockers.every((b) => typeof b.remediation === 'string')).toBe(true);
    expect(profile.environment.app).toBe('loom-console');
  });

  it('markdown carries the timestamp, environment, workload table, and remediation', () => {
    const profile = buildTenantProfile(
      { gates: GATES, statuses: statusesWith([]), probes: [] },
      { generatedAt: '2026-07-20T00:00:00.000Z', cloud: 'AzureCloud', environment: { app: 'loom-console', subscription: 'sub-123' } },
    );
    const md = renderProfileMarkdown(profile);
    expect(md).toContain('# CSA Loom — Ready-to-run tenant profile');
    expect(md).toContain('2026-07-20T00:00:00.000Z');
    expect(md).toContain('loom-console');
    expect(md).toContain('| Workload | Status | Score |');
    expect(md).toContain('Blocked / partial dependencies');
    // A known critical blocker appears with its remediation heading.
    expect(md).toContain('cosmos-config');
  });

  it('all-ready profile renders the celebratory empty-blockers section', () => {
    const allIds = GATES.map((g) => g.id);
    const profile = buildTenantProfile(
      { gates: GATES, statuses: statusesWith(allIds), probes: [] },
      { generatedAt: '2026-07-20T00:00:00.000Z' },
    );
    // Configured everything, no failing probes → no blockers.
    expect(profile.blockers.length).toBe(0);
    const md = renderProfileMarkdown(profile);
    expect(md).toContain('All capabilities are ready');
  });
});

/**
 * #3729 — a probe that did not COMPLETE proves nothing, and must never be
 * scored as a proven failure.
 *
 * On the live Commercial console the `subscription` capability (severity
 * critical, probe `probe-arm-reader`) reported Blocked with a connectivity
 * diagnosis. Measured: ARM was reachable and the probe returned `pass` — the
 * Blocked verdict was the probe's own 6 s timeout, and because the capability
 * is critical it took the whole Core platform workload no-go. `unknown` is the
 * third outcome that was missing.
 */
describe('readiness — an inconclusive probe is "unknown", never "blocked"', () => {
  const CRITICAL_PROBED = 'subscription';
  const probeId = GATE_PROBE_MAP[CRITICAL_PROBED];

  /** Every gate configured; the ARM probe did not finish. */
  function inconclusiveRun() {
    const probes: ProbeLite[] = [{
      id: probeId,
      status: 'warn',
      inconclusive: true,
      detail: 'Could not establish whether ARM is readable — the check did not complete.',
      remediation: 'No operator action is known to be required. Re-check to re-probe.',
    }];
    return buildReadiness({ gates: GATES, statuses: statusesWith(GATES.map((g) => g.id)), probes });
  }

  it('the capability is unknown — not blocked, not partial, not ready', () => {
    const n = inconclusiveRun().capabilities.find((c) => c.id === CRITICAL_PROBED)!;
    expect(n.severity).toBe('critical');
    expect(n.gateStatus).toBe('configured');
    expect(n.state).toBe('unknown');
    expect(n.verified).toBe('live-probe');
    expect(n.probe?.inconclusive).toBe(true);
    // The surface must repeat the probe's honest wording, not the gate's
    // "set LOOM_SUBSCRIPTION_ID …" remediation for values that ARE set.
    expect(n.missing).toEqual([]);
    expect(n.remediation).toMatch(/No operator action is known to be required/);
  });

  it('its workload does NOT go no-go on a check that never completed', () => {
    const report = inconclusiveRun();
    const core = report.workloads.find((w) => w.id === 'core-platform')!;
    expect(core.capabilityIds).toContain(CRITICAL_PROBED);
    expect(core.state).not.toBe('blocked');
    expect(core.summary.blocked).toBe(0);
    expect(core.summary.unknown).toBe(1);
  });

  it('is counted separately in the summary and does not zero the score', () => {
    const report = inconclusiveRun();
    expect(report.summary.capabilities.unknown).toBe(1);
    expect(report.summary.capabilities.blocked).toBe(0);
    // Neither credited (would hide an outage) nor condemned (would let a
    // transient timeout move the operator's headline number).
    const allReady = buildReadiness({ gates: GATES, statuses: statusesWith(GATES.map((g) => g.id)), probes: [] });
    expect(report.summary.score).toBeLessThan(allReady.summary.score);
    expect(report.summary.score).toBeGreaterThan(0);
  });

  it('a warn WITHOUT the inconclusive flag is still partial (a completed, degraded check)', () => {
    const probes: ProbeLite[] = [{ id: probeId, status: 'warn', detail: 'degraded but observed', remediation: 'grant the role' }];
    const report = buildReadiness({ gates: GATES, statuses: statusesWith(GATES.map((g) => g.id)), probes });
    const n = report.capabilities.find((c) => c.id === CRITICAL_PROBED)!;
    expect(n.state).toBe('partial');
    expect(report.summary.capabilities.unknown).toBe(0);
  });

  it('a FAILING probe still blocks — an established negative is still a negative', () => {
    const probes: ProbeLite[] = [{ id: probeId, status: 'fail', detail: 'ARM refused the read (403)', remediation: 'grant Reader' }];
    const report = buildReadiness({ gates: GATES, statuses: statusesWith(GATES.map((g) => g.id)), probes });
    const n = report.capabilities.find((c) => c.id === CRITICAL_PROBED)!;
    expect(n.state).toBe('blocked');
    expect(n.remediation).toBe('grant Reader');
    expect(report.workloads.find((w) => w.id === 'core-platform')!.state).toBe('blocked');
  });

  it('the exported profile files it under "Not established", NOT under Blocked', () => {
    const probes: ProbeLite[] = [{
      id: probeId, status: 'warn', inconclusive: true,
      detail: 'Could not establish whether ARM is readable.',
      remediation: 'Re-check to re-probe.',
    }];
    const profile = buildTenantProfile(
      { gates: GATES, statuses: statusesWith(GATES.map((g) => g.id)), probes },
      { generatedAt: '2026-08-19T00:00:00.000Z' },
    );
    // It IS enumerated (the export lists every non-ready capability) …
    const b = profile.blockers.find((x) => x.id === CRITICAL_PROBED)!;
    expect(b).toBeTruthy();
    // … and it carries the state that says which kind of non-ready it is.
    expect(b.state).toBe('unknown');

    const md = renderProfileMarkdown(profile);
    expect(md).toContain('| Workload | Status | Score | Ready | Partial | Blocked | Not established |');
    expect(md).toContain('## Not established — the live check did not complete');
    expect(md).toContain('NOT found broken');
    // The ONLY non-ready capability here is the inconclusive one, so the
    // Blocked heading must not appear at all — an auditor reading this export
    // must not see a timeout filed as an outage.
    expect(md).not.toContain('## Blocked / partial dependencies');
    // And it appears AFTER the Not-established heading, i.e. inside that section.
    expect(md.indexOf(`(\`${CRITICAL_PROBED}\`)`)).toBeGreaterThan(md.indexOf('## Not established'));
  });

  it('a real blocker and an inconclusive one are filed in DIFFERENT sections', () => {
    const probes: ProbeLite[] = [
      { id: probeId, status: 'warn', inconclusive: true, detail: 'did not complete', remediation: 'Re-check.' },
      { id: GATE_PROBE_MAP['svc-adx'], status: 'fail', detail: 'ARM refused the read (403)', remediation: 'grant AllDatabasesViewer' },
    ];
    const profile = buildTenantProfile(
      { gates: GATES, statuses: statusesWith(GATES.map((g) => g.id)), probes },
      { generatedAt: '2026-08-19T00:00:00.000Z' },
    );
    const md = renderProfileMarkdown(profile);
    expect(md).toContain('## Blocked / partial dependencies + remediation');
    expect(md).toContain('## Not established — the live check did not complete');
    expect(md.indexOf('(`svc-adx`)')).toBeLessThan(md.indexOf('## Not established'));
    expect(md.indexOf(`(\`${CRITICAL_PROBED}\`)`)).toBeGreaterThan(md.indexOf('## Not established'));
  });
});
