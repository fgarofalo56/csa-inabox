/**
 * console-ui-w2 — the seven free-text infrastructure surfaces this wave
 * converted to pickers stay converted.
 *
 * ── WHY THIS IS THE GUARD AND NOT A DOM ASSERTION ───────────────────────────
 * Every fix in this wave is "an `<Input>` a human typed an ARM id / endpoint /
 * credential into became a picker fed by a real discovery call". The thing that
 * can silently come back is the Input, and the component that decides whether
 * one is an infrastructure ask is `scripts/ci/check-no-freeform.mjs` — a
 * classifier with ~40 tags that CI runs on every PR. A `queryByPlaceholderText`
 * assertion in a spec would agree with a reimplementation of that classifier,
 * not with the classifier, and the two drift.
 *
 * So this SPAWNS the real guard, exactly as `wave1a-adopted-surfaces.test.tsx`
 * does, and reads its report. Byte-for-byte the command the guardrails workflow
 * runs.
 *
 * ── THE THREE OUTCOMES, ASSERTED SEPARATELY ─────────────────────────────────
 * "Zero sites" is the right assertion for only ONE of these files. The others
 * legitimately keep sites, and flattening the three cases into one "file is
 * clean" check would let a regression hide behind an acceptance:
 *
 *   DRAINED   the file has no classified site at all and has LEFT the baseline.
 *   ACCEPTED  every remaining site is a reviewed exception, so the file appears
 *             in the report only under an `[accepted]` prefix. A NEW un-accepted
 *             site in such a file is what this must catch — the ACCEPTED entry's
 *             own `sites` count also catches a drift, but only in the guard, and
 *             this states it in the spec too.
 *   PARTIAL   the file still carries sites, but not of the SHAPE this wave
 *             removed. Asserting the shape is gone is stronger than asserting a
 *             count, because a count can be satisfied by a different site
 *             appearing while the fixed one regresses.
 *
 * MUTATION RECEIPT (how each assertion was proven to fail): revert any one
 * picker to a PLACEHOLDER-SHAPED `<Input>` — the shape it had before this wave,
 * e.g. `placeholder="https://<cluster>.<region>.kusto.windows.net"` — and the
 * corresponding case goes red. Re-measured per branch on 2026-09-07, because
 * the first version of this claim was TRUE FOR TWO OF THE THREE and the third
 * was the one carrying the headline `#4201 … fully DRAINED` assertion:
 *
 *   DRAINED   `spark-job-definition-editor.tsx:807`, `AdlsPathPicker` ->
 *             `<Input placeholder="abfss://container@account.dfs.core.windows.
 *             net/path/job.py">`. Guard RC=1, 765 B of stderr, annotated
 *             `[shape:adls-uri,azure-host]`; this case FAILS with
 *             `expected [ Array(1) ] to deeply equal []`, the received element
 *             being that annotation. It did NOT fail before the helpers were
 *             taught the annotation shape — see THE TWO EMISSION SHAPES below,
 *             which is the whole reason this receipt is now per-branch.
 *   ACCEPTED  `stream-analytics-editor.tsx:596`, the `adxUri` AzureBackedField
 *             -> the same placeholder-shaped `<Input>`. `Tests 2 failed |
 *             5 passed`; #3517 fails on `expected [ …(3) ] to deeply equal []`
 *             — the ACCEPTED count no longer describes the file, so the guard
 *             annotates all three of its sites as `[accepted-file drift]`.
 *   PARTIAL   the forbidden SHAPE reappears in the report for that file, which
 *             the per-case `not.toMatch(/\[shape:arm-id\]/)` assertions read.
 *
 * ── THE DEFECT THIS RECEIPT USED TO HIDE (blocking review, 2026-09-07) ──────
 * The DRAINED line above previously read "the DRAINED file reappears as an
 * un-accepted line", and it was FALSE: measured at `8c94f9c`, that exact
 * mutation left the guard at RC=1 and this spec at 7/7 GREEN. The helpers
 * matched only the BASELINED listing shape, never the annotation shape a NEW
 * over-baseline site is emitted in, so the one verdict these assertions exist
 * for was the one they could not see — a `deploy-integrity.md` R7 assertion
 * this file's own code disproved. Fixed in `siteRe`, and the numbers above are
 * the post-fix re-measurement, not the pre-fix claim restated.
 *
 * ── WHAT THIS DOES NOT GUARD (measured, review 2026-09-07) ──────────────────
 * The claim above is deliberately narrower than "the picker stays". The
 * classifier keys on the placeholder and label SHAPE of an ask, not on the
 * presence of a picker, so a revert that asks for the same value WITHOUT a
 * recognizable placeholder is invisible to it. Measured on
 * `stream-analytics-editor.tsx`: replacing the `adxUri` AzureBackedField with a
 * placeholder-free, generically-labelled `<Field label="Cluster" required>
 * <Input value={outForm.cluster || ''} …/></Field>` left
 * `check-no-freeform.mjs` at RC=0 ("OK — no new violations", the ACCEPTED entry
 * still reading 2 sites) and this whole file at 7/7 green, #3517 included.
 *
 * That is a property of the classifier, not a hole to patch here: adding tags
 * until this particular revert is caught only moves the boundary, since the
 * next unlabelled shape walks through it (memory: the narrow-bypass treadmill).
 * So these cases guard "a PLACEHOLDER-SHAPED infrastructure ask does not come
 * back" — now true of all three branches, which it was not when this paragraph
 * was first written — and the picker's continued presence is guarded by the
 * surface's own behavioural specs, not by this file.
 *
 * ONE LIMIT THAT REMAINS, stated because an unstated one reads as coverage:
 * when the ACCEPTED count drifts, `check-no-freeform.mjs` returns before it
 * prints the ratchet listing, so `--report` loses the baselined population
 * entirely. That is why the embedded control at the bottom of this file also
 * goes red under the ACCEPTED mutation above, and why a mutation touching two
 * files at once can hide the second one's site. Pre-existing guard behaviour,
 * not something these helpers can repair.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

// vitest runs with `apps/fiab-console` as its root, so the repo root is two up.
const REPO = path.resolve(process.cwd(), '../..');

/**
 * The guard's full site report, BOTH streams. The split is not stdout-summary /
 * stderr-detail — it is by VERDICT, and reading it wrong is what made the first
 * version of this file's DRAINED case vacuous (see THE TWO EMISSION SHAPES):
 *
 *   stdout  the run summary, the ACCEPTED table, and — under `--report` — the
 *           BASELINED population, one `  <rel>:<line> [kind:ids] evidence` row
 *           per site (`check-no-freeform.mjs`, the `else if (verbose)` branch).
 *   stderr  the FINDINGS: a GitHub annotation per site that is ABOVE its file's
 *           baseline, `::error file=<rel>,line=<n>::…`, plus the accepted-file
 *           drift annotations and the rollup.
 *
 * A helper that read only stdout would return a string naming no files at all;
 * a helper that reads both but matches only ONE of the two shapes is worse,
 * because it looks like it is reading the findings and is not.
 *
 * The exit code is deliberately ignored: the ratchet can fail for reasons that
 * have nothing to do with these files. What must NOT be ignored is the guard
 * failing to run, so that is asserted.
 */
function guardReport(): string {
  const r = spawnSync(process.execPath, ['scripts/ci/check-no-freeform.mjs', '--report'], {
    cwd: REPO, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
  expect(r.error, String(r.error)).toBeUndefined();
  const out = `${r.stdout || ''}\n${r.stderr || ''}`;
  expect(out, 'guard produced no report').toMatch(/asking for an infrastructure value/);
  return out;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * ── THE TWO EMISSION SHAPES, AND WHY BOTH MUST BE MATCHED ──────────────────
 * The guard names a site in two different syntaxes depending on its verdict,
 * and they are NOT interchangeable:
 *
 *   baselined / accepted   `  apps/…/x.tsx:807 [shape:adls-uri] Evidence: …`
 *   OVER BASELINE          `::error file=apps/…/x.tsx,line=807::no-freeform …`
 *
 * `<rel>:<line>` vs `file=<rel>,line=<line>` — a comma where the colon was.
 * Until 2026-09-07 both helpers matched only the first, i.e. only the
 * BASELINED listing, so the one verdict these assertions exist to catch was
 * the one they could not see. MEASURED at `8c94f9c`: reverting the DRAINED
 * file's `AdlsPathPicker` to a placeholder-shaped `<Input>` put the guard at
 * RC=1 with `::error file=apps/fiab-console/lib/editors/spark-job-definition-
 * editor.tsx,line=807::no-freeform [shape:adls-uri,azure-host]` on stderr and
 * ZERO occurrences of that path on stdout — and this spec stayed 7/7 GREEN.
 * `expect(allSites(…)).toEqual([])` passed over a live regression, which is
 * `csa_loom_gates_that_measure_nothing` inside the spec that guards it.
 *
 * So the alternation below is load-bearing, not defensive. It is the only
 * reason the DRAINED case is an assertion about the guard's FINDINGS rather
 * than about its inventory.
 */
function siteRe(rel: string, anchored: boolean): RegExp {
  const listing = `${anchored ? '^\\s{2}' : ''}${esc(rel)}:\\d+\\s`;
  const annotation = `${anchored ? '^::error ' : ''}file=${esc(rel)},line=\\d+`;
  return new RegExp(`(?:${listing}|${annotation})`);
}

/** Site lines the guard did NOT mark `[accepted]`, for one file — in EITHER
 *  shape. An over-baseline annotation is by definition not accepted (an
 *  accepted file's sites are never annotated as findings), so it belongs here. */
function liveSites(report: string, rel: string): string[] {
  return report
    .split('\n')
    .filter((l) => !l.includes('[accepted]'))
    // The ACCEPTED banner names the file in prose; only indented site rows and
    // real annotations count, hence the anchored form.
    .filter((l) => siteRe(rel, true).test(l));
}

/** Every site line for one file, accepted or not, in EITHER shape. */
function allSites(report: string, rel: string): string[] {
  return report.split('\n').filter((l) => siteRe(rel, false).test(l));
}

describe('console-ui-w2 — the converted surfaces stay converted', () => {
  /**
   * THE CLASS GUARD for the blocking defect above, and it runs FIRST because
   * every assertion below is only as good as this one. It needs no guard
   * spawn: it feeds the helpers one line of each emission shape, verbatim from
   * a real run, and asserts they see both.
   *
   * Delete the annotation alternative from `siteRe` and this fails in three
   * places at once — which is what did NOT happen while the DRAINED case was
   * silently vacuous.
   */
  it('the helpers read BOTH shapes the guard names a site in — listing AND annotation', () => {
    const rel = 'apps/fiab-console/lib/editors/spark-job-definition-editor.tsx';
    // Verbatim from `node scripts/ci/check-no-freeform.mjs --report`, stdout.
    const listing = `  ${rel}:807 [shape:adls-uri] Evidence: Main definition file`;
    // Verbatim from the same guard on stderr with the picker reverted.
    const annotation = `::error file=${rel},line=807::no-freeform [shape:adls-uri,azure-host]: this free-text Input asks the user for an ADLS / blob URI the user must compose.`;

    expect(allSites(listing, rel), 'baselined listing row is invisible').toHaveLength(1);
    expect(allSites(annotation, rel), 'over-baseline ANNOTATION is invisible — the blocking defect').toHaveLength(1);
    expect(liveSites(annotation, rel), 'an over-baseline annotation is a LIVE site').toHaveLength(1);
    expect(liveSites(listing, rel), 'baselined listing row counts as live').toHaveLength(1);

    // …and neither helper may fabricate a hit for a DIFFERENT file, which is
    // how a too-loose alternation would turn every assertion below green.
    const other = 'apps/fiab-console/lib/editors/stream-analytics-editor.tsx';
    expect(allSites(`${listing}\n${annotation}`, other)).toEqual([]);
    // The ACCEPTED banner names the file in prose with no `:line`; it must not
    // be mistaken for a site row by either helper.
    const banner = `  ACCEPTED [byo] (ref) ${rel} — 2 site(s): a customer-owned receiver`;
    expect(allSites(banner, rel)).toEqual([]);
    expect(liveSites(banner, rel)).toEqual([]);
  });

  it('#4201 spark-job-definition-editor is fully DRAINED — no site, accepted or otherwise', () => {
    const rel = 'apps/fiab-console/lib/editors/spark-job-definition-editor.tsx';
    expect(allSites(guardReport(), rel)).toEqual([]);
  });

  it('#4201 azure-services-editors keeps ONLY the ADF pagination JSONPath, and it is accepted', () => {
    const rel = 'apps/fiab-console/lib/editors/azure-services-editors.tsx';
    const report = guardReport();
    expect(liveSites(report, rel)).toEqual([]);
    // The one that remains is the false positive, not the abfss:// job file.
    expect(allSites(report, rel)).toHaveLength(1);
    expect(allSites(report, rel)[0]).toMatch(/Pagination next-URL/);
  });

  it('#3515 event-grid-topic-editor keeps ONLY the BYO Web Hook receiver', () => {
    const rel = 'apps/fiab-console/lib/editors/event-grid-topic-editor.tsx';
    const report = guardReport();
    expect(liveSites(report, rel)).toEqual([]);
    // Neither the handler ARM id nor the dead-letter storage id may come back.
    expect(report).not.toMatch(
      new RegExp(`${rel.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}:\\d+ \\[shape:arm-id\\]`),
    );
    expect(allSites(report, rel)).toHaveLength(2);
  });

  it('#3517 stream-analytics-editor keeps ONLY the two managed-identity ALTERNATIVE keys', () => {
    const rel = 'apps/fiab-console/lib/editors/stream-analytics-editor.tsx';
    const report = guardReport();
    expect(liveSites(report, rel)).toEqual([]);
    const sites = allSites(report, rel);
    expect(sites).toHaveLength(2);
    // Both survivors are credentials. The ADX cluster URL and the storage
    // account — the two addresses this wave pickerized — are gone.
    for (const s of sites) expect(s).toMatch(/\[shape:password-field\]/);
  });

  it('#3540 the Unity Catalog credential surfaces no longer ask for an ARM id', () => {
    const report = guardReport();
    for (const rel of [
      'apps/fiab-console/lib/editors/databricks/uc-dialogs.tsx',
      'apps/fiab-console/app/catalog/unity/page.tsx',
    ]) {
      const armIdSites = allSites(report, rel).filter((l) => l.includes('[shape:arm-id]'));
      expect(armIdSites, `${rel} regained a hand-typed ARM id`).toEqual([]);
    }
  });

  it('#3626 unified-sql-database-editor no longer asks for a password', () => {
    const rel = 'apps/fiab-console/lib/editors/unified-sql-database-editor.tsx';
    const report = guardReport();
    const pw = allSites(report, rel).filter((l) => l.includes('[shape:password-field]'));
    expect(pw, 'the PostgreSQL admin password box came back — it is minted server-side').toEqual([]);
  });

  /**
   * The embedded control. Every assertion above is of the form "this file is
   * absent from / thin in the report", and all of them pass against an empty
   * report. This one fails if the guard ever stops naming files, which is the
   * only way the six above could go green while measuring nothing.
   */
  it('and the guard still NAMES files that DO carry an un-accepted site', () => {
    const report = guardReport();
    expect(report).toMatch(/apps\/fiab-console\/lib\/components\/pipeline\/manage-panel\.tsx:\d+/);
    expect(report).toMatch(/\d+ asking for an infrastructure value across \d+ file\(s\)/);
  });
});
