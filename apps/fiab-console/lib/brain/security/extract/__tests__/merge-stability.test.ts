/**
 * MERGE STABILITY — two PRs that each add an unrelated file must merge (#4798).
 *
 * ── THE DEFECT, MEASURED ─────────────────────────────────────────────────
 *
 * The committed artifact used to carry tree-wide tallies in `meta`
 * (`filesScanned`, per-scope `filesMatched`/`nodesEmitted`, `inputsDigest`,
 * `generatedAt`, `commit`) and two ledger reasons that spelled a count. Adding
 * any file under a scanned root moved them, so after each merge to `main` every
 * other open PR that touched the artifact went CONFLICTING (#4767, #4769, #4770
 * and #4777 each had to merge `main` and regenerate), and each resolution was a
 * content push that voided every review verdict.
 *
 * Measured on the real tree with the pre-#4798 extractor, regenerating on base,
 * base+A and base+B and running `git merge-file` over the three: 1 conflict in
 * each of four shapes, and in every shape the merge ALSO differed from the
 * artifact regenerated with both files — two sides that each move a tally
 * N -> N+1 merge cleanly to N+1, which is wrong for the pair.
 *
 * ── WHAT THIS SPEC DOES ──────────────────────────────────────────────────
 *
 * The same experiment, in process, over a fixture corpus, through the REAL
 * `buildSecurityGraphExtraction` and the REAL `serializeArtifact` the CLI writes
 * with. Each side gets its own clock and sha, as two PRs would. Two assertions
 * per scenario, each named for the input that breaks it:
 *
 *   - `git merge-file` reports ZERO conflicts. Broken by re-committing any value
 *     both sides set DIFFERENTLY — `generatedAt`, `commit`, `inputsDigest`.
 *   - the merged bytes EQUAL the artifact regenerated with both files. Broken by
 *     re-committing any value both sides move the SAME way — `filesScanned`, a
 *     `filesMatched`, a count spelled inside a ledger reason — which merges
 *     cleanly to a wrong number.
 *
 * `LEGACY arm` runs the pre-#4798 committed shape through the identical harness
 * and must FAIL it, so a green here is a statement about the shape and not about
 * a harness that cannot go red.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BuildInput } from '../build';
import { buildSecurityGraphExtraction, serializeArtifact } from '../build';
import type { SecurityGraphArtifact, SecurityGraphExtraction, SourceFile, UnmodeledSurface } from '../types';

const route = (name: string): SourceFile => ({
  path: `apps/fiab-console/app/api/${name}/[id]/route.ts`,
  text: `import { withTenantAdmin } from '@/lib/api/route-toolkit';
export const GET = withTenantAdmin(async (req, { params }) => {
  const { id } = await params;
  const c = await container();
  return ok(await c.item(id, id).read());
});`,
});

const script = (name: string): SourceFile => ({
  path: `scripts/ci/${name}.mjs`,
  text: `console.log('${name}');\n`,
});

/**
 * Several nodes on each side of where A and B land, so neither insertion is
 * ADJACENT to the other in any array. Adjacent insertions conflict in any
 * line-based merge whatever the artifact carries, and would make this spec
 * measure the merge algorithm instead of the committed shape.
 */
const BASE_FILES: SourceFile[] = [
  route('alpha'),
  route('bravo'),
  route('charlie'),
  script('mm-first'),
  script('mm-second'),
  script('mm-third'),
];

const BASE_UNMODELED: UnmodeledSurface[] = [
  { root: '.github/', fileCount: 3, extensions: ['.yml'] },
  { root: 'scripts/', fileCount: 2, extensions: ['.sh'] },
];

interface Side {
  readonly files: readonly SourceFile[];
  readonly unmodeled: readonly UnmodeledSurface[];
  readonly now: string;
  readonly commit: string;
}

function extract(side: Side): SecurityGraphExtraction {
  const input: BuildInput = {
    files: side.files,
    publicationRoots: ['scripts/'],
    unmodeledPublicationSurfaces: side.unmodeled,
    routeGuardSource: null,
    commit: side.commit,
    now: new Date(side.now),
  };
  return buildSecurityGraphExtraction(input);
}

/** The committed shape before #4798: the run's tallies folded back into meta. */
function legacyArtifact(x: SecurityGraphExtraction): SecurityGraphArtifact {
  return {
    ...x.artifact,
    meta: {
      generatorVersion: x.artifact.meta.generatorVersion,
      generatedAt: x.run.generatedAt,
      commit: x.run.commit,
      inputsDigest: x.run.inputsDigest,
      filesScanned: x.run.filesScanned,
      scanScopes: x.run.scanScopes,
      skipped: x.artifact.meta.skipped,
    } as SecurityGraphArtifact['meta'],
  };
}

/** `git merge-file -p ours base theirs` — the three-way merge a PR merge performs. */
function merge3(ours: string, base: string, theirs: string): { conflicts: number; merged: string } {
  const dir = mkdtempSync(join(tmpdir(), 'loom-sg-merge-'));
  try {
    const [o, b, t] = ['ours.json', 'base.json', 'theirs.json'].map((n) => join(dir, n));
    writeFileSync(o, ours, 'utf8');
    writeFileSync(b, base, 'utf8');
    writeFileSync(t, theirs, 'utf8');
    const r = spawnSync('git', ['merge-file', '-p', o, b, t], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    // A negative status (or none) is git failing, not a conflict count. Refuse
    // it rather than read it as zero conflicts.
    if (r.error || r.status === null || r.status < 0) {
      throw new Error(`git merge-file did not run: ${r.error?.message ?? r.stderr}`);
    }
    return { conflicts: r.status, merged: r.stdout };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

interface Scenario {
  readonly name: string;
  readonly a: Partial<Pick<Side, 'files' | 'unmodeled'>>;
  readonly b: Partial<Pick<Side, 'files' | 'unmodeled'>>;
}

const SCENARIOS: Scenario[] = [
  {
    // A module with no publication construct and a route file with no
    // handler: both enter the scanned population and neither emits a node.
    name: 'two zero-node files',
    a: { files: [...BASE_FILES, { path: 'scripts/ci/aa-const.mjs', text: 'export const A = 1;\n' }] },
    b: {
      files: [
        ...BASE_FILES,
        { path: 'apps/fiab-console/app/api/zz-static/route.ts', text: "export const dynamic = 'force-static';\n" },
      ],
    },
  },
  {
    // One sink each, at opposite ends of the publication partition: each adds a
    // node, a join row and a per-module ledger entry, and moves the non-spawn
    // sink total the C4 inert-arm reason used to spell.
    name: 'two node-producing files',
    a: { files: [...BASE_FILES, script('aa-new')] },
    b: { files: [...BASE_FILES, script('zz-new')] },
  },
  {
    // A `.yml` on EACH side, under the SAME root — the common case, two PRs
    // that each add a workflow. Both move that root's unread-file count the
    // same way, which the ledger reason used to spell: a clean merge to a
    // count one short.
    name: 'two files this extractor does not lex',
    a: { unmodeled: [{ ...BASE_UNMODELED[0], fileCount: 4 }, BASE_UNMODELED[1]] },
    b: { unmodeled: [{ ...BASE_UNMODELED[0], fileCount: 4 }, BASE_UNMODELED[1]] },
  },
];

function sides(s: Scenario) {
  const base: Side = { files: BASE_FILES, unmodeled: BASE_UNMODELED, now: '2026-09-01T00:00:00.000Z', commit: 'b'.repeat(40) };
  const a: Side = { ...base, ...s.a, now: '2026-09-02T00:00:00.000Z', commit: 'a'.repeat(40) };
  const b: Side = { ...base, ...s.b, now: '2026-09-03T00:00:00.000Z', commit: 'c'.repeat(40) };
  // Both files present: the union of A's and B's additions over base.
  const baseSet = new Set(BASE_FILES.map((f) => f.path));
  const ab: Side = {
    files: [...BASE_FILES, ...a.files.filter((f) => !baseSet.has(f.path)), ...b.files.filter((f) => !baseSet.has(f.path))],
    unmodeled: BASE_UNMODELED.map((u, i) => ({
      ...u,
      fileCount: u.fileCount + (a.unmodeled[i].fileCount - u.fileCount) + (b.unmodeled[i].fileCount - u.fileCount),
    })),
    now: '2026-09-04T00:00:00.000Z',
    commit: 'd'.repeat(40),
  };
  return { base: extract(base), a: extract(a), b: extract(b), ab: extract(ab) };
}

describe('the fixture really moves the population on both sides (controls, not coverage)', () => {
  // Without these the scenarios could pass because A or B changed nothing at
  // all — a file outside every scope, or an unmodeled count that did not move.
  for (const s of SCENARIOS) {
    it(`${s.name}: A and B each move a run tally the pre-#4798 artifact committed`, () => {
      const x = sides(s);
      const tally = (e: SecurityGraphExtraction) =>
        JSON.stringify([e.run.filesScanned, e.run.scanScopes, e.run.unmodeledPublicationSurfaces, e.run.nonSpawnSinks]);
      expect(tally(x.a)).not.toBe(tally(x.base));
      expect(tally(x.b)).not.toBe(tally(x.base));
      expect(tally(x.ab)).not.toBe(tally(x.a));
    });
  }

  it('the node-producing scenario really adds a node on each side', () => {
    const x = sides(SCENARIOS[1]);
    expect(x.a.artifact.graph.nodes.length).toBe(x.base.artifact.graph.nodes.length + 1);
    expect(x.b.artifact.graph.nodes.length).toBe(x.base.artifact.graph.nodes.length + 1);
  });
});

describe('#4798 — the committed artifact merges without conflict and without a wrong value', () => {
  for (const s of SCENARIOS) {
    it(`${s.name}: zero conflicts, and the merge equals the artifact regenerated with both`, () => {
      const x = sides(s);
      const { conflicts, merged } = merge3(
        serializeArtifact(x.a.artifact),
        serializeArtifact(x.base.artifact),
        serializeArtifact(x.b.artifact),
      );
      expect(conflicts).toBe(0);
      expect(merged).toBe(serializeArtifact(x.ab.artifact));
    });
  }
});

describe('LEGACY arm — the pre-#4798 committed shape FAILS the same harness', () => {
  // The harness's power, shown on the defect it exists for. If this ever passes,
  // the harness can no longer tell the two shapes apart and the arm above has
  // stopped measuring anything.
  for (const s of SCENARIOS) {
    it(`${s.name}: the legacy shape conflicts or merges to a wrong value`, () => {
      const x = sides(s);
      const { conflicts, merged } = merge3(
        serializeArtifact(legacyArtifact(x.a)),
        serializeArtifact(legacyArtifact(x.base)),
        serializeArtifact(legacyArtifact(x.b)),
      );
      const wrong = merged !== serializeArtifact(legacyArtifact(x.ab));
      expect(conflicts > 0 || wrong).toBe(true);
      // Every legacy scenario conflicts on the clock/sha/digest block, which is
      // the measured real-tree result as well.
      expect(conflicts).toBeGreaterThan(0);
    });
  }
});

describe('what the CLI writes is exactly this shape', () => {
  it('the committed artifact carries no run-only field', () => {
    // Reads the COMMITTED bytes. Regenerating with a run value folded back into
    // `meta` (or into a scope row) is the input that breaks this.
    const committed = JSON.parse(
      readFileSync(join(__dirname, '..', '__generated__', 'security-graph.json'), 'utf8'),
    ).artifact as SecurityGraphArtifact;
    expect(Object.keys(committed.meta).sort()).toEqual(['generatorVersion', 'scanScopes', 'skipped']);
    for (const scope of committed.meta.scanScopes) expect(Object.keys(scope)).toEqual(['scope']);
  });
});
