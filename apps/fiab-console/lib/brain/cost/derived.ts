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
 *   memory unparseable    Same. '1Gi' is a size; '1' is a guess.
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

/**
 * Parse a Container Apps memory string into GiB.
 *
 * Accepts the forms Container Apps actually authors — '1Gi', '0.5Gi', '512Mi',
 * and the unsuffixed-SI variants 'G'/'M' — and REJECTS a bare number. A bare
 * '1' could be 1 GiB, 1 MiB or 1 byte; choosing one is a guess, and a guess
 * about the memory term is a guess about roughly half the bill.
 *
 * Returns `null` on anything it cannot establish.
 */
export function parseMemoryGib(memory: string | undefined): number | null {
  if (memory === undefined) return null;
  const m = memory.trim();
  if (!m) return null;
  const match = /^([0-9]*\.?[0-9]+)\s*(Gi|Mi|G|M)$/i.exec(m);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value < 0) return null;
  const unit = match[2].toLowerCase();
  switch (unit) {
    case 'gi':
      return value;
    case 'mi':
      return value / 1024;
    // Container Apps quotes GiB; the SI spellings are accepted for robustness
    // and converted on the same binary basis the platform bills on.
    case 'g':
      return value;
    case 'm':
      return value / 1024;
    default:
      return null;
  }
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
        `(expected e.g. '1Gi', '512Mi'); a bare number is rejected rather than guessed`,
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
