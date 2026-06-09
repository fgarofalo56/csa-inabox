/**
 * GET /api/items/[type]/[id]/lineage
 *
 * Item-to-item OneLake lineage for the lineage drawer. The backend is selected
 * AUTOMATICALLY from the deployment's cloud boundary (`detectLoomCloud()`) —
 * the caller never supplies a `source`. This is the Azure-native default path;
 * there is NO hard dependency on a real Microsoft Fabric / OneLake tenant
 * (per .claude/rules/no-fabric-dependency.md):
 *
 *   Commercial / GCC  → Unity Catalog lineage-tracking API (getTableLineage)
 *                       gates on LOOM_DATABRICKS_HOSTNAMES / LOOM_DATABRICKS_HOSTNAME
 *   GCC-High          → Purview Atlas relationships (getLineageSubgraph),
 *                       *.purview.azure.us — gates on LOOM_PURVIEW_ACCOUNT
 *   DoD / IL5         → Apache Atlas-on-AKS (inline atlasAksFetch),
 *                       gates on LOOM_ATLAS_ENDPOINT
 *
 * When the selected backend is not configured the route returns a STRUCTURED
 * honest gate (`{ ok:false, gate:'lineage-backend-not-configured', hint }`,
 * HTTP 501) so the drawer renders a named MessageBar — never an empty graph
 * (per .claude/rules/no-vaporware.md).
 *
 * Query params (all optional):
 *   depth  — Atlas/Purview lineage depth (1-10, default 3; ignored for UC)
 *   host   — Databricks workspace hostname override (UC; default first hostname)
 *   key    — explicit lineage key override (UC full_name or Atlas/Purview GUID).
 *            When omitted it is resolved from the Cosmos item's `state`, then
 *            falls back to the raw [id] path segment.
 *
 * The Atlas REST response shape (guidEntityMap + relations) is identical across
 * Purview and Apache Atlas 2.x, so both Atlas-family backends map to the
 * canvas `source: 'purview'` (the SOURCE_LABEL "Purview" badge covers the
 * GCC-High case; for IL5 the badge copy is approximate but the topology and
 * click-through are correct).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { detectLoomCloud, type LoomCloud } from '@/lib/azure/cloud-endpoints';
import {
  getTableLineage,
  listWorkspaceHostnames,
  UnityCatalogNotConfiguredError,
  UnityCatalogError,
} from '@/lib/azure/unity-catalog-client';
import {
  getLineageSubgraph,
  PurviewNotConfiguredError,
  PurviewError,
} from '@/lib/azure/purview-client';
import { itemsContainer, workspacesContainer } from '@/lib/azure/cosmos-client';
import type { Workspace, WorkspaceItem } from '@/lib/types/workspace';
import type {
  CanvasLineageNode,
  CanvasLineageEdge,
} from '@/lib/components/catalog/lineage-canvas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Backend = 'unity-catalog' | 'purview' | 'atlas-aks';

// ------------------------------------------------------------------
// Atlas-on-AKS (DoD / IL5) — honest gate + client
// ------------------------------------------------------------------

class AtlasAksNotConfiguredError extends Error {
  hint: { missingEnvVar: string; bicepModule: string; followUp: string };
  constructor() {
    super('Atlas-on-AKS lineage is not configured: missing LOOM_ATLAS_ENDPOINT');
    this.name = 'AtlasAksNotConfiguredError';
    this.hint = {
      missingEnvVar: 'LOOM_ATLAS_ENDPOINT',
      bicepModule:
        'platform/fiab/bicep/modules/admin-plane/catalog.bicep (atlasOnAksEnabled path)',
      followUp:
        'Set LOOM_ATLAS_ENDPOINT to the atlasEndpoint output of catalog.bicep. ' +
        'Requires atlasOnAksEnabled=true in main.bicep and the Atlas-on-AKS ' +
        'GitOps deployment to be live.',
    };
  }
}

class AtlasError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'AtlasError';
    this.status = status;
  }
}

const atlasUamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
let _atlasCredential: { getToken(scope: string): Promise<{ token: string } | null> } | null = null;

/**
 * Lazily construct the Atlas-on-AKS credential. `@azure/identity` is imported
 * dynamically (not at module top) so the route module loads without pulling the
 * full MSAL ESM graph until the DoD/IL5 Atlas path actually executes.
 */
async function atlasGetToken(scope: string): Promise<{ token: string } | null> {
  if (!_atlasCredential) {
    const { ChainedTokenCredential, DefaultAzureCredential, ManagedIdentityCredential } = await import(
      '@azure/identity'
    );
    _atlasCredential = atlasUamiClientId
      ? new ChainedTokenCredential(
          new ManagedIdentityCredential({ clientId: atlasUamiClientId }),
          new DefaultAzureCredential(),
        )
      : new DefaultAzureCredential();
  }
  return _atlasCredential.getToken(scope);
}

interface AtlasLineageResponse {
  guidEntityMap: Record<string, any>;
  relations: any[];
}

/** Apache Atlas 2.x lineage on AKS — same REST contract Purview exposes. */
async function atlasAksFetch(guid: string, depth: number): Promise<AtlasLineageResponse> {
  const endpoint = process.env.LOOM_ATLAS_ENDPOINT;
  if (!endpoint) throw new AtlasAksNotConfiguredError();
  const base = endpoint.replace(/\/$/, '');
  // The Atlas workload behind AKS is fronted by Entra; the audience defaults to
  // the endpoint host but can be overridden for a custom app registration.
  const scopeBase = (process.env.LOOM_ATLAS_SCOPE || base).replace(/\/$/, '');
  const token = await atlasGetToken(`${scopeBase}/.default`);
  if (!token?.token) throw new AtlasError('Failed to acquire Atlas-on-AKS token', 401);
  const url = `${base}/api/atlas/v2/lineage/${encodeURIComponent(guid)}?direction=BOTH&depth=${depth}`;
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${token.token}`, accept: 'application/json' },
    cache: 'no-store',
  });
  const text = await res.text();
  let j: any = null;
  try { j = text ? JSON.parse(text) : null; } catch { j = text; }
  if (!res.ok) {
    const msg =
      (j && typeof j === 'object' && (j.errorMessage || j.message)) ||
      (typeof j === 'string' ? j : `Atlas lineage failed ${res.status}`);
    throw new AtlasError(msg, res.status);
  }
  return { guidEntityMap: j?.guidEntityMap || {}, relations: j?.relations || [] };
}

// ------------------------------------------------------------------
// Item + lineage-key resolution
// ------------------------------------------------------------------

/** Load an item by id (cross-partition) and verify the caller's tenant owns it. */
async function loadItem(
  itemId: string,
  type: string,
  tenantId: string,
): Promise<WorkspaceItem | null> {
  const items = await itemsContainer();
  const { resources } = await items.items
    .query<WorkspaceItem>({
      query: 'SELECT * FROM c WHERE c.id = @id AND c.itemType = @t',
      parameters: [
        { name: '@id', value: itemId },
        { name: '@t', value: type },
      ],
    })
    .fetchAll();
  const item = resources[0];
  if (!item) return null;
  const ws = await workspacesContainer();
  try {
    const { resource } = await ws.item(item.workspaceId, tenantId).read<Workspace>();
    if (!resource || resource.tenantId !== tenantId) return null;
  } catch (e: any) {
    if (e?.code === 404) return null;
    throw e;
  }
  return item;
}

/** Resolve the Unity Catalog `catalog.schema.table` lineage key from item state. */
function ucKeyFromItem(item: WorkspaceItem | null): string | null {
  const s: any = item?.state || {};
  const direct = s.ucFullName || s.fullName || s.full_name || s.tableFullName || s.qualifiedName;
  if (typeof direct === 'string' && direct) return direct;
  const cat = s.catalog || s.catalogName;
  const sch = s.schema || s.schemaName;
  const tbl = s.table || s.tableName;
  if (cat && sch && tbl) return `${cat}.${sch}.${tbl}`;
  return null;
}

/** Resolve the Atlas/Purview entity GUID lineage key from item state. */
function guidFromItem(item: WorkspaceItem | null): string | null {
  const s: any = item?.state || {};
  const c = s.purviewGuid || s.atlasGuid || s.entityGuid || s.guid;
  return typeof c === 'string' && c ? c : null;
}

function shortName(fullName: string): string {
  const parts = fullName.split('.');
  return parts[parts.length - 1] || fullName;
}

// ------------------------------------------------------------------
// Backend implementations
// ------------------------------------------------------------------

async function ucLineage(
  type: string,
  id: string,
  item: WorkspaceItem | null,
  hostOverride: string,
  keyOverride: string,
): Promise<NextResponse> {
  const fullName = keyOverride || ucKeyFromItem(item) || id;
  const hosts = listWorkspaceHostnames(); // throws UnityCatalogNotConfiguredError when unset
  const host = hostOverride || hosts[0];
  const ucEdges = await getTableLineage(host, fullName);
  const seen = new Map<string, CanvasLineageNode>();
  const edges: CanvasLineageEdge[] = [];
  const ensure = (nid: string) => {
    if (!seen.has(nid)) {
      seen.set(nid, {
        id: nid,
        label: shortName(nid),
        type: 'table',
        source: 'unity-catalog',
        focus: nid === fullName,
      });
    }
  };
  for (const e of ucEdges) {
    ensure(e.source);
    ensure(e.target);
    edges.push({ from: e.source, to: e.target });
  }
  ensure(fullName); // focus node always present even with zero edges
  const nodes = [...seen.values()];
  if (item) {
    const fn = nodes.find((n) => n.id === fullName);
    if (fn) fn.openHref = `/items/${type}/${encodeURIComponent(id)}`;
  }
  return NextResponse.json({
    ok: true,
    backend: 'unity-catalog' as Backend,
    cloud: detectLoomCloud(),
    nodes,
    edges,
    focusId: fullName,
  });
}

async function atlasFamilyLineage(
  backend: Extract<Backend, 'purview' | 'atlas-aks'>,
  type: string,
  id: string,
  item: WorkspaceItem | null,
  keyOverride: string,
  depth: number,
): Promise<NextResponse> {
  const guid = keyOverride || guidFromItem(item) || id;
  const graph =
    backend === 'purview'
      ? await getLineageSubgraph(guid, depth)
      : await atlasAksFetch(guid, depth);

  const nodes: CanvasLineageNode[] = Object.entries(graph.guidEntityMap).map(
    ([k, v]: [string, any]) => ({
      id: v?.guid || k,
      label: v?.displayText || v?.attributes?.qualifiedName || v?.attributes?.name || k,
      type: v?.typeName,
      source: 'purview',
      focus: (v?.guid || k) === guid,
    }),
  );
  if (!nodes.some((n) => n.id === guid)) {
    nodes.push({
      id: guid,
      label: item?.displayName || guid,
      type,
      source: 'purview',
      focus: true,
    });
  }
  const edges: CanvasLineageEdge[] = (graph.relations || []).map((r: any) => ({
    from: r.fromEntityId,
    to: r.toEntityId,
    type: r.relationshipId || r.relationshipType,
  }));
  if (item) {
    const fn = nodes.find((n) => n.id === guid);
    if (fn) fn.openHref = `/items/${type}/${encodeURIComponent(id)}`;
  }
  return NextResponse.json({
    ok: true,
    backend,
    cloud: detectLoomCloud(),
    nodes,
    edges,
    focusId: guid,
  });
}

// ------------------------------------------------------------------
// Route
// ------------------------------------------------------------------

function gateOrError(e: any): NextResponse {
  if (
    e instanceof UnityCatalogNotConfiguredError ||
    e instanceof PurviewNotConfiguredError ||
    e instanceof AtlasAksNotConfiguredError
  ) {
    return NextResponse.json(
      { ok: false, gate: 'lineage-backend-not-configured', error: e.message, hint: (e as any).hint },
      { status: 501 },
    );
  }
  const status =
    e instanceof UnityCatalogError || e instanceof PurviewError || e instanceof AtlasError
      ? e.status
      : 500;
  return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: status || 500 });
}

export async function GET(
  req: NextRequest,
  props: { params: Promise<{ type: string; id: string }> },
) {
  const { type, id } = await props.params;
  const session = getSession();
  if (!session) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  const depth = Math.max(
    1,
    Math.min(10, parseInt(req.nextUrl.searchParams.get('depth') || '3', 10) || 3),
  );
  const hostOverride = req.nextUrl.searchParams.get('host') || '';
  const keyOverride = req.nextUrl.searchParams.get('key') || '';
  const cloud: LoomCloud = detectLoomCloud();

  // Best-effort item lookup: powers display name, lineage-key resolution from
  // state, and the focus node's deep-link. Never fatal — when the id is a raw
  // lineage key (UC full_name / Atlas GUID) there is no Cosmos row.
  let item: WorkspaceItem | null = null;
  try {
    item = await loadItem(id, type, session.claims.oid);
  } catch {
    item = null;
  }

  try {
    if (cloud === 'Commercial' || cloud === 'GCC') {
      return await ucLineage(type, id, item, hostOverride, keyOverride);
    }
    if (cloud === 'GCC-High') {
      return await atlasFamilyLineage('purview', type, id, item, keyOverride, depth);
    }
    // DoD / IL5
    return await atlasFamilyLineage('atlas-aks', type, id, item, keyOverride, depth);
  } catch (e: any) {
    return gateOrError(e);
  }
}
