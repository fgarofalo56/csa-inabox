/**
 * B-N19e — the ONE way a query run gets tagged for cost attribution.
 *
 * Every interactive execution path in Loom (SQL Lab / DuckDB, Synapse dedicated
 * + serverless, Warehouse, ADX/KQL, Trino, Databricks SQL, AAS DAX, dashboard
 * tiles) calls `recordQueryRun` so ONE consistent record lands in the
 * BR-COSTATTR `cost-attribution` Cosmos ledger:
 *
 *   WHO   — userOid + userName (from the session)
 *   WHERE — workspaceId + itemId + itemType (+ dashboardId/tile for a tile query)
 *   WHAT  — engine + statement FINGERPRINT (never the statement text)
 *   HOW MUCH — wall-clock duration → `query-second` quantity → LCU
 *
 * The FOCUS mart (`focus-mart.ts`) then prices each run from the REAL Cost
 * Management dollars metered against that engine's ARM resource type.
 *
 * PRIVACY: the statement itself is NEVER persisted. `statementFingerprint`
 * normalizes whitespace/case and strips string + numeric literals before
 * hashing, so two runs of the same query share a fingerprint while no literal
 * (which could be a customer identifier or a secret) survives into the ledger.
 *
 * Writes are best-effort and NEVER throw — attribution must not be able to fail
 * a query. Server-only (Node crypto + the Cosmos ledger).
 */
import { createHash } from 'node:crypto';
import {
  ATTRIBUTION_RATES,
  recordCostAttribution,
  type AttributionEngine,
} from '@/lib/azure/cost-attribution';

/** Engines that represent an interactive query run (the N19e scope). */
export type QueryRunEngine = Extract<
  AttributionEngine,
  'adx' | 'synapse-sql' | 'synapse-serverless' | 'duckdb' | 'trino' | 'databricks-sql' | 'aas-dax'
>;

/**
 * Fingerprint a SQL/KQL/DAX statement: lowercase, collapse whitespace, strip
 * line + block comments, replace quoted strings and numeric literals with `?`,
 * then SHA-256 → the first 16 hex chars. Pure + deterministic (unit-tested).
 *
 * Returns `null` for an empty statement so the caller stores nothing.
 */
export function statementFingerprint(statement: string | undefined | null): string | null {
  const raw = (statement || '').toString();
  if (!raw.trim()) return null;
  const normalized = raw
    .replace(/\/\*[\s\S]*?\*\//g, ' ')      // block comments
    .replace(/--[^\n\r]*/g, ' ')            // SQL line comments
    .replace(/\/\/[^\n\r]*/g, ' ')          // KQL/Trino line comments
    .replace(/'(?:''|\\.|[^'])*'/g, "'?'")  // single-quoted literals
    .replace(/"(?:\\.|[^"])*"/g, '"?"')     // double-quoted literals
    .replace(/\b\d+(?:\.\d+)?\b/g, '?')     // numeric literals
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

/**
 * Billable quantity for an engine: `query-second` engines meter real wall-clock
 * (floor 0.001 s so a sub-millisecond run still records a non-zero share);
 * per-query engines (`adx`) keep their historical quantity of 1.
 */
export function queryRunQuantity(engine: QueryRunEngine, durationMs: number | undefined): number {
  const unit = ATTRIBUTION_RATES[engine]?.unit;
  if (unit !== 'query-second') return 1;
  const ms = Number.isFinite(durationMs) && (durationMs as number) > 0 ? (durationMs as number) : 1;
  return Math.max(0.001, Math.round((ms / 1000) * 1000) / 1000);
}

export interface QueryRunContext {
  tenantId: string;
  userOid: string;
  userName?: string;
  engine: QueryRunEngine;
  /** The executed statement — hashed here, never persisted. */
  statement?: string;
  /** Wall-clock of the execution in ms (the `query-second` basis). */
  durationMs?: number;
  rowCount?: number;
  /** Engine-native run id when one exists; otherwise the ledger id is used. */
  queryId?: string;
  workspaceId?: string;
  itemId?: string;
  itemType?: string;
  domainId?: string;
  /** Database / catalog / pool the statement ran against, or an ARM resource id. */
  resourceId?: string;
  dashboardId?: string;
  dashboardTile?: string;
}

/**
 * Record ONE query run to the attribution ledger. Best-effort — resolves to
 * `void` and never throws, so a Cosmos blip can never fail a user's query.
 */
export async function recordQueryRun(ctx: QueryRunContext): Promise<void> {
  try {
    if (!ctx?.tenantId || !ctx?.userOid || !ctx?.engine) return;
    await recordCostAttribution({
      tenantId: ctx.tenantId,
      userOid: ctx.userOid,
      userName: ctx.userName,
      engine: ctx.engine,
      quantity: queryRunQuantity(ctx.engine, ctx.durationMs),
      workspaceId: ctx.workspaceId,
      itemId: ctx.itemId,
      itemType: ctx.itemType,
      domainId: ctx.domainId,
      resourceId: ctx.resourceId,
      queryId: ctx.queryId,
      statementHash: statementFingerprint(ctx.statement) ?? undefined,
      durationMs: ctx.durationMs,
      rowCount: ctx.rowCount,
      dashboardId: ctx.dashboardId,
      dashboardTile: ctx.dashboardTile,
    });
  } catch {
    // never surfaces — attribution is observability, not a control path
  }
}
