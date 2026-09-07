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
import { authorizeItemWorkspace } from '@/lib/auth/workspace-guard';
import { getSession, type SessionPayload } from '@/lib/auth/session';
import { detectLoomCloud, type LoomCloud } from '@/lib/azure/cloud-endpoints';
import {
  UnityCatalogNotConfiguredError,
  UnityCatalogError,
} from '@/lib/azure/unity-catalog-client';
import {
  PurviewNotConfiguredError,
  PurviewError,
  type PurviewLineageGraph,
} from '@/lib/azure/purview-client';
import { getUnifiedLineage } from '@/lib/azure/unified-lineage';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';
import type { WorkspaceItem } from '@/lib/types/workspace';

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
 * Lazily construct the Atlas-on-AKS credential. The heavy MSAL `@azure/identity`
 * graph is imported dynamically (not at module top) so the route module loads
 * without pulling it until the DoD/IL5 Atlas path actually executes. The
 * lightweight {@link AcaManagedIdentityCredential} (core-auth only) is PREPENDED
 * as the first link so the ACA managed-identity token bug is bypassed in
 * production (see lib/azure/arm-credential.ts).
 */
async function atlasGetToken(scope: string): Promise<{ token: string } | null> {
  if (!_atlasCredential) {
    const { ChainedTokenCredential, DefaultAzureCredential, ManagedIdentityCredential } = await import(
      '@azure/identity'
    );
    _atlasCredential = new ChainedTokenCredential(
      new AcaManagedIdentityCredential(),
      new ManagedIdentityCredential(atlasUamiClientId ? { clientId: atlasUamiClientId } : {}),
      new DefaultAzureCredential(),
    );
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

/**
 * Find an item by id (cross-partition) + AUTHORIZE the caller against its parent
 * workspace through the canonical ladder (#3941). Read-scoped for GET, write-
 * scoped for every mutating verb. This REPLACES an owner-only partition point
 * read that admitted only the workspace CREATOR, so the admitted set strictly
 * GROWS: tenant admins and shared-ACL members with the right role now pass.
 */
async function loadItem(
  itemId: string,
  type: string,
  session: SessionPayload,
  allowReadRoles: boolean,
): Promise<{ item: WorkspaceItem | null; denied: NextResponse | null }> {
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
  if (!item) return { item: null, denied: null };
  // #3941 - the canonical ladder, replacing the owner-only partition point read
  // this helper used to do. `workspaces` is partitioned on `/tenantId`, which
  // holds the workspace CREATOR's oid, so `ws.item(workspaceId, callerOid)`
  // could only answer "did YOU create this workspace?" - it refused tenant
  // admins and shared-ACL members on every item type with no dedicated route
  // (the #2941/#2942 defect). `authorizeItemWorkspace` answers "may you ACCESS
  // it?", scoped: read roles for GET, write-capable only for the mutations.
  const denied = await authorizeItemWorkspace(session, {
    workspaceId: item.workspaceId,
    itemId,
    itemType: type,
    allowReadRoles,
    notFound: 'Item not found',
  });
  // An ORDINARY refusal (404) collapses to `null` so the route keeps its own
  // not-found wording, which is what its clients already render. The 409
  // `tenant_unconfirmed` refusal does NOT: flattening it into "item not found"
  // would state that the item does not exist, which the code did not establish
  // - the workspace document WAS read and the admin rights ARE real
  // (deploy-integrity.md R7). It is handed back for the route to return.
  if (denied) return { item: null, denied: denied.status === 404 ? null : denied };
  return { item, denied: null };
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

/** Does the path segment look like a UC `catalog.schema.table` full name? */
function looksLikeUcFullName(s: string): boolean {
  return /^[\w$]+\.[\w$]+\.[\w$]+$/.test(s);
}

/** Normalize an Apache Atlas-on-AKS lineage response into the same shape
 *  Purview's getLineageSubgraph returns, so the unified-lineage service can
 *  treat it as the `purview`-badged source on IL5 / DoD. */
function normalizeAtlasGraph(guid: string, raw: AtlasLineageResponse): PurviewLineageGraph {
  const guidEntityMap: PurviewLineageGraph['guidEntityMap'] = {};
  for (const [k, v] of Object.entries(raw.guidEntityMap || {})) {
    const e: any = v;
    guidEntityMap[k] = {
      guid: e?.guid || k,
      displayText: e?.displayText || e?.attributes?.qualifiedName || e?.attributes?.name,
      typeName: e?.typeName,
    };
  }
  const relations = (raw.relations || []).map((r: any) => ({
    fromEntityId: r.fromEntityId,
    toEntityId: r.toEntityId,
    relationshipType: r.relationshipId || r.relationshipType,
  }));
  return { baseEntityGuid: guid, guidEntityMap, relations };
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
  const columnLineage = req.nextUrl.searchParams.get('columns') === 'true';
  const cloud: LoomCloud = detectLoomCloud();

  // Best-effort item lookup: powers display name, lineage-key resolution from
  // state, and the focus node's deep-link. Never fatal — when the id is a raw
  // lineage key (UC full_name / Atlas GUID) there is no Cosmos row.
  let item: WorkspaceItem | null = null;
  try {
    // Best-effort, and DELIBERATELY dropping the authorization refusal: this
    // lookup only supplies a display name and resolves lineage keys from item
    // state. The lineage answer itself is tenant-scoped inside
    // `getUnifiedLineage`, so a refusal here is the same outcome as "no Cosmos
    // row" — the raw-lineage-key path this try/catch already exists for.
    item = (await loadItem(id, type, session, true)).item;
  } catch {
    item = null;
  }

  // Resolve the focus keys for every source from item state. The cloud boundary
  // still chooses the PRIMARY backend (badge), but the unified service overlays
  // the other Azure-native sources + Weave/Thread edges when their keys resolve
  // (per .claude/rules/no-fabric-dependency.md — Azure-native, never Fabric).
  const ucFromState = ucKeyFromItem(item) || undefined;
  const guidFromState = guidFromItem(item) || undefined;

  let backend: Backend;
  const baseInput = { session, itemId: id, itemType: type, depth, weaveDepth: depth };
  let ucFullName: string | undefined;
  let purviewGuid: string | undefined;
  let atlasFetcher: ((g: string, d: number) => Promise<PurviewLineageGraph>) | undefined;

  if (cloud === 'Commercial' || cloud === 'GCC') {
    backend = 'unity-catalog';
    ucFullName =
      keyOverride || ucFromState || (looksLikeUcFullName(id) ? id : undefined);
    purviewGuid = guidFromState;
  } else if (cloud === 'GCC-High') {
    backend = 'purview';
    purviewGuid = keyOverride || guidFromState || (looksLikeUcFullName(id) ? undefined : id);
    ucFullName = ucFromState;
  } else {
    // DoD / IL5 — Apache Atlas-on-AKS (own gate). Inject its fetcher so the
    // unified service treats it as the `purview`-badged Atlas source.
    backend = 'atlas-aks';
    purviewGuid = keyOverride || guidFromState || (looksLikeUcFullName(id) ? undefined : id);
    ucFullName = ucFromState;
    atlasFetcher = async (g: string, d: number) => normalizeAtlasGraph(g, await atlasAksFetch(g, d));
  }

  try {
    const result = await getUnifiedLineage({
      ...baseInput,
      ucFullName,
      ucHost: hostOverride || undefined,
      purviewGuid,
      atlasFetcher,
      columnLineage,
    });
    return NextResponse.json({ ...result, backend, cloud });
  } catch (e: any) {
    return gateOrError(e);
  }
}
