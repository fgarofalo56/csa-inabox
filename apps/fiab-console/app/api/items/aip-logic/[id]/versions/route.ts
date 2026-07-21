/**
 * GET  /api/items/aip-logic/[id]/versions   → { ok, versions }
 * POST /api/items/aip-logic/[id]/versions    body { label?, note? }
 *   → { ok, version, versions }  (snapshots the current function definition)
 *
 * Version history for a Spindle (Palantir AIP-Logic) function. A version is an
 * immutable snapshot of the AUTHORED definition — typed inputs, the typed block
 * graph, the output contract, and model/settings — captured on demand or
 * automatically when the function is published (as a REST API or a Foundry
 * agent). The editor's Versions panel diffs any two snapshots (blocks/inputs/
 * outputs added · edited · removed). Persisted on the item doc in Cosmos
 * (`state.versions`, capped) — Azure-native, no Fabric.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem, updateOwnedItem } from '../../../_lib/item-crud';
import { apiError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const ITEM_TYPE = 'aip-logic';
const VERSION_CAP = 20;

/** The authored slice we snapshot (never the volatile run history). */
export function snapshotDefinition(state: Record<string, unknown>): Record<string, unknown> {
  return {
    inputs: Array.isArray(state.inputs) ? state.inputs : [],
    blocks: Array.isArray(state.blocks) ? state.blocks : [],
    outputType: state.outputType ?? 'string',
    outputDescription: state.outputDescription ?? '',
    settings: state.settings ?? {},
    boundOntologyId: state.boundOntologyId ?? null,
    boundOntologyName: state.boundOntologyName ?? null,
  };
}

/** Append a snapshot to state.versions (cap-bounded, newest first). Pure — the
 *  caller persists. Reused by the publish route so a publish records a version. */
export function appendVersion(
  state: Record<string, unknown>,
  label: string,
  meta?: Record<string, unknown>,
): { version: Record<string, unknown>; versions: Record<string, unknown>[] } {
  const prev = Array.isArray(state.versions) ? (state.versions as Record<string, unknown>[]) : [];
  const version = {
    id: `v_${Date.now()}`,
    ts: new Date().toISOString(),
    label: label.slice(0, 120) || `Version ${prev.length + 1}`,
    ...(meta ? { meta } : {}),
    snapshot: snapshotDefinition(state),
  };
  const versions = [version, ...prev].slice(0, VERSION_CAP);
  return { version, versions };
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return apiError('unauthenticated', 401, { code: 'unauthenticated' });
  const { id } = await ctx.params;
  if (!id || id === 'new') return apiError('save the function first', 400, { code: 'no_id' });
  const fn = await loadOwnedItem(id, ITEM_TYPE, s.claims.oid);
  if (!fn) return apiError('aip-logic function not found', 404, { code: 'not_found' });
  const state = (fn.state || {}) as Record<string, unknown>;
  return NextResponse.json({ ok: true, versions: Array.isArray(state.versions) ? state.versions : [] });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return apiError('unauthenticated', 401, { code: 'unauthenticated' });
  const { id } = await ctx.params;
  if (!id || id === 'new') return apiError('save the function before snapshotting a version', 400, { code: 'no_id' });
  const fn = await loadOwnedItem(id, ITEM_TYPE, s.claims.oid);
  if (!fn) return apiError('aip-logic function not found', 404, { code: 'not_found' });
  const body = await req.json().catch(() => ({} as { label?: string; note?: string }));
  const state = (fn.state || {}) as Record<string, unknown>;
  const blocks = Array.isArray(state.blocks) ? state.blocks : [];
  if (blocks.length === 0) return apiError('add at least one block before saving a version', 400, { code: 'no_blocks' });

  const label = String(body?.label || '').trim() || `Manual save`;
  const { version, versions } = appendVersion(state, label, body?.note ? { note: String(body.note).slice(0, 500) } : undefined);
  await updateOwnedItem(id, ITEM_TYPE, s.claims.oid, { state: { ...state, versions } });
  return NextResponse.json({ ok: true, version, versions });
}
