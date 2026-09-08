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
 *             the per-case `hasShape(l, 'arm-id')` / `hasShape(l,
 *             'password-field')` filters read. MEASURED for #3540 on
 *             `uc-dialogs.tsx:1741`: the Access-Connector `AzureBackedField` ->
 *             `<Field label="Access connector ARM id" hint="e.g. abfss://…">
 *             <Input …/></Field>`. Guard RC=1, annotated
 *             `[shape:adls-uri,azure-host,arm-id]`; this case FAILS on that
 *             annotation. It did NOT fail while those filters were
 *             `l.includes('[shape:arm-id]')` — see THE TAG LIST IS ALSO A LIST.
 *
 * ── THE DEFECT THIS RECEIPT USED TO HIDE (blocking review, 2026-09-07) ──────
 * TWICE, one level apart, and both are recorded because a corrected claim that
 * hides its predecessor is the same over-assertion again:
 *
 *   1. The DRAINED line above once read "the DRAINED file reappears as an
 *      un-accepted line", and it was FALSE: measured at `8c94f9c`, that exact
 *      mutation left the guard at RC=1 and this spec at 7/7 GREEN. The helpers
 *      matched only the BASELINED listing shape, never the annotation shape a
 *      NEW over-baseline site is emitted in, so the one verdict these
 *      assertions exist for was the one they could not see. Fixed in `siteRe`.
 *   2. The PARTIAL line above then claimed the per-case assertions read the
 *      SHAPE, and for #3540 they did not: measured at `45e01b8`, the
 *      multi-tag mutation quoted above put the guard at RC=1 and this spec at
 *      8/8 GREEN, because `includes('[shape:arm-id]')` only matches when
 *      `arm-id` is the SOLE tag and multi-tag is the ordinary case in that
 *      dialog. Fixed in `hasShape`.
 *
 * Both were `deploy-integrity.md` R7 assertions this file's own subject
 * disproved, and the numbers above are post-fix re-measurements rather than
 * either claim restated.
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
 * ── THE THREE FILES ADDED IN RE-REVIEW (nit 6, 2026-09-07) ─────────────────
 * `shortcut-wizard.tsx`, `lakehouse-shortcut-editor.tsx` and
 * `foundry-hub-editor.tsx` are touched by this wave but had no case here — the
 * ratchet's baseline exit covered them in CI while this spec said nothing about
 * what they are allowed to KEEP. They now have per-file arms, all ACCEPTED or
 * PARTIAL: the first two keep only credentials minted on someone else's cloud
 * plus two addresses that are not Azure resources at all, and the third keeps
 * only Key Vault secret IDENTIFIERS. Their assertions read the `[name:…]`
 * bracket as well as `[shape:…]` — see `hasTag`.
 *
 * ONE LIMIT THAT REMAINS, stated because an unstated one reads as coverage:
 * when the ACCEPTED count drifts, `check-no-freeform.mjs` returns before it
 * prints the ratchet listing, so `--report` loses the baselined population
 * entirely. That is why the embedded control at the bottom of this file also
 * goes red under the ACCEPTED mutation above, and why a mutation touching two
 * files at once can hide the second one's site. Pre-existing guard behaviour,
 * not something these helpers can repair.
 */
import { describe, it, expect, beforeAll } from 'vitest';
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
 *
 * ── SPAWNED ONCE, NOT ONCE PER CASE ────────────────────────────────────────
 * `spawnSync` BLOCKS the vitest worker's event loop, and the guard takes ~4s
 * over the whole tree. Seven cases meant seven serial blocking spawns, which
 * starved vitest's `onTaskUpdate` RPC heartbeat: measured 2026-09-07 on this
 * workstation, 3 of 5 consecutive runs of an otherwise-passing file ended
 * RC=1 — twice on `[vitest-worker]: Timeout calling "onTaskUpdate"` with all
 * 9 tests reported PASSED, and once on three cases hitting the 30s
 * `testTimeout` outright. A spec that reds on machine load is not measuring
 * its subject, which is the same class of defect as one that greens over a
 * regression.
 *
 * The report is a pure function of the working tree and the tree does not
 * change during a run, so one spawn serves every case, and it happens in a
 * `beforeAll` with its own generous timeout rather than inside whichever case
 * happens to run first. That matters: on a loaded machine a SINGLE guard run
 * was measured at 144s, so leaving the spawn under the 30s per-test
 * `testTimeout` would just move the same load-dependent red onto one case.
 * This is a scheduling change only — the command, its arguments and the two
 * streams read are unchanged.
 */
let CACHED: string | null = null;

function runGuard(): string {
  const r = spawnSync(process.execPath, ['scripts/ci/check-no-freeform.mjs', '--report'], {
    cwd: REPO, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
  expect(r.error, String(r.error)).toBeUndefined();
  const out = `${r.stdout || ''}\n${r.stderr || ''}`;
  expect(out, 'guard produced no report').toMatch(/asking for an infrastructure value/);
  return out;
}

/** The one spawn, off the per-test clock. */
beforeAll(() => { CACHED = runGuard(); }, 600_000);

function guardReport(): string {
  // Lazy fallback, so the helper is still correct if a future case runs
  // outside this file's `beforeAll`.
  if (CACHED === null) CACHED = runGuard();
  return CACHED;
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

/**
 * ── THE TAG LIST INSIDE THE BRACKET IS ALSO A LIST ─────────────────────────
 * `siteRe` above taught the helpers the two BRACKET syntaxes; this teaches them
 * the list INSIDE the bracket, which was the same defect one level down.
 *
 * The guard tags a site with EVERY shape it matched, comma-joined:
 * `[shape:arm-id]` when one pattern fired, `[shape:adls-uri,azure-host,arm-id]`
 * when three did. Multi-tag is the ordinary case in these files, not the exotic
 * one — the baselined listing is full of `[shape:connection-string,secret-
 * descriptor]` and `[shape:azure-host,templated-host]`.
 *
 * MEASURED at `45e01b8`, which is why this exists: the #3540 case filtered with
 * `l.includes('[shape:arm-id]')`, so reverting the uc-dialogs Access-Connector
 * picker to a hand-typed ARM-id `<Input>` whose hint ALSO named an abfss host
 * (four of its neighbours are abfss locations, so this is an ordinary shape
 * there) put the guard at RC=1 —
 * `uc-dialogs.tsx,line=1741::no-freeform [shape:adls-uri,azure-host,arm-id]` —
 * and left this spec at 8/8 GREEN. The case stayed green over the precise
 * regression it exists to catch, because `arm-id` was no longer the SOLE tag.
 *
 * So the tag is matched bounded by `[shape:` or a comma on the left and a comma
 * or `]` on the right. `[shape:non-arm-id]` is NOT a hit for `arm-id`, and
 * `[shape:arm-id-ish]` is not either — the bounds are what make that true.
 */
function hasShape(line: string, tag: string): boolean {
  return new RegExp(`\\[shape:(?:[^\\]]*,)?${esc(tag)}(?:,[^\\]]*)?\\]`).test(line);
}

/**
 * The same bounded match over EITHER bracket the classifier emits. It tags a
 * site by HOW it matched: `[shape:…]` when a placeholder/hint pattern fired,
 * `[name:…]` when the field or variable NAME did. Measured in the current
 * report, the three files added below carry both kinds on adjacent lines —
 * `lakehouse-shortcut-editor.tsx:412 [shape:password-field]` next to
 * `:445 [name:secret-value,secret-ref]` — so a helper that read only `shape:`
 * would silently answer "no such site" for half of each file's population, and
 * an assertion built on it would pass for the wrong reason.
 *
 * `hasShape` is deliberately NOT redefined in terms of this: the cases above
 * were measured against the shape bracket specifically, and widening them now
 * would change what those receipts mean.
 */
function hasTag(line: string, tag: string): boolean {
  return new RegExp(`\\[(?:shape|name):(?:[^\\]]*,)?${esc(tag)}(?:,[^\\]]*)?\\]`).test(line);
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

  /**
   * THE SECOND CLASS GUARD, for the level below: the tag list INSIDE the
   * bracket. `siteRe` finds the LINE; `hasShape` decides whether the shape a
   * case names is on it, and matching that by substring made the #3540 case
   * blind to its own target the moment the site carried more than one tag
   * (measured at `45e01b8` — see the `hasShape` header). The third fixture
   * below is the exact annotation that mutation produced.
   */
  it('the tag test reads a MULTI-TAG shape list, not just a sole tag', () => {
    const rel = 'apps/fiab-console/lib/editors/databricks/uc-dialogs.tsx';
    const sole = `  ${rel}:1741 [shape:arm-id] Evidence: Access connector ARM id`;
    // Verbatim from `node scripts/ci/check-no-freeform.mjs` (stderr) with the
    // Access-Connector picker reverted to an ARM-id Input whose hint names an
    // abfss host — RC=1, and this spec was 8/8 GREEN before `hasShape` existed.
    const multi = `::error file=${rel},line=1741::no-freeform [shape:adls-uri,azure-host,arm-id]: this free-text Input asks the user for an ARM resource id.`;

    expect(hasShape(sole, 'arm-id'), 'sole tag').toBe(true);
    expect(hasShape(multi, 'arm-id'), 'LAST tag of three — the blocking defect').toBe(true);
    expect(hasShape(multi, 'adls-uri'), 'FIRST tag of three').toBe(true);
    expect(hasShape(multi, 'azure-host'), 'MIDDLE tag of three').toBe(true);
    // …and it must not fire on a tag that merely CONTAINS or is contained by
    // the one asked for, which is what a substring test would do.
    expect(hasShape(multi, 'password-field')).toBe(false);
    expect(hasShape('  x.tsx:1 [shape:non-arm-id] Evidence: y', 'arm-id')).toBe(false);
    expect(hasShape('  x.tsx:1 [shape:arm-id-ish] Evidence: y', 'arm-id')).toBe(false);
    expect(hasShape('  x.tsx:1 [shape:arm] Evidence: y', 'arm-id')).toBe(false);

    // The helpers and the tag test compose: the multi-tag ANNOTATION is both a
    // site line for this file and an arm-id site.
    expect(allSites(multi, rel).filter((l) => hasShape(l, 'arm-id'))).toHaveLength(1);

    // `hasTag` reads the NAME bracket too — the per-file arms below need it,
    // because `[name:secret-value,secret-ref]` and `[shape:password-field]`
    // both appear in those files and `hasShape` sees only the second.
    const named = '    [accepted] x.tsx:1027 [name:secret-value,secret-ref] Service-account JSON';
    expect(hasShape(named, 'secret-ref'), 'hasShape must NOT read the name bracket').toBe(false);
    expect(hasTag(named, 'secret-ref'), 'name bracket, LAST tag').toBe(true);
    expect(hasTag(named, 'secret-value'), 'name bracket, FIRST tag').toBe(true);
    expect(hasTag(sole, 'arm-id'), 'shape bracket still matches').toBe(true);
    expect(hasTag(multi, 'azure-host'), 'shape bracket, middle of three').toBe(true);
    // …with the same bounds, so a shorter or longer neighbouring tag is no hit.
    expect(hasTag(named, 'secret')).toBe(false);
    expect(hasTag(named, 'secret-values')).toBe(false);
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
    // Neither the handler ARM id nor the dead-letter storage id may come back —
    // in EITHER emission shape, and whether or not `arm-id` is the only tag the
    // site matched.
    expect(allSites(report, rel).filter((l) => hasShape(l, 'arm-id'))).toEqual([]);
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
    for (const s of sites) expect(hasShape(s, 'password-field'), s).toBe(true);
  });

  it('#3540 the Unity Catalog credential surfaces no longer ask for an ARM id', () => {
    const report = guardReport();
    for (const rel of [
      'apps/fiab-console/lib/editors/databricks/uc-dialogs.tsx',
      'apps/fiab-console/app/catalog/unity/page.tsx',
    ]) {
      const armIdSites = allSites(report, rel).filter((l) => hasShape(l, 'arm-id'));
      expect(armIdSites, `${rel} regained a hand-typed ARM id`).toEqual([]);
    }
  });

  it('#3626 unified-sql-database-editor no longer asks for a password', () => {
    const rel = 'apps/fiab-console/lib/editors/unified-sql-database-editor.tsx';
    const report = guardReport();
    const pw = allSites(report, rel).filter((l) => hasShape(l, 'password-field'));
    expect(pw, 'the PostgreSQL admin password box came back — it is minted server-side').toEqual([]);
  });

  /**
   * ── THE THREE FILES THAT HAD ONLY THE RATCHET (re-review 2026-09-07, nit 6) ─
   * `shortcut-wizard.tsx`, `lakehouse-shortcut-editor.tsx` and
   * `foundry-hub-editor.tsx` are all touched by this wave and were covered only
   * by the ratchet's baseline exit — a regression in them fails
   * `check-no-freeform.mjs` in CI, but this spec, which is where the per-file
   * INTENT is written down, said nothing about what they are ALLOWED to keep.
   *
   * Each is an ACCEPTED or PARTIAL case in the taxonomy at the top, never a
   * DRAINED one: none of these three is empty of sites, and asserting that any
   * of them was would be false.
   *
   * The counts and tag sets below are read from the CURRENT report
   * (`node scripts/ci/check-no-freeform.mjs --report`, RC=0, 0 B on stderr),
   * not from the baseline JSON, so they describe what the classifier says today.
   *
   * MUTATION RECEIPT — one per arm, each measured on 2026-09-07 by reverting a
   * picker in THAT file and reverting it back. These are three separate arms so
   * they get three separate measurements; a receipt taken on one and asserted
   * of the other two would be the over-assertion this PR was blocked for:
   *
   *   foundry-hub-editor  `BlobContainerPicker` -> `<Field label="Container /
   *     filesystem" hint="abfss://<container>@<account>.dfs.core.windows.net">
   *     <Input placeholder=… /></Field>`. Guard RC=1, 1996 B stderr,
   *     `foundry-hub-editor.tsx: 3 (baseline 2)` with the new site annotated
   *     `[shape:adls-uri,azure-host]`. Spec `Tests 1 failed | 11 passed`, the
   *     foundry arm alone, on `expected [ …(3) ] to have a length of 2 but got 3`.
   *   shortcut-wizard  the Dataverse `AdlsPathPicker` -> a placeholder-shaped
   *     `<Input>`. Guard RC=1, 2869 B stderr, `ACCEPTED entry … declares 4
   *     site(s); the classifier now finds 5`. Spec `Tests 3 failed | 9 passed`:
   *     the wizard arm on `expected [ …(5) ] to deeply equal []` (liveSites —
   *     the five `[accepted-file drift]` annotations are NOT `[accepted]`).
   *   lakehouse-shortcut-editor  the "Path / prefix" `<Input>` given an
   *     abfss-shaped placeholder + hint. Guard RC=1, 3760 B stderr, same
   *     accepted-drift shape. Spec `Tests 3 failed | 9 passed`, this arm on
   *     `expected [ …(6) ] to deeply equal []`.
   *
   * THE COLLATERAL IN THE TWO ACCEPTED CASES IS THE DOCUMENTED LIMIT, NOT A
   * BONUS: an accepted-count drift makes the guard return before it prints the
   * ratchet listing, so the baselined population vanishes from `--report` and
   * the foundry arm (`expected [] to have a length of 2`) and the embedded
   * control fail too. That is the limit stated at the top of this file, and it
   * is why an accepted-file mutation cannot be used as the receipt for a
   * DIFFERENT file's arm — each arm above was measured against its own file.
   */
  it('#3718 the OneLake shortcut wizard keeps ONLY foreign-cloud credentials', () => {
    const rel = 'apps/fiab-console/lib/components/onelake/shortcut-wizard.tsx';
    const report = guardReport();
    // Every survivor is a reviewed exception, so nothing here is un-accepted.
    expect(liveSites(report, rel)).toEqual([]);
    const sites = allSites(report, rel);
    expect(sites).toHaveLength(4);
    // …and all four are CREDENTIALS — an AWS key pair, a GCS service-account
    // JSON, a SAS: values minted on someone else's cloud that no Azure
    // discovery call could ever produce.
    for (const s of sites) {
      expect(
        hasTag(s, 'secret-value') || hasTag(s, 'secret-ref') || hasTag(s, 'password-field'),
        s,
      ).toBe(true);
    }
    // The Azure-side asks this wave replaced with pickers (the ADLS account,
    // its container, the Synapse Link export path) may not come back in any of
    // the shapes the classifier would name them by.
    for (const tag of ['adls-uri', 'arm-id', 'storage-loc', 'bare-locator']) {
      expect(sites.filter((l) => hasTag(l, tag)), `${tag} came back`).toEqual([]);
    }
  });

  it('#3718 lakehouse-shortcut-editor keeps 3 credentials + 2 NON-Azure locators', () => {
    const rel = 'apps/fiab-console/lib/editors/lakehouse-shortcut-editor.tsx';
    const report = guardReport();
    expect(liveSites(report, rel)).toEqual([]);
    const sites = allSites(report, rel);
    expect(sites).toHaveLength(5);
    // The two that are NOT credentials are addresses outside Azure entirely: an
    // S3-compatible API host (MinIO / Wasabi) and a Dataverse environment URL.
    // Resource Graph cannot enumerate either, which is why they are the two
    // exceptions — and why they are NAMED here rather than merely counted, so a
    // different locator taking their place is still a failure.
    const locators = sites.filter(
      (l) => !hasTag(l, 'secret-value') && !hasTag(l, 'secret-ref') && !hasTag(l, 'password-field'),
    );
    expect(locators).toHaveLength(2);
    expect(locators.some((l) => /Endpoint host/.test(l)), String(locators)).toBe(true);
    expect(locators.some((l) => /Dataverse environment URL/.test(l)), String(locators)).toBe(true);
    for (const tag of ['adls-uri', 'arm-id', 'storage-loc']) {
      expect(sites.filter((l) => hasTag(l, tag)), `${tag} came back`).toEqual([]);
    }
  });

  it('#3518 foundry-hub-editor asks only for Key Vault secret IDENTIFIERS, never an address', () => {
    const rel = 'apps/fiab-console/lib/editors/foundry-hub-editor.tsx';
    const report = guardReport();
    const sites = allSites(report, rel);
    // Two remain, both the `https://<vault>.vault.…/secrets/<name>` boxes on the
    // ApiKey / CustomKeys branches: a REFERENCE to a secret, typed because the
    // secret belongs to whoever minted it, and validated to be a KV identifier
    // rather than a raw key (`RawSecretRejectedError`).
    expect(sites).toHaveLength(2);
    for (const s of sites) expect(hasTag(s, 'azure-host'), s).toBe(true);
    // The AzureBlob target is composed from a storage-account picker, a
    // container picker and the stored path (`composeBlobTarget`), so no address
    // may be asked for here in any shape — and no raw credential either.
    for (const tag of ['adls-uri', 'arm-id', 'storage-loc', 'bare-locator', 'password-field']) {
      expect(sites.filter((l) => hasTag(l, tag)), `${tag} came back`).toEqual([]);
    }
  });

  /**
   * The embedded control. Every assertion above is of the form "this file is
   * absent from / thin in the report", and all of them pass against an empty
   * report. This one fails if the guard ever stops naming files, which is the
   * only way the cases above could go green while measuring nothing.
   */
  it('and the guard still NAMES files that DO carry an un-accepted site', () => {
    const report = guardReport();
    expect(report).toMatch(/apps\/fiab-console\/lib\/components\/pipeline\/manage-panel\.tsx:\d+/);
    expect(report).toMatch(/\d+ asking for an infrastructure value across \d+ file\(s\)/);
  });
});
