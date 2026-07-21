/**
 * Dataset→Object sync (WS-4.4) — backfill control route.
 *
 * GET  /api/items/ontology/[id]/sync?objectType=<type>
 *   → { ok, job: SyncJobDoc | null } — current progress (UI polls this)
 *
 * POST /api/items/ontology/[id]/sync
 *   body: { objectType: string }
 *   → { ok, result: SyncResult } — runs the full backfill synchronously,
 *     flushing progress to Cosmos after each 1 000-row batch so the GET
 *     poll reflects live forward progress even for large tables.
 *
 * DELETE /api/items/ontology/[id]/sync?objectType=<type>
 *   → { ok } — cancels a running job (the next batch check sees 'cancelled')
 *
 * Backend:
 *   - Reads the source table from Synapse Serverless (lakehouse Delta) or
 *     Dedicated SQL (warehouse) in PAGE_SIZE batches.
 *   - Upserts each row as an Apache AGE vertex (MERGE = idempotent).
 *   - Indexes every instance into Azure AI Search (loom-object-instances).
 *   - Persists progress to Cosmos `object-sync-jobs` (PK /ontologyId).
 *
 * Honest gates:
 *   - Weave PG not wired → 503 naming LOOM_WEAVE_PG_FQDN
 *   - Synapse not wired  → 503 naming LOOM_SYNAPSE_WORKSPACE
 *   - AI Search absent   → sync completes (AGE only); `indexed:false` in result
 *
 * Azure-native; no Fabric dependency.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { pdpCheck } from '@/lib/auth/pdp/enforce';
import { loadOwnedItem } from '../../../_lib/item-crud';
import { objectTypeByName, objectTypeNames } from '@/lib/editors/ontology-model';
import {
  runDatasetSync, getDatasetSyncStatus, cancelDatasetSync, SyncGateError,
} from '@/lib/azure/object-dataset-sync';
import type { OntoDatasource } from '@/lib/editors/ontology-model';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'ontology';

function err(error: string, status: number, code?: string, gate?: Record<string, unknown>) {
  return NextResponse.json(
    { ok: false, error, ...(code ? { code } : {}), ...(gate ? { gate } : {}) },
    { status },
  );
}

// ── GET — poll current job progress ──────────────────────────────────────────

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401, 'unauthenticated');
  const { id } = await ctx.params;
  if (!id || id === 'new') return err('save the ontology first', 400, 'no_id');

  const objectType = String(req.nextUrl.searchParams.get('objectType') || '').trim();
  if (!objectType) return err('objectType query param required', 400, 'bad_request');

  const onto = await loadOwnedItem(id, ITEM_TYPE, s.claims.oid);
  if (!onto) return err('ontology not found', 404, 'not_found');
  const blocked = await pdpCheck(s, { level: 'item', id, itemType: ITEM_TYPE }, 'read');
  if (blocked) return blocked;

  const state = (onto.state || {}) as Record<string, unknown>;
  const types = objectTypeNames(state);
  if (!types.has(objectType)) {
    return err(`"${objectType}" is not a declared object type`, 409, 'undeclared_type');
  }

  try {
    const job = await getDatasetSyncStatus(id, objectType);
    return NextResponse.json({ ok: true, job });
  } catch (e: unknown) {
    return err(`Failed to read sync status: ${e instanceof Error ? e.message : String(e)}`, 502, 'status_failed');
  }
}

// ── POST — start (or re-start) the backfill ──────────────────────────────────

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401, 'unauthenticated');
  const { id } = await ctx.params;
  if (!id || id === 'new') return err('save the ontology first', 400, 'no_id');

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const objectType = String((body as { objectType?: string }).objectType || '').trim();
  if (!objectType) return err('objectType is required', 400, 'bad_request');

  const onto = await loadOwnedItem(id, ITEM_TYPE, s.claims.oid);
  if (!onto) return err('ontology not found', 404, 'not_found');
  const blocked = await pdpCheck(s, { level: 'item', id, itemType: ITEM_TYPE }, 'write');
  if (blocked) return blocked;

  const state = (onto.state || {}) as Record<string, unknown>;
  const types = objectTypeNames(state);
  if (!types.has(objectType)) {
    return err(`"${objectType}" is not a declared object type on this ontology`, 409, 'undeclared_type');
  }

  // Require a datasource binding
  const ot = objectTypeByName(state, objectType);
  if (!ot?.datasource?.kind || !ot?.datasource?.table) {
    return err(
      `Object type "${objectType}" has no datasource binding. ` +
      'Edit the object type in the Typed model panel to add a Lakehouse or Warehouse datasource ' +
      '(kind + table + primary-key column are required for backfill).',
      409,
      'no_datasource',
    );
  }
  const datasource = ot.datasource as OntoDatasource;

  // Optional titleKey for the search index display label
  const titleKey = ot.titleKey || ot.primaryKey || undefined;

  try {
    const result = await runDatasetSync(id, objectType, datasource, { titleKey });
    const status = result.ok ? 200 : (result.status === 'failed' ? 502 : 200);
    return NextResponse.json({ ok: result.ok, result }, { status });
  } catch (e: unknown) {
    if (e instanceof SyncGateError) {
      return err(
        `Dataset sync not available: ${e.missing} is not configured. ${e.detail}`,
        503,
        'sync_not_configured',
        { missing: e.missing, detail: e.detail },
      );
    }
    return err(
      `Sync failed: ${e instanceof Error ? e.message : String(e)}`,
      502,
      'sync_failed',
    );
  }
}

// ── DELETE — cancel a running job ─────────────────────────────────────────────

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401, 'unauthenticated');
  const { id } = await ctx.params;
  if (!id || id === 'new') return err('save the ontology first', 400, 'no_id');

  const objectType = String(req.nextUrl.searchParams.get('objectType') || '').trim();
  if (!objectType) return err('objectType query param required', 400, 'bad_request');

  const onto = await loadOwnedItem(id, ITEM_TYPE, s.claims.oid);
  if (!onto) return err('ontology not found', 404, 'not_found');
  const blocked = await pdpCheck(s, { level: 'item', id, itemType: ITEM_TYPE }, 'write');
  if (blocked) return blocked;

  try {
    await cancelDatasetSync(id, objectType);
    return NextResponse.json({ ok: true, message: `Cancellation requested for ${objectType} sync.` });
  } catch (e: unknown) {
    return err(`Cancel failed: ${e instanceof Error ? e.message : String(e)}`, 502, 'cancel_failed');
  }
}
