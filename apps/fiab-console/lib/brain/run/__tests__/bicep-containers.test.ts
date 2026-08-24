/**
 * LOOM BRAIN W10 — THE BICEP CONTAINER GUARD (#4014 review, merge-conflict note).
 *
 * ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────
 * #3993 (W9) and #4014 (W10) each add a Brain container, at the IDENTICAL anchor
 * in the SAME two cosmos modules. Measured by the reviewer:
 *
 *     git merge-tree --write-tree --merge-base=... 6a007268 cfb43020
 *     CONFLICT (content): admin-plane/loom-console-cosmos.bicep
 *     CONFLICT (content): landing-zone/cosmos.bicep
 *
 * Git cannot auto-merge either. In `landing-zone/cosmos.bicep` both add a row to
 * the same `loomContainers` array, so a careless resolution silently DROPS one
 * container — and until this file existed, no test asserted container presence,
 * so nothing would have gone red. The lane whose container was dropped would
 * then fail at runtime, in production, on a Cosmos 404.
 *
 * ── THE INVARIANT THIS ASSERTS ─────────────────────────────────────────────
 * The two modules must declare the SAME set of Brain containers, with the same
 * partition key and the same TTL. That is exactly the property a bad merge
 * resolution breaks, in either direction:
 *
 *   - drop `brain-findings` from one file      -> set mismatch, RED
 *   - drop `brain-graph-versions` from one     -> set mismatch, RED
 *   - keep both in one file and one in the other -> set mismatch, RED
 *
 * It is deliberately NOT a hard-coded list of two names: `brain-graph-versions`
 * does not exist on this branch, and a test that demanded it would be red today
 * for the wrong reason. Instead the containers are DISCOVERED from both files
 * and the two sets compared — which needs no edit when W9 lands and still
 * catches the drop.
 *
 * ── WHY SOURCE PARSING AND NOT `az bicep build` ────────────────────────────
 * A compiled-ARM assertion would need the Azure CLI in every vitest run. The
 * failure mode this guards is a TEXT-LEVEL merge resolution, which is visible in
 * the source, and `az bicep build` is still run as a gate on every PR that
 * touches these files (both compiled outputs were checked by hand for this one).
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..', '..', '..');
const ADMIN = join(
  REPO_ROOT,
  'platform/fiab/bicep/modules/admin-plane/loom-console-cosmos.bicep',
);
const LZ = join(REPO_ROOT, 'platform/fiab/bicep/modules/landing-zone/cosmos.bicep');

interface Declared {
  readonly name: string;
  readonly partitionKey: string;
  readonly ttl: string | null;
}

/**
 * Every Brain container a module declares, in EITHER shape.
 *
 * `landing-zone/cosmos.bicep` uses rows in a `loomContainers` array;
 * `admin-plane/loom-console-cosmos.bicep` uses standalone resources, because its
 * container loop emits no `defaultTtl`. Both shapes have to be understood or the
 * guard would range over one file and be blind to the other — a population of
 * one, reported as a comparison.
 */
function declaredBrainContainers(path: string): Declared[] {
  const text = readFileSync(path, 'utf8');
  const found = new Map<string, Declared>();

  // Shape A — a row: { name: 'brain-x', partitionKey: '/y', ttl: -1 }
  const rowRe =
    /\{\s*name:\s*'(brain-[a-z0-9-]+)'\s*,\s*partitionKey:\s*'([^']+)'\s*(?:,\s*ttl:\s*(-?\d+)\s*)?\}/g;
  for (const m of text.matchAll(rowRe)) {
    found.set(m[1], { name: m[1], partitionKey: m[2], ttl: m[3] ?? null });
  }

  // Shape B — a standalone resource with a nested partitionKey/defaultTtl.
  const resRe = /name:\s*'(brain-[a-z0-9-]+)'\s*\n\s*properties:\s*\{[\s\S]*?\n\s{2}\}\n\}/g;
  for (const m of text.matchAll(resRe)) {
    const block = m[0];
    const pk = block.match(/partitionKey:\s*\{\s*paths:\s*\['([^']+)'\]/);
    const ttl = block.match(/defaultTtl:\s*(-?\d+)/);
    found.set(m[1], {
      name: m[1],
      partitionKey: pk ? pk[1] : '<unparsed>',
      ttl: ttl ? ttl[1] : null,
    });
  }

  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const admin = declaredBrainContainers(ADMIN);
const lz = declaredBrainContainers(LZ);

describe('the two cosmos modules declare the same Brain containers', () => {
  it('has a NON-EMPTY population in BOTH files', () => {
    // A parser that matched nothing would report two equal empty sets and pass.
    // This is the embedded control for the parser itself.
    expect(admin.length).toBeGreaterThan(0);
    expect(lz.length).toBeGreaterThan(0);
  });

  it('brain-findings is declared in BOTH', () => {
    expect(admin.map((c) => c.name)).toContain('brain-findings');
    expect(lz.map((c) => c.name)).toContain('brain-findings');
  });

  it('THE MERGE GUARD: the container SETS are identical', () => {
    // This is the assertion a careless #3993/#4014 resolution trips. It needs no
    // edit when `brain-graph-versions` lands — it will simply be in both sets.
    expect(admin.map((c) => c.name)).toEqual(lz.map((c) => c.name));
  });

  it('every Brain container is partitioned by /estateId in both files', () => {
    // Not /tenantId. The Brain's data is a property of the deployed ESTATE, and
    // a resolution that took the wrong side of the conflict could flip this.
    for (const c of [...admin, ...lz]) {
      expect(c.partitionKey, `${c.name} in one of the two modules`).toBe('/estateId');
    }
  });

  it('brain-findings carries defaultTtl -1 in both — TTL on, NO blanket expiry', () => {
    // The single most load-bearing setting in this lane. A `fixed` finding is
    // the ONLY thing that makes its next occurrence a REGRESSION; giving these
    // documents a blanket expiry silently downgrades the loudest signal the lane
    // produces to the quietest, with nothing in any log to show for it.
    for (const set of [admin, lz]) {
      const f = set.find((c) => c.name === 'brain-findings');
      expect(f?.ttl).toBe('-1');
    }
  });

  it('CONTROL: the parser can tell the two shapes apart and reads a TTL from each', () => {
    // Proves the shape-B regex is not silently matching nothing and leaving the
    // whole guard resting on shape A.
    const rowShape = declaredBrainContainers(LZ).find((c) => c.name === 'brain-findings');
    const resourceShape = declaredBrainContainers(ADMIN).find((c) => c.name === 'brain-findings');
    expect(rowShape?.ttl).toBe('-1');
    expect(resourceShape?.ttl).toBe('-1');
    expect(readFileSync(LZ, 'utf8')).toContain("{ name: 'brain-findings'");
    expect(readFileSync(ADMIN, 'utf8')).toContain("resource brainFindings ");
  });
});
