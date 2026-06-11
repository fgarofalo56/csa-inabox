/**
 * Plan planning-sheet writeback route (audit-T64).
 *
 * Azure-native parity of Microsoft Fabric Plan's planning writeback
 * (/fabric/iq/plan/planning-writeback/planning-how-to-persist-data): persists a
 * planning sheet's budget/forecast/scenario cell values into a governed
 * relational store. Fabric writes to its auto-provisioned Fabric SQL database;
 * Loom writes to an Azure SQL Database (loom_plan_cells) — NO Microsoft Fabric
 * dependency (.claude/rules/no-fabric-dependency.md).
 *
 *   POST { sheetId, cells: [{ lineItemId, periodId, scenarioId, value }] }
 *        → MERGE the cells into Azure SQL (parameterized). Honest 503 gate when
 *          no backing store is configured — the editor keeps the cells in Cosmos
 *          regardless, so the plan never loses data.
 *
 * Per no-vaporware.md the cells genuinely land in a real Azure SQL table; the
 * route never returns a fake success when the store is missing.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem } from '../../../_lib/item-crud';
import { resolvePlanBacking, writebackCells, type WritebackCell } from '@/lib/azure/plan-backing-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'plan';
const MAX_CELLS = 5000;

function err(error: string, status: number, extra?: Record<string, unknown>) {
  return NextResponse.json({ ok: false, error, ...(extra || {}) }, { status });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);
  const { id } = await ctx.params;
  if (!id || id === 'new') return err('save the plan before writeback (no id yet)', 400);

  const plan = await loadOwnedItem(id, ITEM_TYPE, s.claims.oid);
  if (!plan) return err('plan not found', 404);

  const body = await req.json().catch(() => ({} as any));
  const sheetId = String(body?.sheetId || '').trim();
  if (!sheetId) return err('sheetId is required', 400);
  const rawCells: any[] = Array.isArray(body?.cells) ? body.cells : [];
  if (rawCells.length === 0) return err('cells[] is required and must be non-empty', 400);
  if (rawCells.length > MAX_CELLS) return err(`too many cells (max ${MAX_CELLS})`, 413);

  const cells: WritebackCell[] = [];
  for (const c of rawCells) {
    const lineItemId = String(c?.lineItemId || '').trim();
    const periodId = String(c?.periodId || '').trim();
    const scenarioId = String(c?.scenarioId || '').trim();
    const value = Number(c?.value);
    if (!lineItemId || !periodId || !scenarioId || !Number.isFinite(value)) continue;
    cells.push({ sheetId, lineItemId, periodId, scenarioId, value });
  }
  if (cells.length === 0) return err('no valid cells in payload', 400);

  const resolved = resolvePlanBacking();
  if (!resolved.ok) {
    return err(
      `Backing store not configured (missing ${resolved.gate.missing}). Cells are kept in Cosmos.`,
      503,
      { gate: resolved.gate },
    );
  }

  const result = await writebackCells(resolved.config, id, cells);
  if (!result.ok) return err(result.error || 'writeback failed', 502);

  return NextResponse.json({
    ok: true,
    written: result.written,
    server: resolved.config.server,
    database: resolved.config.database,
    message: `${result.written} cell${result.written === 1 ? '' : 's'} written to dbo.loom_plan_cells on ${resolved.config.database}.`,
  });
}
