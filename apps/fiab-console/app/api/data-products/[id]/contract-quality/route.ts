/**
 * /api/data-products/[id]/contract-quality  (F19 / C8 — contract ENFORCEMENT)
 *
 * The data product's declared contract quality expectations
 * (`state.contract.quality[]`, authored in the Contract tab) are EXECUTED here
 * against the product's bound Azure Data Explorer table using real KQL, and the
 * pass rate feeds a composite data-quality score. This is what turns a written
 * commitment (not-null / unique / primary-key / accepted-values / range / regex /
 * freshness / row-count …) into an enforced one. Azure-native, NO Microsoft
 * Fabric dependency.
 *
 *   POST → run every declared expectation, persist the run to
 *          `dq-runs:<tenantId>` (Cosmos), return the per-expectation results +
 *          score. This is the "Run quality checks" action.
 *   GET  → the declared-expectation count + the most-recent persisted contract
 *          run for THIS product (so the panel shows last-run info on load) —
 *          read-only, no new run.
 *
 * Honest gates (no fake numbers, per no-vaporware.md):
 *   - ADX unset (`LOOM_KUSTO_CLUSTER_URI`)   → `gate.adx`, no run.
 *   - Product has no bound ADX table          → `gate.table`, no run.
 *   - No expectations declared in the contract → `expectationCount: 0`, no run.
 *
 * Authorization: `loadOwnedItem` scopes the product to the caller's workspace —
 * a signed-in session alone is not enough (route-guards).
 */

import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem } from '@/app/api/items/_lib/item-crud';
import { adxConfigGate, runContractQuality } from '@/lib/azure/data-quality-client';
import { defaultDatabase } from '@/lib/azure/kusto-client';
import { appendDqRun, listDqRuns, type DqRunRecord } from '@/lib/azure/dq-run-store';
import type { DataContract, QualityExpectation } from '@/lib/dataproducts/contract';
import type { DqRuleResult } from '@/lib/azure/data-quality-client';
import { apiOk, apiServerError, apiUnauthorized, apiNotFound } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'data-product';

interface Dataset { name?: string; guid?: string; qualifiedName?: string }

/** Resolve the product's bound ADX database + table (same resolution as observability). */
function resolveTarget(state: Record<string, unknown>) {
  const datasets = (Array.isArray(state.datasets) ? state.datasets : []) as Dataset[];
  const tableName = (state.databaseTable as string) || datasets[0]?.name || '';
  const database = (state.databaseName as string) || defaultDatabase();
  const contract = (state.contract || {}) as DataContract;
  const expectations = (Array.isArray(contract.quality) ? contract.quality : []) as QualityExpectation[];
  return { database, tableName, expectations };
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return apiUnauthorized();

  const { id } = await ctx.params;
  const item = await loadOwnedItem(id, ITEM_TYPE, session.claims.oid);
  if (!item) return apiNotFound('data-product item not found');

  const { database, tableName, expectations } = resolveTarget((item.state || {}) as Record<string, unknown>);

  // Most-recent persisted contract run for this product (best-effort read).
  let lastRun: { ranAt: string; score: number | null; passingRules: number; ruleCount: number } | null = null;
  try {
    const runs = await listDqRuns(session.claims.oid);
    const mine = runs.find((r) => r.productId === id);
    if (mine) lastRun = { ranAt: mine.ranAt, score: mine.score, passingRules: mine.passingRules, ruleCount: mine.ruleCount };
  } catch { /* history read is best-effort — a fresh run still works */ }

  const gate = adxConfigGate();
  return apiOk({
    database,
    tableName: tableName || null,
    expectationCount: expectations.length,
    lastRun,
    gate: gate ? { adx: { missing: gate.missing } } : !tableName ? { table: true } : undefined,
  });
}

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return apiUnauthorized();

  const { id } = await ctx.params;
  const item = await loadOwnedItem(id, ITEM_TYPE, session.claims.oid);
  if (!item) return apiNotFound('data-product item not found');

  const { database, tableName, expectations } = resolveTarget((item.state || {}) as Record<string, unknown>);

  // Honest gates — surface the precise remediation, never a fabricated result.
  const gate = adxConfigGate();
  if (gate) {
    return apiOk({ database, tableName: tableName || null, expectationCount: expectations.length, gate: { adx: { missing: gate.missing } } });
  }
  if (!tableName) {
    return apiOk({ database, tableName: null, expectationCount: expectations.length, gate: { table: true } });
  }
  if (expectations.length === 0) {
    return apiOk({ database, tableName, expectationCount: 0 });
  }

  try {
    const run = await runContractQuality(database, tableName, expectations);

    // Persist to the shared DQ run history (dq-runs:<tenantId>), mapping each
    // expectation into the common DqRuleResult breakdown shape.
    const breakdown: DqRuleResult[] = run.results.map((r) => ({
      ruleId: r.expectationId,
      name: r.column ? `${r.rule} · ${r.column}` : `${r.rule} (table)`,
      check: r.rule as DqRuleResult['check'],
      scope: r.column ? `column:${tableName}.${r.column}` : `table:${tableName}`,
      percentage: r.percentage,
      passed: r.pass,
      detail: r.detail,
    }));
    const rec: DqRunRecord = {
      id: `contract-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      backend: 'kusto',
      target: `contract:${tableName}`,
      score: run.score,
      ruleCount: run.results.length,
      passingRules: run.passed,
      breakdown,
      ranAt: run.computedAt,
      ranBy: session.claims.upn || session.claims.oid,
      tables: [tableName],
      productId: id,
    };
    await appendDqRun(session.claims.oid, rec).catch(() => { /* history write best-effort */ });

    return apiOk({
      database,
      tableName,
      expectationCount: expectations.length,
      run: {
        results: run.results,
        passed: run.passed,
        failed: run.failed,
        warnings: run.warnings,
        errored: run.errored,
        evaluated: run.evaluated,
        score: run.score,
        computedAt: run.computedAt,
      },
    });
  } catch (e: any) {
    return apiServerError(e, 'contract quality run failed', 'contract_quality_failed');
  }
}
