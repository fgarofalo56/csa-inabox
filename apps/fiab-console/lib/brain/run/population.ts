/**
 * LOOM BRAIN W10 — the POPULATION comparator (#3936, PRP §5).
 *
 * PURE. Compares this run's per-detector examined sets against the previous
 * run's and reports whether the SCANNER got worse.
 *
 * ── WHY THIS EXISTS, MEASURED ──────────────────────────────────────────────
 * On 2026-08-24, against the live Commercial estate, emptying the wire-binding
 * table that this lane feeds the graph extractor took the run from
 *
 *     105 nodes ·  18 edges ·  8 findings · 1 blind detector
 * to  105 nodes ·   0 edges ·  0 findings · 2 blind detectors
 *
 * and the run still reported `ok` with a tidy "0 findings". Every count moved.
 * The VERDICT did not. An operator reading that summary sees a clean estate.
 *
 * That is the exact failure PRP §3.8 names as this repo's DOMINANT evasion —
 * falling outside the population being examined, invisible in every artifact
 * except a population count — and PRP §5 states the rule: **a shrinking `judged`
 * count is a P0 regression, not a quiet improvement.**
 *
 * ── WHAT IT DOES NOT DO ────────────────────────────────────────────────────
 * It does not compare finding COUNTS. Fewer findings is the outcome the whole
 * system exists to produce, and treating it as an incident would make the lane
 * punish success. What is compared is what the detectors LOOKED AT.
 *
 * ── THE FIRST RUN ──────────────────────────────────────────────────────────
 * With no previous run there is no basis, so there is no regression — and that
 * is reported as "no basis" rather than as "no regression". The two are
 * different facts and only one of them is reassuring.
 */

import {
  POPULATION_SHRINK_TOLERANCE,
  type DetectorPopulationRegression,
  type DetectorPopulationSnapshot,
  type PopulationRegression,
  type ScanRunRecord,
} from './model';

/** Project a detector pass to the shape the next run compares against. */
export function snapshotPopulations(
  results: readonly {
    readonly detector: string;
    readonly findings: readonly unknown[];
    readonly population: { readonly examined: number; readonly blind: boolean };
  }[],
): readonly DetectorPopulationSnapshot[] {
  return results.map((r) => ({
    detector: r.detector,
    examined: r.population.examined,
    blind: r.population.blind,
    findings: r.findings.length,
  }));
}

/**
 * Compare this run's populations against the previous run's.
 *
 * Returns `null` when nothing got worse — including when there is no previous
 * run to compare against, which the caller must render as NO BASIS rather than
 * as a pass.
 */
export function detectPopulationRegression(
  previous: ScanRunRecord | null,
  current: readonly DetectorPopulationSnapshot[],
): PopulationRegression | null {
  if (previous === null || previous.detectorPopulations === null) return null;

  const before = new Map(previous.detectorPopulations.map((p) => [p.detector, p]));
  const now = new Map(current.map((p) => [p.detector, p]));
  const regressions: DetectorPopulationRegression[] = [];

  for (const [detector, prior] of before) {
    const cur = now.get(detector);

    if (cur === undefined) {
      // It ran last time and did not run at all this time. A detector removed
      // from the list is a legitimate change — and it is a change that must be
      // SEEN, because it silently stops producing a whole class of finding.
      regressions.push({
        detector,
        kind: 'disappeared',
        previousExamined: prior.examined,
        examined: 0,
        previouslyBlind: prior.blind,
        blind: true,
      });
      continue;
    }

    if (!prior.blind && cur.blind) {
      // Green and blind. Zero is always a regression from non-zero, whatever
      // the tolerance says.
      regressions.push({
        detector,
        kind: 'went-blind',
        previousExamined: prior.examined,
        examined: cur.examined,
        previouslyBlind: false,
        blind: true,
      });
      continue;
    }

    if (prior.examined > 0 && cur.examined < prior.examined * (1 - POPULATION_SHRINK_TOLERANCE)) {
      regressions.push({
        detector,
        kind: 'shrank',
        previousExamined: prior.examined,
        examined: cur.examined,
        previouslyBlind: prior.blind,
        blind: cur.blind,
      });
    }
  }

  if (regressions.length === 0) return null;

  const lines = regressions.map((r) => {
    switch (r.kind) {
      case 'went-blind':
        return `${r.detector}: examined ${r.previousExamined} last run and is BLIND now (0). It ` +
          'is green and it is looking at nothing.';
      case 'disappeared':
        return `${r.detector}: ran last run (examined ${r.previousExamined}) and did not run at ` +
          'all this run. Its whole finding class stopped being produced.';
      case 'shrank':
        return `${r.detector}: examined ${r.previousExamined} -> ${r.examined}, a drop past the ` +
          `${Math.round(POPULATION_SHRINK_TOLERANCE * 100)}% tolerance.`;
    }
  });

  return {
    detectors: regressions,
    previousRunId: previous.runId,
    message:
      `POPULATION REGRESSION: ${regressions.length} detector(s) examined materially LESS than ` +
      `they did in run '${previous.runId}'. PRP §5 treats a shrinking judged count as a P0, ` +
      'because a detector that stops looking reports the same clean result as a detector that ' +
      'looked and found nothing. This run is RED on its own axis: the estate was reached and ' +
      'scanned, but the SCAN got worse. ' +
      lines.join(' | ') +
      ' If the estate genuinely shrank, this clears on the next run, because that run compares ' +
      'against these numbers.',
  };
}
