/**
 * GET /api/catalog/browse
 *   Tree view rooted at Source → Workspace/Metastore → Schema/Domain → Asset.
 *
 *   ?source=purview|unity-catalog|onelake (required)
 *   ?path=...   Comma-separated path segments. Empty = top level.
 *
 *   - For unity-catalog: empty path → metastores; one segment (host) → catalogs
 *     in that metastore; two (host,catalog) → schemas; three → tables+volumes.
 *   - For onelake: empty path → the user's Fabric workspaces (real
 *     api.fabric.microsoft.com/v1/workspaces); one segment (workspaceId) →
 *     that workspace's items (lakehouses, warehouses, semantic models,
 *     reports, KQL DBs, notebooks, pipelines, …) via /workspaces/{id}/items.
 *   - For purview: empty path → business domains; one segment (domainId) → data
 *     products in that domain.
 *
 * Returns { ok, nodes: TreeNode[] } where each node carries `id`, `label`,
 * `kind`, `hasChildren`, `meta` for the UI.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listAllMetastores, listCatalogs, listSchemas, listTables, listVolumes,
  UnityCatalogNotConfiguredError,
} from '@/lib/azure/unity-catalog-client';
import {
  listOneLakeWorkspaces, listWorkspaceItems,
} from '@/lib/azure/onelake-catalog-client';
import {
  listBusinessDomains, listDataProducts, PurviewNotConfiguredError,
} from '@/lib/azure/purview-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export interface TreeNode {
  id: string;
  label: string;
  kind: string;
  hasChildren: boolean;
  meta?: Record<string, unknown>;
}

export async function GET(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const source = (req.nextUrl.searchParams.get('source') || '').trim();
  const pathRaw = (req.nextUrl.searchParams.get('path') || '').trim();
  const path = pathRaw ? pathRaw.split('|').filter(Boolean) : [];

  if (!['purview', 'unity-catalog', 'onelake'].includes(source)) {
    return NextResponse.json({ ok: false, error: 'source must be one of purview|unity-catalog|onelake' }, { status: 400 });
  }

  try {
    if (source === 'unity-catalog') {
      if (path.length === 0) {
        const metastores = await listAllMetastores();
        return NextResponse.json({
          ok: true,
          nodes: metastores.map((m) => {
            // listAllMetastores returns a synthetic row (id prefixed `ERROR_`)
            // for any workspace it could reach the host of but not list the
            // metastore on — almost always a 403 "User is not an account admin
            // for Account." That happens because GET /metastores requires
            // Databricks account-admin privileges, OR the workspace simply
            // isn't attached to a Unity Catalog metastore yet. Render a clean
            // gate node instead of leaking the raw REST error string into the
            // tree; the rest of the tree (other workspaces) still renders.
            if (m.metastore_id.startsWith('ERROR_')) {
              const reason = m.name.replace(/^\((.*)\)$/, '$1');
              const is403 = /\b403\b/.test(reason) || /account admin/i.test(reason);
              // Listing METASTORES needs Databricks account-admin (the 403 here).
              // Listing this workspace's CATALOGS does NOT. So instead of a dead
              // "gate" node, render the workspace as a NAVIGABLE node whose
              // children come from listCatalogs(host) (path.length===1). The tree
              // works by default with only workspace access — account-admin is an
              // optional enrichment, never a hard requirement. Only a non-403
              // unreachable error stays a true gate.
              if (is403) {
                return {
                  id: m.workspace_hostname,
                  label: m.workspace_hostname,
                  kind: 'metastore',
                  hasChildren: true,
                  meta: {
                    workspace_hostname: m.workspace_hostname,
                    accountAdminEnrichment:
                      'Metastore-level metadata (region, metastore id) needs Databricks account-admin; the catalogs below list without it.',
                  },
                };
              }
              return {
                id: m.metastore_id,
                label: m.workspace_hostname,
                kind: 'gate',
                hasChildren: false,
                meta: {
                  workspace_hostname: m.workspace_hostname,
                  reason,
                  title: 'Workspace unreachable',
                  detail: `The workspace ${m.workspace_hostname} could not be reached: ${reason}`,
                  remediation: [
                    `Confirm LOOM_DATABRICKS_HOSTNAMES lists a reachable workspace and the Console UAMI can authenticate to it.`,
                  ],
                  learnMore:
                    'https://learn.microsoft.com/azure/databricks/data-governance/unity-catalog/manage-privileges/admin-privileges#account-admins',
                },
              };
            }
            return {
              id: m.workspace_hostname || m.metastore_id,
              label: `${m.name} (${m.workspace_hostname})`,
              kind: 'metastore',
              hasChildren: true,
              meta: { metastore_id: m.metastore_id, region: m.region },
            };
          }),
        });
      }
      if (path.length === 1) {
        const cats = await listCatalogs(path[0]);
        return NextResponse.json({
          ok: true,
          nodes: cats.map((c) => ({
            id: c.name,
            label: c.name,
            kind: 'catalog',
            hasChildren: true,
            meta: { comment: c.comment, owner: c.owner, host: path[0] },
          })),
        });
      }
      if (path.length === 2) {
        const schemas = await listSchemas(path[0], path[1]);
        return NextResponse.json({
          ok: true,
          nodes: schemas.map((sc) => ({
            id: sc.name,
            label: sc.name,
            kind: 'schema',
            hasChildren: true,
            meta: { full_name: sc.full_name, comment: sc.comment, owner: sc.owner, host: path[0] },
          })),
        });
      }
      if (path.length === 3) {
        const [host, catalog, schema] = path;
        const [tables, volumes] = await Promise.all([
          listTables(host, catalog, schema).catch(() => []),
          listVolumes(host, catalog, schema).catch(() => []),
        ]);
        const nodes: TreeNode[] = [];
        for (const t of tables) {
          nodes.push({
            id: t.full_name, label: t.name, kind: 'table', hasChildren: false,
            meta: { table_type: t.table_type, owner: t.owner, comment: t.comment, full_name: t.full_name, host },
          });
        }
        for (const v of volumes) {
          nodes.push({
            id: v.full_name, label: v.name, kind: 'volume', hasChildren: false,
            meta: { volume_type: v.volume_type, owner: v.owner, comment: v.comment, full_name: v.full_name, host },
          });
        }
        return NextResponse.json({ ok: true, nodes });
      }
    }

    if (source === 'onelake') {
      // Real Fabric/OneLake catalog — the workspaces the Console UAMI can see
      // (api.fabric.microsoft.com/v1/workspaces) and, on expand, every item in
      // them (lakehouses, warehouses, semantic models, reports, KQL DBs,
      // notebooks, pipelines, …). This is live tenant data, not a sample.
      if (path.length === 0) {
        const ws = await listOneLakeWorkspaces();
        return NextResponse.json({
          ok: true,
          nodes: ws.map((w) => ({
            id: w.id, label: w.displayName, kind: 'workspace', hasChildren: true,
            meta: { description: w.description, capacityId: w.capacityId, type: w.type, source: 'fabric-onelake' },
          })),
        });
      }
      if (path.length === 1) {
        const items = await listWorkspaceItems(path[0]);
        return NextResponse.json({
          ok: true,
          // Normalize Fabric item types to a stable, lower-case node `kind` so
          // the tree can pick a per-type icon; keep the original Fabric type in
          // meta.type for the label suffix and the detail page.
          nodes: items.map((it) => ({
            id: it.id,
            label: it.displayName,
            kind: (it.type || 'item').toLowerCase(),
            hasChildren: false,
            meta: { description: it.description, type: it.type || 'Item', workspaceId: path[0], source: 'fabric-onelake' },
          })),
        });
      }
    }

    if (source === 'purview') {
      if (path.length === 0) {
        const domains = await listBusinessDomains();
        return NextResponse.json({
          ok: true,
          nodes: domains.map((d) => ({
            id: d.id, label: d.name, kind: 'domain', hasChildren: true,
            meta: { description: d.description, type: d.type },
          })),
        });
      }
      if (path.length === 1) {
        // Data products are a unified-catalog concept that the classic Data Map
        // account doesn't expose. On classic, a domain mirrors to a collection
        // (see purview-client listBusinessDomains) which has no "data products"
        // sub-list — so an empty children list is the honest, non-erroring state
        // rather than letting the unified-catalog gate 501 the whole tree.
        let products: Awaited<ReturnType<typeof listDataProducts>> = [];
        try { products = await listDataProducts(path[0]); }
        catch (e: any) {
          if (!(e instanceof PurviewNotConfiguredError)) throw e;
          return NextResponse.json({ ok: true, nodes: [] });
        }
        return NextResponse.json({
          ok: true,
          nodes: products.map((p) => ({
            id: p.id, label: p.name, kind: 'data-product', hasChildren: false,
            meta: { description: p.description, type: p.type, status: p.status, owner: (Array.isArray(p.contacts) ? (p.contacts as any[])[0]?.id : undefined) },
          })),
        });
      }
    }

    return NextResponse.json({ ok: true, nodes: [] });
  } catch (e: any) {
    if (e instanceof PurviewNotConfiguredError || e instanceof UnityCatalogNotConfiguredError) {
      return NextResponse.json({ ok: false, error: e.message, hint: (e as any).hint }, { status: 501 });
    }
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e?.status || 500 });
  }
}
