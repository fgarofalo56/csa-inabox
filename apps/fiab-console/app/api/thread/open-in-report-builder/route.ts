/**
 * POST /api/thread/open-in-report-builder — operator review 5.3:
 * "Open in Loom report builder".
 *
 * The sibling of the "Open in Power BI Desktop" (.pbids) action: instead of
 * downloading a Desktop connection file, this creates a DRAFT Loom `report`
 * item PRE-BOUND to the source (the same `state.dataSource` union the report
 * designer + report-model-resolver consume) and returns a deep link so the
 * caller navigates straight into the Loom-native report builder — already
 * wired to real data, NO Power BI / Fabric workspace required
 * (no-fabric-dependency.md).
 *
 * Binding per source type (all resolved via the SAME `resolvePbiSource`
 * coordinate resolver the Weave → Power BI edge uses):
 *   • semantic-model            → { kind:'semantic-model', itemId } (models are
 *                                 already reusable sources — bind directly).
 *   • warehouse / dedicated pool /
 *     lakehouse / mirrored-db /
 *     serverless pool           → { kind:'direct-query', target, sql } over the
 *                                 resolver's default table (the same derived
 *                                 `Query` source the app-install report
 *                                 auto-bind uses — see lib/install/
 *                                 report-binding.ts DERIVED_TABLE).
 *   • kql-database / eventhouse → { kind:'connection', connType:'adx',
 *                                 objectRef:{mode:'table'} } over a REAL Loom
 *                                 Connection (found or created, Console-MI
 *                                 auth — no secret) targeting the item's ADX
 *                                 cluster + database; the default table comes
 *                                 from the item content or a live `listTables`.
 *   • dataset (ADLS)            → { kind:'adls-file' } (serverless OPENROWSET).
 *
 * Every unresolvable backend is an HONEST gate naming the exact env var /
 * remediation (no-vaporware.md) — never a report bound to nothing.
 *
 * Body:    { from: { id, type, name? }, values?: { reportName?: string } }
 * Returns: { ok:true, reportId, link:'/items/report/<id>', linkLabel, message }
 *          | { ok:false, error, gate? }
 */

import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { apiError, apiOk, apiUnauthorized } from '@/lib/api/respond';
import { loadOwnedItem, createOwnedItem } from '../../items/_lib/item-crud';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import {
  resolvePbiSource, isPbiSourceGate, type PbiSourceBinding,
} from '@/lib/azure/pbi-source-resolver';
import { listConnections, createConnection } from '@/lib/azure/connections-store';
import { listTables } from '@/lib/azure/kusto-client';
import { recordThreadEdge } from '@/lib/thread/thread-edges';
import type { ReportContent } from '@/lib/apps/content-bundles/types';
import type { ReportDataSource } from '@/lib/editors/report/report-data-source';
import type { WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Source types the report builder can be deep-linked from (resolver-covered). */
const SOURCE_TYPES = new Set([
  'semantic-model', 'warehouse', 'synapse-dedicated-sql-pool',
  'synapse-serverless-sql-pool', 'lakehouse', 'mirrored-database',
  'kql-database', 'eventhouse', 'dataset',
]);

/** A fresh, empty single-page report body (the designer fills in visuals). */
function emptyReport(): ReportContent {
  return { kind: 'report', pages: [{ name: 'Page 1', visuals: [] }] };
}

/** Load ANY owned item by id (type-agnostic) — for the data-product recursion. */
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

/**
 * Resolve the ADX default table for a kql-database / eventhouse binding: the
 * resolver's content-derived table when present, else a LIVE `listTables`
 * against the real cluster (first table). Honest null when the database has
 * no tables yet.
 */
async function resolveAdxTable(binding: PbiSourceBinding): Promise<string | null> {
  if (binding.defaultTable) return binding.defaultTable.split('.').pop() || binding.defaultTable;
  try {
    const tables = await listTables(binding.database, binding.clusterUri ? { clusterUri: binding.clusterUri } : undefined);
    return tables[0]?.name || null;
  } catch {
    return null;
  }
}

/**
 * Find (or create) the Loom Connection the ADX report source binds through —
 * a REAL Cosmos-backed connection (Console managed identity, no secret) whose
 * host/database match the item's resolved cluster + database. Reuse first so
 * repeated deep-links never pile up duplicate connections.
 */
async function findOrCreateAdxConnection(
  session: NonNullable<ReturnType<typeof getSession>>,
  binding: PbiSourceBinding,
): Promise<{ id: string }> {
  const existing = await listConnections(session);
  const hit = existing.find((c) =>
    c.type === 'adx' &&
    (c.database || '') === binding.database &&
    (!c.host || !binding.clusterUri || c.host === binding.clusterUri),
  );
  if (hit) return { id: hit.id };
  const created = await createConnection(session, {
    name: `ADX — ${binding.database}`,
    type: 'adx',
    authMethod: 'entra-mi',
    host: binding.clusterUri,
    database: binding.database,
    description: 'Created by "Open in Loom report builder" (Console managed identity).',
  });
  return { id: created.id };
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return apiUnauthorized();
  const oid = session.claims.oid;

  const body = await req.json().catch(() => ({} as any));
  const from = body?.from || {};
  const values = (body?.values || {}) as Record<string, unknown>;

  if (!from.id || !from.type) return apiError('missing source item', 400);
  if (!SOURCE_TYPES.has(String(from.type))) {
    return apiError(
      `"${from.type}" cannot be opened in the report builder. Use a semantic model, warehouse, lakehouse, ` +
      'mirrored database, KQL database / eventhouse, or dataset.',
      400,
    );
  }

  const src = await loadOwnedItem(String(from.id), String(from.type), oid).catch(() => null);
  if (!src) return apiError('The source item was not found in your tenant.', 404);
  const fromName = String(from.name || src.displayName || from.type);
  const reportName = String(values.reportName || '').trim() || `${fromName} report`;

  try {
    // ── resolve the pre-bound data source per source type ───────────────────
    let dataSource: ReportDataSource;
    let bindingNote: string;

    if (src.itemType === 'semantic-model') {
      dataSource = { kind: 'semantic-model', itemId: src.id };
      bindingNote = `bound to the semantic model "${fromName}"`;
    } else {
      const binding = await resolvePbiSource(src, { loadItem: (id) => loadAnyOwnedItem(id, oid) });
      if (isPbiSourceGate(binding)) return apiError(binding.gate, 422, { gate: true });

      if (binding.connector === 'adx') {
        const table = await resolveAdxTable(binding);
        if (!table) {
          return apiError(
            'This KQL database has no tables to report over yet. Open it and create a table ' +
            '(New → Table) or ingest data first, then retry.',
            400,
          );
        }
        const conn = await findOrCreateAdxConnection(session, binding);
        dataSource = {
          kind: 'connection',
          connectionId: conn.id,
          connType: 'adx',
          objectRef: { mode: 'table', table },
        };
        bindingNote = `bound to ADX table "${table}" in database "${binding.database}"`;
      } else if (binding.connector === 'adls') {
        dataSource = binding.loomNativeDataSource;
        bindingNote = 'bound to the dataset\'s ADLS path (Synapse serverless OPENROWSET)';
      } else {
        // synapse-sql — the same derived-`Query` direct-query source the
        // app-install report auto-bind stamps (report-model-resolver runs it
        // inline; the designer's Fields pane introspects the real columns).
        const seed = binding.loomNativeDataSource as ReportDataSource & { sql?: string };
        if (seed.kind !== 'direct-query' || !seed.sql) {
          return apiError(
            `No default table could be resolved on "${fromName}" to pre-bind the report. Open the item, ` +
            'create/register a table first, or use Weave → "Build a report" to pick a table or SQL query.',
            400,
          );
        }
        dataSource = seed;
        bindingNote = `bound to a direct query over ${binding.defaultTable ? `table "${binding.defaultTable}"` : 'the source'} (Synapse ${seed.target === 'lakehouse' ? 'serverless' : 'dedicated'})`;
      }
    }

    // ── create the DRAFT report item, pre-bound ──────────────────────────────
    const created = await createOwnedItem(session, 'report', {
      workspaceId: src.workspaceId,
      displayName: reportName,
      description: `Draft report on "${fromName}" — created by "Open in Loom report builder".`,
      state: { dataSource, content: emptyReport(), sourceItemId: src.id },
    });
    if (!created.ok) return apiError(created.error, created.status);
    const reportId = created.item.id;

    await recordThreadEdge(session, {
      fromItemId: src.id, fromType: src.itemType, fromName,
      toItemId: reportId, toType: 'report', toName: reportName,
      toLink: `/items/report/${reportId}`, action: 'open-in-report-builder',
    });

    return apiOk({
      reportId,
      link: `/items/report/${reportId}`,
      linkLabel: 'Open the report builder',
      message: `Created draft report "${reportName}" ${bindingNote}. It opens in the Loom report builder pre-bound — drag fields onto visuals to render real rows.`,
    });
  } catch (e: any) {
    const status = Number.isInteger(e?.status) ? e.status : 500;
    return apiError(e?.message || String(e), status);
  }
}
