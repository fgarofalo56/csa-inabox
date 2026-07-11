/**
 * GET /api/items/[type]/[id]/pbi-source — resolve a Loom item to a Power BI
 * source binding for the report / paginated-report / semantic-model source
 * pickers (Weave → Power BI, W2).
 *
 * This is the BFF helper behind the "Pick a Loom item" data-source flow: given
 * ANY Power BI-sourceable Loom item (lakehouse / warehouse / eventhouse /
 * kql-database / mirrored-database / dataset / semantic-model / data-product /
 * the paired serverless / dedicated SQL-pool items), it runs the W1 resolver
 * (`lib/azure/pbi-source-resolver.ts`) and returns:
 *   • `binding`     — the normalized Azure-native coordinates (connector, SQL
 *                     FQDN / ADX cluster URI, database, defaultTable, PE flag).
 *   • `dataSource`  — a ready-to-persist `ReportDataSource` seed for the report
 *                     designer's `state.dataSource` (the picker never asks the
 *                     user to type a server / database / SQL). Mirrors the report
 *                     branch of `/api/thread/analyze-in-powerbi` (semantic-model
 *                     → model ref; ADLS → adls-file; Synapse → direct-query with
 *                     the resolver's canned SELECT). `null` when the item can be
 *                     resolved but is not directly report-bindable (see
 *                     `reportGate`).
 *   • `reportGate`  — an HONEST note (Fluent MessageBar) when the resolved source
 *                     is real but not directly bindable to an interactive report
 *                     in this release (eventhouse / KQL → wire via a Dashboard;
 *                     a Synapse source with no discoverable default table → enter
 *                     a Direct query). Never a mock (no-vaporware.md).
 *   • `preview`     — REAL columns introspected from the source (Synapse: a
 *                     `TOP` read over the resolved SELECT; ADX: the eventhouse's
 *                     own table schema). Omitted when a live read isn't possible
 *                     without a bound report (ADLS / dataset) — the designer's
 *                     own `/fields` previews those once the report is saved.
 *
 * When the resolver returns an honest gate (unresolvable coordinates — e.g.
 * LOOM_SYNAPSE_WORKSPACE unset) this returns 422 `{ ok:false, error, gate:true }`
 * so the picker surfaces the exact remediation verbatim.
 *
 * Route-guard: session-gated + `loadOwnedItem` on the source (the caller must own
 * it in their tenant). The `data-product` path additionally resolves its
 * referenced lakehouse / warehouse via a type-agnostic owned-item loader.
 *
 * Rules: no-fabric-dependency (every coordinate is Azure-native — no
 * api.fabric.microsoft.com / api.powerbi.com host is touched), no-vaporware
 * (real introspection or an honest gate — never a fabricated column list),
 * bff-errors (structured `{ok,…}` JSON via lib/api/respond).
 */

import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem } from '../../../_lib/item-crud';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import { apiError, apiOk, apiUnauthorized } from '@/lib/api/respond';
import {
  resolvePbiSource,
  isPbiSourceGate,
  type PbiSourceBinding,
} from '@/lib/azure/pbi-source-resolver';
import { executeQuery, type SynapseTarget } from '@/lib/azure/synapse-sql-client';
import { isSqlLoginFailure } from '@/lib/azure/sql-login-gate';
import { bracket } from '@/lib/sql/quoting';
import type { ReportDataSource } from '@/lib/editors/report/report-data-source';
import type { WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PREVIEW_ROWS = 50;

/** A resolved column (name + best-effort type) shown in the picker's preview. */
interface PreviewColumn { name: string; dataType: string }

/** Load ANY owned item by id (type-agnostic) for the data-product recursion. */
async function loadAnyOwnedItem(id: string, oid: string): Promise<WorkspaceItem | null> {
  const items = await itemsContainer();
  const { resources } = await items.items
    .query<WorkspaceItem>({
      query: 'SELECT c.id, c.itemType FROM c WHERE c.id = @id',
      parameters: [{ name: '@id', value: id }],
    })
    .fetchAll();
  const hit = resources[0];
  if (!hit?.itemType) return null;
  return loadOwnedItem(id, hit.itemType, oid);
}

/** Live TDS target from the resolved binding's server + database. */
function synapseTargetFor(binding: PbiSourceBinding): SynapseTarget {
  return {
    server: binding.server!,
    database: binding.database,
    cacheKey: `pbi-preview:${binding.server}:${binding.database}`,
  };
}

/** The effective read the picker previews + seeds: the resolver's canned SELECT
 *  when present, else a `SELECT TOP * FROM [schema].[table]` over the default table. */
function effectiveSelect(binding: PbiSourceBinding): string | null {
  const seed = binding.loomNativeDataSource as { sql?: string };
  const seedSql = typeof seed?.sql === 'string' ? seed.sql.trim() : '';
  if (seedSql) return seedSql;
  const table = (binding.defaultTable || '').trim();
  if (!table) return null;
  const parts = table.includes('.') ? table.split('.') : ['dbo', table];
  const t = (parts.pop() as string).replace(/[[\]]/g, '');
  const schema = (parts.pop() || 'dbo').replace(/[[\]]/g, '');
  return `SELECT TOP 1000 * FROM ${bracket(schema)}.${bracket(t)}`;
}

/** Introspect REAL columns for a Synapse SELECT (best-effort — omitted on gate). */
async function synapsePreview(
  binding: PbiSourceBinding,
  select: string,
): Promise<{ columns: PreviewColumn[] } | { gate: string }> {
  const target = synapseTargetFor(binding);
  try {
    const res = await executeQuery(target, `SELECT TOP ${PREVIEW_ROWS} * FROM (\n${select}\n) AS loom_q`);
    const columns: PreviewColumn[] = res.columns.map((c: any) => ({
      name: String(c?.name ?? c ?? '').trim(),
      dataType: String(c?.type ?? c?.dataType ?? 'string'),
    })).filter((c) => c.name);
    return { columns };
  } catch (e: any) {
    if (isSqlLoginFailure(e)) {
      return {
        gate:
          `Could not read a live column preview from ${target.server} / ${target.database}: the Console identity ` +
          'is not yet a SQL login on this endpoint. The source is still bindable — bind it and grant access, or ' +
          'preview it from the report designer once saved.',
      };
    }
    return { gate: `Could not read a live column preview: ${e?.message || String(e)}` };
  }
}

/** ADX columns from the eventhouse / kql-database item's own content (no network). */
function adxPreviewFromContent(src: WorkspaceItem): PreviewColumn[] {
  const content = (src.state?.content ?? {}) as Record<string, unknown>;
  const tables = Array.isArray(content.tables) ? (content.tables as Array<Record<string, unknown>>) : [];
  const first = tables[0];
  const cols = first && Array.isArray(first.columns) ? (first.columns as Array<Record<string, unknown>>) : [];
  return cols
    .map((c) => ({ name: String(c.name || '').trim(), dataType: String(c.type || c.dataType || 'string') }))
    .filter((c) => c.name);
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ type: string; id: string }> }) {
  const session = getSession();
  if (!session) return apiUnauthorized();
  const oid = session.claims.oid;

  const { type, id } = await ctx.params;
  if (!type || !id) return apiError('missing item type / id', 400);

  const src = await loadOwnedItem(id, type, oid).catch(() => null);
  if (!src) return apiError('The source item was not found in your tenant.', 404);

  const binding = await resolvePbiSource(src, { loadItem: (rid) => loadAnyOwnedItem(rid, oid) });
  if (isPbiSourceGate(binding)) {
    return apiError(binding.gate, 422, { gate: true });
  }

  const sourceLabel = String(src.displayName || src.itemType);
  const bindingOut = {
    connector: binding.connector,
    server: binding.server,
    clusterUri: binding.clusterUri,
    database: binding.database,
    defaultTable: binding.defaultTable,
    behindPrivateEndpoint: binding.behindPrivateEndpoint,
    sourceItemId: binding.sourceItemId,
    sourceType: src.itemType,
    sourceLabel,
  };

  // ── Map the binding → a report-bindable ReportDataSource (mirrors the report
  //    branch of /api/thread/analyze-in-powerbi) + a REAL column preview. ──────
  let dataSource: ReportDataSource | null = null;
  let reportGate: string | undefined;
  let preview: { columns: PreviewColumn[] } | undefined;
  let previewGate: string | undefined;

  if (src.itemType === 'semantic-model') {
    // A report binds directly to the model item (no server coords needed).
    dataSource = { kind: 'semantic-model', itemId: src.id };
  } else if (binding.connector === 'adls') {
    // Serverless OPENROWSET over the resolved ADLS path (adls-file seed).
    dataSource = binding.loomNativeDataSource;
  } else if (binding.connector === 'adx') {
    // Interactive reports over an eventhouse / KQL database are wired via a
    // Dashboard in this release — surface the honest note, still show columns.
    reportGate =
      'Interactive reports over an eventhouse / KQL database are wired via a Dashboard in this release. ' +
      'Use Weave → “Analyze in Power BI” and pick “Dashboard” (real-time ADX tile), or “Semantic model” to ' +
      'build a reusable model. The columns below are read from this eventhouse.';
    const columns = adxPreviewFromContent(src);
    if (columns.length) preview = { columns };
  } else if (binding.connector === 'synapse-sql') {
    const select = effectiveSelect(binding);
    if (!select) {
      reportGate =
        'This source has no discoverable default table. Bind it, then open the report’s Direct query source and ' +
        'enter a read-only SELECT (or pick a specific table) to preview real rows.';
    } else {
      // Seed the report with the resolver's direct-query seed, pinned to the
      // effective SELECT (identical shape to the analyze-in-powerbi report path).
      const base = binding.loomNativeDataSource as unknown as Record<string, unknown>;
      dataSource = { ...(base as any), sql: select } as ReportDataSource;
      const pv = await synapsePreview(binding, select);
      if ('gate' in pv) previewGate = pv.gate;
      else if (pv.columns.length) preview = { columns: pv.columns };
    }
  } else {
    reportGate =
      `“${src.itemType}” resolved to a ${binding.connector} backend that is not directly report-bindable in this ` +
      'release. Use Weave → “Analyze in Power BI” to build a semantic model or dashboard over it.';
  }

  return apiOk({
    binding: bindingOut,
    dataSource,
    ...(reportGate ? { reportGate } : {}),
    ...(preview ? { preview } : {}),
    ...(previewGate ? { previewGate } : {}),
  });
}
