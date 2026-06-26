/**
 * GET / PUT /api/items/report/[id]/data-source
 *
 * Read + persist the REPORT DATA SOURCE — the discriminated union
 * (`lib/editors/report/report-data-source.ts`) the designer holds in state and
 * the `/fields` + `/query` resolvers dispatch on. This is the route the
 * designer's "Data source" drawer calls to switch a report between an
 * Azure-native Loom semantic model (DEFAULT), a direct SQL query, or (advanced)
 * an Azure Analysis Services tabular model.
 *
 * ── GET ────────────────────────────────────────────────────────────────────
 * Returns the report item's persisted `state.dataSource`. For reports saved
 * before `state.dataSource` existed, `fromLegacyState()` synthesizes
 * `{kind:'aas', server, database}` from the legacy `state.aasServer` /
 * `state.aasDatabase` keys so they keep working unchanged. A genuinely unbound
 * report returns `{ ok:true, dataSource:null }` so the designer shows its
 * honest "pick a data source" gate rather than an empty render.
 *
 * ── PUT ────────────────────────────────────────────────────────────────────
 * Validate the `ReportDataSource` union and persist it to `state.dataSource`
 * via `updateOwnedItem` (additive — the legacy `aasServer/aasDatabase` keys and
 * `state.content` are left untouched). Validation per kind:
 *   • semantic-model → `itemId` must resolve to an owned `semantic-model` item
 *     in the caller's tenant (the picker's choice is real, not a dangling ref).
 *     The id is normalized off any `loom:` content prefix so the `/fields` +
 *     `/query` resolvers (`loadModelItem` by plain Cosmos id) find it.
 *   • direct-query   → `sql` must pass `readOnlySelect` (single guarded SELECT,
 *     no DML/DDL — the only free-text escape hatch, per no-freeform-config);
 *     `target` is the warehouse|lakehouse Synapse path.
 *   • aas            → both `server` (XMLA URI) + `database` are required.
 *
 * Session-gated; owner-checked against the parent workspace's tenant. The
 * report id may be a plain Cosmos id OR a `loom:<cosmosId>` content-backed id
 * (bundle-installed reports), handled exactly like the sibling `…/definition`
 * write path.
 *
 * Rules compliance:
 *  - no-fabric-dependency: the DEFAULT source is a Loom semantic model over
 *    Synapse/lakehouse; AAS is advanced; Power BI is reached only via the
 *    opt-in publish path, never from this union. No api.powerbi.com /
 *    api.fabric.microsoft.com is called here.
 *  - no-vaporware: the semantic-model branch verifies the referenced item
 *    actually exists + is owned (no dangling binding); every reject is an
 *    actionable error, never a silent no-op.
 *  - no-freeform-config: the source is a picker choice; the only free text is
 *    the advanced AAS XMLA URI + the guarded direct-query SELECT.
 *
 * 200 OK → { ok:true, dataSource }
 * 4xx    → { ok:false, error } (validation) | { ok:false, gate } (honest gate)
 */

import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { readOnlySelect } from '@/lib/thread/sql-guard';
import {
  parseDataSource,
  fromLegacyState,
  type ReportDataSource,
} from '@/lib/editors/report/report-data-source';
import {
  isLoomContentId,
  cosmosIdFromLoomId,
  loadContentBackedItem,
} from '../../../_lib/pbi-content-fallback';
import { loadOwnedItem, updateOwnedItem } from '../../../_lib/item-crud';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** A validated source ready to persist, or a structured rejection. */
type ValidationResult =
  | { ok: true; dataSource: ReportDataSource }
  | { ok: false; status: number; error: string };

/**
 * Validate + normalize a parsed `ReportDataSource` against the caller's tenant.
 * The semantic-model branch is the only one that touches Cosmos (to confirm the
 * referenced model item exists + is owned); the others are pure structural
 * checks. Returns the canonical value to persist (ids trimmed/normalized, SQL
 * guard-normalized) so the `/fields` + `/query` resolvers find it.
 */
async function validateDataSource(
  ds: ReportDataSource,
  tenantId: string,
): Promise<ValidationResult> {
  switch (ds.kind) {
    case 'semantic-model': {
      const raw = (ds.itemId || '').trim();
      if (!raw) {
        return {
          ok: false,
          status: 400,
          error: 'Pick a semantic model for this report in the Data source panel.',
        };
      }
      // Normalize off any `loom:` content prefix so the model resolves by its
      // plain Cosmos id (what loadModelItem/loadOwnedItem query on).
      const itemId = isLoomContentId(raw) ? cosmosIdFromLoomId(raw) : raw;
      const model = await loadOwnedItem(itemId, 'semantic-model', tenantId);
      if (!model) {
        return {
          ok: false,
          status: 404,
          error:
            `The selected semantic model (${raw}) was not found in your workspace, or is not a ` +
            'semantic-model item. Pick an existing semantic model in the Data source panel.',
        };
      }
      return { ok: true, dataSource: { kind: 'semantic-model', itemId } };
    }

    case 'direct-query': {
      const guard = readOnlySelect(ds.sql);
      if (!guard.ok) {
        return { ok: false, status: 400, error: `Direct-query data source: ${guard.error}` };
      }
      const target = ds.target === 'lakehouse' ? 'lakehouse' : 'warehouse';
      return {
        ok: true,
        dataSource: {
          kind: 'direct-query',
          target,
          sql: guard.sql,
          // Preserve an already-scaffolded model link (governed reuse).
          ...(ds.modelItemId && ds.modelItemId.trim()
            ? { modelItemId: ds.modelItemId.trim() }
            : {}),
        },
      };
    }

    case 'aas': {
      const server = (ds.server || '').trim();
      const database = (ds.database || '').trim();
      if (!server || !database) {
        return {
          ok: false,
          status: 400,
          error:
            'The Analysis Services source requires both a server (XMLA URI, e.g. ' +
            'asazure://eastus2.asazure.windows.net/my-server) and a database/model name.',
        };
      }
      return { ok: true, dataSource: { kind: 'aas', server, database } };
    }

    default:
      return { ok: false, status: 400, error: 'Unrecognized data source.' };
  }
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const rawId = (await ctx.params).id;
  const cosmosId = isLoomContentId(rawId) ? cosmosIdFromLoomId(rawId) : rawId;

  const item = await loadContentBackedItem(cosmosId, 'report', session.claims.oid);
  if (!item) {
    return NextResponse.json({ ok: false, error: 'report item not found or not owned by you' }, { status: 404 });
  }

  // Persisted dataSource wins; else legacy aasServer/aasDatabase synthesizes an
  // AAS source; else null (drives the designer's "pick a data source" gate).
  const dataSource = fromLegacyState((item.state || {}) as Record<string, unknown>);
  return NextResponse.json({ ok: true, dataSource });
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const rawId = (await ctx.params).id;
  const cosmosId = isLoomContentId(rawId) ? cosmosIdFromLoomId(rawId) : rawId;

  let body: unknown = {};
  try { body = await req.json(); } catch {}

  // Accept either the bare union or `{ dataSource: <union> }`.
  const candidate =
    body && typeof body === 'object' && 'dataSource' in (body as Record<string, unknown>)
      ? (body as Record<string, unknown>).dataSource
      : body;
  const parsed = parseDataSource(candidate);
  if (!parsed) {
    return NextResponse.json(
      {
        ok: false,
        error:
          'Provide a data source with kind "semantic-model" (default, Azure-native), ' +
          '"direct-query", or "aas".',
      },
      { status: 400 },
    );
  }

  // Owner-check the report item up-front (404 before any validation work).
  const item = await loadContentBackedItem(cosmosId, 'report', session.claims.oid);
  if (!item) {
    return NextResponse.json({ ok: false, error: 'report item not found or not owned by you' }, { status: 404 });
  }

  const validated = await validateDataSource(parsed, session.claims.oid);
  if (!validated.ok) {
    return NextResponse.json({ ok: false, error: validated.error }, { status: validated.status });
  }

  // Persist additively onto state.dataSource (legacy keys + content untouched).
  const newState = { ...((item.state || {}) as Record<string, unknown>), dataSource: validated.dataSource };
  const updated = await updateOwnedItem(cosmosId, 'report', session.claims.oid, { state: newState });
  if (!updated) {
    return NextResponse.json({ ok: false, error: 'failed to persist data source' }, { status: 502 });
  }

  return NextResponse.json({ ok: true, dataSource: validated.dataSource });
}
