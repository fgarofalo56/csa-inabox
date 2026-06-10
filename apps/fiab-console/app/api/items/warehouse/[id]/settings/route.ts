/**
 * GET  /api/items/warehouse/[id]/settings  → resolve the warehouse's compute
 *      settings + the live backend capability matrix (which toggles are
 *      honestly available on the current backend).
 * PUT  /api/items/warehouse/[id]/settings  body { queryAcceleration?: boolean }
 *      → persist the requested setting onto the item's Cosmos state. A setting
 *      that the current backend can't honor is recorded but reported back as
 *      `effective:false` with an honest reason — never silently "on".
 *
 * Backend resolution (no-fabric-dependency.md):
 *   - DEFAULT is the Azure-native Synapse Dedicated SQL pool. It runs the
 *     SQL Server batch-mode columnar engine — fast, CPU-only, NO GPU. So
 *     GPU-accelerated query acceleration is NOT available there: the toggle is
 *     honestly gated, not faked.
 *   - Fabric Data Warehouse is an OPT-IN alternative selected via
 *     LOOM_WAREHOUSE_BACKEND=fabric AND a bound Fabric workspace
 *     (LOOM_DEFAULT_FABRIC_WORKSPACE). Its distributed query-execution engine
 *     is what exposes GPU-accelerated query acceleration (Fabric Build 2026).
 *     Only then is the toggle effective.
 *
 * Works with LOOM_DEFAULT_FABRIC_WORKSPACE UNSET — the GET returns the Synapse
 * capability matrix and the toggle renders as an honest infra-gate.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem, updateOwnedItem, jerr } from '../../../_lib/item-crud';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'warehouse';

export type WarehouseBackend = 'synapse' | 'fabric';

export interface WarehouseSettingsState {
  /** User intent — persisted even when the current backend can't honor it. */
  queryAcceleration?: boolean;
}

export interface WarehouseCapabilityMatrix {
  backend: WarehouseBackend;
  /** Human label for the resolved backend. */
  backendLabel: string;
  /** Whether GPU-accelerated query acceleration can be turned on at all. */
  queryAccelerationAvailable: boolean;
  /** When unavailable, the exact, honest reason (which env to set / what to bind). */
  queryAccelerationGate?: string;
  /** Engine description shown in the UI. */
  engine: string;
}

/**
 * Resolve the warehouse backend from env. Azure-native Synapse is the DEFAULT;
 * Fabric is opt-in and requires BOTH the explicit backend selection AND a bound
 * Fabric workspace. Missing either → Synapse, silently (no Fabric gate).
 */
export function resolveWarehouseBackend(): WarehouseBackend {
  const selected = (process.env.LOOM_WAREHOUSE_BACKEND || '').trim().toLowerCase();
  const boundWorkspace = (process.env.LOOM_DEFAULT_FABRIC_WORKSPACE || '').trim();
  if (selected === 'fabric' && boundWorkspace) return 'fabric';
  return 'synapse';
}

/** Build the honest capability matrix for the resolved backend. */
export function warehouseCapabilityMatrix(): WarehouseCapabilityMatrix {
  const backend = resolveWarehouseBackend();
  if (backend === 'fabric') {
    return {
      backend,
      backendLabel: 'Fabric Data Warehouse (opt-in)',
      engine:
        'Fabric distributed query-execution engine — GPU-accelerated query acceleration is available on this backend.',
      queryAccelerationAvailable: true,
    };
  }
  return {
    backend,
    backendLabel: 'Synapse Dedicated SQL pool (Azure-native default)',
    engine:
      'SQL Server batch-mode columnar engine on a Synapse Dedicated SQL pool — CPU-only, no GPU.',
    queryAccelerationAvailable: false,
    queryAccelerationGate:
      'GPU-accelerated query acceleration is a Fabric Data Warehouse capability (Fabric Build 2026). '
      + 'The Azure-native Synapse Dedicated SQL pool that backs this warehouse runs a CPU-only '
      + 'batch-mode columnar engine and has no GPU compute. To enable it, opt into the Fabric '
      + 'backend: set LOOM_WAREHOUSE_BACKEND=fabric and bind a Fabric workspace via '
      + 'LOOM_DEFAULT_FABRIC_WORKSPACE. Your query setting is saved and applies automatically once '
      + 'the Fabric backend is bound.',
  };
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return jerr('unauthenticated', 401);
  const { id } = await ctx.params;
  const matrix = warehouseCapabilityMatrix();

  // 'new' (pre-save) warehouses have no Cosmos doc yet — return defaults + the
  // capability matrix so the editor renders the toggle before first save.
  if (!id || id === 'new') {
    return NextResponse.json({
      ok: true,
      settings: { queryAcceleration: false } as WarehouseSettingsState,
      capabilities: matrix,
      effective: { queryAcceleration: false },
    });
  }

  try {
    const item = await loadOwnedItem(id, ITEM_TYPE, session.claims.oid);
    if (!item) return jerr('not found', 404);
    const state = (item.state as Record<string, unknown>) || {};
    const persisted = (state.settings as WarehouseSettingsState | undefined) || {};
    const requested = persisted.queryAcceleration === true;
    return NextResponse.json({
      ok: true,
      settings: { queryAcceleration: requested } as WarehouseSettingsState,
      capabilities: matrix,
      // The TRUE effective state: only on when both requested AND the backend
      // can honor it. Never report "on" against a backend with no GPU.
      effective: { queryAcceleration: requested && matrix.queryAccelerationAvailable },
    });
  } catch (e: any) {
    return jerr(e?.message || String(e), 500);
  }
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return jerr('unauthenticated', 401);
  const { id } = await ctx.params;
  if (!id || id === 'new') return jerr('save the warehouse before changing settings', 409);

  const body = await req.json().catch(() => ({}));
  if (typeof body?.queryAcceleration !== 'boolean') {
    return jerr('queryAcceleration (boolean) is required', 400);
  }
  const matrix = warehouseCapabilityMatrix();

  try {
    const item = await loadOwnedItem(id, ITEM_TYPE, session.claims.oid);
    if (!item) return jerr('not found', 404);
    const state = ((item.state as Record<string, unknown>) || {});
    const prevSettings = (state.settings as WarehouseSettingsState | undefined) || {};
    const nextSettings: WarehouseSettingsState = {
      ...prevSettings,
      queryAcceleration: body.queryAcceleration,
    };
    const updated = await updateOwnedItem(id, ITEM_TYPE, session.claims.oid, {
      state: { ...state, settings: nextSettings },
    });
    if (!updated) return jerr('not found', 404);
    return NextResponse.json({
      ok: true,
      settings: nextSettings,
      capabilities: matrix,
      effective: {
        queryAcceleration: body.queryAcceleration && matrix.queryAccelerationAvailable,
      },
    });
  } catch (e: any) {
    return jerr(e?.message || String(e), 500);
  }
}
