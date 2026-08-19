/**
 * G2 — a route-emitted gate `code` must resolve to a REAL registry gate.
 * (issue #2624)
 *
 * The defect this pins is the one #2624 hit. The Unity Catalog system-tables
 * route was hardened to return a machine-readable `code` on every gated answer,
 * which LOOKS like G2 compliance. But two of the four codes
 * (`uc_system_tables_boundary`, `uc_system_schema_grant`) existed only as string
 * literals in the route: `git grep` found them nowhere in lib/gates. So:
 *
 *   - `HonestGate` resolves a gate with `getGate(id)` and fell through to its
 *     "Gate '<id>' is not in the registry" branch — NO Fix-it button;
 *   - `/admin/gates` never listed them;
 *   - the Copilot gate tool could not discover or resolve either one.
 *
 * A code that resolves to nothing is a gate that reports itself as machine-
 * readable while carrying no machine-readable meaning — the same class as a
 * control that runs and measures nothing. This test reads the route SOURCE
 * rather than exercising the handler on purpose: a handler test only covers the
 * branches its mocks can reach, so a fifth code added tomorrow behind an
 * un-mocked condition would sail past it. Every `code:` literal in the file has
 * to name a gate, reachable or not.
 *
 * Deliberately NOT widened to "every route in the repo". Most routes still
 * return legacy bespoke codes that predate the registry; sweeping them all is a
 * separate migration, and a guard that fails on day one for 300 unrelated files
 * gets disabled rather than fixed.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getGate, gateForLegacyCode } from '../registry';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Routes whose every emitted `code` must be registry-resolvable. */
const GATE_CODE_ROUTES = [
  'app/api/databricks/unity-catalog/system-tables/route.ts',
  // #3549 — the bind routes emit a seed-incomplete code when auto-bind created
  // the pipeline but could not author its graph. Added here so the code cannot
  // become an unresolvable literal the way #2624's two did.
  'app/api/items/adf-pipeline/[id]/bind/route.ts',
  'app/api/items/synapse-pipeline/[id]/bind/route.ts',
];

/** A gate id OR a legacy code claimed by exactly one gate. */
function resolves(code: string): boolean {
  return !!(getGate(code) || gateForLegacyCode(code));
}

/** Every `code: '<literal>'` in the source (the shape gated answers return). */
function emittedCodes(src: string): string[] {
  return [...src.matchAll(/\bcode:\s*'([^']+)'/g)].map((m) => m[1]).filter((c) => !c.includes('${'));
}

describe('route gate codes resolve to registry gates (G2)', () => {
  for (const rel of GATE_CODE_ROUTES) {
    it(`${rel}: every emitted code names a gate`, () => {
      const src = fs.readFileSync(path.join(APP, rel), 'utf8');
      const codes = emittedCodes(src);
      // Guard the guard: a regex that matched nothing would pass vacuously —
      // exactly the "control that measures nothing" failure this test exists
      // to catch, so assert it actually found the codes.
      expect(codes.length, `${rel}: no code: literals found — has the shape changed?`).toBeGreaterThan(0);
      expect(codes.filter((c) => !resolves(c))).toEqual([]);
    });
  }

  it('the system-tables route emits the exact codes #2624 is about', () => {
    const src = fs.readFileSync(path.join(APP, GATE_CODE_ROUTES[0]), 'utf8');
    const codes = new Set(emittedCodes(src));
    expect(codes.has('uc_system_tables_boundary')).toBe(true);
    expect(codes.has('uc_system_schema_grant')).toBe(true);
    // NOT `uc_backend_not_oss`. The issue names that code, but the commit that
    // would have emitted it (the OSS reader + /catalog/unity pane) was split out
    // of #2611 before merge, so it is in no shipped file. The two above are the
    // codes the route actually returns.
    expect(codes.has('uc_backend_not_oss')).toBe(false);
  });

  it('both orphan codes map to the system-tables gate', () => {
    expect(gateForLegacyCode('uc_system_tables_boundary')?.id).toBe('svc-databricks-system-tables');
    expect(gateForLegacyCode('uc_system_schema_grant')?.id).toBe('svc-databricks-system-tables');
  });

  /**
   * CONTROL — passes before AND after the fix. If a later change makes the
   * lookup answer "yes" for anything (e.g. a fallback that returns the first
   * gate, or a `resolves()` widened to `true`), the guard above would still be
   * green while measuring nothing. This is the assertion that catches that.
   */
  it('CONTROL: an unregistered code still resolves to nothing', () => {
    expect(getGate('definitely_not_a_gate_2624')).toBeUndefined();
    expect(gateForLegacyCode('definitely_not_a_gate_2624')).toBeUndefined();
    expect(resolves('definitely_not_a_gate_2624')).toBe(false);
    // `uc_backend_not_oss` is NOT registered — it is not emitted by any shipped
    // code, and registering a gate for a string nothing returns would be the
    // vaporware version of closing this issue.
    expect(resolves('uc_backend_not_oss')).toBe(false);
  });
});
