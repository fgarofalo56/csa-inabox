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

  it('an auto-resolving optional-default gate is ready even when unset', () => {
    const autoGate = GATES.find((g) => g.canAutoResolve);
    expect(autoGate, 'registry has at least one auto-resolvable gate').toBeTruthy();
    const nodes = buildCapabilityNodes({ gates: GATES, statuses: statusesWith([]), probes: [] });
    const n = nodes.find((x) => x.id === autoGate!.id)!;
    expect(n.state).toBe('ready');
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
