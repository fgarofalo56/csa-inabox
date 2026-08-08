/**
 * Notebook source version history (R4-DBX-3).
 *
 * Databricks does not expose a public notebook-revision REST API, so Loom
 * captures its own point-in-time SOURCE snapshots into the shared `item-versions`
 * Cosmos container (PK /itemId) — the same store the generic item version layer
 * uses. Each snapshot records the full serialized notebook SOURCE for a given
 * workspace path, so any two versions diff cleanly and a restore has the exact
 * prior content to load back and re-import to the workspace.
 *
 *   GET  ?path=/Workspace/foo   → { ok, versions: [{ id, savedAt, savedBy,
 *                                    description, source }] }  (newest first)
 *   POST { path, language, source, description? } → { ok, id }
 *
 * Real backend (Cosmos). Honest 503 when Cosmos isn't configured
 * (no-vaporware.md). Snapshots are small (a notebook's text), so the source is
 * returned inline — restore is a client-side load + Save (workspace/import).
 */
import { NextRequest, NextResponse } from 'next/server';
import { withSession } from '@/lib/api/route-toolkit';
import type { SessionPayload } from '@/lib/auth/session';
import { authorizeItemWorkspace } from '@/lib/auth/workspace-guard';
import { itemVersionsContainer } from '@/lib/azure/cosmos-client';
import type { ItemVersionDoc } from '@/lib/versions/item-version-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NB_ITEM_TYPE = 'databricks-notebook';
const NB_NOT_FOUND = 'notebook not found';

/**
 * C22 (#3122) — neither handler authorized the caller against the notebook.
 * `item-versions` is partitioned by `/itemId`, so `[id]` alone reached ANY
 * tenant's notebook history: GET returned the full serialized SOURCE of every
 * snapshot, and POST wrote snapshots into someone else's history.
 *
 * The route-guard checker could not see it. GET carried no signal but its
 * sibling POST mentions `session.claims.oid` — as the snapshot's `savedBy`
 * ATTRIBUTION, never as a check — and the signal test was applied to the FILE.
 * Presence of the caller's oid was read as proof the caller was authorized.
 *
 * `authorizeItemWorkspace` runs the canonical owner → tenant-admin → shared-ACL
 * ladder and resolves the workspace FROM THE ITEM when `?workspaceId=` is
 * omitted, so authorization cannot be skipped by dropping the parameter.
 */
async function denyUnlessAuthorized(
  session: SessionPayload,
  id: string,
  workspaceId: string | null,
  opts?: { allowReadRoles?: boolean },
) {
  return authorizeItemWorkspace(session, {
    workspaceId,
    itemId: id,
    itemType: NB_ITEM_TYPE,
    notFound: NB_NOT_FOUND,
    ...(opts?.allowReadRoles ? { allowReadRoles: true } : {}),
  });
}

const MAX_VERSIONS_PER_PATH = 100;

interface NbVersionState {
  kind: 'databricks-notebook-source';
  path: string;
  language: string;
  source: string;
  description?: string;
}

function is503(e: any): boolean {
  return e?.code === 'cosmos_not_configured' || e?.name === 'CosmosNotConfiguredError';
}

export const GET = withSession<{ id: string }>(async (req: NextRequest, { session, params }) => {
  const { id } = params;
  const path = (req.nextUrl.searchParams.get('path') || '').trim();
  // READ surface → any workspace role may view version history.
  const denied = await denyUnlessAuthorized(session, id, req.nextUrl.searchParams.get('workspaceId'), { allowReadRoles: true });
  if (denied) return denied;
  try {
    const container = await itemVersionsContainer();
    const { resources } = await container.items
      .query<ItemVersionDoc>(
        {
          query:
            "SELECT * FROM c WHERE c.itemId = @i AND c.itemType = 'databricks-notebook' AND c.content.state.kind = 'databricks-notebook-source' ORDER BY c.savedAt DESC",
          parameters: [{ name: '@i', value: id }],
        },
        { partitionKey: id },
      )
      .fetchAll();
    const versions = resources
      .map((v) => {
        const st = (v.content?.state || {}) as unknown as NbVersionState;
        return {
          id: v.id,
          savedAt: v.savedAt,
          savedBy: v.savedByName || v.savedBy,
          path: st.path,
          language: st.language,
          description: st.description || '',
          source: st.source || '',
        };
      })
      .filter((v) => !path || v.path === path);
    return NextResponse.json({ ok: true, versions });
  } catch (e: any) {
    if (is503(e)) {
      return NextResponse.json(
        { ok: false, code: 'cosmos_not_configured', error: 'Version history requires Cosmos DB (set LOOM_COSMOS_ENDPOINT).' },
        { status: 503 },
      );
    }
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
});

export const POST = withSession<{ id: string }>(async (req: NextRequest, { session, params }) => {
  const { id } = params;
  const body = await req.json().catch(() => ({}));
  // WRITE surface → intentionally NO `allowReadRoles`: a read-only Viewer must
  // not be able to write into another member's notebook history.
  const denied = await denyUnlessAuthorized(session, id, (body?.workspaceId || '').toString() || null);
  if (denied) return denied;
  const path = (body?.path || '').toString().trim();
  const language = (body?.language || 'PYTHON').toString();
  const source = (body?.source ?? '').toString();
  const description = (body?.description || '').toString().slice(0, 400);
  if (!path) return NextResponse.json({ ok: false, error: 'path is required' }, { status: 400 });

  const state: NbVersionState = { kind: 'databricks-notebook-source', path, language, source, description };
  const doc: ItemVersionDoc = {
    id: `ver:${id}:${crypto.randomUUID()}`,
    docType: 'item-version',
    itemId: id,
    itemType: 'databricks-notebook',
    workspaceId: (body?.workspaceId || '').toString(),
    content: { displayName: path.split('/').pop() || path, description, state: state as unknown as Record<string, unknown> },
    savedAt: new Date().toISOString(),
    savedBy: session.claims.oid,
    savedByName: (session.claims as any)?.name || (session.claims as any)?.preferred_username,
  };
  try {
    const container = await itemVersionsContainer();
    await container.items.create<ItemVersionDoc>(doc);
    // Best-effort cap per path: evict oldest beyond the cap.
    try {
      const { resources } = await container.items
        .query<ItemVersionDoc>(
          {
            query:
              "SELECT * FROM c WHERE c.itemId = @i AND c.content.state.path = @p AND c.content.state.kind = 'databricks-notebook-source' ORDER BY c.savedAt ASC",
            parameters: [{ name: '@i', value: id }, { name: '@p', value: path }],
          },
          { partitionKey: id },
        )
        .fetchAll();
      const excess = resources.length - MAX_VERSIONS_PER_PATH;
      for (let k = 0; k < excess; k++) {
        try { await container.item(resources[k].id, id).delete(); } catch { /* best-effort */ }
      }
    } catch { /* cap is best-effort */ }
    return NextResponse.json({ ok: true, id: doc.id });
  } catch (e: any) {
    if (is503(e)) {
      return NextResponse.json(
        { ok: false, code: 'cosmos_not_configured', error: 'Version history requires Cosmos DB (set LOOM_COSMOS_ENDPOINT).' },
        { status: 503 },
      );
    }
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
});
