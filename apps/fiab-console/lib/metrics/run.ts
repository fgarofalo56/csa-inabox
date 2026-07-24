/**
 * run.ts — the ONE server-side execute path for a governed metric (N15).
 *
 * Both consumers that RUN a metric — the REST endpoint (POST /api/metrics/query)
 * and the report designer's metric-backed visual — call
 * {@link runGovernedMetricQuery}, so they resolve the same governed spec, compile
 * through the same native compiler, execute on the same real backend, cache with
 * the same key, and write the same audited data-access row. That is how "one
 * metric ⇒ one number everywhere" is enforced at the execution layer (the
 * Copilot NL2SQL path only needs the compiled SQL for grounding, so it uses the
 * pure compile wrapper directly).
 *
 * REAL backend, no vaporware: Synapse serverless (T-SQL, TDS-parameterised) for
 * the `synapse`/`lakehouse` engines; Azure Data Explorer for `adx`. NO runtime
 * MetricFlow engine — the SQL/KQL comes from Loom's own compiler. IL5: executes
 * entirely in-boundary with zero external egress.
 *
 * Server-only (imports the Synapse/ADX clients + Cosmos store); never import into
 * a client component.
 */

import crypto from 'node:crypto';
import { getSemanticSpec } from '@/lib/azure/semantic-contract';
import { normalizeSpec, type MetricFlowSpec } from './metricflow-spec';
import { compileGovernedMetric } from './consumers';
import {
  MetricCompileError,
  type CompiledMetricQuery,
  type MetricEngine,
  type MetricFilter,
} from './metric-compiler';
import { serverlessTarget, executeQuery as synapseExecuteQuery } from '@/lib/azure/synapse-sql-client';
import {
  executeQuery as kustoExecuteQuery,
  defaultDatabase as kustoDefaultDatabase,
  kustoConfigGate,
  KustoError,
} from '@/lib/azure/kusto-client';
import { buildScopedCacheKey, getOrComputeCached } from '@/lib/azure/query-result-cache';
import { auditLogContainer } from '@/lib/azure/cosmos-client';
import { emitAuditEvent } from '@/lib/admin/audit-stream';

/** A governed-metric query request (shared by the endpoint + the report path). */
export interface GovernedMetricRequest {
  metric: string;
  dimensions?: string[];
  filters?: MetricFilter[];
  grain?: string;
  engine?: MetricEngine;
}

/** The uniform executed result (report-grid parity: record rows + emitted SQL). */
export interface GovernedMetricResult {
  metric: string;
  engine: MetricEngine;
  dialect: 'synapse' | 'kql';
  sql: string;
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  executionMs: number;
  groupBy: string[];
  cached: boolean;
}

/** Actor context for the audited data-access row. */
export interface MetricActor {
  oid: string;
  who: string;
  tenantId: string;
}

/** A discriminated outcome — the caller maps it to its own envelope (BFF / route). */
export type GovernedMetricOutcome =
  | { ok: true; result: GovernedMetricResult }
  | { ok: false; status: number; error: string; code?: string; missing?: string };

/** Reshape a columns + row-matrix result into row objects (report-grid parity). */
function toRecords(columns: string[], rows: unknown[][]): Record<string, unknown>[] {
  return rows.map((r) => {
    const o: Record<string, unknown> = {};
    columns.forEach((c, i) => {
      o[c] = r[i];
    });
    return o;
  });
}

/**
 * Resolve → compile → execute (cached) → audit a governed metric for one owner.
 * Owner-scoped (`actor.oid` is the contract-store partition, mirroring N9). Never
 * throws for an expected condition (no spec / bad metric / unconfigured backend):
 * those return a typed `{ ok:false, ... }` the caller surfaces as an honest gate.
 */
export async function runGovernedMetricQuery(
  actor: MetricActor,
  req: GovernedMetricRequest,
): Promise<GovernedMetricOutcome> {
  const metric = String(req.metric || '').trim();
  if (!metric) return { ok: false, status: 400, error: 'metric is required' };
  const engine: MetricEngine = req.engine ?? 'synapse';

  // Governed spec from the EXTENDED N9 contract store (owner-scoped).
  const raw = await getSemanticSpec(actor.oid);
  if (!raw) {
    return {
      ok: false,
      status: 412,
      code: 'no_metrics_spec',
      error:
        'No governed metrics are defined for you yet. Import a MetricFlow-compatible spec ' +
        '(semantic models + metrics) on the semantic-model editor, then query the metric here.',
    };
  }
  const spec: MetricFlowSpec = normalizeSpec(raw);

  // Compile NATIVELY (no runtime MetricFlow engine) — the same path report + NL use.
  let compiled: CompiledMetricQuery;
  try {
    compiled = compileGovernedMetric({
      spec,
      metric,
      dimensions: req.dimensions,
      filters: req.filters,
      grain: req.grain,
      engine,
    });
  } catch (e) {
    if (e instanceof MetricCompileError) return { ok: false, status: e.status, error: e.message, code: 'metric_compile' };
    throw e;
  }

  // ADX honest gate (cluster not configured) before executing.
  if (engine === 'adx') {
    const gate = kustoConfigGate();
    if (gate) {
      return {
        ok: false,
        status: 503,
        code: 'not_configured',
        missing: gate.missing,
        error: `Azure Data Explorer is not configured for the ADX metric engine — set ${gate.missing}.`,
      };
    }
  }

  const cacheKey = buildScopedCacheKey('metrics-query', {
    oid: actor.oid,
    metric,
    dimensions: req.dimensions ?? [],
    filters: req.filters ?? [],
    grain: req.grain ?? null,
    engine,
    sql: compiled.sql,
  });

  try {
    const { value, meta } = await getOrComputeCached<Omit<GovernedMetricResult, 'cached'>>(
      cacheKey,
      `metrics:${actor.oid}`,
      async () => {
        if (engine === 'adx') {
          const r = await kustoExecuteQuery(kustoDefaultDatabase(), compiled.sql);
          return {
            metric,
            engine,
            dialect: compiled.dialect,
            sql: compiled.sql,
            columns: r.columns,
            rows: toRecords(r.columns, r.rows),
            rowCount: r.rowCount,
            executionMs: r.executionMs,
            groupBy: compiled.groupBy,
          };
        }
        // synapse | lakehouse → Synapse serverless (T-SQL). Values bind as TDS
        // parameters (injection-safe).
        const target = serverlessTarget();
        const r = await synapseExecuteQuery(target, compiled.sql, 60_000, compiled.params);
        return {
          metric,
          engine,
          dialect: compiled.dialect,
          sql: compiled.sql,
          columns: r.columns,
          rows: toRecords(r.columns, r.rows),
          rowCount: r.rowCount,
          executionMs: r.executionMs,
          groupBy: compiled.groupBy,
        };
      },
      { backend: engine === 'adx' ? 'adx' : 'serverless', counterBackend: engine === 'adx' ? 'adx' : 'result-cache' },
    );

    // Audited data-access row (best-effort — never blocks the read).
    void writeMetricAudit(actor, { metric, engine, dimensions: req.dimensions ?? [], rowCount: value.rowCount, cached: meta.hit });

    return { ok: true, result: { ...value, cached: meta.hit } };
  } catch (e) {
    if (e instanceof KustoError) {
      const status = e.status >= 400 && e.status < 600 ? e.status : 502;
      return { ok: false, status, error: `ADX metric query failed: ${e.message}`, code: 'adx_error' };
    }
    // A missing Synapse env var throws 'Missing env var: LOOM_SYNAPSE_WORKSPACE'
    // — surface it as an honest config gate, not a generic 500.
    const msg = e instanceof Error ? e.message : String(e);
    const missing = /Missing env var:\s*(LOOM_\w+)/.exec(msg)?.[1];
    if (missing) {
      return {
        ok: false,
        status: 503,
        code: 'not_configured',
        missing,
        error: `The Synapse serverless endpoint for the metric engine is not configured — set ${missing}.`,
      };
    }
    throw e;
  }
}

/** Authoritative data-access audit row + SIEM fan-out (best-effort, non-blocking). */
async function writeMetricAudit(
  actor: MetricActor,
  detail: { metric: string; engine: string; dimensions: string[]; rowCount: number; cached: boolean },
): Promise<void> {
  const at = new Date().toISOString();
  try {
    const audit = await auditLogContainer();
    await audit.items
      .create({
        id: `audit-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
        itemId: `metrics:${detail.metric}`,
        tenantId: actor.tenantId,
        who: actor.who,
        actorOid: actor.oid,
        oid: actor.oid,
        at,
        kind: 'metrics.query',
        target: detail.metric,
        detail,
      })
      .catch(() => undefined);
  } catch {
    /* audit failures are non-blocking */
  }
  emitAuditEvent({
    actorOid: actor.oid,
    actorUpn: actor.who,
    action: 'metrics.query',
    targetType: 'metric',
    targetId: detail.metric,
    tenantId: actor.tenantId,
    detail,
  });
}
