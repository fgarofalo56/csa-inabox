/**
 * Cross-type item lister for top-level surfaces like /activator,
 * /realtime-hub, /semantic-model, /onelake, etc., AND the editor source pickers.
 *
 * GET /api/items/by-type?type=lakehouse&type=eventstream&workspaceId=<ws>
 *   → flat list of every item of those types the caller can see, SCOPED to one
 *     workspace when `workspaceId` is supplied.
 *
 * TWO scopes, one endpoint:
 *
 *  1. WORKSPACE-SCOPED (the editor-picker path — pass `workspaceId`). The picker
 *     opened inside Workspace A must list ONLY Workspace A's items — a lakehouse
 *     / warehouse / database that lives in Workspace B must NEVER appear (that
 *     cross-workspace leak is the bug this route closes; Fabric scopes every
 *     picker to the current workspace + the caller's access). We authorize the
 *     caller against that one workspace via `authorizeWorkspaceList` (owner →
 *     workspace-roles ACL → tid boundary → admin-open), 404 when they have no
 *     access, then run a partition-keyed query filtered to `c.workspaceId`.
 *
 *  2. TENANT/BROWSE (no `workspaceId` — the intentional global explorer at
 *     /browse and admin callers). Cross-partition scan, then per-workspace ACL
 *     filter (same resolver, so an ACL-shared or admin-visible workspace's items
 *     are included — consistent with the scoped path, no longer owner-only).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import { authorizeWorkspaceList } from '@/lib/auth/workspace-list-access';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Projection shared by both scopes (ItemDetails reads c.state; cards read the
 *  two governance leaves Cosmos returns as top-level fields). */
const SELECT_COLS =
  'c.id, c.itemType, c.workspaceId, c.displayName, c.description, c.state, c.createdBy, c.createdAt, c.updatedAt, c.state.endorsement, c.state.sensitivityLabel';
const NOT_RECYCLED = '(NOT IS_DEFINED(c.state._recycled) OR c.state._recycled = null)';

export async function GET(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const sp = new URL(req.url).searchParams;
  // Accept either repeated `?type=A&type=B` (legacy callers) OR a single
  // comma-separated `?types=A,B`. The comma-separated form is preferred
  // because Azure Front Door Premium WAF (DRS 2.1 rule 921180, HTTP
  // Parameter Pollution) blocks the repeated form when there are 4+
  // identical keys, returning 403 at the edge.
  const fromRepeated = sp.getAll('type');
  const fromCsv = (sp.get('types') || '').split(',');
  const types = [...fromRepeated, ...fromCsv].map((t) => t.trim()).filter(Boolean);
  if (types.length === 0) {
    return NextResponse.json({ ok: false, error: 'at least one ?type= or ?types= required' }, { status: 400 });
  }
  const workspaceId = (sp.get('workspaceId') || '').trim();

  const items = await itemsContainer();
  const orClauses = types.map((_, i) => `c.itemType = @t${i}`).join(' OR ');
  const params = types.map((t, i) => ({ name: `@t${i}`, value: t }));

  // ── (1) WORKSPACE-SCOPED — the picker path. Authorize once, then a single
  //    partition-keyed query returns ONLY this workspace's items. No per-item
  //    ownership loop (the WHERE + partitionKey do the scoping).
  if (workspaceId) {
    const access = await authorizeWorkspaceList(s, workspaceId);
    if (!access) {
      return NextResponse.json({ ok: false, error: 'workspace not found' }, { status: 404 });
    }
    const { resources } = await items.items
      .query(
        {
          query: `SELECT ${SELECT_COLS} FROM c WHERE (${orClauses}) AND c.workspaceId = @w AND ${NOT_RECYCLED}`,
          parameters: [...params, { name: '@w', value: workspaceId }],
        },
        { partitionKey: workspaceId },
      )
      .fetchAll();
    const domain = (access.workspace as any)?.domain ?? undefined;
    const out = (resources as any[]).map((it) => ({ ...it, workspaceDomain: domain }));
    out.sort((a, b) => (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt));
    return NextResponse.json({ ok: true, items: out });
  }

  // ── (2) TENANT/BROWSE — no workspaceId (the /browse global explorer + admin
  //    callers). Cross-partition query; types is small, expanded to OR.
  const { resources: candidates } = await items.items
    .query({
      query: `SELECT ${SELECT_COLS} FROM c WHERE (${orClauses}) AND ${NOT_RECYCLED}`,
      parameters: params,
    })
    .fetchAll();

  if (candidates.length === 0) return NextResponse.json({ ok: true, items: [] });

  // Per-workspace ACL filter (owner → workspace-roles ACL → admin-open), cached
  // per workspace. Capture each visible workspace's domain id so the card can
  // show a domain badge (resolved to a display name client-side).
  const cache = new Map<string, { visible: boolean; domain?: string }>();
  const owned: any[] = [];
  for (const it of candidates as any[]) {
    let entry = cache.get(it.workspaceId);
    if (entry === undefined) {
      const access = await authorizeWorkspaceList(s, it.workspaceId);
      entry = { visible: !!access, domain: (access?.workspace as any)?.domain ?? undefined };
      cache.set(it.workspaceId, entry);
    }
    if (entry.visible) owned.push({ ...it, workspaceDomain: entry.domain });
  }
  owned.sort((a, b) => (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt));
  return NextResponse.json({ ok: true, items: owned });
}
