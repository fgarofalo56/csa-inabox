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
 *     /browse and admin callers). Cross-partition scan, then a BATCH workspace
 *     ACL filter (same resolver semantics, so an ACL-shared or admin-visible
 *     workspace's items are included — consistent with the scoped path).
 *
 * TENANT-PATH SHAPE (the /browse fix — root causes it closes):
 *   • `types=all` — /browse wants EVERY item type (~130 slugs). The old client
 *     sent ~130 repeated `?type=` params which the route expanded into a
 *     129-term OR; `all` drops the type predicate entirely (one clean
 *     cross-partition scan) and uses a LEAN projection (no `c.state` blob) so
 *     the payload stays small at tenant scale.
 *   • BATCH visibility, not per-item sequential authz. The old path awaited
 *     `authorizeWorkspaceList` PER DISTINCT WORKSPACE in a sequential loop
 *     (owner point-read + cross-partition doc read + ACL query each) — 36
 *     workspaces ≈ 36 serial round-trips, which regularly outran the client's
 *     20s budget; the client then swallowed the failure into `[]` and every
 *     Browse stat card showed 0. Now: ONE `listAccessibleWorkspaces` call
 *     (owned + direct-shared), plus ONE projected all-workspaces query for
 *     tenant admins (the admin-open bypass), plus a bounded-PARALLEL
 *     `authorizeWorkspaceList` fallback only for the group-shared stragglers.
 *   • Optional PAGING so the client can render progressively instead of
 *     all-or-nothing: `?pageSize=N` + request header `x-loom-continuation`
 *     (base64url of the Cosmos continuation token, minted by us in the
 *     previous response's `continuation` field). Omitted → fetchAll (legacy
 *     behavior for every existing caller).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { itemsContainer, workspacesContainer } from '@/lib/azure/cosmos-client';
import { authorizeWorkspaceList } from '@/lib/auth/workspace-list-access';
import { listAccessibleWorkspaces } from '@/lib/auth/workspace-access';
import { isTenantAdmin } from '@/lib/auth/feature-gate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Projection shared by both scopes (ItemDetails reads c.state; cards read the
 *  two governance leaves Cosmos returns as top-level fields). */
const SELECT_COLS =
  'c.id, c.itemType, c.workspaceId, c.displayName, c.description, c.state, c.createdBy, c.createdAt, c.updatedAt, c.state.endorsement, c.state.sensitivityLabel';
/** Lean projection for the tenant-wide `types=all` scan — everything the Browse
 *  explorer renders, WITHOUT the full `c.state` blob (editor definitions can be
 *  large; at ~1000s of items the full projection is megabytes). */
const SELECT_COLS_LITE =
  'c.id, c.itemType, c.workspaceId, c.displayName, c.description, c.createdBy, c.createdAt, c.updatedAt, c.state.endorsement, c.state.sensitivityLabel';
const NOT_RECYCLED = '(NOT IS_DEFINED(c.state._recycled) OR c.state._recycled = null)';

/** Max distinct-workspace ACL resolutions in flight at once (fallback path). */
const ACL_CONCURRENCY = 8;

/**
 * Resolve which workspaces the caller can see, as `workspaceId → { domain }`.
 * ONE batch query for owned + direct-shared (the same resolver /api/workspaces
 * uses), plus ONE projected cross-partition query for tenant admins so the
 * admin-open bypass holds without a per-workspace loop. The tid boundary is
 * enforced on the admin path exactly as `resolveWorkspaceAccessByOid` does.
 */
async function resolveVisibleWorkspaces(
  s: NonNullable<ReturnType<typeof getSession>>,
): Promise<Map<string, { domain?: string }>> {
  const visible = new Map<string, { domain?: string }>();
  const accessible = await listAccessibleWorkspaces(s.claims.oid, { callerTid: s.claims.tid });
  for (const w of accessible) visible.set(w.id, { domain: (w as any).domain ?? undefined });

  if (isTenantAdmin(s)) {
    const ws = await workspacesContainer();
    const { resources } = await ws.items
      .query<{ id: string; domain?: string; tid?: string }>({
        query: 'SELECT c.id, c.domain, c.tid FROM c',
        parameters: [],
      })
      .fetchAll();
    for (const w of resources) {
      // tid boundary: reject cross-tenant docs when both sides record a tid.
      if (s.claims.tid && w.tid && w.tid !== s.claims.tid) continue;
      if (!visible.has(w.id)) visible.set(w.id, { domain: w.domain ?? undefined });
    }
  }
  return visible;
}

/**
 * Bounded-parallel ACL fallback for workspaces NOT covered by the batch
 * resolution (group-shared grants resolve per-workspace via the caller's
 * groups). Returns the additional visible entries.
 */
async function resolveStragglers(
  s: NonNullable<ReturnType<typeof getSession>>,
  workspaceIds: string[],
): Promise<Map<string, { domain?: string }>> {
  const out = new Map<string, { domain?: string }>();
  for (let i = 0; i < workspaceIds.length; i += ACL_CONCURRENCY) {
    const batch = workspaceIds.slice(i, i + ACL_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (id) => {
        try {
          const access = await authorizeWorkspaceList(s, id);
          return access ? ([id, { domain: (access.workspace as any)?.domain ?? undefined }] as const) : null;
        } catch {
          return null; // one bad workspace never fails the whole browse scan
        }
      }),
    );
    for (const r of results) if (r) out.set(r[0], r[1]);
  }
  return out;
}

const b64urlEncode = (s: string) => Buffer.from(s, 'utf-8').toString('base64url');
const b64urlDecode = (s: string) => Buffer.from(s, 'base64url').toString('utf-8');

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
  // `types=all` — every item type (the /browse tenant-wide explorer). No type
  // predicate, lean projection.
  const allTypes = types.includes('all');
  const workspaceId = (sp.get('workspaceId') || '').trim();
  // Optional paging (tenant path): pageSize + base64url continuation header.
  const pageSize = Math.min(1000, Math.max(0, Number(sp.get('pageSize')) || 0));
  let cursor: string | undefined;
  try {
    const rawCursor = req.headers.get('x-loom-continuation');
    cursor = rawCursor ? b64urlDecode(rawCursor) : undefined;
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid continuation token' }, { status: 400 });
  }

  const items = await itemsContainer();
  const orClauses = allTypes ? '1 = 1' : types.map((_, i) => `c.itemType = @t${i}`).join(' OR ');
  const params = allTypes ? [] : types.map((t, i) => ({ name: `@t${i}`, value: t }));
  const cols = allTypes ? SELECT_COLS_LITE : SELECT_COLS;

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
          query: `SELECT ${cols} FROM c WHERE (${orClauses}) AND c.workspaceId = @w AND ${NOT_RECYCLED}`,
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
  //    callers). ONE cross-partition items query (optionally paged) + a BATCH
  //    workspace-visibility resolution — no per-workspace sequential authz.
  const query = {
    query: `SELECT ${cols} FROM c WHERE (${orClauses}) AND ${NOT_RECYCLED}`,
    parameters: params,
  };

  let candidates: any[];
  let continuation: string | undefined;
  if (pageSize > 0) {
    const iterator = items.items.query(query, {
      maxItemCount: pageSize,
      continuationToken: cursor,
    });
    const page = await iterator.fetchNext();
    candidates = (page.resources as any[]) ?? [];
    continuation = page.continuationToken ? b64urlEncode(page.continuationToken) : undefined;
  } else {
    const { resources } = await items.items.query(query).fetchAll();
    candidates = resources as any[];
  }

  if (candidates.length === 0) {
    return NextResponse.json({ ok: true, items: [], ...(continuation ? { continuation } : {}) });
  }

  // Batch visibility: owned + direct-shared + (admin) every in-tenant workspace,
  // then a bounded-parallel ACL fallback for group-shared stragglers only.
  // Capture each visible workspace's domain id so the card can show a domain
  // badge (resolved to a display name client-side).
  const visible = await resolveVisibleWorkspaces(s);
  const unknown = [...new Set(candidates.map((it) => it.workspaceId as string))].filter(
    (id) => !visible.has(id),
  );
  if (unknown.length > 0) {
    for (const [id, entry] of await resolveStragglers(s, unknown)) visible.set(id, entry);
  }

  const owned: any[] = [];
  for (const it of candidates) {
    const entry = visible.get(it.workspaceId);
    if (entry) owned.push({ ...it, workspaceDomain: entry.domain });
  }
  owned.sort((a, b) => (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || ''));
  return NextResponse.json({ ok: true, items: owned, ...(continuation ? { continuation } : {}) });
}
