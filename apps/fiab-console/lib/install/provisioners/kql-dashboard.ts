/**
 * Phase 2 — KQL Dashboard (Real-Time Dashboard) provisioner.
 *
 * Real REST: Fabric POST /v1/workspaces/{ws}/kqlDashboards (Create Item
 * with definition). The bundle's KqlDashboardContent.tiles are compiled
 * into a real Real-Time Dashboard JSON definition (one `RealTimeDashboard.json`
 * part, Base64-encoded, payloadType InlineBase64) plus the required
 * `.platform` metadata part. Idempotency: if a dashboard with the same
 * displayName already exists in the workspace we updateDefinition instead
 * of create.
 *
 * The dashboard's data source is the ADX/Kusto cluster the sibling
 * `kql-database` item provisions against (LOOM_KUSTO_CLUSTER_URI /
 * LOOM_KUSTO_DEFAULT_DB). Each tile carries its own KQL query and a viz
 * hint mapped to the documented Real-Time Dashboard visualType enum so the
 * tile renders the same chart the bundle declares (card / line / bar /
 * table / pie).
 *
 * Grounded in Microsoft Learn:
 *   - KQL Dashboard definition (JSON format, RealTimeDashboard.json part):
 *     https://learn.microsoft.com/rest/api/fabric/articles/item-management/definitions/kql-dashboard-definition
 *   - Real-Time Dashboard schema (autoRefresh / dataSources / pages /
 *     queries / tiles / schema_version) via export dashboards:
 *     https://learn.microsoft.com/fabric/real-time-intelligence/dashboard-real-time-create#export-dashboards
 *   - Create Item with definition:
 *     https://learn.microsoft.com/rest/api/fabric/core/items/create-item
 *
 * Remediation gates:
 *   - target.fabricWorkspaceId missing → bind a Fabric workspace.
 *   - LOOM_KUSTO_CLUSTER_URI missing  → set it so tiles have a data source.
 *   - 401/403 from Fabric             → UAMI not a Contributor on the
 *                                        Fabric workspace; admin must add it.
 *
 * Per .claude/rules/no-vaporware.md no mock fallback — every error surfaces
 * verbatim with the exact remediation in the wizard MessageBar.
 */
import { ChainedTokenCredential, DefaultAzureCredential, ManagedIdentityCredential } from '@azure/identity';
import { FabricError, fabricHint } from '@/lib/azure/fabric-client';
import type { Provisioner, ProvisionResult } from './types';

const FABRIC_BASE = process.env.LOOM_FABRIC_BASE || 'https://api.fabric.microsoft.com/v1';
const FABRIC_SCOPE = 'https://api.fabric.microsoft.com/.default';
const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID;
const credential = uamiClientId
  ? new ChainedTokenCredential(new ManagedIdentityCredential({ clientId: uamiClientId }), new DefaultAzureCredential())
  : new DefaultAzureCredential();

async function getToken(scope: string): Promise<string> {
  const t = await credential.getToken(scope);
  if (!t?.token) throw new FabricError('Failed to acquire AAD token', 401, undefined, undefined, fabricHint(401));
  return t.token;
}

async function fabricCall(
  path: string,
  method: 'GET' | 'POST',
  body?: unknown,
): Promise<{ status: number; body: any; location?: string }> {
  const token = await getToken(FABRIC_SCOPE);
  const res = await fetch(`${FABRIC_BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  return { status: res.status, body: json ?? text, location: res.headers.get('location') || undefined };
}

/**
 * Map the bundle's tile viz hint to the Real-Time Dashboard `visualType`
 * enum. Grounded in the exported-dashboard schema (the same identifiers the
 * RTI dashboard "Visual type" picker writes):
 *   card → 'stat', line → 'line', bar → 'bar', pie → 'pie', table → 'table'.
 */
function vizToVisualType(viz: string): string {
  switch (viz) {
    case 'card':  return 'stat';
    case 'line':  return 'line';
    case 'bar':   return 'bar';
    case 'pie':   return 'pie';
    case 'table': return 'table';
    default:      return 'table';
  }
}

/** Deterministic GUID-shaped id from a seed so re-installs are stable. */
function stableId(seed: string): string {
  // FNV-1a 32-bit, expanded into a GUID-shaped string. Not cryptographic —
  // only needs to be stable + unique within one dashboard definition.
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const hex = (n: number) => (n >>> 0).toString(16).padStart(8, '0');
  const a = hex(h);
  const b = hex(Math.imul(h ^ 0x9e3779b9, 0x85ebca6b));
  const c = hex(Math.imul(h ^ 0xc2b2ae35, 0x27d4eb2f));
  const d = hex(Math.imul(h ^ 0x165667b1, 0x9e3779b9));
  return `${a}-${b.slice(0, 4)}-4${b.slice(4, 7)}-8${c.slice(0, 3)}-${c.slice(3, 8)}${d.slice(0, 4)}`;
}

/**
 * Build the Real-Time Dashboard JSON definition from the bundle tiles. The
 * single page lays tiles out in a 2-wide grid. Every tile references the one
 * Kusto data source (the ADX cluster + monitoring DB) so the dashboard is
 * immediately runnable when opened.
 */
function buildDashboardJson(
  content: any,
  title: string,
  dataSource: { id: string; clusterUri: string; database: string },
): unknown {
  const tiles: Array<{ title: string; kql: string; viz: string }> = Array.isArray(content?.tiles) ? content.tiles : [];
  const pageId = stableId(`${title}::page1`);

  const queries = tiles.map((t, i) => ({
    id: stableId(`${title}::q${i}::${t.title}`),
    text: t.kql,
    dataSource: { kind: 'manual', dataSourceId: dataSource.id, database: dataSource.database },
    usedVariables: [],
  }));

  const tileDefs = tiles.map((t, i) => {
    const col = (i % 2) * 12;        // 2 tiles per row on a 24-col grid
    const row = Math.floor(i / 2) * 6;
    return {
      id: stableId(`${title}::tile${i}::${t.title}`),
      title: t.title,
      visualType: vizToVisualType(t.viz),
      pageId,
      queryRef: { kind: 'query', queryId: queries[i].id },
      layout: { x: col, y: row, width: 12, height: 6 },
      visualOptions: {},
    };
  });

  return {
    schema_version: '52',
    title,
    autoRefresh: { enabled: true, defaultInterval: '5m', minInterval: '30s' },
    pages: [{ id: pageId, name: title }],
    dataSources: [
      {
        id: dataSource.id,
        name: dataSource.database,
        kind: 'kusto-trident',
        scopeId: 'kusto',
        clusterUri: dataSource.clusterUri,
        database: dataSource.database,
      },
    ],
    baseQueries: [],
    parameters: [
      {
        kind: 'duration',
        id: stableId(`${title}::param::timerange`),
        displayName: 'Time range',
        description: '',
        beginVariableName: '_startTime',
        endVariableName: '_endTime',
        defaultValue: { kind: 'dynamic', count: 4, unit: 'hours' },
        showOnPages: { kind: 'all' },
      },
    ],
    queries,
    tiles: tileDefs,
  };
}

function platformPart(displayName: string): { path: string; payload: string; payloadType: 'InlineBase64' } {
  return {
    path: '.platform',
    payload: Buffer.from(
      JSON.stringify({
        $schema: 'https://developer.microsoft.com/json-schemas/fabric/gitIntegration/platformProperties/2.0.0/schema.json',
        metadata: { type: 'KQLDashboard', displayName },
        config: { version: '2.0' },
      }),
      'utf-8',
    ).toString('base64'),
    payloadType: 'InlineBase64',
  };
}

export const kqlDashboardProvisioner: Provisioner = async (input): Promise<ProvisionResult> => {
  const steps: string[] = [];
  const ws = input.target.fabricWorkspaceId;
  const backend = input.target.dashboardBackend || 'adx';

  // The tiles query an ADX/Kusto database — the same one the sibling
  // kql-database item provisions. Without a cluster URI the dashboard would
  // have no runnable data source, so gate honestly (an ADX gate, not Fabric).
  const clusterUri = input.target.kustoClusterUri || process.env.LOOM_KUSTO_CLUSTER_URI;
  if (!clusterUri) {
    return {
      status: 'remediation',
      gate: {
        reason: 'No ADX cluster configured for the dashboard data source.',
        remediation:
          'Set LOOM_KUSTO_CLUSTER_URI (e.g. https://adx-csa-loom-shared.eastus2.kusto.<cloud-suffix>) so the dashboard tiles have a queryable Kusto data source.',
        link: 'https://learn.microsoft.com/azure/data-explorer/',
      },
      steps,
    };
  }
  // Resolve the Kusto database the tiles query.  The dashboard's data
  // source is the database the sibling `kql-database` item in the same app
  // bundle provisions — kql-db.ts derives that DB name from its item's
  // displayName via displayName.replace(/[^A-Za-z0-9_]/g,'_').slice(0,50).
  //
  // Resolution order (app-agnostic — no hard-coded per-app DB name):
  //   1. content.database — explicit sibling DB name carried on the bundle
  //      content (set by app bundles whose dashboard + kql-database items
  //      live in the same install).
  //   2. input.target.kustoDatabase — the install's resolved target DB
  //      (LOOM_KUSTO_DEFAULT_DB), passed by the provisioning engine.
  //   3. Slug of the dashboard's own displayName, stripped of a trailing
  //      " Dashboard" suffix and re-suffixed to match the conventional
  //      "<App> KQL Database" item naming — a best-effort last resort that
  //      keeps every app's dashboard pointed at a real DB rather than one
  //      app's hard-coded name.
  const contentDb = typeof (input.content as any)?.database === 'string'
    ? String((input.content as any).database).replace(/[^A-Za-z0-9_]/g, '_').slice(0, 50)
    : undefined;
  const database =
    contentDb ||
    input.target.kustoDatabase ||
    `${input.displayName.replace(/\s+Dashboard$/i, '')} KQL Database`
      .replace(/[^A-Za-z0-9_]/g, '_')
      .slice(0, 50) ||
    'loomdb';
  const dataSource = { id: stableId(`${input.displayName}::ds::${database}`), clusterUri, database };
  steps.push(`Dashboard data source: ${clusterUri} / ${database}`);

  const tileCount = Array.isArray((input.content as any)?.tiles) ? (input.content as any).tiles.length : 0;

  // ── Azure-native DEFAULT: Loom-native Real-Time Dashboard over ADX ────────
  // The dashboard is a Loom-native surface — kql-dashboard-model.ts + the
  // /api/items/kql-dashboard/[id]?run=1 route execute each tile's KQL directly
  // against the ADX cluster and render the visual in the Loom dashboard UI. No
  // Microsoft Fabric workspace is required (no-fabric-dependency.md). The tile
  // model is already persisted on the Cosmos item by Phase-1 install; here we
  // confirm the ADX data source is configured so the tiles are runnable.
  if (backend !== 'fabric' || !ws) {
    if (backend === 'fabric' && !ws) {
      steps.push('LOOM_DASHBOARD_BACKEND=fabric but no Fabric workspace bound — falling back to the Azure-native Loom dashboard over ADX.');
    }
    const tiles: Array<{ kql?: string }> = Array.isArray((input.content as any)?.tiles) ? (input.content as any).tiles : [];
    const runnable = tiles.filter((t) => typeof t.kql === 'string' && t.kql.trim().length > 0).length;
    steps.push(`Loom-native KQL dashboard ready: ${runnable}/${tileCount} tile(s) bound to ADX ${clusterUri} / ${database}. Renders in the Loom dashboard surface; tiles run live KQL via /run. No Fabric workspace required.`);
    return {
      status: 'created',
      resourceId: input.cosmosItemId,
      secondaryIds: { backend: 'adx', clusterUri, database, tiles: String(runnable) },
      steps,
    };
  }

  // ── Fabric Real-Time Dashboard (opt-in: LOOM_DASHBOARD_BACKEND=fabric + ws) ─
  steps.push(`Fabric workspace: ${ws}`);
  const dashboardJson = buildDashboardJson(input.content, input.displayName, dataSource);
  steps.push(`Built Real-Time Dashboard definition with ${tileCount} tiles.`);

  const definition = {
    format: 'JSON',
    parts: [
      {
        path: 'RealTimeDashboard.json',
        payload: Buffer.from(JSON.stringify(dashboardJson), 'utf-8').toString('base64'),
        payloadType: 'InlineBase64' as const,
      },
      platformPart(input.displayName),
    ],
  };

  // 1. Idempotency: list existing dashboards in the workspace.
  const list = await fabricCall(`/workspaces/${encodeURIComponent(ws)}/kqlDashboards`, 'GET');
  if (list.status === 401 || list.status === 403) {
    return {
      status: 'remediation',
      gate: {
        reason: `Fabric ${list.status}: not authorized to list KQL dashboards in workspace ${ws}.`,
        remediation: fabricHint(list.status) || 'Add the Console UAMI as a Contributor on this Fabric workspace.',
        link: `https://app.fabric.microsoft.com/groups/${ws}/settings`,
      },
      steps,
    };
  }
  if (list.status >= 400) {
    return {
      status: 'failed',
      error: `List kqlDashboards ${list.status}: ${typeof list.body === 'string' ? list.body : JSON.stringify(list.body)}`,
      steps,
    };
  }

  const existing = Array.isArray(list.body?.value)
    ? list.body.value.find((d: any) => (d.displayName || '').toLowerCase() === input.displayName.toLowerCase())
    : null;

  // 2. Update existing or create new.
  if (existing?.id) {
    steps.push(`Found existing KQL dashboard ${existing.id}; updating definition.`);
    const upd = await fabricCall(
      `/workspaces/${encodeURIComponent(ws)}/kqlDashboards/${encodeURIComponent(existing.id)}/updateDefinition`,
      'POST',
      { definition },
    );
    if (upd.status === 401 || upd.status === 403) {
      return {
        status: 'remediation',
        gate: {
          reason: `Fabric ${upd.status}: cannot update KQL dashboard definition.`,
          remediation: fabricHint(upd.status) || 'Add the Console UAMI as a Contributor on this Fabric workspace.',
          link: `https://app.fabric.microsoft.com/groups/${ws}/settings`,
        },
        steps,
      };
    }
    if (upd.status >= 400 && upd.status !== 202) {
      return {
        status: 'failed',
        error: `updateDefinition ${upd.status}: ${typeof upd.body === 'string' ? upd.body : JSON.stringify(upd.body)}`,
        steps,
      };
    }
    steps.push(`updateDefinition ${upd.status} OK.`);
    return {
      status: 'exists',
      resourceId: existing.id,
      secondaryIds: { fabricWorkspaceId: ws, clusterUri, database },
      steps,
    };
  }

  steps.push('Creating new Fabric KQL dashboard…');
  const create = await fabricCall(`/workspaces/${encodeURIComponent(ws)}/kqlDashboards`, 'POST', {
    displayName: input.displayName,
    description: `Installed from ${input.appId}`,
    definition,
  });
  if (create.status === 401 || create.status === 403) {
    return {
      status: 'remediation',
      gate: {
        reason: `Fabric ${create.status}: cannot create KQL dashboard.`,
        remediation: fabricHint(create.status) || 'Add the Console UAMI as a Contributor on this Fabric workspace.',
        link: `https://app.fabric.microsoft.com/groups/${ws}/settings`,
      },
      steps,
    };
  }
  if (create.status >= 400 && create.status !== 202) {
    return {
      status: 'failed',
      error: `Create kqlDashboards ${create.status}: ${typeof create.body === 'string' ? create.body : JSON.stringify(create.body)}`,
      steps,
    };
  }
  const dashboardId = create.body?.id;
  steps.push(`Created KQL dashboard ${dashboardId || '(long-running)'}.`);
  return {
    status: 'created',
    resourceId: dashboardId,
    secondaryIds: { fabricWorkspaceId: ws, clusterUri, database },
    steps,
  };
};
