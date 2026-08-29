/**
 * CONTRACTS THE ARTIFACT MUST HOLD — publication safety, cloud neutrality, the
 * coupling between what this extractor NAMES and what C1 RECOGNISES, and the
 * truth of the SCOPE it declares.
 *
 * All of them are asserted rather than stated, because each is a claim made in a
 * docblock elsewhere in this package and a docblock does not fail a build. The
 * scope-truth and allowlist blocks were added on 2026-08-24 after review
 * measured two of those claims to be false in the shipped bytes.
 */

import { readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runSecuritySweep } from '../../index';
import type { SecurityGraph, SecurityNode, VerdictCallFacet } from '../../substrate';
import { pathOfNodeId } from '../join';
import { ADMIN_CLAIM_SPELLINGS } from '../route-nodes';
import { extractedArtifact } from '../runtime';

const artifact = extractedArtifact()!;
const serialized = JSON.stringify(artifact);

describe('the committed artifact publishes NOTHING about an estate', () => {
  // This repo is PUBLIC and the artifact is COMMITTED. Anything that reaches it
  // is published, permanently, to everyone.

  it('contains no GUID — no subscription, tenant, object or client id', () => {
    const guid = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
    const hit = guid.exec(serialized);
    expect(hit?.[0] ?? null).toBeNull();
  });

  it('contains no ARM resource path', () => {
    expect(/\/subscriptions\//i.test(serialized)).toBe(false);
    expect(/\/resourceGroups\//i.test(serialized)).toBe(false);
  });

  it('contains no Azure endpoint host', () => {
    for (const host of [
      'core.windows.net',
      'azure.com',
      'usgovcloudapi.net',
      'core.usgovcloudapi.net',
      'azure.us',
      'onelake.dfs.fabric.microsoft.com',
      'limitlessdata.ai',
    ]) {
      expect(serialized.includes(host)).toBe(false);
    }
  });
});

describe('the artifact is CLOUD-NEUTRAL by construction', () => {
  // cloud-parity.md is die-hard. A build-time artifact SHOULD be cloud-neutral
  // because it names no cloud — but "should" is how parity claims go wrong, so
  // the property is measured on the real bytes.

  it('names no cloud, boundary or sovereign environment', () => {
    for (const token of [
      'AzureUSGovernment',
      'AzureCloud',
      'usgov',
      'gcc-high',
      'gcchigh',
      'il5',
      'commercial-full',
    ]) {
      expect(serialized.toLowerCase().includes(token.toLowerCase())).toBe(false);
    }
  });

  it('joins through LOGICAL app names only, never an ARM id', () => {
    const units = new Set(artifact.join.painted.map((p) => p.deployedAs));
    expect(units.size).toBeGreaterThan(0);
    for (const unit of units) {
      expect(unit).toMatch(/^[a-z0-9-]+$/);
      expect(unit.startsWith('azure:')).toBe(false);
    }
  });
});

/**
 * The coupling that would otherwise fail SILENTLY.
 *
 * `route-nodes.ts#ADMIN_CLAIM_SPELLINGS` maps a source spelling
 * (`withTenantAdmin`) to the predicate NAME C1 keys on (`isTenantAdmin`). C1's
 * `ADMIN_CLAIM_PREDICATES` is module-private, so this asserts the coupling
 * BEHAVIOURALLY: a node carrying each emitted predicate name, with every other
 * C1 condition satisfied, must actually produce a finding.
 *
 * A rename on either side empties the C1 finding set without erroring. This
 * turns that into a red test.
 */
function authorizerNode(predicate: string): SecurityNode {
  return {
    id: `sec:authorizer:apps/fiab-console/app/api/probe/[id]/route.ts#GET`,
    kind: 'authorizer',
    provenance: 'declared',
    label: 'GET /api/probe/[id]',
    facet: {
      kind: 'authorizer',
      fnName: 'GET /api/probe/[id]',
      params: ['id'],
      resourceScoped: true,
      callerNamedResourceInputs: ['id'],
      allowPaths: [
        {
          id: 'get:admin-claim',
          conditionPredicates: [predicate],
          scopeLiterals: [],
          mentionsVerdict: false,
          impliedByOwnsVerdict: false,
          ownsResolver: null,
        },
      ],
      reachesPrivilegedSink: true,
      privilegedSinkKinds: ['cosmos-cross-partition-read'],
    },
  };
}

function sweepOne(node: SecurityNode) {
  const graph: SecurityGraph = {
    nodes: [node],
    edges: [],
    annotations: { expectedPredicateClusterSize: {} },
    source: 'extracted',
  };
  return runSecuritySweep(graph);
}

describe('every predicate name this extractor emits is one C1 recognises', () => {
  // #4028 — THE SUBJECTS ARE DERIVED, NOT TYPED OUT. This loop used to iterate a
  // hardcoded `['isTenantAdmin', 'hasTenantAdminRole']` while its title claimed
  // to cover "every predicate name this extractor emits", and
  // `ADMIN_CLAIM_SPELLINGS` — the thing that would have to be read for the title
  // to be true — was mentioned only in a comment. Adding a fifth spelling mapped
  // to a predicate C1 does NOT recognise therefore passed this block in silence,
  // which is exactly the rename-on-either-side failure it exists to catch.
  //
  // Measured during the review that filed #4028: M7 (renaming the
  // `withTenantAdmin` -> predicate mapping to `isTenantAdminGate`) was caught by
  // the NAMED-INSTANCE test in `generated-sweep.test.ts`, not by this one. That
  // backstop defends exactly one route (`copilot/sessions/[id]/trace`), so any
  // change sparing it was invisible to both.
  const emitted = [...new Set(ADMIN_CLAIM_SPELLINGS.map(([, predicate]) => predicate))];

  it('the derived subject set is NON-EMPTY (population floor)', () => {
    // Without this, a future `ADMIN_CLAIM_SPELLINGS = []` — or a mapping change
    // that empties the projection — turns the loop below into ZERO `it` blocks
    // and this describe reports green having asserted nothing. That is the same
    // zero-population shape the whole extractor contract is about.
    expect(emitted.length).toBeGreaterThan(0);
    // And it must genuinely be a PROJECTION of the real table, not a copy that
    // happens to agree today: every emitted predicate has to appear as some
    // spelling's right-hand side.
    for (const predicate of emitted) {
      expect(ADMIN_CLAIM_SPELLINGS.some(([, p]) => p === predicate)).toBe(true);
    }
  });

  for (const predicate of emitted) {
    it(`C1 fires on '${predicate}'`, () => {
      const sweep = sweepOne(authorizerNode(predicate));
      const c1 = sweep.findings.filter((f) => f.findingClass === 'C1-unauthorized-inbound-edge');
      expect(c1.length).toBeGreaterThan(0);
    });
  }

  it('C1 does NOT fire on a predicate name it does not recognise (control)', () => {
    // Proves the assertions above are watching the PREDICATE and not merely the
    // node's presence — without this, a detector that fired on everything would
    // pass them all. KEPT from the pre-#4028 version deliberately: deriving the
    // positive subjects makes the negative control MORE load-bearing, not less.
    const sweep = sweepOne(authorizerNode('someUnrelatedCheck'));
    const c1 = sweep.findings.filter((f) => f.findingClass === 'C1-unauthorized-inbound-edge');
    expect(c1).toHaveLength(0);
  });
});

describe('the artifact records what it did NOT measure', () => {
  it('carries scan scopes with real file counts', () => {
    expect(artifact.meta.scanScopes.length).toBeGreaterThan(0);
    for (const scope of artifact.meta.scanScopes) {
      expect(scope.filesMatched).toBeGreaterThan(0);
      expect(scope.scope.length).toBeGreaterThan(0);
    }
  });

  it('carries skipped subjects with reasons, so the gaps are countable', () => {
    expect(artifact.meta.skipped.length).toBeGreaterThan(0);
    for (const s of artifact.meta.skipped.slice(0, 50)) {
      expect(s.reason.length).toBeGreaterThan(30);
    }
  });
});

/**
 * THE SCOPE STRING IS A CLAIM IN PUBLISHED BYTES, SO IT IS MEASURED.
 *
 * Until 2026-08-24 `meta.scanScopes` declared `scripts/**, .github/**` while the
 * CLI walked `scripts/` alone: 0 `.github` nodes, 0 `skipped` entries naming it,
 * and `.github/scripts/deploy-notify-failure.mjs` — a failure NOTIFIER, i.e.
 * exactly the publication surface C4 exists to find — outside the population the
 * artifact said it covered. `build.ts` now derives the label from the roots it
 * partitions on and throws on a root that matched nothing, but that is a
 * property of the PRODUCER; these assert it on the bytes that ship.
 */
describe('every scan scope the artifact DECLARES is a scope it actually SCANNED', () => {
  const publicationScope = artifact.meta.scanScopes.find((s) =>
    s.scope.includes('CI publication surfaces'),
  );

  it('declares a publication scope at all', () => {
    expect(publicationScope).toBeDefined();
  });

  it('emitted at least one node from EVERY root the scope string names', () => {
    const roots = [...publicationScope!.scope.matchAll(/([^\s,()]+)\/\*\*/g)].map((m) => `${m[1]}/`);
    // Two roots today (`.github/`, `scripts/`). A single-root parse would make
    // the loop below vacuous, so the count is pinned as a non-degeneracy control.
    expect(roots.length).toBeGreaterThan(1);
    for (const root of roots) {
      const fromRoot = artifact.graph.nodes.filter((n) => pathOfNodeId(n.id)?.startsWith(root));
      expect(fromRoot.length).toBeGreaterThan(0);
    }
  });

  it('scans `.github/**` FOR REAL — the root whose declaration was a false claim', () => {
    const gh = artifact.graph.nodes.filter((n) => pathOfNodeId(n.id)?.startsWith('.github/'));
    expect(gh.length).toBeGreaterThan(0);
    // The specific miss the review named: a failure notifier, five sink-shaped
    // lines, permanently publishing to a public issue and a public run log.
    expect(gh.some((n) => n.id.includes('.github/scripts/deploy-notify-failure.mjs'))).toBe(true);
  });

  it('declares, with a COUNT, what it saw under a scanned root and could not read', () => {
    // A narrowed scope is fine. An undeclared one is the defect. Workflow YAML
    // `run:` blocks and `.sh` steps publish into the same public Actions log and
    // this extractor lexes neither.
    const unread = artifact.meta.skipped.filter((s) => s.reason.includes('were seen and NOT read'));
    expect(unread.length).toBeGreaterThan(0);
    for (const s of unread) expect(s.reason).toMatch(/\d+ file\(s\)/);
    expect(unread.some((s) => s.subject.startsWith('.github/'))).toBe(true);
  });

  it('joins every `.github` node through a LIVE no-estate-presence reason', () => {
    // The `.github/workflows/` entry in `join.ts` was dead for the same reason
    // the scope string was false. It must now resolve for real, not fall through
    // to the "no deployable unit is declared" default.
    const gh = artifact.join.unjoined.filter((u) => u.codeModuleId.startsWith('code:.github/'));
    expect(gh.length).toBeGreaterThan(0);
    for (const u of gh) {
      expect(u.reason).toContain('GitHub Actions surface');
      expect(u.reason).not.toContain('no deployable unit is declared');
    }
  });
});

/**
 * THE ALLOWLIST ARM, PINNED IN BOTH DIRECTIONS.
 *
 * `parseAllowlistPrefixes` returns `[]` for a present-but-unparseable guard
 * source as readily as for one that declares nothing. Measured 2026-08-24: an
 * upstream rename took `allowlisted: true` from 23 to 0 with the node count, the
 * skipped count and the digest all identical and the suite green.
 *
 * `build.ts` now writes a ledger entry for the empty parse. These two assert the
 * live state on the shipped bytes, so the transition is loud whichever way it
 * happens: the count going to zero reddens the first, and the ledger entry
 * appearing reddens the second.
 */
describe('the ALLOWLIST_PREFIXES arm is LIVE on this tree', () => {
  it('marks real routes allowlisted — a zero here UNDERSTATES C3', () => {
    const allowlisted = artifact.graph.nodes.filter(
      (n) => n.kind === 'verdict-call' && (n.facet as VerdictCallFacet).allowlisted,
    );
    expect(allowlisted.length).toBeGreaterThan(0);
  });

  it('carries NO allowlist-parse gap in the ledger, because the parse succeeded', () => {
    expect(artifact.meta.skipped.filter((s) => s.subject.includes('ALLOWLIST_PREFIXES'))).toEqual(
      [],
    );
  });
});

/**
 * THE INERT C4 ARM, PINNED SO ITS TRANSITION IS LOUD.
 *
 * `carriesSensitive` matches ZERO non-spawn sinks on this corpus, so every C4
 * finding comes from the spawn-stdio arm and the expression arm's correctness is
 * unexercised by real data. `build.ts` records that in `meta.skipped` — but a
 * recorded fact that nothing ASSERTS disappears silently the day the arm goes
 * live. This makes both directions of that transition red.
 */
describe('the C4 expression arm reports its own inertness', () => {
  it('carries the inert-arm entry while the arm matches nothing', () => {
    const inert = artifact.meta.skipped.filter((s) => s.subject.includes('C4 expression arm'));
    expect(inert).toHaveLength(1);
    expect(inert[0].reason).toContain('INERT');
  });
});

/**
 * THE INDEPENDENT DENOMINATOR, ON THE REQUIRED LANE.
 *
 * `build.ts` already refuses a walk whose examined count disagrees with an
 * independent census — but that runs in the GENERATOR, and the generator runs in
 * `brain security graph — committed artifact matches the tree`, which is NOT one
 * of `main`'s 15 required contexts. `vitest (node 20)` IS required.
 *
 * So the same census is recomputed here, from the filesystem, and asserted
 * against the COMMITTED bytes. A narrowed artifact — including one produced by
 * hand rather than by the generator — reddens a required check instead of only a
 * skippable one. The previous assertion on these fields was
 * `toBeGreaterThan(0)`, which a 44%-narrowed `1492` satisfied.
 *
 * This does not add a regeneration burden that did not already exist: the drift
 * gate compares the whole graph, so any change to a scanned file already
 * requires re-running the generator.
 */
describe('the committed scan scopes match a census taken from the filesystem', () => {
  const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..', '..', '..', '..');

  /** Count files under `dir` matching `match`, skipping what the CLI skips. */
  function countFiles(dir: string, match: (relPath: string) => boolean): number {
    let entries: ReturnType<typeof readdirSync>;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw e;
    }
    let n = 0;
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.next' || entry.name === '.git') continue;
        n += countFiles(full, match);
        continue;
      }
      if (match(relative(REPO_ROOT, full).split(sep).join('/'))) n += 1;
    }
    return n;
  }

  const scopeNamed = (fragment: string) =>
    artifact.meta.scanScopes.find((s) => s.scope.includes(fragment))!;

  it('resolved the repo root (control — a wrong root would make every count 0)', () => {
    expect(countFiles(join(REPO_ROOT, 'scripts'), (p) => p.endsWith('.mjs'))).toBeGreaterThan(0);
  });

  it('scanned every `app/**/route.ts` module in the tree', () => {
    const census = countFiles(join(REPO_ROOT, 'apps', 'fiab-console', 'app'), (p) =>
      /\/route\.tsx?$/.test(p),
    );
    expect(census).toBeGreaterThan(0);
    expect(scopeNamed('console BFF routes').filesMatched).toBe(census);
  });

  it('scanned every JavaScript module under EVERY declared publication root', () => {
    const publication = scopeNamed('CI publication surfaces');
    const roots = [...publication.scope.matchAll(/([^\s,()]+)\/\*\*/g)].map((m) => m[1]);
    expect(roots.length).toBeGreaterThan(1);

    let census = 0;
    for (const root of roots) {
      census += countFiles(join(REPO_ROOT, root), (p) => /\.(?:mjs|cjs|js)$/.test(p));
    }
    expect(census).toBeGreaterThan(0);
    expect(publication.filesMatched).toBe(census);
  });
});
