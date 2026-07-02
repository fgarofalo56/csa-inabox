/**
 * POST /api/thread/publish-as-api — Loom Thread edge (PR3).
 *
 * Weaves a warehouse table into a REST + GraphQL **API** by creating a real
 * Loom `data-api-builder` item whose config exposes that table as an entity.
 * The config is built from the table's real catalog schema (columns + primary
 * key) and points at the Azure-native warehouse (Synapse dedicated SQL pool,
 * which DAB's `dwsql` database-type supports). It passes `dab validate` parity
 * out of the box; the user then deploys it from the DAB editor (a disclosed,
 * deliberate step — no hidden hosting claimed).
 *
 * Per .claude/rules:
 *  - no-vaporware: creates a REAL, validate-passing DAB item (reusing the same
 *    createOwnedItem + DabConfig model the DAB editor uses); schema read from a
 *    real catalog query. Deploy/host is the editor's existing explicit action.
 *  - no-fabric-dependency: the backend is Azure-native Synapse dedicated SQL.
 *  - loom-no-freeform-config: every wizard field is a dropdown/toggle.
 *
 * Body: { from:{id,type,name}, values:{ table:"objId|schema|name", apiName,
 *         requireAuth? } }
 * Returns: { ok, message, link, linkLabel } | { ok:false, error }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { createOwnedItem, loadOwnedItem, listOwnedWorkspaces } from '../../items/_lib/item-crud';
import { dedicatedTarget, executeQuery } from '@/lib/azure/synapse-sql-client';
import { listColumns } from '@/lib/azure/sql-objects-client';
import {
  emptyDabConfig, emitDabConfigJson, validateDabConfig,
  type DabConfig, type DabEntity, type DabField,
} from '../../dab/_lib/dab-config-model';
import { recordThreadEdge } from '@/lib/thread/thread-edges';
import { readOnlySelect } from '@/lib/thread/sql-guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const WAREHOUSE_TYPES = new Set(['warehouse', 'synapse-dedicated-sql-pool']);
const GRAPHQL_NAME = /^[_A-Za-z][_0-9A-Za-z]*$/;

/** Make a safe GraphQL singular/plural from a table name. */
function gqlNames(name: string): { singular: string; plural: string } {
  const base = name.replace(/[^_0-9A-Za-z]/g, '_').replace(/^([0-9])/, '_$1') || 'Entity';
  const singular = base.charAt(0).toUpperCase() + base.slice(1);
  return { singular, plural: `${singular}s` };
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const oid = session.claims.oid;

  const body = await req.json().catch(() => ({} as any));
  const from = body?.from || {};
  const sourceMode = String(body?.values?.sourceMode || 'table').trim();
  const tableValue = String(body?.values?.table || '').trim();
  const queryText = String(body?.values?.query || '').trim();
  const apiName = String(body?.values?.apiName || '').trim();
  const requireAuth = body?.values?.requireAuth !== false; // secure by default

  if (!from.id || !from.type) return NextResponse.json({ ok: false, error: 'missing source item' }, { status: 400 });
  if (!WAREHOUSE_TYPES.has(from.type)) {
    return NextResponse.json({ ok: false, error: `${from.type} can't be published as an API yet (warehouse only).` }, { status: 400 });
  }
  if (!apiName) return NextResponse.json({ ok: false, error: 'name the API' }, { status: 400 });

  // The API is built from the Azure-native warehouse BACKEND (the env-configured
  // Synapse dedicated pool resolved below), not from the specific source item —
  // so a brand-new/unsaved pool, or one surfaced by the resource navigator
  // rather than saved as a Loom item, must still work. Use the source item's
  // workspace when we can load it; otherwise place the new DAB item in the
  // caller's first workspace. Only fail if the tenant has no workspace at all.
  const src = await loadOwnedItem(from.id, from.type, oid).catch(() => null);
  let targetWorkspaceId = src?.workspaceId;
  if (!targetWorkspaceId) {
    const wss = await listOwnedWorkspaces(oid).catch(() => []);
    targetWorkspaceId = wss[0]?.id;
  }
  if (!targetWorkspaceId) {
    return NextResponse.json(
      { ok: false, error: 'No workspace is available to place the API in. Create a workspace first, then retry.' },
      { status: 400 },
    );
  }

  let target;
  try {
    target = dedicatedTarget();
  } catch {
    return NextResponse.json(
      { ok: false, error: 'The Azure-native warehouse is not configured: set LOOM_SYNAPSE_WORKSPACE and LOOM_SYNAPSE_DEDICATED_POOL.' },
      { status: 503 },
    );
  }

  // Resolve the API's backing DB object (schema/name/type) + its key fields.
  //  - table: the catalog table picked in the dropdown.
  //  - query: wrap the user's SELECT as a real VIEW, then expose that view.
  let schema: string;
  let name: string;
  let objectType: 'table' | 'view';
  let fields: DabField[];
  let sourceDescr: string;

  if (sourceMode === 'query') {
    if (!queryText) return NextResponse.json({ ok: false, error: 'enter a SQL query' }, { status: 400 });
    const guard = readOnlySelect(queryText);
    if (!guard.ok) return NextResponse.json({ ok: false, error: guard.error }, { status: 400 });
    schema = 'dbo';
    // Deterministic, identifier-safe view name from the API name.
    const base = apiName.replace(/[^_0-9A-Za-z]/g, '_').replace(/^([0-9])/, '_$1').slice(0, 80) || 'Api';
    name = `loom_api_${base}`;
    objectType = 'view';
    // Create (or replace) the view from the user's query — real DDL on the
    // Azure-native warehouse, the deliberate step that makes the query a stable
    // API-addressable object.
    try {
      await executeQuery(target, `CREATE OR ALTER VIEW [${schema}].[${name.replace(/]/g, ']]')}] AS\n${guard.sql}`);
    } catch (e: any) {
      return NextResponse.json({ ok: false, error: `Could not create the view from your query: ${e?.message || String(e)}` }, { status: 400 });
    }
    fields = []; // views have no declared PK; DAB exposes read over all columns
    sourceDescr = `a custom SQL query (view ${schema}.${name})`;
  } else {
    if (!tableValue) return NextResponse.json({ ok: false, error: 'pick a table' }, { status: 400 });
    const [objIdStr, sch, nm] = tableValue.split('|');
    const objectId = Number(objIdStr);
    if (!Number.isInteger(objectId) || !sch || !nm) {
      return NextResponse.json({ ok: false, error: 'invalid table selection' }, { status: 400 });
    }
    schema = sch; name = nm; objectType = 'table';
    // Read the table's real columns → derive primary-key fields for the entity.
    try {
      const cols = await listColumns(target.server, target.database, objectId);
      if (!cols.length) return NextResponse.json({ ok: false, error: `Table ${schema}.${name} has no readable columns.` }, { status: 400 });
      // DAB auto-discovers columns; we only need to declare the primary key(s).
      fields = cols.filter((c) => c.isPrimaryKey).map((c) => ({ name: c.name, primaryKey: true }));
    } catch (e: any) {
      return NextResponse.json({ ok: false, error: `Could not read schema for ${schema}.${name}: ${e?.message || String(e)}` }, { status: 500 });
    }
    sourceDescr = `${from.type} table ${schema}.${name}`;
  }

  // Build a real DAB config: dwsql source (Synapse dedicated) + one entity.
  // The host auth PROVIDER (EntraId + jwt issuer/audience) is configured in the
  // editor before deploy — forcing EntraId here without jwt would fail
  // `dab validate`. The "Require authentication" toggle instead controls the
  // entity PERMISSION role (authenticated vs anonymous), the secure default.
  const cfg: DabConfig = emptyDabConfig('dwsql');
  cfg.sourceRef = { kind: 'dwsql', server: target.server, database: target.database, synapseRole: 'dedicated' };

  const entityName = GRAPHQL_NAME.test(name) ? name : gqlNames(name).singular;
  const { singular, plural } = gqlNames(name);
  const entity: DabEntity = {
    name: entityName,
    description: `Auto-exposed via Thread from ${sourceDescr}.`,
    source: { object: `${schema}.${name}`, type: objectType },
    rest: { enabled: true, path: `/${name.toLowerCase()}` },
    graphql: { enabled: true, singular, plural },
    fields,
    // Secure by default: authenticated read. The editor can broaden actions/roles.
    permissions: [{ role: requireAuth ? 'authenticated' : 'anonymous', actions: [{ action: 'read' }] }],
  };
  cfg.entities = [entity];

  // Block only on hard errors (warnings like "no PK" are surfaced in the editor).
  const errors = validateDabConfig(cfg).filter((i) => i.severity === 'error');
  if (errors.length) {
    return NextResponse.json({ ok: false, error: `Generated API config is invalid: ${errors.map((e) => e.message).join('; ')}` }, { status: 400 });
  }

  const res = await createOwnedItem(session, 'data-api-builder', {
    workspaceId: targetWorkspaceId,
    displayName: apiName,
    description: `REST + GraphQL API over ${schema}.${name}, created via Thread.`,
    state: { dabConfig: cfg, dabConfigJson: emitDabConfigJson(cfg) },
  });
  if (!res.ok) return NextResponse.json({ ok: false, error: res.error }, { status: res.status });

  await recordThreadEdge(session, {
    fromItemId: from.id, fromType: from.type, fromName: `${schema}.${name}`,
    toItemId: res.item.id, toType: 'data-api-builder', toName: res.item.displayName,
    action: 'publish-as-api',
  });

  return NextResponse.json({
    ok: true,
    message:
      `Created API "${res.item.displayName}" exposing ${schema}.${name} over REST (/${name.toLowerCase()}) and GraphQL ` +
      `(${plural}). ${requireAuth ? 'Secured to authenticated callers. ' : ''}Open it to review permissions, then Deploy.`,
    link: `/items/data-api-builder/${res.item.id}`,
    linkLabel: 'Open the API in the editor',
  });
}
