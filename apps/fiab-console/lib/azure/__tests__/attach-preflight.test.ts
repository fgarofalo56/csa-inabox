/**
 * Pins the brownfield attach preflight logic (attach-preflight): network-posture
 * derivation from an ARM properties bag + the composed verdict (reachability,
 * PE-needed flagging, the exact navigator role the UAMI needs), all honest.
 */
import { describe, it, expect } from 'vitest';
import { deriveNetworkPosture, composePreflight, preflightToValidation } from '../attach-preflight';

const adxId = '/subscriptions/s/resourceGroups/r/providers/Microsoft.Kusto/clusters/c1';

describe('attach-preflight', () => {
  it('derives public posture when public access is enabled + no PE', () => {
    expect(deriveNetworkPosture({ publicNetworkAccess: 'Enabled' })).toBe('public');
  });

  it('derives private-endpoint posture when public is disabled', () => {
    expect(deriveNetworkPosture({ publicNetworkAccess: 'Disabled' })).toBe('private-endpoint');
    expect(deriveNetworkPosture({ privateEndpointConnections: [{ id: 'pe1' }], publicNetworkAccess: 'Disabled' })).toBe('private-endpoint');
  });

  it('reads networkAcls defaultAction Deny as a locked-down posture', () => {
    expect(deriveNetworkPosture({ networkAcls: { defaultAction: 'Deny' } })).toBe('service-endpoint');
  });

  it('returns unknown for a missing property bag', () => {
    expect(deriveNetworkPosture(undefined)).toBe('unknown');
  });

  it('composes a reachable+ok verdict for a public resource, naming the ADX role', () => {
    const p = composePreflight(adxId, 'adx', { status: 200, properties: { publicNetworkAccess: 'Enabled' } });
    expect(p.reachability).toBe('reachable');
    expect(p.ok).toBe(true);
    expect(p.rbacState).toBe('pending');
    expect(p.rbacScope).toBe(adxId);
    expect(p.rbacRoleName).toBe('Contributor');
    // Even a green resource names the RBAC it still needs.
    expect(p.remediation).toContain('Contributor');
  });

  it('flags PE-needed (not fully reachable) for a private-endpoint-locked resource', () => {
    const p = composePreflight(adxId, 'adx', { status: 200, properties: { publicNetworkAccess: 'Disabled' } });
    expect(p.reachability).toBe('private-endpoint-needed');
    expect(p.networkPosture).toBe('private-endpoint');
    expect(p.ok).toBe(false);
    expect(p.remediation).toMatch(/private-endpoint/i);
  });

  it('marks a 403 as blocked with an honest remediation', () => {
    const p = composePreflight(adxId, 'adx', { status: 403 });
    expect(p.reachability).toBe('blocked');
    expect(p.ok).toBe(false);
    expect(p.remediation).toMatch(/403/);
  });

  it('projects a verdict onto the registry validation shape', () => {
    const p = composePreflight(adxId, 'adx', { status: 200, properties: { publicNetworkAccess: 'Enabled' } });
    const v = preflightToValidation(p);
    expect(v.reachability).toBe('reachable');
    expect(v.rbacState).toBe('pending');
    expect(v.rbacScope).toBe(adxId);
    expect(typeof v.checkedAt).toBe('string');
  });
});
