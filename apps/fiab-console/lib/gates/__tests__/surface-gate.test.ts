/**
 * #4776 — surfaceGateFrom normalises a route's gate-shaped body for HonestGate.
 * Each case names the body that would break it.
 */
import { describe, it, expect } from 'vitest';
import { surfaceGateFrom, gateIdForEnvVar } from '../surface-gate';

describe('surfaceGateFrom', () => {
  it('a classified warehouse body → the gate + a classified block (cause, remediation, entitlement)', () => {
    const g = surfaceGateFrom({
      ok: false, code: 'warehouse_permission', gateId: 'svc-databricks-sql', kind: 'permission',
      error: 'refused', remediation: 'grant it', entitlement: 'databricks-sql-access',
    });
    // Breaks if a classified body is not recognised (null → the page falls to setError).
    expect(g).toEqual({
      gateId: 'svc-databricks-sql', missing: undefined, error: 'refused',
      classified: { kind: 'permission', error: 'refused', remediation: 'grant it', entitlement: 'databricks-sql-access' },
    });
  });

  it('a classified not-configured body → the gate with its missing var, NOT a classified block', () => {
    const g = surfaceGateFrom({ ok: false, code: 'not_configured', gateId: 'svc-databricks-sql', kind: 'not-configured', missing: 'LOOM_DATABRICKS_HOSTNAME', error: 'no workspace' });
    expect(g).toEqual({ gateId: 'svc-databricks-sql', missing: 'LOOM_DATABRICKS_HOSTNAME', error: 'no workspace' });
  });

  it('a legacy not_configured body (no gateId) → the registry gate that requires the missing var', () => {
    const g = surfaceGateFrom({ ok: false, code: 'not_configured', missing: 'LOOM_DATABRICKS_HOSTNAME', error: 'set it' });
    // Breaks if the lookup picks a gate that does not require the var.
    expect(g?.gateId).toBe('svc-databricks');
    expect(g?.missing).toBe('LOOM_DATABRICKS_HOSTNAME');
    expect(g?.classified).toBeUndefined();
  });

  it('an unknown var yields gateId "" (HonestGate then renders its honest generic bar)', () => {
    expect(gateIdForEnvVar('LOOM_NOT_A_REAL_VAR_4776')).toBe('');
    expect(surfaceGateFrom({ ok: false, code: 'not_configured', missing: 'LOOM_NOT_A_REAL_VAR_4776' })?.gateId).toBe('');
  });

  it('non-gate bodies → null (the caller keeps its ordinary error path)', () => {
    expect(surfaceGateFrom({ ok: true, constraints: [] })).toBeNull();
    expect(surfaceGateFrom({ ok: false, error: 'TABLE_OR_VIEW_NOT_FOUND' })).toBeNull();
    expect(surfaceGateFrom([])).toBeNull();
    expect(surfaceGateFrom(null)).toBeNull();
    expect(surfaceGateFrom({ error: 'x' })).toBeNull(); // a {error} constraints half with no ok:false
  });
});
