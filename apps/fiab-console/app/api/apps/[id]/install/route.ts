/**
 * POST /api/apps/[id]/install — install an app's bundled items into a
 * caller-chosen workspace. Idempotent: items with the same displayName +
 * itemType already in the workspace are skipped (not duplicated).
 *
 * Body: { workspaceId: string }
 *
 * Reads the curated app from /api/apps-catalog (Cosmos apps-catalog).
 * For each `items[i]` in the app: creates a workspace item via the same
 * createOwnedItem helper the per-type editors use, so they pick it up in
 * their normal list flow + the item gets mirrored into AI Search /
 * audit-log automatically.
 *
 * Result:
 *   { ok, app, workspaceId, installed: [{itemType, id, displayName, status:'created'|'existed'}] }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { appsCatalogContainer, itemsContainer, workspacesContainer } from '@/lib/azure/cosmos-client';
import { createOwnedItem } from '@/app/api/items/_lib/item-crud';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface AppItemRef {
  type: string;
  template?: string;
  displayName?: string;
}
interface AppDoc {
  id: string;
  name: string;
  description?: string;
  items?: AppItemRef[];
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const workspaceId = (body?.workspaceId || '').toString().trim();
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });

  // Verify caller owns the workspace.
  const ws = await workspacesContainer();
  try {
    const { resource } = await ws.item(workspaceId, s.claims.oid).read<any>();
    if (!resource || resource.tenantId !== s.claims.oid) {
      return NextResponse.json({ ok: false, error: 'workspace not found' }, { status: 404 });
    }
  } catch (e: any) {
    if (e?.code === 404) return NextResponse.json({ ok: false, error: 'workspace not found' }, { status: 404 });
    throw e;
  }

  // Load the app.
  const apps = await appsCatalogContainer();
  const { resources: appDocs } = await apps.items
    .query<AppDoc>({
      query: 'SELECT * FROM c WHERE c.id = @id AND c.tenantId = @t',
      parameters: [{ name: '@id', value: params.id }, { name: '@t', value: s.claims.oid }],
    })
    .fetchAll();
  let app = appDocs[0];
  // Fall back to GLOBAL if not yet copied per-tenant.
  if (!app) {
    const { resources: globalDocs } = await apps.items
      .query<AppDoc>({
        query: 'SELECT * FROM c WHERE c.id = @id AND c.tenantId = @t',
        parameters: [{ name: '@id', value: params.id }, { name: '@t', value: 'GLOBAL' }],
      })
      .fetchAll();
    app = globalDocs[0];
  }
  if (!app) return NextResponse.json({ ok: false, error: `app '${params.id}' not found` }, { status: 404 });

  const items = await itemsContainer();
  // Existing items in this workspace, for dedup.
  const { resources: existing } = await items.items
    .query({
      query: 'SELECT c.id, c.itemType, c.displayName FROM c WHERE c.workspaceId = @w',
      parameters: [{ name: '@w', value: workspaceId }],
    }, { partitionKey: workspaceId })
    .fetchAll();
  const existsKey = new Set<string>(
    (existing as any[]).map(e => `${e.itemType}::${(e.displayName || '').toLowerCase()}`),
  );

  const installed: Array<{ itemType: string; id?: string; displayName: string; status: string; error?: string }> = [];
  for (const ref of app.items || []) {
    const displayName = ref.displayName || `${app.name} · ${ref.type}`;
    const key = `${ref.type}::${displayName.toLowerCase()}`;
    if (existsKey.has(key)) {
      const match = (existing as any[]).find(e => e.itemType === ref.type && (e.displayName || '').toLowerCase() === displayName.toLowerCase());
      installed.push({ itemType: ref.type, id: match?.id, displayName, status: 'existed' });
      continue;
    }
    const r = await createOwnedItem(s, ref.type, {
      workspaceId,
      displayName,
      description: `Installed from app '${app.name}'${ref.template ? ` · template: ${ref.template}` : ''}`,
      state: ref.template ? { template: ref.template, sourceApp: app.id } : { sourceApp: app.id },
    });
    if (r.ok) installed.push({ itemType: ref.type, id: r.item.id, displayName, status: 'created' });
    else installed.push({ itemType: ref.type, displayName, status: 'failed', error: r.error });
  }

  return NextResponse.json({ ok: true, app: app.id, workspaceId, installed });
}
