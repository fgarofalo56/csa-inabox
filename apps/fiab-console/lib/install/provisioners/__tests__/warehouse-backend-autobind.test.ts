/**
 * #3513 bucket (a) — a remediation the PLATFORM could have performed itself.
 *
 * THE DEFECT: `warehouse.ts` read
 *     const BACKEND = process.env.LOOM_WAREHOUSE_BACKEND || 'synapse-dedicated';
 * so an UNSET value defaulted correctly, but any UNRECOGNIZED value (a typo
 * like `synapse_dedicated`, a stale `fabric`, trailing whitespace, wrong case)
 * fell through every branch to a terminal `status:'remediation'` whose
 * remediation read:
 *     "Set LOOM_WAREHOUSE_BACKEND=synapse-dedicated (the Azure-native default)"
 *
 * That asks the operator to supply the exact value the platform already uses as
 * its own default and already hard-codes one line above — the forbidden shape in
 * `.claude/rules/auto-bind-by-default.md` §5 ("a remediation the platform could
 * have executed is a defect, not a helpful message"). The right fix REMOVES the
 * gate rather than decorating it with a Fix-it button.
 *
 * MUTATION PROOF (break the subject, watch the named spec go red, restore):
 *   a) In resolveWarehouseBackend, `return { backend: raw as any }` for an
 *      unrecognized value -> RED: "coerces an unrecognized backend to the
 *      Azure-native default"
 *   b) Drop the `.toLowerCase()` -> RED: "coerces case/whitespace variants"
 *   c) Drop the `coercedFrom` reporting -> RED: "records the coercion so the
 *      mapping is inspectable, never guessed"
 *   d) Restore the old terminal remediation return at the bottom of the
 *      provisioner -> RED: "no unknown-backend remediation gate remains"
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  resolveWarehouseBackend,
  AZURE_NATIVE_WAREHOUSE_BACKEND,
} from '../warehouse';

describe('#3513 (a) — warehouse backend resolves instead of gating', () => {
  it('leaves the Azure-native default alone when unset', () => {
    const r = resolveWarehouseBackend(undefined);
    expect(r.backend).toBe(AZURE_NATIVE_WAREHOUSE_BACKEND);
    expect(r.coercedFrom).toBeUndefined();
  });

  it('leaves an explicitly-correct value alone', () => {
    const r = resolveWarehouseBackend('synapse-dedicated');
    expect(r.backend).toBe('synapse-dedicated');
    expect(r.coercedFrom).toBeUndefined();
  });

  it('coerces an unrecognized backend to the Azure-native default', () => {
    // The exact shape that used to dead-end the install.
    for (const bad of ['synapse_dedicated', 'fabric', 'fabric-warehouse', 'nonsense']) {
      const r = resolveWarehouseBackend(bad);
      expect(r.backend, `'${bad}' should coerce`).toBe(AZURE_NATIVE_WAREHOUSE_BACKEND);
    }
  });

  it('coerces case/whitespace variants rather than dead-ending on them', () => {
    for (const v of ['Synapse-Dedicated', '  synapse-dedicated  ', 'SYNAPSE-DEDICATED']) {
      const r = resolveWarehouseBackend(v);
      expect(r.backend, `'${v}' should resolve`).toBe(AZURE_NATIVE_WAREHOUSE_BACKEND);
      // These ARE the documented backend, just spelled differently — treat as
      // exact, not as a coercion needing a log line.
      expect(r.coercedFrom, `'${v}' is the same backend`).toBeUndefined();
    }
  });

  it('records the coercion so the mapping is inspectable, never guessed', () => {
    // auto-bind-by-default §2: a deterministic mapping must be recorded, not
    // silently applied.
    const r = resolveWarehouseBackend('fabric');
    expect(r.coercedFrom).toBe('fabric');
  });

  it('no unknown-backend remediation gate remains in the provisioner', () => {
    const src = readFileSync(join(process.cwd(), 'lib/install/provisioners/warehouse.ts'), 'utf8');
    // The gate is gone, not merely reworded.
    expect(src).not.toMatch(/Unknown LOOM_WAREHOUSE_BACKEND/);
    expect(src).not.toMatch(/Set LOOM_WAREHOUSE_BACKEND=synapse-dedicated/);
  });

  it('the residual exhaustiveness branch is a defect report, not a config gate', () => {
    // deploy-integrity R7: it must not assert an operator-fixable cause it did
    // not establish. There is no operator action for an internal branch miss.
    const src = readFileSync(join(process.cwd(), 'lib/install/provisioners/warehouse.ts'), 'utf8');
    expect(src).toMatch(/This is a Loom defect, not a configuration problem/);
  });
});
