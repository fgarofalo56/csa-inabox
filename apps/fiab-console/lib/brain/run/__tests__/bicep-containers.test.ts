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
 * ── THE HOLE THE SET COMPARISON ALONE LEAVES (closed 2026-08-25) ───────────
 * A set comparison is SYMMETRIC, so it is blind to the one resolution that
 * deletes the SAME container from BOTH files: two equal sets of one still
 * compare equal, and `length > 0` is still satisfied. That is not a theoretical
 * shape — it is what "take the W10 side of the hunk" does in `landing-zone`,
 * where both rows sit inside one `loomContainers` array and one `git checkout
 * --ours` drops `brain-graph-versions` everywhere at once.
 *
 * So the set comparison is kept AND joined by an explicit per-name floor. Both
 * containers are now merged into `main` (#3993 landed W9; this branch carries
 * W10), so naming them is a statement about shipped state rather than a
 * prediction — and the census assertion below makes ADDING a third Brain
 * container a deliberate edit to this file rather than a silent widening.
 *
 * ── WHY SOURCE PARSING AND NOT `az bicep build` ────────────────────────────
 * A compiled-ARM assertion would need the Azure CLI in every vitest run. The
 * failure mode this guards is a TEXT-LEVEL merge resolution, which is visible in
 * the source, and `az bicep build` is still run as a gate on every PR that
 * touches these files (both compiled outputs were checked by hand for this one).
 *
 * ── EXCEPT FOR THE ONE PROPERTY SOURCE CANNOT SHOW (added 2026-08-27) ──────
 * The Gov data-plane grant loop is the exception, and it needs the COMPILED
 * output — because the defect it guards is invisible in the source. That is not
 * a hypothetical: the obvious way to extend `brainScanContainers` from one name
 * to two is to append a string literal, and the loop's `dependsOn` was a literal
 * `[ brainGraphVersions ]`. That combination compiles with RC=0 and ZERO
 * diagnostics, and produces a role assignment SCOPED to `brain-findings` that
 * waits on `brain-graph-versions` and on nothing else. Source review reads fine.
 * Only the emitted `dependsOn` shows it.
 *
 * No CLI is needed, because `apps/fiab-console/deploy-templates/main.json` is a
 * COMMITTED compiled artifact kept byte-identical to a fresh build by
 * `scripts/ci/check-deploy-template-sync.mjs`. Asserting against it is asserting
 * against the real emitted ARM.
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

/**
 * Every Brain container that has SHIPPED, by name.
 *
 * This list is the asymmetric half of the guard — the half a "drop it from both
 * files" resolution cannot satisfy. Adding a row here is the deliberate act that
 * accompanies adding a container; the census test below refuses to let the list
 * and the modules drift apart in either direction.
 */
const SHIPPED_BRAIN_CONTAINERS = [
  // W9 (#3935 / PR #3993) — immutable graph history, 90-day backstop TTL.
  { name: 'brain-graph-versions', ttl: '7776000' },
  // W10 (#3936 / PR #4014) — findings + scan runs, TTL on with no blanket expiry.
  { name: 'brain-findings', ttl: '-1' },
] as const;

describe('the two cosmos modules declare the same Brain containers', () => {
  it('has a NON-EMPTY population in BOTH files', () => {
    // A parser that matched nothing would report two equal empty sets and pass.
    // This is the embedded control for the parser itself.
    expect(admin.length).toBeGreaterThan(0);
    expect(lz.length).toBeGreaterThan(0);
  });

  it.each(SHIPPED_BRAIN_CONTAINERS)(
    'THE PRESENCE FLOOR: $name is declared in BOTH modules',
    ({ name }) => {
      // Asymmetric on purpose. The set comparison below cannot see a container
      // deleted from both files at once; this can, and that is precisely the
      // shape a one-sided `--ours` resolution of the shared `loomContainers`
      // hunk produces.
      expect(admin.map((c) => c.name), 'admin-plane/loom-console-cosmos.bicep').toContain(name);
      expect(lz.map((c) => c.name), 'landing-zone/cosmos.bicep').toContain(name);
    },
  );

  it.each(SHIPPED_BRAIN_CONTAINERS)('$name carries its declared TTL in both', ({ name, ttl }) => {
    // The TTLs are OPPOSITE choices and both are load-bearing: 7776000 is the
    // graph-history cost backstop; -1 turns TTL on for findings with NO blanket
    // expiry, because a `fixed` finding is the ONLY thing that makes its next
    // occurrence a REGRESSION rather than a new finding. Expiring one silently
    // downgrades the loudest signal this lane produces to the quietest. Taking
    // the wrong side of the conflict swaps them, and nothing else would notice.
    for (const [label, set] of [
      ['admin-plane', admin],
      ['landing-zone', lz],
    ] as const) {
      expect(set.find((c) => c.name === name)?.ttl, `${name} in ${label}`).toBe(ttl);
    }
  });

  it('CENSUS: the modules declare exactly the shipped containers, no more, no less', () => {
    // Two-sided. A container added to bicep without a row above fails here, so a
    // new lane cannot inherit this guard's coverage silently; a container quietly
    // deleted from both files fails here too.
    const expected = [...SHIPPED_BRAIN_CONTAINERS.map((c) => c.name)].sort();
    expect(admin.map((c) => c.name).sort()).toEqual(expected);
    expect(lz.map((c) => c.name).sort()).toEqual(expected);
  });

  it('THE MERGE GUARD: the container SETS are identical', () => {
    // This is the assertion a careless #3993/#4014 resolution trips whenever the
    // two files disagree. It is kept alongside the per-name floor above because
    // it needs no edit to catch a FUTURE container dropped from one side only.
    expect(admin.map((c) => c.name)).toEqual(lz.map((c) => c.name));
  });

  it('every Brain container is partitioned by /estateId in both files', () => {
    // Not /tenantId. The Brain's data is a property of the deployed ESTATE, and
    // a resolution that took the wrong side of the conflict could flip this.
    for (const c of [...admin, ...lz]) {
      expect(c.partitionKey, `${c.name} in one of the two modules`).toBe('/estateId');
    }
  });

  it('CONTROL: the parser can tell the two shapes apart and reads a TTL from each', () => {
    // Proves the shape-B regex is not silently matching nothing and leaving the
    // whole guard resting on shape A — and vice versa. Both shapes are exercised
    // for BOTH containers, so a regex that happened to fit only the `-1` TTL or
    // only the first resource in the file cannot pass.
    for (const { name, ttl } of SHIPPED_BRAIN_CONTAINERS) {
      expect(lz.find((c) => c.name === name)?.ttl, `${name} row shape`).toBe(ttl);
      expect(admin.find((c) => c.name === name)?.ttl, `${name} resource shape`).toBe(ttl);
      expect(readFileSync(LZ, 'utf8')).toContain(`{ name: '${name}'`);
    }
    expect(readFileSync(ADMIN, 'utf8')).toContain('resource brainFindings ');
    expect(readFileSync(ADMIN, 'utf8')).toContain('resource brainGraphVersions ');
  });
});

// ---------------------------------------------------------------------------
// THE COMPILED-ARM GUARD — the property source review cannot see
// ---------------------------------------------------------------------------

const COMPILED_ARM = join(REPO_ROOT, 'apps/fiab-console/deploy-templates/main.json');

interface ArmResource {
  readonly type?: unknown;
  readonly name?: unknown;
  readonly copy?: { readonly name?: unknown; readonly count?: unknown };
  readonly dependsOn?: unknown;
  readonly properties?: unknown;
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

/**
 * Every resource in the template, descending into nested deployments.
 *
 * `resources` is a LIST in classic templates and a DICT keyed by symbolic name
 * in newer ones; both shapes appear in this artifact, and a walker that handled
 * only one would range over a fraction of the template and report a confident
 * green over it.
 */
function* armResources(node: unknown): Generator<ArmResource> {
  const res = asRecord(node).resources;
  const list: unknown[] = Array.isArray(res)
    ? res
    : typeof res === 'object' && res !== null
      ? Object.values(res)
      : [];
  for (const r of list) {
    if (typeof r !== 'object' || r === null) continue;
    yield r as ArmResource;
    const tmpl = asRecord(asRecord(r).properties).template;
    if (typeof tmpl === 'object' && tmpl !== null) yield* armResources(tmpl);
  }
}

describe('the compiled ARM orders each Brain grant after the container it scopes to', () => {
  const template: unknown = JSON.parse(readFileSync(COMPILED_ARM, 'utf8'));
  const all = [...armResources(template)];
  const grantLoops = all.filter(
    (r) =>
      typeof r.type === 'string' &&
      r.type.endsWith('databaseAccounts/sqlRoleAssignments') &&
      r.copy?.name === 'brainScanDataAssignments',
  );

  it('has a NON-EMPTY population to examine', () => {
    // The walker is the thing most likely to be silently wrong here (two
    // `resources` shapes, arbitrary nesting depth), and a walker that found
    // nothing would pass every assertion below vacuously.
    expect(all.length).toBeGreaterThan(100);
    expect(grantLoops.length, 'the brainScanDataAssignments copy loop').toBe(1);
  });

  it.each(SHIPPED_BRAIN_CONTAINERS)(
    'THE TRAP: the emitted dependsOn names $name',
    ({ name }) => {
      // This is the assertion the naive extension fails. Appending a string
      // literal to `brainScanContainers` while leaving `dependsOn` as a literal
      // `[ brainGraphVersions ]` compiles clean, emits a grant scoped to
      // `brain-findings`, and emits NO edge to the container that creates it.
      const deps = JSON.stringify(grantLoops[0]?.dependsOn ?? []);
      expect(deps, `dependsOn for the ${name} grant`).toContain(`'${name}'`);
    },
  );

  it('the grant SCOPE is indexed by copyIndex(), not pinned to one container', () => {
    // A scope that named a container literally would grant every iteration on
    // the same container — the mirror-image defect, and equally invisible in
    // the bicep source.
    const scope = String(asRecord(grantLoops[0]?.properties).scope ?? '');
    expect(scope).toContain('copyIndex()');
    expect(scope).toContain("variables('brainScanContainers')");
  });

  it('the loop count is the container list, so a name added gets a grant', () => {
    expect(String(grantLoops[0]?.copy?.count ?? '')).toContain(
      "length(variables('brainScanContainers'))",
    );
  });

  it.each(SHIPPED_BRAIN_CONTAINERS)('$name is actually CREATED by the template', ({ name, ttl }) => {
    // The other half of the trap: a grant scoped to a container nothing
    // creates. The container resources are asserted in the compiled output, not
    // only in the source, because that is where the grant's scope points.
    const containers = all.filter(
      (r) =>
        typeof r.type === 'string' &&
        r.type.endsWith('sqlDatabases/containers') &&
        asRecord(asRecord(r.properties).resource).id === name,
    );
    expect(containers.length, `${name} container declarations`).toBeGreaterThan(0);
    for (const c of containers) {
      const resource = asRecord(asRecord(c.properties).resource);
      expect(String(resource.defaultTtl), `${name} TTL`).toBe(ttl);
      expect(JSON.stringify(resource.partitionKey)).toContain('/estateId');
    }
  });
});
