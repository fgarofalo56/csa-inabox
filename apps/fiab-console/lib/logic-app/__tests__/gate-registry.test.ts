/**
 * The Logic Apps gate is REGISTERED (G2, `.claude/rules/ux-baseline.md`).
 *
 * Before #2954 the workflow feature's only remediation was a bespoke MessageBar
 * that named `LOOM_LOGIC_LOCATION` / `LOOM_AZURE_LOCATION` — variables NOTHING
 * in the platform sets. It was absent from the central gate registry entirely,
 * so `/admin/gates` never listed it and Copilot could not discover or resolve
 * it. G2 requires every unavoidable gate to (a) offer an inline Fix-it, (b) live
 * in the registry, (c) appear on the admin gate page — all three follow from the
 * registry entry asserted here.
 *
 * These assertions import the REAL registry (no mocks) so they fail if the
 * entry is deleted, renamed, or drifts away from the variables the bicep emits.
 */
import { describe, it, expect } from 'vitest';
import { getGate, GATES } from '@/lib/gates/registry';
import { LOGIC_APP_GATE_ID } from '../auto-bind';

describe('svc-logic-apps gate registration', () => {
  it('the id the auto-bind module reports resolves to a real registry gate', () => {
    expect(LOGIC_APP_GATE_ID).toBe('svc-logic-apps');
    expect(getGate(LOGIC_APP_GATE_ID)).toBeDefined();
    expect(GATES.some((g) => g.id === LOGIC_APP_GATE_ID)).toBe(true);
  });

  it('names the workflow designer + BFF as its surfaces', () => {
    const g = getGate(LOGIC_APP_GATE_ID)!;
    const paths = g.surfaces.map((s) => s.path);
    expect(paths).toContain('/items/logic-app');
    expect(paths.some((p) => p.startsWith('/api/items/logic-app'))).toBe(true);
  });

  it('accepts the variables the platform bicep actually stamps', () => {
    // Each of these is emitted by admin-plane/main.bicep onto the Console
    // container app. A gate whose settings do not include them is unsatisfiable
    // on a push-button deploy — the exact #2954 failure mode.
    const vars = getGate(LOGIC_APP_GATE_ID)!.requiredSettings.flatMap((s) => [s.envVar, ...(s.aliasOf || [])]);
    expect(vars).toContain('LOOM_SUBSCRIPTION_ID');
    expect(vars).toContain('LOOM_DLZ_RG');
    expect(vars).toContain('LOOM_LOCATION');
  });

  it('does NOT advertise the never-set LOOM_AZURE_LOCATION as the way to satisfy it', () => {
    const vars = getGate(LOGIC_APP_GATE_ID)!.requiredSettings.flatMap((s) => [s.envVar, ...(s.aliasOf || [])]);
    expect(vars).not.toContain('LOOM_AZURE_LOCATION');
  });

  it('auto-resolves on a push-button deploy (zero day-one operator input)', () => {
    const g = getGate(LOGIC_APP_GATE_ID)!;
    expect(g.canAutoResolve).toBe(true);
    expect(g.provisionedBy).toMatch(/logic-app\.bicep/);
  });

  it('names the RESOURCE-GROUP-scoped role — a workflow-scoped grant 403s every create', () => {
    const g = getGate(LOGIC_APP_GATE_ID)!;
    expect(g.role).toMatch(/Logic App Contributor/);
    expect(g.role).toMatch(/RESOURCE-GROUP scope/);
  });

  it('maps the legacy bespoke error codes onto itself', () => {
    const g = getGate(LOGIC_APP_GATE_ID)!;
    expect(g.legacyCodes).toContain('logic_app_not_configured');
  });
});
