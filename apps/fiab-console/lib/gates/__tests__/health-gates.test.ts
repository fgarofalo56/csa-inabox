/**
 * LHDS W1-7 gates: health-control-plane, health-stamp-capacity,
 * health-gov-image-gate, health-lakehouse-isolation.
 *
 * Each case sets the env a real estate would carry and asserts the status the
 * gate must produce; the comment on each names the value that flips it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getGate, gateStatus } from '../registry';
import { getCapability, ancestorIds } from '@/lib/auth/feature-catalog';

const IDS = ['health-control-plane', 'health-stamp-capacity', 'health-gov-image-gate', 'health-lakehouse-isolation', 'health-auth-graph-consent'] as const;
const VARS = [
  'LOOM_HEALTH_CP_URL', 'LOOM_HEALTH_CP_AUDIENCE', 'LOOM_HEALTH_DEFAULT_STAMP_ID',
  'LOOM_HEALTH_GOV_STAMP_ID', 'LOOM_HEALTH_GOV_IMAGE_ATTESTATION', 'LOOM_HEALTH_LAKEHOUSE_ISOLATION', 'LOOM_HEALTH_AUTH_GRAPH_CONSENT',
];

function clean() { for (const v of VARS) vi.stubEnv(v, ''); }
afterEach(() => vi.unstubAllEnvs());

describe('health gates are registered with an inline Fix-it', () => {
  it.each(IDS)('%s exists, names surfaces and settings, and has a Fix-it of a supported kind', (id) => {
    const g = getGate(id);
    expect(g, `gate ${id} missing from the registry`).toBeDefined();
    expect(g!.surfaces.length).toBeGreaterThan(0);
    expect(g!.requiredSettings.length).toBeGreaterThan(0);
    expect(['env-picker', 'wizard']).toContain(g!.fixit.kind);
    // A wizard Fix-it with no note would be a button that explains nothing.
    if (g!.fixit.kind === 'wizard') expect(g!.fixit.grantNote?.length ?? 0).toBeGreaterThan(40);
  });

  it('no health gate claims a `provision` Fix-it: deploy-health.yml has no dispatch input for it', () => {
    for (const id of IDS) expect(getGate(id)!.fixit.kind, id).not.toBe('provision');
  });
});

describe('health gate evaluation', () => {
  it('on an estate that never enabled health: control plane is opt-in (neutral), the other three are configured (not applicable)', () => {
    clean();
    expect(gateStatus('health-control-plane')!.status).toBe('opt-in');
    // appliesWhenPresent: with LOOM_HEALTH_CP_URL / GOV_STAMP_ID unset they must say nothing.
    expect(gateStatus('health-stamp-capacity')!.status).toBe('configured');
    expect(gateStatus('health-gov-image-gate')!.status).toBe('configured');
    expect(gateStatus('health-lakehouse-isolation')!.status).toBe('configured');
  });

  it('control plane flips to configured only with BOTH url and audience (audience unset keeps it unmet)', () => {
    clean();
    vi.stubEnv('LOOM_HEALTH_CP_URL', 'https://loom-health-cp.example.azurecontainerapps.io');
    const half = gateStatus('health-control-plane')!;
    expect(half.status).not.toBe('configured');
    expect(half.missing).toEqual(['LOOM_HEALTH_CP_AUDIENCE']);
    vi.stubEnv('LOOM_HEALTH_CP_AUDIENCE', 'api://loom-health-cp');
    expect(gateStatus('health-control-plane')!.status).toBe('configured');
  });

  it('a bind-all control-plane URL (0.0.0.0) does NOT satisfy the gate', () => {
    clean();
    vi.stubEnv('LOOM_HEALTH_CP_URL', 'https://0.0.0.0:8080');
    vi.stubEnv('LOOM_HEALTH_CP_AUDIENCE', 'api://loom-health-cp');
    expect(gateStatus('health-control-plane')!.status).not.toBe('configured');
  });

  it('once health is deployed, stamp-capacity is BLOCKED until a default stamp is named', () => {
    clean();
    vi.stubEnv('LOOM_HEALTH_CP_URL', 'https://loom-health-cp.example.azurecontainerapps.io');
    const s = gateStatus('health-stamp-capacity')!;
    expect(s.status).toBe('blocked');
    expect(s.missing).toEqual(['LOOM_HEALTH_DEFAULT_STAMP_ID']);
    vi.stubEnv('LOOM_HEALTH_DEFAULT_STAMP_ID', 'east-s1');
    expect(gateStatus('health-stamp-capacity')!.status).toBe('configured');
  });

  it('lakehouse isolation: "false" / "unverified" do NOT satisfy it; "verified" does', () => {
    clean();
    vi.stubEnv('LOOM_HEALTH_CP_URL', 'https://loom-health-cp.example.azurecontainerapps.io');
    expect(gateStatus('health-lakehouse-isolation')!.status).toBe('blocked');
    for (const v of ['false', 'unverified', '0']) {
      vi.stubEnv('LOOM_HEALTH_LAKEHOUSE_ISOLATION', v);
      expect(gateStatus('health-lakehouse-isolation')!.status, `value ${v}`).toBe('blocked');
    }
    vi.stubEnv('LOOM_HEALTH_LAKEHOUSE_ISOLATION', 'verified');
    expect(gateStatus('health-lakehouse-isolation')!.status).toBe('configured');
  });

  it('Graph consent: silent until health is deployed, then blocked until "granted"; "needs-consent" does NOT satisfy it', () => {
    clean();
    expect(gateStatus('health-auth-graph-consent')!.status).toBe('configured');
    vi.stubEnv('LOOM_HEALTH_CP_URL', 'https://loom-health-cp.example.azurecontainerapps.io');
    expect(gateStatus('health-auth-graph-consent')!.status).toBe('blocked');
    // A value that says consent is still outstanding must not flip the gate that detects it.
    for (const v of ['needs-consent', 'pending', 'false']) {
      vi.stubEnv('LOOM_HEALTH_AUTH_GRAPH_CONSENT', v);
      expect(gateStatus('health-auth-graph-consent')!.status, `value ${v}`).toBe('blocked');
    }
    vi.stubEnv('LOOM_HEALTH_AUTH_GRAPH_CONSENT', 'granted');
    expect(gateStatus('health-auth-graph-consent')!.status).toBe('configured');
  });

  it('Gov image gate applies only when a Gov stamp exists, then needs the attestation', () => {
    clean();
    vi.stubEnv('LOOM_HEALTH_GOV_STAMP_ID', 'usgov-s1');
    expect(gateStatus('health-gov-image-gate')!.status).toBe('blocked');
    vi.stubEnv('LOOM_HEALTH_GOV_IMAGE_ATTESTATION', '40300000001');
    expect(gateStatus('health-gov-image-gate')!.status).toBe('configured');
  });
});

describe('Health Tenant Admin capability (D12)', () => {
  it('exists, and a grant on Tenant administration does NOT cascade to it (no parent)', () => {
    const c = getCapability('health.tenant-admin');
    expect(c?.name).toBe('Health Tenant Admin');
    // Adding parentId 'workload.admin' would make this chain ['health.tenant-admin','workload.admin'].
    expect(c?.parentId).toBeUndefined();
    expect(ancestorIds('health.tenant-admin')).toEqual(['health.tenant-admin']);
  });
});
