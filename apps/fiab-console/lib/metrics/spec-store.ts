/**
 * spec-store.ts — store-integrated MetricFlow import/export (N15).
 *
 * Ties the PURE spec transforms (metricflow-spec.ts) to N9's EXTENDED contract
 * store (lib/azure/semantic-contract.ts): `importMetricSpec` persists the whole
 * MetricFlow spec (the compilable substrate) AND registers each metric into N9's
 * governed registry (so synonym-matching + refuse-not-guess keep working);
 * `exportMetricSpec(tenantId)` reads the stored spec back to YAML. This is the
 * "importSpec(yaml)→contract docs / exportSpec(tenantId)→yaml" contract, and it
 * EXTENDS the contract store — it does not fork it.
 *
 * Round-trip lossless for the supported subset: `exportMetricSpec` after
 * `importMetricSpec(sameYaml)` yields YAML that re-parses to the same spec (the
 * per-subset guarantee proven by metricflow-spec's round-trip test).
 *
 * Server-only (Cosmos); never import into a client component.
 */

import {
  getSemanticSpec,
  putSemanticSpec,
  registerMetric,
  type MetricDoc,
} from '@/lib/azure/semantic-contract';
import {
  importSpec,
  exportSpec,
  normalizeSpec,
  type MetricFlowSpec,
} from './metricflow-spec';

/** Owner context for the import (owner-scoped, mirrors N9's Prep-for-AI scoping). */
export interface MetricSpecActor {
  /** Owner oid — the contract-store partition key. */
  oid: string;
  /** UPN / email / display fallback (recorded as the metric owner when unset). */
  who: string;
}

/**
 * Import a MetricFlow YAML spec for one owner: validate + parse, persist the whole
 * spec (compilable substrate), and register each metric into N9's governed
 * registry (sourceKind `measure`, sourceRef `<model>::<measure>`). Returns the
 * canonical spec + the registered metric docs. Throws `MetricSpecError` on a bad
 * spec (the caller surfaces it as an honest 400).
 */
export async function importMetricSpec(
  actor: MetricSpecActor,
  yaml: string,
): Promise<{ spec: MetricFlowSpec; registered: MetricDoc[] }> {
  const { spec, metricInputs } = importSpec(yaml);
  await putSemanticSpec(actor.oid, spec);
  const registered: MetricDoc[] = [];
  for (const input of metricInputs) {
    // Default the governed owner to the importing actor when the spec omitted it.
    registered.push(await registerMetric(actor.oid, { ...input, owner: input.owner || actor.who }));
  }
  return { spec, registered };
}

/**
 * Export the owner's stored MetricFlow spec back to canonical YAML. Returns an
 * empty (but valid) spec document when nothing has been imported yet, so a caller
 * always gets round-trippable YAML rather than null.
 */
export async function exportMetricSpec(tenantId: string): Promise<string> {
  const raw = await getSemanticSpec(tenantId);
  const spec: MetricFlowSpec = raw ? normalizeSpec(raw) : { semantic_models: [], metrics: [] };
  return exportSpec(spec);
}
