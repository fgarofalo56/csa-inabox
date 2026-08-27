/**
 * LOOM BRAIN — the DERIVED cost fallback: measured SKU × published rate.
 *
 * Used ONLY when billed data is absent. PRP §1 decision 3 puts real cost in a
 * Cost Management export to storage, and `./export-reader.ts` reads it; this
 * module exists because the export's first data lands roughly 24 hours after
 * the export is created, and because the live Cost Management API — the other
 * obvious source — returned HTTP 429 on ELEVEN consecutive attempts over ~35
 * minutes on 2026-08-23. Every figure this module produces is `derived` and
 * `./figure.ts` makes it structurally unrenderable as a bill.
 *
 * ── WHAT IT REFUSES TO DO ──────────────────────────────────────────────────
 * This is the R7 surface of the cost layer, so it declines rather than guesses,
 * and every decline carries the reason:
 *
 *   scale absent          NOT MEASURED. Returns a skip, never $0.00. Treating
 *                         absent scale as `minReplicas: 0` silently exonerates
 *                         every resource whose scale could not be read — which
 *                         is why `../types.ts` documents `ScaleFacts |
 *                         undefined` as "not measured" in the first place.
 *   cpu / memory absent   Same. A replica count with no size is not a SKU.
 *   memory unparseable    Same. '1Gi' is a size; '1' is a guess; and '512m' is
 *                         0.512 BYTES, because `m` is the Kubernetes MILLI
 *                         suffix — it is refused, not folded into mega.
 *   region unclassified   Same, and pointedly: falling back to the Commercial
 *                         card understates a Gov resource by 25–33% (see
 *                         `./rate-card.ts`) AND produces a confident number for
 *                         a boundary nobody checked.
 *   Dedicated profile     Bills per vCPU-HOUR against reserved capacity — a
 *                         different model. Declines rather than mis-applying
 *                         the Consumption card.
 *
 * ── WHY A BAND ─────────────────────────────────────────────────────────────
 * Container Apps bills vCPU-seconds and GiB-seconds at an ACTIVE rate or an
 * IDLE rate depending on whether the replica is serving a request. Nothing the
 * Brain reads today measures that split — the graph substrate reports
 * `observed: 0` because there is no telemetry extractor yet. So both bounds are
 * computed and BOTH are returned. Collapsing them to one number would assert a
 * duty cycle the code never established.
 *
 * For the founding example this is the useful shape: `loom-capacity-broker`
 * runs `minReplicas: 2` at 0.5 vCPU / 1 GiB and has ZERO inbound `configured`
 * edges, so it is serving nothing — the IDLE bound is the defensible estimate
 * of what it burns, and the ACTIVE bound is the ceiling. Quoting the band says
 * both, and says which is which.
 *
 * PURE. No I/O, no Azure client, no mutation. Nothing here can scale or delete
 * anything (PRP §1 decision 1).
 */

import { derivedCost, type AzureResourceNode, type SkippedSubject } from '../types';
import type { DerivedFigure } from './figure';
import {
  rateCardFor,
  SECONDS_PER_MONTH,
  type ContainerAppsRateCard,
} from './rate-card';

/** ARM type this module prices. Compared case-insensitively. */
export const CONTAINER_APP_TYPE = 'Microsoft.App/containerApps';

/**
 * A derived estimate as a BAND, because the active/idle split is not measured.
 *
 * `lower` assumes every always-on replica-second bills at the IDLE rate;
 * `upper` assumes every one bills at the ACTIVE rate. The truth is between
 * them, and where in between is exactly what the missing `observed` extractor
 * would tell us.
 */
export interface DerivedCostBand {
  readonly lower: DerivedFigure;
  readonly upper: DerivedFigure;
  /** The card used, echoed so a caller can show which cloud/region priced it. */
  readonly card: ContainerAppsRateCard;
  /** The always-on replica-seconds per month the band was computed over. */
  readonly alwaysOnReplicaSeconds: number;
}

/**
 * Why a resource could not be priced. Returned INSTEAD of a figure — there is
 * no "$0.00, reason: unknown" state, because that is the exact shape of a
 * confident claim over a failed measurement.
 */
export interface DerivationSkip extends SkippedSubject {
  readonly kind: 'skip';
}

/** Either a band or the reason there isn't one. Never a silent zero. */
export type DerivationOutcome =
  | ({ readonly kind: 'band' } & DerivedCostBand)
  | DerivationSkip;

function skip(subject: string, reason: string): DerivationSkip {
  return { kind: 'skip', subject, reason };
}

/** Bytes in one GiB — the unit `./rate-card.ts` prices memory in. */
const BYTES_PER_GIB = 1024 ** 3;

/**
 * A Container Apps memory quantity: a non-negative decimal, an optional space,
 * and a suffix matched EXACTLY.
 *
 * There is deliberately no `/i` flag. See {@link parseMemoryGib} — in this
 * notation the case of the suffix is not spelling, it is meaning.
 */
const MEMORY_QUANTITY = /^([0-9]*\.?[0-9]+)\s*(Ki|Mi|Gi|Ti|k|M|G|T|m)$/;

/**
 * Bytes per unit for one EXACT suffix, or `null` for one this module declines.
 *
 * The switch keys on the captured text verbatim, and that is what makes the fix
 * durable rather than cosmetic: even if someone re-adds a case-insensitive flag
 * to {@link MEMORY_QUANTITY}, a lower-case `m` can only ever land on the milli
 * case below — there is no path that routes it into mega. The meaning of a unit
 * is pinned here, in the lookup, not in a regex flag someone can relax.
 */
function memoryUnitBytes(unit: string): number | null {
  switch (unit) {
    // Binary (IEC) suffixes — powers of 1024. These are the forms Container
    // Apps actually authors: '1Gi', '0.5Gi', '512Mi'.
    case 'Ki':
      return 1024;
    case 'Mi':
      return 1024 ** 2;
    case 'Gi':
      return BYTES_PER_GIB;
    case 'Ti':
      return 1024 ** 4;
    // Decimal (SI) suffixes — powers of 1000, NOT 1024. These were previously
    // converted on the binary basis, which read '1G' as 7.4% more memory than
    // it is and '1M' as 4.9% more. Far smaller than the milli defect below, but
    // wrong for the same reason: the suffix states which base to use, so use it.
    // Note the decimal kilo is LOWER-case `k`; a bare `K` is not a suffix in
    // this notation and is declined rather than assumed to mean one or the other.
    case 'k':
      return 1000;
    case 'M':
      return 1000 ** 2;
    case 'G':
      return 1000 ** 3;
    case 'T':
      return 1000 ** 4;
    // MILLI — one thousandth. Matched by the pattern ON PURPOSE so that a milli
    // quantity is distinguishable from a typo, then refused here. See
    // {@link parseMemoryGib} for why refusing beats converting.
    case 'm':
      return null;
    default:
      return null;
  }
}

/**
 * Parse a Container Apps memory string into GiB.
 *
 * THE SUFFIX IS MATCHED EXACTLY, because in the Kubernetes quantity notation
 * Container Apps inherits, case carries meaning:
 *
 *   Ki Mi Gi Ti   binary (IEC), powers of 1024 — what ACA authors in practice
 *   k  M  G  T    decimal (SI), powers of 1000 — note the kilo is lower-case
 *   m             MILLI, one thousandth — a CPU idiom ('500m' = half a vCPU)
 *
 * This function used to match case-INSENSITIVELY and lower-case the suffix
 * before the lookup, which collapsed `m` into `M` and read '512m' as 512 MiB.
 * '512m' is 0.512 BYTES. That fold was wrong by a factor of 1,048,576,000 on
 * the memory term, and the memory term is two thirds of the founding example's
 * lower bound — 15.768 of its 23.652 USD/month. It had not yet bitten only
 * because ACA happens to author 'Gi'; nothing between Resource Graph and here
 * prevented a milli quantity from arriving, which makes it luck, not a guard.
 *
 * A MILLI quantity is REFUSED rather than converted. Both honest options were
 * available — convert it faithfully to ~4.8e-10 GiB, or decline — and declining
 * wins here because there is no magnitude check anywhere between this parse and
 * the arithmetic in {@link deriveContainerAppCost}. A faithful 0.512 bytes would
 * sail straight through and produce a confident band over a resource shape that
 * cannot exist, since no Container App runs on a fraction of a byte. A skip WITH
 * A REASON is this module's designed safe direction (see the file header); a
 * plausible-looking number is not. The reason names the milli suffix explicitly
 * so the author is told what to write instead of being left to re-derive it.
 *
 * A bare number is still rejected: '1' could be 1 GiB, 1 MiB or 1 byte, and
 * choosing one is a guess about the larger half of the bill.
 *
 * Returns `null` on anything it cannot establish.
 */
export function parseMemoryGib(memory: string | undefined): number | null {
  if (memory === undefined) return null;
  const m = memory.trim();
  if (!m) return null;
  const match = MEMORY_QUANTITY.exec(m);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value < 0) return null;
  const unitBytes = memoryUnitBytes(match[2]);
  if (unitBytes === null) return null;
  return (value * unitBytes) / BYTES_PER_GIB;
}

/**
 * Is this a well-formed MILLI quantity — '512m', '0.5 m'?
 *
 * Kept apart from {@link parseMemoryGib} so the caller can say WHY it declined.
 * Per R7 a message states what the code established, and "this is a milli
 * quantity, which is not a memory size" is a materially different fact from
 * "this is not a quantity at all". Collapsing the two would hand the author the
 * generic message and leave them to spot the case difference themselves.
 */
function isMilliQuantity(memory: string | undefined): boolean {
  if (memory === undefined) return false;
  return MEMORY_QUANTITY.exec(memory.trim())?.[2] === 'm';
}

/**
 * The extra sentence a MILLI memory quantity earns in the skip reason.
 *
 * Empty for every other rejection, so the generic message stays generic.
 */
function milliMemoryNote(memory: string | undefined): string {
  if (!isMilliQuantity(memory)) return '';
  return (
    `. The unit is the Kubernetes MILLI suffix 'm' — one THOUSANDTH of a byte, not mega: ` +
    `'512m' means 0.512 bytes, which is 1,048,576,000x smaller than '512Mi'. Refused rather ` +
    `than read as mega, because no Container App runs on a fraction of a byte, so the value ` +
    `cannot be a measurement of anything live. Author it as '512Mi' (binary, 1024-based) or ` +
    `'512M' (decimal, 1000-based) to say which was meant.`
  );
}

/**
 * Price ONE container app's always-on floor.
 *
 * `seconds` defaults to a 730-hour month, the convention Azure pricing pages
 * quote, and is a parameter so a caller can price a day or an hour without
 * re-deriving the arithmetic.
 */
export function deriveContainerAppCost(
  node: AzureResourceNode,
  options?: {
    /** Override the card — e.g. rates re-read from the retail API today. */
    readonly card?: ContainerAppsRateCard;
    /** Window to price. Defaults to one 730-hour month. */
    readonly seconds?: number;
    /** ISO-8601 for the figure's `asOf`. Defaults to the card's `asOf`. */
    readonly asOf?: string;
  },
): DerivationOutcome {
  const subject = node.id;

  if (node.resourceType.toLowerCase() !== CONTAINER_APP_TYPE.toLowerCase()) {
    return skip(
      subject,
      `not a ${CONTAINER_APP_TYPE} (type is '${node.resourceType}') — this module prices Container Apps consumption only`,
    );
  }

  // Scale facts absent means NOT MEASURED. It does NOT mean minReplicas 0.
  if (node.scale === undefined) {
    return skip(
      subject,
      'no scale facts — replica count NOT MEASURED. Not priced, and NOT counted as $0.00',
    );
  }
  const { minReplicas, cpu, memory } = node.scale;

  if (cpu === undefined) {
    return skip(subject, 'scale.cpu absent — vCPU per replica NOT MEASURED, cannot price');
  }
  if (!Number.isFinite(cpu) || cpu < 0) {
    return skip(subject, `scale.cpu is '${String(cpu)}' — not a usable vCPU count`);
  }
  const memGib = parseMemoryGib(memory);
  if (memGib === null) {
    return skip(
      subject,
      `scale.memory ${memory === undefined ? 'absent' : `'${memory}'`} — could not be parsed as GiB ` +
        `(expected e.g. '1Gi', '512Mi'); a bare number is rejected rather than guessed` +
        milliMemoryNote(memory),
    );
  }
  if (!Number.isFinite(minReplicas) || minReplicas < 0) {
    return skip(subject, `scale.minReplicas is '${String(minReplicas)}' — not a usable replica count`);
  }

  const card = options?.card ?? rateCardFor(node.location);
  if (!card) {
    return skip(
      subject,
      `no rate card for location ${node.location === undefined ? '(absent)' : `'${node.location}'`} — ` +
        `refusing to substitute another cloud's card (Gov list rates run 25–33% above Commercial). ` +
        `Supply options.card with rates read for this region.`,
    );
  }

  const seconds = options?.seconds ?? SECONDS_PER_MONTH;
  if (!Number.isFinite(seconds) || seconds < 0) {
    return skip(subject, `seconds is '${String(seconds)}' — not a usable window`);
  }

  const asOf = options?.asOf ?? card.asOf;
  const alwaysOnReplicaSeconds = minReplicas * seconds;
  const vcpuSeconds = alwaysOnReplicaSeconds * cpu;
  const gibSeconds = alwaysOnReplicaSeconds * memGib;

  const lowerUsd =
    vcpuSeconds * card.vcpuIdleUsdPerSecond + gibSeconds * card.memoryIdleUsdPerGibSecond;
  const upperUsd =
    vcpuSeconds * card.vcpuActiveUsdPerSecond + gibSeconds * card.memoryActiveUsdPerGibSecond;

  const shape =
    `${minReplicas} always-on replica(s) x ${cpu} vCPU + ${memGib} GiB over ${seconds}s ` +
    `= ${vcpuSeconds} vCPU-s + ${gibSeconds} GiB-s`;
  const zeroNote =
    minReplicas === 0
      ? ' NOTE: minReplicas 0, so the ALWAYS-ON floor is genuinely $0.00 — this is NOT a claim ' +
        'that the app is free, only that it holds no replicas at rest. Request-driven usage is NOT MEASURED.'
      : '';
  const provenance = `${card.cloud}/${card.region} LIST rates, ${card.source}.${zeroNote}`;

  return {
    kind: 'band',
    card,
    alwaysOnReplicaSeconds,
    // The `source` label is PINNED here, not asserted. `derivedCost` lives in
    // `../types.ts` — the graph-substrate lane's file, not this one — and
    // returns the WIDENED `CostFigure`, so `as DerivedFigure` was an UNCHECKED
    // assertion: it promised a label it never inspected. Measured 2026-08-23 on
    // the combined tree, flipping that constructor's literal to `'billed'`
    // compiled clean (`tsc -p tsconfig.build.json` RC=0, 0 errors) and this very
    // band then rendered as `$23.65 (billed, LOWER bound: …)` — a list-rate
    // estimate in the exact visual form of a bill, which is the one outcome this
    // module exists to make impossible (PRP §3.4, R7).
    //
    // Pinning turns the assertion into a CHECKED assignment against
    // `DerivedCostBand.lower: DerivedFigure`. Flip either literal below and
    // `next build` fails here — the guard is now visible to the build, not only
    // to `__tests__`, which `tsconfig.build.json` excludes.
    lower: {
      ...derivedCost(
        lowerUsd,
        `LOWER bound: ${shape}, all seconds at the IDLE rate ` +
          `(${card.vcpuIdleUsdPerSecond}/vCPU-s, ${card.memoryIdleUsdPerGibSecond}/GiB-s). ` +
          `The active/idle split is NOT MEASURED — no telemetry extractor exists yet. ${provenance}`,
        asOf,
      ),
      source: 'derived' as const,
    },
    upper: {
      ...derivedCost(
        upperUsd,
        `UPPER bound: ${shape}, all seconds at the ACTIVE rate ` +
          `(${card.vcpuActiveUsdPerSecond}/vCPU-s, ${card.memoryActiveUsdPerGibSecond}/GiB-s). ` +
          `The active/idle split is NOT MEASURED — no telemetry extractor exists yet. ${provenance}`,
        asOf,
      ),
      source: 'derived' as const,
    },
  };
}

/**
 * Which bound to quote when a single figure is unavoidable — e.g. for
 * `Finding.cost`, which is one {@link CostFigure}.
 *
 * There is no default. The caller names the bound, and the choice is already
 * written into the figure's `basis`, so a reader can always see whether they
 * are looking at a floor or a ceiling.
 */
export function boundOf(band: DerivedCostBand, bound: 'lower' | 'upper'): DerivedFigure {
  return bound === 'lower' ? band.lower : band.upper;
}

/** Type guard — did the derivation produce a band, or decline? */
export function isBand(
  outcome: DerivationOutcome,
): outcome is { readonly kind: 'band' } & DerivedCostBand {
  return outcome.kind === 'band';
}
