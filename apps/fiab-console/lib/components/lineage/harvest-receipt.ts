/**
 * Lineage-harvest receipt classifier (issue #2625) — PURE, no React.
 *
 * The LU-8 harvest returns an honest receipt on every run poll, and until this
 * shipped the console dropped it on the floor: `harvestSparkBatchLineage`
 * explained, in prose, exactly why a succeeded Spark batch produced no lineage
 * ("the batch declared no storage input+output …"), the run route returned it
 * as `lineage.reason`, and NOTHING rendered it. Per `ux-baseline.md` G2 a
 * remediation the user never sees is not a compliant gate.
 *
 * This module owns the ONE decision — "given a receipt, what does the user see?"
 * — so it can be unit-tested without a DOM and so the Spark Runs tab and the
 * pipeline Output pane cannot drift apart about it.
 *
 * It switches on the receipt's stable `code`, never on `reason` prose: a copy
 * edit to a message must not silently un-render a gate.
 */
import type { HarvestReasonCode } from '@/lib/lineage/synapse-lineage-harvest';

/** The receipt shape as it arrives over the wire (all fields optional). */
export interface LineageHarvestReceipt {
  ok?: boolean;
  events?: number;
  written?: number;
  skipped?: number;
  denied?: number;
  reason?: string;
  code?: HarvestReasonCode | string;
  error?: string;
}

/** What the surface should render for one receipt. */
export interface LineageHarvestNotice {
  /** MessageBar intent — 'success' is rendered as the compact live chip. */
  intent: 'success' | 'warning' | 'info' | 'error';
  title: string;
  body: string;
  /**
   * True ONLY for the resolvable configuration gate — the inline Fix-it wizard
   * that writes `spark.loom.lineage.inputs/outputs` into the job's spec.conf.
   * Everything else is a FACT about the run (wrong state, not this item's
   * batch, already harvested); offering a "Fix it" there would be a lie.
   */
  fixit: boolean;
  /** The canonical gate this notice belongs to, for the registry deep-link. */
  gateId?: string;
}

/** The gate registry id that owns Spark lineage (see lib/gates/registry). */
export const SPARK_LINEAGE_GATE_ID = 'svc-openlineage';

/**
 * Codes that are pure noise on a run grid — the run's own status column
 * already tells the user everything these say, so surfacing them would add a
 * banner to every healthy poll.
 */
const SILENT_CODES = new Set<string>(['already_harvested', 'run_not_succeeded', 'no_run']);

/**
 * Classify one harvest receipt into the notice to render, or `null` for
 * "render nothing".
 *
 * Order matters: a receipt that WROTE edges is reported as a success even if it
 * also carries a `reason` (the budget-truncated pipeline pass does exactly
 * that — it writes what it reached and says it will resume).
 */
export function classifyHarvestReceipt(
  receipt: LineageHarvestReceipt | null | undefined,
): LineageHarvestNotice | null {
  if (!receipt || typeof receipt !== 'object') return null;

  const written = Number(receipt.written) || 0;
  const denied = Number(receipt.denied) || 0;

  if (written > 0) {
    const deniedNote = denied > 0
      ? ` ${denied} edge${denied === 1 ? '' : 's'} refused — an endpoint is owned by another workspace.`
      : '';
    return {
      intent: 'success',
      title: `Lineage recorded — ${written} edge${written === 1 ? '' : 's'}`,
      body: `${receipt.reason ? `${receipt.reason} ` : ''}Open the lineage canvas to see this run's inputs and outputs.${deniedNote}`.trim(),
      fixit: false,
      gateId: SPARK_LINEAGE_GATE_ID,
    };
  }

  if (receipt.ok === false && receipt.error) {
    return {
      intent: 'warning',
      title: 'Lineage harvest failed for this run',
      body: `${receipt.error} — lineage is best-effort and never blocks the run; the next refresh retries.`,
      fixit: false,
      gateId: SPARK_LINEAGE_GATE_ID,
    };
  }

  const code = String(receipt.code || '');
  if (SILENT_CODES.has(code)) return null;

  switch (code) {
    case 'spark_lineage_not_declared':
      // THE configuration gate — the only receipt an operator can resolve.
      return {
        intent: 'warning',
        title: 'No lineage recorded — this job declares no input or output dataset',
        body:
          `${receipt.reason || 'the batch declared no storage input+output'} — ` +
          'Fix it picks the workspace lakehouse roots this job reads and writes and stores them on the job spec, ' +
          'so every future run stamps lineage automatically.',
        fixit: true,
        gateId: SPARK_LINEAGE_GATE_ID,
      };
    case 'batch_unattributed':
      return {
        intent: 'info',
        title: 'No lineage recorded — this batch was not submitted by this item',
        body: receipt.reason || 'Livy batch ids are pool-scoped; lineage is only stamped for a batch this item owns.',
        fixit: false,
        gateId: SPARK_LINEAGE_GATE_ID,
      };
    case 'harvest_budget_exhausted':
    case 'harvest_rate_limited':
      return {
        intent: 'info',
        title: 'Lineage harvest is still catching up',
        body: `${receipt.reason || 'the harvest stopped early'} — refresh to continue; nothing is lost.`,
        fixit: false,
        gateId: SPARK_LINEAGE_GATE_ID,
      };
    case 'pipeline_no_activities':
    case 'pipeline_no_copy_activity':
      return {
        intent: 'info',
        title: 'No lineage recorded for this run',
        body:
          `${receipt.reason || 'no activity declared a resolvable dataset pair'} — ` +
          'lineage is derived from Copy activities whose source and sink datasets resolve to a storage path or table.',
        fixit: false,
        gateId: SPARK_LINEAGE_GATE_ID,
      };
    default:
      break;
  }

  // Unknown / absent code but a real reason: fail OPEN to honest disclosure.
  // A future receipt shape must never regress this surface back to silence —
  // which is the exact defect issue #2625 exists to fix.
  if (receipt.reason) {
    return {
      intent: 'info',
      title: 'No lineage recorded for this run',
      body: receipt.reason,
      fixit: false,
      gateId: SPARK_LINEAGE_GATE_ID,
    };
  }
  return null;
}
