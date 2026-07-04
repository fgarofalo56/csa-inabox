/**
 * /api/data-products/[id]/assets  — F9 "Add / Remove data assets".
 *
 * Curate the physical assets a data product wraps, sourced from the classic
 * Microsoft Purview Data Map and scoped to the product's governance domain
 * (mirrored 1:1 to a Purview collection). Asset references are stored on the
 * data-product WorkspaceItem under `state.dataAssets[]` in Cosmos — there is no
 * mock list anywhere; the search hits real Atlas entities via the Data Map
 * Discovery query, and deletion detection re-reads each entity by GUID.
 *
 *   GET  (no ?search)            → list attached assets + { deleted, dqRunning } flags + count.
 *   GET  ?search=1&q=&type=&...  → domain-scoped Purview Data Map search for the Add panel.
 *   POST { assets: [...] }       → attach the selected assets (dedup by guid).
 *   DELETE ?guid=<atlas-guid>    → remove one attached asset (blocked if a DQ rule covers it).
 *
 * Auth: session cookie + tenant ownership via loadOwnedItem / updateOwnedItem.
 * Honest gate: when LOOM_PURVIEW_ACCOUNT is unset the search returns HTTP 501
 * with the structured PurviewNotConfiguredHint (per .claude/rules/no-vaporware.md).
 *
 * No Microsoft Fabric dependency — the Data Map is a standalone Azure service
 * (Microsoft.Purview/accounts); this works with LOOM_DEFAULT_FABRIC_WORKSPACE
 * unset (per .claude/rules/no-fabric-dependency.md).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem, updateOwnedItem } from '@/app/api/items/_lib/item-crud';
import { tenantSettingsContainer } from '@/lib/azure/cosmos-client';
import {
  searchDataMapAssets,
  getAssetDetail,
  domainCollectionName,
  PurviewNotConfiguredError,
  PurviewError,
} from '@/lib/azure/purview-client';
import {
  ENTITY_TYPE_CHIPS,
  dqRunningRuleName,
  type DataAssetRef,
  type DqRule,
} from './asset-helpers';
import { apiError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'data-product';

function jerr(error: string, status = 500, extra?: Record<string, unknown>) {
  return apiError(error, status, extra);
}

function readDataAssets(state: Record<string, unknown> | undefined): DataAssetRef[] {
  const raw = (state?.dataAssets as DataAssetRef[] | undefined) || [];
  return Array.isArray(raw) ? raw : [];
}

// ---------------------------------------------------------------------------
// DQ-rule coverage — a Remove is blocked while a data-quality rule is "running"
// against the asset. Rules live in the tenant-settings doc dq-rules:<tenantId>
// (same store as /api/admin/data-quality-rules). loadEnabledDqRules reads the
// doc; ruleCoversAsset / dqRunningRuleName (in ./asset-helpers) do the matching.
// ---------------------------------------------------------------------------
async function loadEnabledDqRules(tenantId: string): Promise<DqRule[]> {
  try {
    const c = await tenantSettingsContainer();
    const { resource } = await c.item(`dq-rules:${tenantId}`, tenantId).read<{ items?: DqRule[] }>();
    return (resource?.items || []).filter((r) => r.enabled);
  } catch (e: any) {
    if (e?.code === 404) return [];
    throw e;
  }
}

// ---------------------------------------------------------------------------
// GET
// ---------------------------------------------------------------------------
export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const session = getSession();
  if (!session) return jerr('unauthenticated', 401);
  const tenantId = session.claims.oid;

  const url = new URL(req.url);
  const isSearch = url.searchParams.get('search') === '1' || url.searchParams.has('q');

  const item = await loadOwnedItem(id, ITEM_TYPE, tenantId);
  if (!item) return jerr('data product not found', 404);
  const state = (item.state || {}) as Record<string, unknown>;

  // --- Search branch (Add panel) ---
  if (isSearch) {
    const q = url.searchParams.get('q') || '';
    const type = url.searchParams.get('type') || 'All';
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '20', 10) || 20, 1), 50);
    const offset = Math.max(parseInt(url.searchParams.get('offset') || '0', 10) || 0, 0);
    const entityTypes = type && type !== 'All' ? ENTITY_TYPE_CHIPS[type] : undefined;
    const domain = typeof state.domain === 'string' ? state.domain.trim() : '';
    const collectionName = domain ? domainCollectionName(domain) : undefined;
    try {
      const results = await searchDataMapAssets({ q, collectionName, entityTypes, limit, offset });
      return NextResponse.json({
        ok: true,
        results,
        total: results.length,
        q,
        type,
        offset,
        limit,
        collectionName: collectionName || null,
        // Discovery returns a page; a full page implies there may be more.
        hasMore: results.length === limit,
      });
    } catch (e: any) {
      if (e instanceof PurviewNotConfiguredError) {
        return NextResponse.json({ ok: false, error: e.message, hint: e.hint }, { status: 501 });
      }
      const status = e instanceof PurviewError ? e.status : 502;
      return jerr(e?.message || 'Purview search failed', status);
    }
  }

  // --- List branch (attached assets with flags) ---
  const assets = readDataAssets(state);
  let dqRules: DqRule[] = [];
  try { dqRules = await loadEnabledDqRules(tenantId); } catch { dqRules = []; }

  // Deletion detection — re-read each asset by GUID (bounded concurrency 5).
  // A 404 (getAssetDetail → null) means the asset was deleted from the Data Map.
  const deletedFlags = new Array<boolean>(assets.length).fill(false);
  const CONC = 5;
  for (let i = 0; i < assets.length; i += CONC) {
    const batch = assets.slice(i, i + CONC);
    const settled = await Promise.allSettled(batch.map((a) => getAssetDetail(a.guid)));
    settled.forEach((res, j) => {
      if (res.status === 'fulfilled') {
        // null = 404 from the Data Map = deleted. A thrown error (e.g. Purview
        // unset) leaves deleted=false so we don't false-flag on an infra gate.
        deletedFlags[i + j] = res.value == null;
      }
    });
  }

  const enriched = assets.map((a, idx) => {
    const dqRule = dqRunningRuleName(dqRules, a);
    return {
      ...a,
      deleted: deletedFlags[idx],
      dqRunning: !!dqRule,
      dqRuleName: dqRule || undefined,
    };
  });

  return NextResponse.json({ ok: true, assets: enriched, count: enriched.length });
}

// ---------------------------------------------------------------------------
// POST — attach assets
// ---------------------------------------------------------------------------
export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const session = getSession();
  if (!session) return jerr('unauthenticated', 401);
  const tenantId = session.claims.oid;

  let body: any;
  try { body = await req.json(); } catch { return jerr('invalid JSON', 400); }
  const incoming: any[] = Array.isArray(body?.assets) ? body.assets : [];
  if (incoming.length === 0) return jerr('assets[] is required (at least one asset)', 400);

  const item = await loadOwnedItem(id, ITEM_TYPE, tenantId);
  if (!item) return jerr('data product not found', 404);
  const state = (item.state || {}) as Record<string, unknown>;
  const existing = readDataAssets(state);
  const haveGuids = new Set(existing.map((a) => a.guid));

  const now = new Date().toISOString();
  const toAdd: DataAssetRef[] = [];
  for (const a of incoming) {
    const guid = String(a?.guid || a?.id || '').trim();
    if (!guid || haveGuids.has(guid)) continue;
    haveGuids.add(guid);
    toAdd.push({
      guid,
      name: String(a?.name || a?.qualifiedName || guid).trim(),
      qualifiedName: a?.qualifiedName ? String(a.qualifiedName) : undefined,
      entityType: a?.entityType ? String(a.entityType) : undefined,
      addedAt: now,
    });
  }
  if (toAdd.length === 0) {
    return NextResponse.json({ ok: true, added: 0, dataAssets: existing, note: 'all selected assets were already attached' });
  }
  const next = [...existing, ...toAdd];
  const updated = await updateOwnedItem(id, ITEM_TYPE, tenantId, { state: { ...state, dataAssets: next } });
  if (!updated) return jerr('failed to persist asset refs', 500);
  return NextResponse.json({ ok: true, added: toAdd.length, dataAssets: next });
}

// ---------------------------------------------------------------------------
// DELETE — remove one attached asset (blocked while a DQ rule covers it)
// ---------------------------------------------------------------------------
export async function DELETE(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const session = getSession();
  if (!session) return jerr('unauthenticated', 401);
  const tenantId = session.claims.oid;

  const url = new URL(req.url);
  const guid = (url.searchParams.get('guid') || '').trim();
  if (!guid) return jerr('guid query parameter is required', 400);

  const item = await loadOwnedItem(id, ITEM_TYPE, tenantId);
  if (!item) return jerr('data product not found', 404);
  const state = (item.state || {}) as Record<string, unknown>;
  const existing = readDataAssets(state);
  const target = existing.find((a) => a.guid === guid);
  if (!target) return jerr('asset is not attached to this data product', 404);

  // Block removal while a data-quality rule is running against the asset — UNLESS
  // it has been deleted from the Data Map (then removal is always allowed, since
  // there is nothing left to govern). The UI gates the button; the server is the
  // authoritative check.
  const force = url.searchParams.get('force') === '1';
  if (!force) {
    let dqRules: DqRule[] = [];
    try { dqRules = await loadEnabledDqRules(tenantId); } catch { dqRules = []; }
    const ruleName = dqRunningRuleName(dqRules, target);
    if (ruleName) {
      // Confirm the asset still exists in the Data Map; if it's gone, allow removal.
      let stillExists = true;
      try { stillExists = (await getAssetDetail(guid)) != null; } catch { stillExists = true; }
      if (stillExists) {
        return jerr(
          `Cannot remove "${target.name}" while data-quality rule "${ruleName}" is running against it. ` +
          `Disable the rule (Governance → Data quality) first.`,
          409,
          { blocked: true, dqRuleName: ruleName },
        );
      }
    }
  }

  const next = existing.filter((a) => a.guid !== guid);
  const updated = await updateOwnedItem(id, ITEM_TYPE, tenantId, { state: { ...state, dataAssets: next } });
  if (!updated) return jerr('failed to persist asset refs', 500);
  return NextResponse.json({ ok: true, removed: guid, dataAssets: next });
}
