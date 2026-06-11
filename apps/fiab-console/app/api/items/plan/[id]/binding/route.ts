/**
 * Plan binding + backing-store route (audit-T64).
 *
 * Backs the Loom **Plan (preview)** editor's Settings flyout — the Azure-native
 * parity of Microsoft Fabric Plan's semantic-model connection + auto-provisioned
 * Fabric SQL database (/fabric/iq/plan/overview). NO Microsoft Fabric dependency
 * (.claude/rules/no-fabric-dependency.md):
 *
 *   GET  → { semanticModels[], backing: { configured, gate?, table? } }
 *            semanticModels = real owned semantic-model items (Cosmos) for the
 *            bind picker; backing reports whether an Azure SQL writeback store is
 *            configured (honest gate naming the env vars when not).
 *   POST { action: 'provision' }
 *        → create the loom_plan_cells writeback table (idempotent). Returns the
 *          provisioned table name or an honest gate. Records state.backingDb.
 *
 * Per no-vaporware.md: when no backing SQL is configured the route returns a
 * precise gate (env vars + bicep module) — never a fake success — and the plan
 * still works (cells persist to Cosmos).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem, listOwnedItems, updateOwnedItem } from '../../../_lib/item-crud';
import { resolvePlanBacking, provisionPlanTables } from '@/lib/azure/plan-backing-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'plan';

function err(error: string, status: number, extra?: Record<string, unknown>) {
  return NextResponse.json({ ok: false, error, ...(extra || {}) }, { status });
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);
  await ctx.params; // id not needed for the picker list, but keep the contract

  // Real owned semantic-model items for the bind picker (no free-text ids).
  let semanticModels: Array<{ id: string; name: string }> = [];
  try {
    const items = await listOwnedItems('semantic-model', s.claims.oid);
    semanticModels = items.map((it) => ({ id: it.id, name: it.displayName || it.id }));
  } catch { /* surface an empty picker rather than 500 the whole flyout */ }

  const resolved = resolvePlanBacking();
  const backing = resolved.ok
    ? { configured: true, server: resolved.config.server, database: resolved.config.database }
    : { configured: false, gate: resolved.gate };

  return NextResponse.json({ ok: true, semanticModels, backing });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);
  const { id } = await ctx.params;
  if (!id || id === 'new') return err('save the plan before provisioning a backing store (no id yet)', 400);

  const body = await req.json().catch(() => ({} as any));
  const action = String(body?.action || 'provision');
  if (action !== 'provision') return err(`unknown action '${action}'`, 400);

  const plan = await loadOwnedItem(id, ITEM_TYPE, s.claims.oid);
  if (!plan) return err('plan not found', 404);

  const resolved = resolvePlanBacking();
  if (!resolved.ok) {
    return err(
      `Backing store not configured (missing ${resolved.gate.missing}).`,
      503,
      { gate: resolved.gate },
    );
  }

  const result = await provisionPlanTables(resolved.config);
  if (!result.ok) return err(result.error || 'provisioning failed', 502, { table: result.table });

  // Record the backing-db descriptor on the plan (parity with Fabric's
  // state.backingDb pointer to the auto-provisioned Fabric SQL database).
  const nextState: Record<string, unknown> = {
    ...(plan.state || {}),
    backingDb: {
      kind: 'azure-sql',
      serverName: resolved.config.server,
      dbName: resolved.config.database,
      provisionedAt: new Date().toISOString(),
    },
  };
  await updateOwnedItem(id, ITEM_TYPE, s.claims.oid, { state: nextState });

  return NextResponse.json({
    ok: true,
    table: result.table,
    server: resolved.config.server,
    database: resolved.config.database,
    message: `Backing store ready (${result.table} on ${resolved.config.database}). Planning cells now write back to Azure SQL on save.`,
  });
}
