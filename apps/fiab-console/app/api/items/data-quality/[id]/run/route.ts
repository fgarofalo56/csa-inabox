/**
 * POST /api/items/data-quality/[id]/run   (W11)
 *   body { backend?, database?, warehouseId?, catalog?, schema?, synapsePool?, tableNames?[] }
 *   (falls back to the values persisted on item.state)
 *
 * Runs the tenant's enabled Data Quality rules against this item's pinned target
 * via the shared multi-backend engine (data-quality-client `runDqRules`), and
 * persists the run to item.state.runs[]. Azure-native — ADX (default) /
 * Databricks / Synapse; no Microsoft Fabric dependency.
 *
 * GET returns the config-gate status + last run for the item (so the editor
 * shows readiness on load). Owner-scoped via loadOwnedItem / updateOwnedItem
 * (route-guards). Honest 503 with the exact env var when the chosen backend
 * isn't configured (no-vaporware).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { runDqRules, dqRunConfigGate, type DqRunBackend, type DqRunOptions } from '@/lib/azure/data-quality-client';
import { dqItemRunFromResult, appendDqItemRun, type DqItemRun } from '@/lib/azure/dq-item-run';
import { loadOwnedItem, updateOwnedItem, jerr } from '../../../_lib/item-crud';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'data-quality';
const BACKENDS: DqRunBackend[] = ['kusto', 'databricks', 'synapse'];

function optsFrom(body: any, state: Record<string, any>): DqRunOptions {
  const backend = (BACKENDS.includes(body?.backend) ? body.backend : BACKENDS.includes(state?.backend) ? state.backend : 'kusto') as DqRunBackend;
  const pick = (k: string) => (typeof body?.[k] === 'string' && body[k].trim() ? body[k].trim() : typeof state?.[k] === 'string' ? state[k] : undefined);
  const rawTables = Array.isArray(body?.tableNames) ? body.tableNames : Array.isArray(state?.tableNames) ? state.tableNames : [];
  const tableNames = rawTables.map((t: unknown) => String(t).trim()).filter(Boolean).slice(0, 100);
  return {
    backend,
    database: pick('database'),
    warehouseId: pick('warehouseId'),
    catalog: pick('catalog'),
    schema: pick('schema'),
    synapsePool: body?.synapsePool === 'dedicated' || state?.synapsePool === 'dedicated' ? 'dedicated' : (body?.synapsePool === 'serverless' || state?.synapsePool === 'serverless' ? 'serverless' : undefined),
    tableNames: tableNames.length ? tableNames : undefined,
  };
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return jerr('unauthenticated', 401);
  const item = await loadOwnedItem((await ctx.params).id, ITEM_TYPE, session.claims.oid, { allowReadRoles: true });
  if (!item) return jerr('data-quality item not found', 404);
  const state = (item.state || {}) as Record<string, any>;
  const backend = (BACKENDS.includes(state.backend) ? state.backend : 'kusto') as DqRunBackend;
  const gate = dqRunConfigGate(backend);
  const runs = Array.isArray(state.runs) ? (state.runs as DqItemRun[]) : [];
  return NextResponse.json({ ok: true, backend, gate: gate ? { missing: gate.missing } : undefined, lastRun: runs[0] || null, runCount: runs.length });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return jerr('unauthenticated', 401);
  const itemId = (await ctx.params).id;
  const item = await loadOwnedItem(itemId, ITEM_TYPE, session.claims.oid);
  if (!item) return jerr('data-quality item not found', 404);
  const state = (item.state || {}) as Record<string, any>;

  const body = await req.json().catch(() => ({}));
  const opts = optsFrom(body, state);

  const gate = dqRunConfigGate(opts.backend);
  if (gate) {
    return NextResponse.json({ ok: false, code: 'not_configured', gated: true, error: `The ${opts.backend} backend is not configured: set ${gate.missing}.`, hint: `Set ${gate.missing} on the loom-console env (or pick a different backend). Data-quality checks run against your real Azure backend — no fabricated scores.` }, { status: 503 });
  }

  const t0 = Date.now();
  try {
    const result = await runDqRules(session.claims.oid, opts);
    const run = dqItemRunFromResult(result, { durationMs: Date.now() - t0, ranBy: session.claims.upn || session.claims.email || session.claims.oid });
    // Persist the run + mirror the last-used target config.
    const nextState = {
      ...state,
      backend: opts.backend,
      ...(opts.database ? { database: opts.database } : {}),
      ...(opts.warehouseId ? { warehouseId: opts.warehouseId } : {}),
      ...(opts.catalog ? { catalog: opts.catalog } : {}),
      ...(opts.schema ? { schema: opts.schema } : {}),
      ...(opts.synapsePool ? { synapsePool: opts.synapsePool } : {}),
      ...(opts.tableNames ? { tableNames: opts.tableNames } : {}),
      runs: appendDqItemRun(Array.isArray(state.runs) ? state.runs : undefined, run),
    };
    await updateOwnedItem(itemId, ITEM_TYPE, session.claims.oid, { state: nextState }).catch(() => {});
    return NextResponse.json({ ok: true, run });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
