/**
 * #2625 — the PURE conf-write half of the Spark lineage Fix-it wizard.
 *
 * Separated from the dialog component so the write can be unit-tested in the
 * node environment (no React, no Fluent) and so the SJD editor can reason about
 * the same two keys without importing a dialog.
 *
 * These are exactly the keys `parseSparkDatasets` reads
 * (lib/lineage/synapse-emitters.ts) — imported from the shared
 * `lib/lineage/spark-conf-keys` leaf, never re-spelled, so a rename there
 * cannot silently orphan what the wizard writes. The leaf (rather than
 * `synapse-emitters` itself) because this module is reached from a client
 * component, and `synapse-emitters` pulls `next/headers` in transitively.
 */
import { SPARK_CONF_INPUTS, SPARK_CONF_OUTPUTS } from '@/lib/lineage/spark-conf-keys';

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
