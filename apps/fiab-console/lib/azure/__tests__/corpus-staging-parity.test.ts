/**
 * DRIFT GUARD: the corpus walker's roots vs. what the stager copies into the image.
 *
 * ── Why this exists (2026-08-22) ────────────────────────────────────────────
 *
 * The retrieval corpus is described by TWO hand-maintained lists in two
 * languages:
 *
 *   1. `detectRoots()` in `lib/azure/loom-docs-corpus.ts` — the roots the
 *      walker READS, in both the repo-checkout and bundled-image forms.
 *   2. `SOURCES` in `scripts/csa-loom/stage-copilot-corpus.sh` — the trees
 *      COPIED into the Docker build context, because repo-root `docs/` and
 *      `PRPs/` sit outside the `apps/fiab-console` build context.
 *
 * They have already drifted once, and the drift was invisible in the worst
 * possible way. The omnibus consolidation (57fa48f6 / #3881) moved 22 PRP units
 * into `PRPs/archive/`, so the walker needed an archive root. Adding ONLY the
 * walker root turns every test green — the dev branch of `detectRoots()` walks
 * the real repo, where the archive exists — while the PRODUCTION image ships a
 * root pointing at a directory the stager never created. `walkMarkdown` returns
 * `[]` for a missing dir, so the live Copilot would have seen zero archived
 * documents with nothing red anywhere. A fix that looks applied and is inert is
 * worse than the bug it replaces.
 *
 * ── Why an assertion rather than deriving one list from the other ───────────
 *
 * Deriving would be better and was considered. It is not practical here:
 * `detectRoots()` returns a NAMED-FIELD `RepoRoots` object whose fields are
 * consumed by `loom-docs-index.ts`, so collapsing it into an iterable list is a
 * refactor that ripples outside this change. Reading the TS from bash (or the
 * shell from TS) at runtime means one of them parsing the other's source, which
 * is the fragile half of the `derive-infra-reading-suites.mjs` pattern without
 * its payoff. So the two lists stay explicit and THIS asserts they are equal —
 * which catches drift in BOTH directions, which is the property that matters.
 *
 * If this test fails, do not delete a case: add the root to whichever list is
 * missing it.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { detectRoots } from '../loom-docs-corpus';

/** Repo root — walk up from cwd (apps/fiab-console) until `mkdocs.yml`. */
function repoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'mkdocs.yml'))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error('repo root (mkdocs.yml) not found from ' + process.cwd());
}

const STAGER_REL = 'scripts/csa-loom/stage-copilot-corpus.sh';

/**
 * The `<src>|<destsub>` pairs from the stager's `SOURCES` heredoc-ish block.
 * Parsed from the literal text rather than by running the script, so this is
 * fast, hermetic, and works on a machine with no bash.
 */
function stagedDestinations(stagerText: string): string[] {
  const block = stagerText.match(/^SOURCES="\n([\s\S]*?)^"/m);
  if (!block) throw new Error('could not locate the SOURCES block in ' + STAGER_REL);
  return block[1]
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'))
    .map((l) => {
      const [, destsub] = l.split('|');
      if (!destsub) throw new Error('malformed SOURCES line: ' + l);
      return destsub.trim();
    });
}

/**
 * EVERY corpus root the walker reads, as paths RELATIVE to the bundled corpus
 * dir, DERIVED from the returned object rather than hand-listed.
 *
 * ── Why derived, after the first version was blind (review, 2026-08-23) ─────
 *
 * v1 listed the five fields it knew about and asserted `walker.length === 5`.
 * That made the guard blind to THE EXACT RECURRENCE IT EXISTS TO PREVENT: add
 * a SIXTH root to `RepoRoots` and forget the stager — the #3881 shape — and the
 * hand-list simply never mentions it, the length check still sees 5, and the
 * test passes (measured: RC=0, 4 passed, with an unstaged `PRPs/drafts` root
 * live in `detectRoots()`). It also silently omitted `adrRoot`, harmless today
 * only because the staged `docs` tree happens to cover it.
 *
 * `Object.entries` means a new field is in scope the moment it is added, so the
 * walker side is now genuinely derived like the stager side already was. The
 * only hand-maintained fact left is which roots are KNOWN to be unstaged, and
 * that is asserted exactly (below), not filtered.
 */
function walkerBundledRoots(): string[] {
  const cwd = process.cwd();
  const tmp = fs.mkdtempSync(path.join(cwd, '.corpus-roots-probe-'));
  try {
    // detectRoots() takes the bundled branch when `<cwd>/copilot-corpus/docs`
    // exists, so probe it in an isolated cwd rather than mutating the real one.
    const bundled = path.join(tmp, 'copilot-corpus');
    fs.mkdirSync(path.join(bundled, 'docs'), { recursive: true });
    process.chdir(tmp);
    const roots = detectRoots() as unknown as Record<string, string>;
    const rel = (p: string) => path.relative(bundled, p).replace(/\\/g, '/');
    expect(rel(roots.repoRoot)).toBe('');
    return Object.entries(roots)
      .filter(([key]) => key !== 'repoRoot')
      .map(([key, value]) => {
        // A root that is not a string is a malformed RepoRoots, not something
        // to coerce — say so rather than throwing a bare TypeError out of
        // path.relative(), which is how the removed-root case used to fail.
        expect(
          typeof value,
          `detectRoots().${key} is ${typeof value}, expected a string path`,
        ).toBe('string');
        return rel(value);
      });
  } finally {
    process.chdir(cwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Roots that MUST exist on `RepoRoots`. Removing one from `detectRoots()` drops
 * it from the derived list above, which would otherwise make this guard quietly
 * measure less — the removal would look like "nothing unstaged". Asserted by
 * name so that case fails with a guided message instead of a TypeError.
 */
const REQUIRED_WALKER_ROOTS = ['docs', 'PRPs/active', 'PRPs/archive', 'PRPs/completed/csa-loom-pillar'];


/**
 * KNOWN, PRE-EXISTING GAP — asserted EXACTLY, not skipped.
 *
 * `detectRoots()` points `consoleLibRoot` at `<bundled>/lib` in the image, but
 * the stager is markdown-only and never stages `lib/`, and the Dockerfile
 * copies only `copilot-corpus`. So the production corpus contains ZERO
 * `repo`-kind chunks — measured 2026-08-22: the repo checkout enumerates 1,387
 * of them and the staged tree enumerates none. That is a real gap in
 * "where does X live in code?" answers and it PREDATES the archive-root work;
 * it is reported rather than fixed here because staging TypeScript into the
 * image is a size/behaviour decision of its own, not a corpus-roots bugfix.
 *
 * It is listed here rather than filtered out silently so the assertion below
 * fails in BOTH directions: a NEW unstaged root fails, and FIXING this one also
 * fails — forcing whoever stages `lib/` to delete this entry in the same PR
 * instead of leaving a stale exemption behind.
 */
const KNOWN_UNSTAGED_ROOTS = ['lib'];


describe('corpus walker roots vs. image staging', () => {
  const root = repoRoot();
  const stagerText = fs.readFileSync(path.join(root, STAGER_REL), 'utf-8');

  it('parses a non-empty SOURCES list from the stager (control)', () => {
    // A parser that silently matched nothing would make every assertion below
    // vacuously true — the exact "guard with zero population" shape. This
    // asserts the PARSER works; whether the list is COMPLETE is the next test's
    // job, so a genuine drift fails there with a useful message instead of
    // reddening this one too.
    const dests = stagedDestinations(stagerText);
    expect(dests.length).toBeGreaterThan(0);
    expect(dests).toContain('docs');
  });

  it('every root the walker reads in the image is staged into the image', () => {
    const staged = stagedDestinations(stagerText);
    const walker = walkerBundledRoots();

    // Control: the probe produced roots at all, and the roots this guard is
    // ABOUT are still present. Asserted by NAME, not by count — a count check
    // passes happily when a root is added, which is the #3881 shape.
    expect(walker.length).toBeGreaterThan(0);
    for (const required of REQUIRED_WALKER_ROOTS) {
      expect(
        walker,
        `detectRoots() no longer declares a root for '${required}'. If that was ` +
          'deliberate, remove it from REQUIRED_WALKER_ROOTS here and from SOURCES ' +
          `in ${STAGER_REL} in the same PR — otherwise this guard silently stops ` +
          'checking the thing it exists for.',
      ).toContain(required);
    }

    // A walker root is covered when the stager copies it or an ancestor of it.
    const covered = (r: string) =>
      staged.some((d) => r === d || r.startsWith(d + '/'));

    const uncovered = walker.filter((r) => !covered(r)).sort();
    expect(
      uncovered,
      'the set of corpus roots that detectRoots() reads but the stager never copies has ' +
        'CHANGED. In the production image an unstaged root resolves to a missing directory ' +
        'and walks NOTHING, so the feature looks shipped and is inert. If you added a root, ' +
        `add it to SOURCES in ${STAGER_REL}; if you fixed the known gap, remove it from ` +
        `KNOWN_UNSTAGED_ROOTS. Found: [${uncovered.join(', ')}]`,
    ).toEqual([...KNOWN_UNSTAGED_ROOTS].sort());
  });

  it('every tree the stager copies is actually read by the walker', () => {
    // The other direction: a staged tree nothing reads bloats the image and is
    // usually the residue of a root that was renamed on the TS side only.
    const staged = stagedDestinations(stagerText);
    const walker = walkerBundledRoots();

    const read = (d: string) =>
      walker.some((r) => r === d || r.startsWith(d + '/') || d.startsWith(r + '/'));

    const unread = staged.filter((d) => !read(d));
    expect(
      unread,
      `${STAGER_REL} stages these trees but no detectRoots() root reads them: ` +
        unread.join(', '),
    ).toEqual([]);
  });

  it('the stager creates the destination dir for every tree it stages', () => {
    // `mkdir -p` and SOURCES are a third copy of the same list, one line apart.
    const staged = stagedDestinations(stagerText);
    const mkdir = stagerText.match(/^mkdir -p (.*)$/m);
    expect(mkdir, 'no `mkdir -p` line found in ' + STAGER_REL).toBeTruthy();
    const missing = staged.filter((d) => !mkdir![1].includes(`$DEST/${d}"`));
    expect(
      missing,
      `staged but never mkdir'd in ${STAGER_REL}: ${missing.join(', ')}`,
    ).toEqual([]);
  });
});
