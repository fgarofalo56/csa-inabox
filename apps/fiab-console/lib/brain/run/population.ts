/**
 * LOOM BRAIN W10 — the POPULATION comparator (#3936, PRP §5).
 *
 * PURE. Compares this run's per-detector examined sets against the last run that
 * actually SCANNED, and against each detector's own HIGH-WATER MARK, and reports
 * whether the SCANNER got worse.
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
 * ── THE HIGH-WATER MARK IS THE ANTI-RATCHET (review of #4014) ─────────────
 * The first version compared only against the previous run, which makes the
 * comparator a ratchet: it asks "worse than yesterday?" and a slow erosion
 * answers "no" every single night. MEASURED by the reviewer at 19% per run:
 *
 *     1000 -> 810 -> 656 -> 531 -> 430 -> 348 -> 281 -> 227 -> 183 -> 148
 *          -> 119 -> 96 -> 77
 *
 * Twelve runs, 92.3% of the population gone, ZERO regressions reported. And a
 * single large drop was red for exactly one run and green on an immediate
 * re-run with nothing about the estate changed — the P0 was clearable by
 * pressing "Re-run jobs". Neither is fixed by tuning the 20% figure; both are
 * fixed by remembering the maximum.
 *
 * The mark DECAYS ({@link HIGH_WATER_DECAY_DAYS}) so a deliberate, permanent
 * downsizing does not pin the lane red forever — a gate that can never go green
 * is its own failure mode.
 *
 * ── WHAT IT DOES NOT DO ────────────────────────────────────────────────────
 * It does not compare finding COUNTS. Fewer findings is the outcome the whole
 * system exists to produce, and treating it as an incident would make the lane
 * punish success. What is compared is what the detectors LOOKED AT.
 *
 * ── THE FIRST RUN ──────────────────────────────────────────────────────────
 * With no previous SCANNED run there is no basis, so there is no regression —
 * and that is reported as "no basis" rather than as "no regression". The two are
 * different facts and only one of them is reassuring.
 */

import {
  HIGH_WATER_DECAY_DAYS,
  POPULATION_SHRINK_TOLERANCE,
  type DetectorPopulationRegression,
  type DetectorPopulationSnapshot,
  type PopulationRegression,
  type ScanRunRecord,
} from './model';

const MS_PER_DAY = 86_400_000;

/**
 * FNV-1a, 64-bit, as lowercase hex.
 *
 * Written in plain TypeScript rather than reaching for `node:crypto` so this
 * whole module stays pure and importable from any runtime — the same reason W9's
 * history layer hand-rolls its sha256. It is a CHANGE DETECTOR over a set that
 * is already a few thousand elements at most, never a security primitive, and
 * nothing downstream treats a match as proof of anything.
 */
export function fnv1a64(input: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash ^ BigInt(input.charCodeAt(i))) & mask;
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, '0');
}

/**
 * A stable digest of a set of ids.
 *
 * SORTED before hashing, because the graph's node order is a function of the
 * Resource Graph row order, and ARG does not promise a stable one. Hashing
 * as-emitted would make the SAME estate digest differently on the next pull and
 * report composition change on every run — noise that would train the operator
 * to ignore the signal, which is the failure mode this whole lane is built
 * against.
 */
export function digestOfIds(ids: readonly string[]): string {
  return fnv1a64([...ids].sort().join('\n'));
}

/** Project a detector pass to the shape the next run compares against. */
export function snapshotPopulations(
  results: readonly {
    readonly detector: string;
    readonly findings: readonly unknown[];
    readonly population: { readonly examined: number; readonly blind: boolean };
  }[],
  args: {
    /** The previous SCANNED run's snapshots, so high-water marks carry forward. */
    readonly previous: readonly DetectorPopulationSnapshot[] | null;
    readonly at: string;
  },
): readonly DetectorPopulationSnapshot[] {
  const priorByDetector = new Map((args.previous ?? []).map((p) => [p.detector, p]));
  const nowMs = Date.parse(args.at);

  return results.map((r) => {
    const prior = priorByDetector.get(r.detector);
    const examined = r.population.examined;

    // No history: this run IS the mark.
    if (prior === undefined) {
      return {
        detector: r.detector,
        examined,
        blind: r.population.blind,
        findings: r.findings.length,
        maxExamined: examined,
        maxExaminedAt: args.at,
      };
    }

    // A new maximum always wins and re-stamps the clock.
    if (examined >= prior.maxExamined) {
      return {
        detector: r.detector,
        examined,
        blind: r.population.blind,
        findings: r.findings.length,
        maxExamined: examined,
        maxExaminedAt: args.at,
      };
    }

    // Below the mark. Keep it until it decays, then re-base to today so a
    // permanent downsizing cannot pin the lane red forever.
    const markAgeMs = nowMs - Date.parse(prior.maxExaminedAt);
    const decayed = Number.isFinite(markAgeMs) && markAgeMs > HIGH_WATER_DECAY_DAYS * MS_PER_DAY;
    return {
      detector: r.detector,
      examined,
      blind: r.population.blind,
      findings: r.findings.length,
      maxExamined: decayed ? examined : prior.maxExamined,
      maxExaminedAt: decayed ? args.at : prior.maxExaminedAt,
    };
  });
}

/**
 * Compare this run's populations against the previous SCANNED run's.
 *
 * `previous` MUST be a run that actually scanned — one whose
 * `detectorPopulations` is non-null. `scan.ts` obtains it through
 * `FindingStore.lastScannedRun`, never `lastRun`: a PAUSED or UNREACHABLE run
 * persists a null population, and taking the basis from it erases the baseline.
 * Under the standing estate-pause mandate that is not an edge case, it is the
 * normal operating mode.
 *
 * Returns `null` when nothing got worse — including when there is no basis,
 * which the caller must render as NO BASIS rather than as a pass.
 */
export function detectPopulationRegression(
  previous: ScanRunRecord | null,
  current: readonly DetectorPopulationSnapshot[],
  opts?: { readonly basisAgeRuns?: number },
): PopulationRegression | null {
  if (previous === null || previous.detectorPopulations === null) return null;

  const before = new Map(previous.detectorPopulations.map((p) => [p.detector, p]));
  const now = new Map(current.map((p) => [p.detector, p]));
  const regressions: DetectorPopulationRegression[] = [];

  for (const [detector, prior] of before) {
    const cur = now.get(detector);
    const highWater = prior.maxExamined;
    const highWaterAt = prior.maxExaminedAt;

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
        highWater,
        highWaterAt,
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
        highWater,
        highWaterAt,
      });
      continue;
    }

    const floor = 1 - POPULATION_SHRINK_TOLERANCE;

    if (prior.examined > 0 && cur.examined < prior.examined * floor) {
      regressions.push({
        detector,
        kind: 'shrank',
        previousExamined: prior.examined,
        examined: cur.examined,
        previouslyBlind: prior.blind,
        blind: cur.blind,
        highWater,
        highWaterAt,
      });
      continue;
    }

    // THE ANTI-RATCHET. Reached only when the step-over-step comparison passed,
    // which is exactly the case a slow erosion produces every night.
    if (highWater > 0 && cur.examined < highWater * floor) {
      regressions.push({
        detector,
        kind: 'below-high-water',
        previousExamined: prior.examined,
        examined: cur.examined,
        previouslyBlind: prior.blind,
        blind: cur.blind,
        highWater,
        highWaterAt,
      });
    }
  }

  if (regressions.length === 0) return null;

  const pct = Math.round(POPULATION_SHRINK_TOLERANCE * 100);
  const lines = regressions.map((r) => {
    switch (r.kind) {
      case 'went-blind':
        return `${r.detector}: examined ${r.previousExamined} last scan and is BLIND now (0). It ` +
          'is green and it is looking at nothing.';
      case 'disappeared':
        return `${r.detector}: ran last scan (examined ${r.previousExamined}) and did not run at ` +
          'all this run. Its whole finding class stopped being produced.';
      case 'shrank':
        return `${r.detector}: examined ${r.previousExamined} -> ${r.examined}, a drop past the ` +
          `${pct}% tolerance.`;
      case 'below-high-water':
        return `${r.detector}: examined ${r.examined}, more than ${pct}% below its high-water ` +
          `mark of ${r.highWater} (set ${r.highWaterAt}) — no single run crossed the tolerance, ` +
          'which is exactly what a slow erosion looks like.';
    }
  });

  const basisAgeRuns = opts?.basisAgeRuns ?? 1;

  return {
    detectors: regressions,
    previousRunId: previous.runId,
    basisAgeRuns,
    message:
      `POPULATION REGRESSION: ${regressions.length} detector(s) examined materially LESS than ` +
      `the last run that actually scanned ('${previous.runId}'` +
      (basisAgeRuns > 1
        ? `, ${basisAgeRuns} runs back — the runs in between did not scan`
        : '') +
      '). PRP §5 treats a shrinking judged count as a P0, because a detector that stops ' +
      'looking reports the same clean result as a detector that looked and found nothing. ' +
      'This run is RED on its own axis: the estate was reached and scanned, but the SCAN got ' +
      'worse. ' +
      lines.join(' | ') +
      ' A step-over-step drop clears on the next run once the smaller number is the basis; a ' +
      `high-water finding clears only when the population recovers, or after ` +
      `${HIGH_WATER_DECAY_DAYS} days if the shrink is permanent.`,
  };
}
