/**
 * Phase 2 — KQL Dashboard (Real-Time Dashboard) provisioner.
 *
 * Azure-native DEFAULT (no-fabric-dependency.md): the dashboard is a
 * Loom-native surface over ADX. The bundle's KqlDashboardContent.tiles are
 * persisted on the Cosmos item at Phase-1 install; this provisioner confirms
 * the ADX data source — the same cluster the sibling `kql-database` item
 * provisions against (LOOM_KUSTO_CLUSTER_URI / LOOM_KUSTO_DEFAULT_DB) — so
 * every tile's KQL runs live via /api/items/kql-dashboard/[id]?run=1 in the
 * Loom dashboard UI. No Microsoft Fabric workspace is required or requested
 * on this path.
 *
 * Fabric backend (OPT-IN ONLY — target.dashboardBackend === 'fabric' AND a
 * bound workspace): compiles the tiles into a real Real-Time Dashboard JSON
 * definition (one `RealTimeDashboard.json` part, Base64-encoded, payloadType
 * InlineBase64, plus the required `.platform` metadata part) and creates it
 * via Fabric POST /v1/workspaces/{ws}/kqlDashboards. Idempotency: if a
 * dashboard with the same displayName already exists in the workspace we
 * updateDefinition instead of create. Each tile carries its own KQL query
 * and a viz hint mapped to the documented Real-Time Dashboard visualType
 * enum (card / line / bar / table / pie). When the Fabric backend is
 * selected but no workspace is bound we FALL BACK to the Azure-native path —
 * never a "bind a Fabric workspace" gate.
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
 * Remediation gates (Azure-side only, per no-vaporware.md):
 *   - LOOM_KUSTO_CLUSTER_URI missing  → set it so tiles have a data source.
 *   - 401/403 from Fabric (opt-in path only) → UAMI not a Contributor on the
 *     Fabric workspace; admin must add it.
 *
 * Per .claude/rules/no-vaporware.md no mock fallback — every error surfaces
 * verbatim with the exact remediation in the wizard MessageBar.
 */
import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import { ChainedTokenCredential, DefaultAzureCredential, ManagedIdentityCredential } from '@azure/identity';
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';
import { FabricError, fabricHint } from '@/lib/azure/fabric-client';
import type { Provisioner, ProvisionResult } from './types';
import { resolveInfraResidual } from './types';

const FABRIC_BASE = process.env.LOOM_FABRIC_BASE || 'https://api.fabric.microsoft.com/v1';
const FABRIC_SCOPE = 'https://api.fabric.microsoft.com/.default';
const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID;
const credential = uamiClientId
  ? new ChainedTokenCredential(new AcaManagedIdentityCredential(), new ManagedIdentityCredential({ clientId: uamiClientId }), new DefaultAzureCredential())
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
  const res = await fetchWithTimeout(`${FABRIC_BASE}${path}`, {
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
    const tile: any = {
      id: stableId(`${title}::tile${i}::${t.title}`),
      title: t.title,
      visualType: vizToVisualType(t.viz),
      pageId,
      queryRef: { kind: 'query', queryId: queries[i].id },
      layout: { x: col, y: row, width: 12, height: 6 },
      visualOptions: {},
    };
    // Drill-through interaction (Fabric: visual Interactions > Drillthrough).
    // Maps a result column → a dashboard parameter. Loom is single-page, so
    // the target page is the same page. Grounded in Learn: dashboard-parameters
    // #use-drillthroughs-as-dashboard-parameters.
    const dt = (t as any).drillthrough;
    if (dt?.column && dt?.paramName) {
      tile.interactions = {
        drillthroughEnabled: true,
        drillthroughTargets: [{
          pageId,
          columnParameterMappings: [{
            column: String(dt.column),
            parameterId: stableId(`${title}::param::${dt.paramName}`),
          }],
        }],
      };
    }
    return tile;
  });

  return {
    schema_version: '52',
    title,
    // Fabric RTD's own minimum auto-refresh interval is 30s (a real Fabric
    // constraint, preserved here for the opt-in Fabric export). The Loom-native
    // ADX editor supports a tighter 5s live cadence guarded against query
    // pile-up — see REFRESH_INTERVALS in phase3-editors.tsx.
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
        gateId: 'svc-adx',
        reason: 'No ADX cluster configured for the dashboard data source.',
        remediation:
          'Set LOOM_KUSTO_CLUSTER_URI (e.g. https://adx-csa-loom-shared.eastus2.kusto.<cloud-suffix>) so the dashboard tiles have a queryable Kusto data source.',
        link: 'https://learn.microsoft.com/azure/data-explorer/',
      },
      steps,
    };
  }
  // Resolve the Kusto database the tiles query (#3537).
  //
  // THE DEFECT THIS CLOSES. The tiles are real KQL against real tables, and the
  // same query pasted into a KQL queryset ran fine — but every tile on an
  // app-installed dashboard failed with "table not resolved", because the
  // dashboard was pointed at a DATABASE the tables do not live in. The old
  // order ended in two fallbacks that cannot be right:
  //   - `input.target.kustoDatabase` (LOOM_KUSTO_DEFAULT_DB) — the operator's
  //     default DB, which is not where the app's kql-database item seeded its
  //     tables; and
  //   - a SLUG of the dashboard's own displayName, re-suffixed to guess the
  //     conventional "<App> KQL Database" item name. That one is the worst of
  //     the two: it invents a database name that NOTHING creates, so it cannot
  //     resolve for any app whose DB item is not named to that convention —
  //     and it never fails loudly, it just silently produces a dead dashboard.
  //
  // The new order is grounded in what the install ACTUALLY provisions:
  //   1. `content.siblingKqlDatabases` — the deterministic backing names of the
  //      kql-database items in THIS install, computed by provisioning-engine.ts
  //      from `safeAdxDatabaseName(displayName)`, which is the same mapping
  //      kql-db.ts creates the ARM database with. Exactly one sibling is the
  //      unambiguous case and it wins outright — including over a declared
  //      `content.database`, because a hand-declared name that disagrees with
  //      the provisioned one is precisely the bug (app-federal-data-mesh
  //      declared `FederationAudit`; the item provisions `FederationAudit__ADX_`).
  //   2. `content.database` — an explicitly declared DB, for a dashboard whose
  //      database is provisioned by something other than a sibling item in the
  //      same bundle (app-workspace-monitoring's MONITOR_DB is the case).
  //   3. Otherwise: an honest gate. The platform cannot bind a dashboard to a
  //      database nobody provisioned, and pointing it at a default DB or an
  //      invented slug is a dead dashboard reported as 'created'.
  const siblings: string[] = Array.isArray((input.content as any)?.siblingKqlDatabases)
    ? (input.content as any).siblingKqlDatabases.map((s: unknown) => String(s)).filter(Boolean)
    : [];
  const contentDb = typeof (input.content as any)?.database === 'string'
    ? String((input.content as any).database).replace(/[^A-Za-z0-9_]/g, '_').slice(0, 50)
    : undefined;

  let database: string;
  if (siblings.length === 1) {
    database = siblings[0];
    if (contentDb && contentDb !== database) {
      // Stated, not silently overridden — the bundle's declaration is wrong and
      // the receipt has to say which name won and why.
      steps.push(`Bundle declared database '${contentDb}', but the kql-database item this install provisions is '${database}'. Binding the tiles to the provisioned database.`);
    } else {
      steps.push(`Bound to the sibling kql-database this install provisions: '${database}'.`);
    }
  } else if (contentDb) {
    database = contentDb;
    steps.push(
      siblings.length > 1
        ? `Bundle declares database '${database}'; this install provisions ${siblings.length} kql-database items (${siblings.join(', ')}), so the declaration is used.`
        : `Bound to the database declared on the bundle content: '${database}'.`,
    );
  } else if (siblings.length > 1) {
    return {
      status: 'remediation',
      gate: {
        reason: `This install provisions ${siblings.length} KQL databases (${siblings.join(', ')}) and the dashboard does not say which one its tiles query.`,
        remediation: `Set 'database' on the kql-dashboard item's content to one of: ${siblings.join(', ')}. Then re-run the install.`,
        link: 'https://learn.microsoft.com/azure/data-explorer/azure-data-explorer-dashboards',
      },
      steps,
    };
  } else {
    return {
      status: 'remediation',
      gate: {
        reason: 'No KQL database is provisioned for this dashboard: the app bundle contains no kql-database item, and the dashboard content declares no database name.',
        remediation:
          `Add a kql-database item to this app bundle (its tables are what the tiles query), or set 'database' on the kql-dashboard item's content to a database that already exists on ${clusterUri}. Then re-run the install. Loom does not point the tiles at a default database, because a dashboard bound to a database that does not hold its tables reports 'created' and then fails every tile with "table not resolved".`,
        link: 'https://learn.microsoft.com/azure/data-explorer/create-cluster-database',
      },
      steps,
    };
  }
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
    return resolveInfraResidual(
      `List kqlDashboards ${list.status}: ${typeof list.body === 'string' ? list.body : JSON.stringify(list.body)}`,
      fabricHint(list.status) || 'Add the Console UAMI as a Contributor on this Fabric workspace (and bind it to a capacity).',
      { status: list.status, link: `https://app.fabric.microsoft.com/groups/${ws}/settings`, steps },
    );
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
      return resolveInfraResidual(
        `updateDefinition ${upd.status}: ${typeof upd.body === 'string' ? upd.body : JSON.stringify(upd.body)}`,
        fabricHint(upd.status) || 'Add the Console UAMI as a Contributor on this Fabric workspace (and bind it to a capacity).',
        { status: upd.status, link: `https://app.fabric.microsoft.com/groups/${ws}/settings`, steps },
      );
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
    return resolveInfraResidual(
      `Create kqlDashboards ${create.status}: ${typeof create.body === 'string' ? create.body : JSON.stringify(create.body)}`,
      fabricHint(create.status) || 'Add the Console UAMI as a Contributor on this Fabric workspace (and bind it to a capacity).',
      { status: create.status, link: `https://app.fabric.microsoft.com/groups/${ws}/settings`, steps },
    );
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
