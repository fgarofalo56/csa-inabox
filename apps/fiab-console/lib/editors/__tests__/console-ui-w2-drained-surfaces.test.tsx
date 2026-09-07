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
 * corresponding case goes red: the DRAINED file reappears as an un-accepted
 * line, an ACCEPTED file gains one, and a PARTIAL file's forbidden shape comes
 * back.
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
 * So these cases guard "a placeholder-shaped infrastructure ask does not come
 * back", and the picker's continued presence is guarded by the surface's own
 * behavioural specs, not by this file.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

// vitest runs with `apps/fiab-console` as its root, so the repo root is two up.
const REPO = path.resolve(process.cwd(), '../..');

/**
 * The guard's full site report, BOTH streams — the summary goes to stdout and
 * the per-site lines to stderr, and a helper that read only stdout would return
 * a string naming no files at all, which every "this file is absent" assertion
 * below would then pass vacuously.
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

/** Site lines the guard did NOT mark `[accepted]`, for one file. */
function liveSites(report: string, rel: string): string[] {
  return report
    .split('\n')
    .filter((l) => l.includes(`${rel}:`) && !l.includes('[accepted]'))
    // The ACCEPTED banner names the file in prose; only indented site rows count.
    .filter((l) => new RegExp(`^\\s{2}${rel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\d+\\s`).test(l));
}

/** Every site line for one file, accepted or not. */
function allSites(report: string, rel: string): string[] {
  return report
    .split('\n')
    .filter((l) => new RegExp(`${rel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\d+\\s`).test(l));
}

describe('console-ui-w2 — the converted surfaces stay converted', () => {
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
