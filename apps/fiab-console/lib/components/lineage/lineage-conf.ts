/**
 * #2625 — the PURE conf-write half of the Spark lineage Fix-it wizard.
 *
 * Separated from the dialog component so the write can be unit-tested in the
 * node environment (no React, no Fluent) and so the SJD editor can reason about
 * the same two keys without importing a dialog.
 *
 * These are exactly the keys `parseSparkDatasets` reads
 * (lib/lineage/synapse-emitters.ts) — imported, never re-spelled, so a rename
 * there cannot silently orphan what the wizard writes.
 */
import { SPARK_CONF_INPUTS, SPARK_CONF_OUTPUTS } from '@/lib/lineage/synapse-emitters';

/**
 * Merge the picked roots into an existing Spark conf.
 *
 * Unrelated conf keys are preserved verbatim; an empty selection DELETES its
 * key rather than writing an empty string, because `parseSparkDatasets` splits
 * on `,` and an empty value would leave a stale, meaningless declaration behind
 * that reads as "declared" to a human skimming the conf grid.
 */
export function applyLineageConf(
  conf: Record<string, string>,
  inputs: string[],
  outputs: string[],
): Record<string, string> {
  const next: Record<string, string> = { ...conf };
  if (inputs.length) next[SPARK_CONF_INPUTS] = inputs.join(',');
  else delete next[SPARK_CONF_INPUTS];
  if (outputs.length) next[SPARK_CONF_OUTPUTS] = outputs.join(',');
  else delete next[SPARK_CONF_OUTPUTS];
  return next;
}

/** Split a stored conf value back into the picker's selected options. */
export function selectedFromConf(conf: Record<string, string>, key: string): string[] {
  return String(conf?.[key] || '')
    .split(/[,;]/)
    .map((v) => v.trim())
    .filter(Boolean);
}
