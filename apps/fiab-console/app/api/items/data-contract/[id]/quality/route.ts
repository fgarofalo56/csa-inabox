/**
 * /api/items/data-contract/[id]/quality  (W10 — standalone data contract)
 *
 * Runs the standalone data contract's declared quality expectations
 * (`state.contract.quality[]`) against a bound Azure Data Explorer table
 * (`state.databaseName` / `state.databaseTable`) using real KQL — the same
 * runContractQuality engine the data-product contract-quality route uses, now
 * for a first-class `data-contract` item. Azure-native, no Fabric dependency.
 *
 *   GET                          → meta { database, tableName, expectationCount, gate, lastRun }
 *   GET ?browse=databases        → { databases: string[] }        (ADX database picker)
 *   GET ?browse=tables&database= → { tables: string[] }           (ADX table picker)
 *   POST                         → run the expectations, persist state.lastQualityRun, return results
 *
 * Honest gates (no fabricated numbers): ADX unset → gate.adx; no bound table →
 * gate.table; no expectations → expectationCount:0. Owner-scoped via
 * loadOwnedItem (route-guards): a signed-in session alone is not enough.
 */
import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem, updateOwnedItem } from '@/app/api/items/_lib/item-crud';
import { adxConfigGate, runContractQuality } from '@/lib/azure/data-quality-client';
import { defaultDatabase, listDatabases, listTables } from '@/lib/azure/kusto-client';
import type { DataContract, QualityExpectation } from '@/lib/dataproducts/contract';
import { apiOk, apiServerError, apiUnauthorized, apiNotFound } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'data-contract';

interface LastQualityRun {
  ranAt: string;
  score: number | null;
  passed: number;
  failed: number;
  warnings: number;
  ruleCount: number;
}

function resolveTarget(state: Record<string, unknown>) {
  const contract = (state.contract || {}) as DataContract;
  const expectations = (Array.isArray(contract.quality) ? contract.quality : []) as QualityExpectation[];
  const tableName = String((state.databaseTable as string) || '').trim();
  const database = String((state.databaseName as string) || '') || defaultDatabase();
  return { database, tableName, expectations };
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return apiUnauthorized();

  const { id } = await ctx.params;
  const item = await loadOwnedItem(id, ITEM_TYPE, session.claims.oid, { allowReadRoles: true });
  if (!item) return apiNotFound('data-contract item not found');
  const state = (item.state || {}) as Record<string, unknown>;

  const browse = req.nextUrl.searchParams.get('browse');

  // ADX database / table pickers (no free-typed table names — loom_no_freeform_config).
  if (browse === 'databases') {
    const gate = adxConfigGate();
    if (gate) return apiOk({ databases: [], gate: { adx: { missing: gate.missing } } });
    try {
      const dbs = await listDatabases();
      return apiOk({ databases: dbs.map((d) => d.name) });
    } catch (e: any) {
      return apiServerError(e, 'could not list ADX databases', 'adx_list_failed');
    }
  }
  if (browse === 'tables') {
    const gate = adxConfigGate();
    if (gate) return apiOk({ tables: [], gate: { adx: { missing: gate.missing } } });
    const db = String(req.nextUrl.searchParams.get('database') || '') || defaultDatabase();
    try {
      const tables = await listTables(db);
      return apiOk({ tables: tables.map((t) => t.name) });
    } catch (e: any) {
      return apiServerError(e, 'could not list ADX tables', 'adx_list_failed');
    }
  }

  const { database, tableName, expectations } = resolveTarget(state);
  const lastRun = (state.lastQualityRun as LastQualityRun | undefined) || null;
  const gate = adxConfigGate();
  return apiOk({
    database,
    tableName: tableName || null,
    expectationCount: expectations.length,
    lastRun: lastRun ? { ranAt: lastRun.ranAt, score: lastRun.score, passingRules: lastRun.passed, ruleCount: lastRun.ruleCount } : null,
    gate: gate ? { adx: { missing: gate.missing } } : !tableName ? { table: true } : undefined,
  });
}

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return apiUnauthorized();

  const { id } = await ctx.params;
  const item = await loadOwnedItem(id, ITEM_TYPE, session.claims.oid);
  if (!item) return apiNotFound('data-contract item not found');
  const state = (item.state || {}) as Record<string, unknown>;

  const { database, tableName, expectations } = resolveTarget(state);

  const gate = adxConfigGate();
  if (gate) return apiOk({ database, tableName: tableName || null, expectationCount: expectations.length, gate: { adx: { missing: gate.missing } } });
  if (!tableName) return apiOk({ database, tableName: null, expectationCount: expectations.length, gate: { table: true } });
  if (expectations.length === 0) return apiOk({ database, tableName, expectationCount: 0 });

  try {
    const run = await runContractQuality(database, tableName, expectations);
    // Persist the last-run summary onto the item (owner-scoped) so GET shows it.
    const lastQualityRun: LastQualityRun = {
      ranAt: run.computedAt, score: run.score, passed: run.passed, failed: run.failed,
      warnings: run.warnings, ruleCount: run.results.length,
    };
    await updateOwnedItem(id, ITEM_TYPE, session.claims.oid, { state: { ...state, lastQualityRun } }).catch(() => {});
    return apiOk({
      database,
      tableName,
      expectationCount: expectations.length,
      run: {
        results: run.results,
        passed: run.passed, failed: run.failed, warnings: run.warnings,
        errored: run.errored, evaluated: run.evaluated, score: run.score, computedAt: run.computedAt,
      },
    });
  } catch (e: any) {
    return apiServerError(e, 'contract quality run failed', 'contract_quality_failed');
  }
}
