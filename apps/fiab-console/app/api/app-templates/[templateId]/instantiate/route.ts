/**
 * POST /api/app-templates/[templateId]/instantiate
 *
 * Fully-backed "demote-to-template" instantiation. A demoted app template is
 * NOT an empty shell or a copy-the-bundle stub — instantiating it scaffolds
 * SEVERAL real, Cosmos-persisted, editor-openable, backend-wired Loom items and
 * wires them to each other, then hands the caller back the id of the primary
 * item the user lands in.
 *
 * The template specs (which items, seed state, and sibling wiring) live in the
 * client-safe registry `@/lib/catalog/app-templates` — the SAME module the
 * New-item dialog imports to decide when to POST this route. This route is the
 * server-only half: it adds createOwnedItem / updateOwnedItem / getSession on
 * top of that shared data so the dialog and the route can never disagree on a
 * template's id, items, or bindings.
 *
 * No-vaporware contract (every returned item is REAL):
 *   - Each item is created via createOwnedItem() → a real Cosmos write plus the
 *     same AI-Search / governance-catalog / Purview mirroring every other create
 *     path performs. No mock arrays, no placeholder docs.
 *   - Every scaffolded item type opens in its OWN real Loom editor and calls its
 *     OWN real Azure backend. If a backend's infra isn't provisioned yet, the
 *     editor renders its existing honest Fluent MessageBar gate (DAB runtime
 *     container app, Functions runtime, Cosmos `LOOM_COSMOS_ACCOUNT`, ontology
 *     binding) — the full UI still renders; nothing is faked.
 *
 * No-fabric-dependency: every template here is 100% Azure-native by default —
 *   workshop-app  = ACA app over an ontology Synapse layer
 *   data-api-builder = Data API Builder on ACA
 *   slate-app     = Static Web App bundle
 *   user-data-function = Azure Functions
 *   azure-cosmos-account = Azure Cosmos DB
 * None of them touch api.fabric.microsoft.com / api.powerbi.com / onelake on the
 * default path, and none gate on a bound Fabric workspace.
 *
 * Back-compat: this route only creates NEW instances. slate-app / rayfin-app /
 * workshop-app keep their slugs, REST types, per-item BFF routes and registry
 * editors. Existing instances open at /items/<slug>/<id> with their own editor,
 * untouched. The dialog routes a template pick to the returned `primaryItemId`
 * (a real id), never to /items/<headSlug>/new.
 *
 * Body:     { workspaceId: string, displayName: string }
 * Response: { ok, templateId, primarySlug, primaryItemId, items: [{ slug, id, role, displayName, primary }] }
 * Auth:     session required.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { createOwnedItem, updateOwnedItem } from '@/app/api/items/_lib/item-crud';
import { findAppTemplate, type AppTemplateBindingField } from '@/lib/catalog/app-templates';
import type { WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Derive the bound value for a sibling reference. Every value is a REAL,
 * resolvable Loom path: `restBase` is the live Data API Builder control/preview
 * base served under /api/dab/<id>, and `apiBaseUrl` is the user-data-function
 * invoke route. `id` is the sibling's Cosmos item id.
 */
function resolveBindingValue(field: AppTemplateBindingField, sibling: WorkspaceItem): string {
  switch (field) {
    case 'id':
      return sibling.id;
    case 'restBase':
      // Data API Builder items are served under /api/dab/<id> (config/preview/publish).
      return `/api/dab/${sibling.id}`;
    case 'apiBaseUrl':
      // Azure Functions user-data-function invoke route.
      return `/api/items/user-data-function/${sibling.id}/invoke`;
    default:
      return sibling.id;
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ templateId: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const { templateId } = await ctx.params;
  const tpl = findAppTemplate(templateId);
  if (!tpl) {
    return NextResponse.json({ ok: false, error: 'unknown app template' }, { status: 404 });
  }

  const body = await req.json().catch(() => ({}));
  const workspaceId = (body?.workspaceId || '').toString().trim();
  const displayName = (body?.displayName || '').toString().trim();
  if (!workspaceId) {
    return NextResponse.json({ ok: false, error: 'workspaceId is required' }, { status: 400 });
  }
  if (!displayName) {
    return NextResponse.json({ ok: false, error: 'displayName is required' }, { status: 400 });
  }

  // ── PASS 1 — create every backing item (real Cosmos writes). ──────────────
  // createOwnedItem failures are rare (workspace-ownership / Cosmos) and are
  // surfaced honestly; on failure we stop and return the partial set so the
  // caller can see exactly what was created before the error.
  const created = new Map<string, WorkspaceItem>(); // role → created item
  for (const it of tpl.items) {
    const res = await createOwnedItem(session, it.slug, {
      workspaceId,
      displayName: `${displayName}${it.nameSuffix}`,
      state: { ...(it.seedState || {}), _scaffoldedBy: tpl.id },
    });
    if (!res.ok) {
      return NextResponse.json(
        {
          ok: false,
          error: `Failed to create ${it.slug}: ${res.error}`,
          templateId: tpl.id,
          partial: Array.from(created.entries()).map(([role, item]) => ({
            role,
            slug: item.itemType,
            id: item.id,
            displayName: item.displayName,
          })),
        },
        { status: res.status },
      );
    }
    created.set(it.role, res.item);
  }

  // ── PASS 2 — wire sibling bindings (merge into the seeded state). ─────────
  for (const it of tpl.items) {
    if (!it.bindings?.length) continue;
    const self = created.get(it.role);
    if (!self) continue;
    const patch: Record<string, unknown> = {};
    for (const b of it.bindings) {
      const sibling = created.get(b.fromRole);
      if (!sibling) continue;
      patch[b.stateKey] = resolveBindingValue(b.fromField, sibling);
    }
    if (Object.keys(patch).length === 0) continue;
    const mergedState = {
      ...((self.state as Record<string, unknown> | undefined) || {}),
      ...patch,
    };
    const updated = await updateOwnedItem(self.id, it.slug, session.claims.oid, {
      state: mergedState,
    });
    if (updated) created.set(it.role, updated);
  }

  // ── Resolve the primary item the user lands in. ───────────────────────────
  const primaryDef = tpl.items.find((i) => i.primary) ?? tpl.items[0];
  if (!primaryDef) {
    return NextResponse.json(
      { ok: false, error: 'template has no items', templateId: tpl.id },
      { status: 500 },
    );
  }
  const primary = created.get(primaryDef.role);
  if (!primary) {
    return NextResponse.json(
      { ok: false, error: 'primary item was not created', templateId: tpl.id },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    templateId: tpl.id,
    primarySlug: tpl.primarySlug,
    primaryItemId: primary.id,
    items: tpl.items.map((it) => {
      const c = created.get(it.role)!;
      return {
        slug: it.slug,
        id: c.id,
        role: it.role,
        displayName: c.displayName,
        primary: it.primary,
      };
    }),
  });
}
