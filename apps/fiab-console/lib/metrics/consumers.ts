/**
 * consumers.ts — the THREE consumers of the governed metric, funnelled through
 * ONE compile path (N15).
 *
 * The whole point of the headless metrics layer is "one metric definition ⇒ one
 * number everywhere": a report visual, a Copilot NL2SQL answer, and a REST/SDK
 * caller must NOT compute revenue three different ways. This module is the seam
 * that guarantees it — every surface resolves a governed metric through
 * {@link compileGovernedMetric}, which is a thin, side-effect-free wrapper over
 * the single native {@link compileMetricQuery}. A unit test asserts the three
 * wrappers emit BYTE-IDENTICAL SQL for the same metric + dimensions + filters
 * (the three-way-same-number contract, proven at the compiler level).
 *
 * These functions are PURE (spec in, compiled query out): they do NOT touch
 * Cosmos or Azure. The route (app/api/metrics/query) loads the governed spec
 * from the extended N9 contract store and executes the compiled SQL on the real
 * backend; the report + NL paths resolve through that SAME endpoint at runtime so
 * the number is identical. Keeping the wrappers pure means the "same number"
 * invariant is testable without any I/O.
 */

import {
  compileMetricQuery,
  type CompileMetricArgs,
  type CompiledMetricQuery,
  type MetricEngine,
} from './metric-compiler';
import type { MetricFlowSpec } from './metricflow-spec';

/** Which surface asked to resolve the metric (provenance for the receipt/trace). */
export type MetricConsumer = 'report' | 'nl2sql' | 'sdk';

/** Options shared by every consumer wrapper. */
export interface ResolveMetricOptions {
  spec: MetricFlowSpec;
  metric: string;
  dimensions?: string[];
  filters?: CompileMetricArgs['filters'];
  /**
   * Row-level-security predicates keyed on an embed-token effective identity
   * (N18) — ANDed into the compiled WHERE at the engine before the caller's own
   * `filters`, so the SDK/embed consumer serves identity-scoped rows from the
   * same governed metric. Empty/undefined for the report + NL consumers (they
   * resolve as the signed-in owner). See {@link CompileMetricArgs.rls}.
   */
  rls?: CompileMetricArgs['rls'];
  grain?: string;
  engine?: MetricEngine;
}

/**
 * The ONE compile path. Every consumer routes here so the compiled SQL — and
 * therefore the number — is identical regardless of who asked. Any difference in
 * output for the same inputs would be a governance defect.
 */
export function compileGovernedMetric(opts: ResolveMetricOptions): CompiledMetricQuery {
  return compileMetricQuery({
    spec: opts.spec,
    metric: opts.metric,
    dimensions: opts.dimensions,
    filters: opts.filters,
    rls: opts.rls,
    grain: opts.grain,
    engine: opts.engine,
  });
}

/**
 * CONSUMER 1 — the report designer's metric resolution. When a report visual's
 * value well references a governed metric (rather than a raw measure), the report
 * query path resolves it here instead of hand-compiling, so a KPI card and a
 * matrix on the same metric agree with the API and the Copilot.
 */
export function resolveMetricForReport(opts: ResolveMetricOptions): CompiledMetricQuery {
  return compileGovernedMetric(opts);
}

/**
 * CONSUMER 2 — the Copilot NL2SQL path. When a question is metric-grounded
 * (N9 `mode:'metric'`), the reasoning loop compiles the governed metric here and
 * grounds generation on that EXACT SQL, so the answer's number matches the report
 * and the API rather than being re-derived by the model.
 */
export function resolveMetricForNl(opts: ResolveMetricOptions): CompiledMetricQuery {
  return compileGovernedMetric(opts);
}

/**
 * CONSUMER 3 — the SDK hook (STUB for N18). The forthcoming Loom SDK
 * (`loom.metrics.query(...)`) will resolve governed metrics through this same
 * path (and the POST /api/metrics/query endpoint) so a programmatic caller gets
 * the identical number. Wired now so N18 only has to add the transport, never a
 * second compile path.
 */
export function resolveMetricForSdk(opts: ResolveMetricOptions): CompiledMetricQuery {
  return compileGovernedMetric(opts);
}
