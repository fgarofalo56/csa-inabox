/**
 * GET /api/items/report/[id]/fields
 *
 * Returns the tabular-model SCHEMA (tables → columns[] + measures[]) that backs
 * this report so the Loom-native report DESIGNER can populate its Fields pane
 * and let the author drag columns/measures into a visual's field wells.
 *
 * Azure-native default (no-fabric-dependency.md): the schema is read from the
 * report's bound Azure Analysis Services tabular model via the real TMSCHEMA
 * Discover rowsets (`readModel()` — same XMLA transport the model/column editor
 * uses). NO Power BI / Fabric workspace required. No mock data — when the model
 * can't be reached the route returns an honest 412 gate naming the exact env
 * var / item-state binding to set.
 *
 * Binding resolution mirrors the /query route: per-item `state.aasServer` /
 * `state.aasDatabase` first, then the platform `LOOM_AAS_SERVER` /
 * `LOOM_AAS_DATABASE` defaults. `readModel()` additionally needs an XMLA
 * endpoint (`LOOM_AAS_SERVER_URL`, asazure://…) — surfaced in the gate when
 * absent.
 *
 * 200 OK → { ok: true, aasServer, aasDatabase, database, tables: FieldTable[] }
 * 412    → { ok: false, code: 'unbound', error } (honest, actionable)
 * 4xx/5xx→ { ok: false, error, status? }
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { readModel, resolveAasBinding, AasError } from '@/lib/azure/aas-client';
import { loadModelItem } from '@/lib/azure/model-binding';
import {
  isLoomContentId,
  cosmosIdFromLoomId,
  loadContentBackedItem,
} from '../../../_lib/pbi-content-fallback';
import type { WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** One model column surfaced to the Fields pane. */
export interface FieldColumn {
  name: string;
  dataType: string;
  /** Default summarization hint (Sum/Count/None…) from the model. */
  summarizeBy?: string;
  isHidden: boolean;
}
/** One model measure surfaced to the Fields pane. */
export interface FieldMeasure {
  name: string;
  isHidden: boolean;
}
/** A table node in the Fields tree. */
export interface FieldTable {
  name: string;
  columns: FieldColumn[];
  measures: FieldMeasure[];
}

function stateBinding(item: WorkspaceItem): { server?: string; database?: string } {
  const state = (item.state || {}) as Record<string, unknown>;
  return {
    server: typeof state.aasServer === 'string' ? state.aasServer : undefined,
    database: typeof state.aasDatabase === 'string' ? state.aasDatabase : undefined,
  };
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const id = (await ctx.params).id;

  // Load the report item (loom: content id OR plain Cosmos id), owner-checked.
  let item: WorkspaceItem | null;
  if (isLoomContentId(id)) {
    item = await loadContentBackedItem(cosmosIdFromLoomId(id), 'report', session.claims.oid);
    if (!item) return NextResponse.json({ ok: false, error: 'report template not found' }, { status: 404 });
  } else {
    item = await loadModelItem(id, 'report', session.claims.oid);
    if (!item) return NextResponse.json({ ok: false, error: 'report item not found' }, { status: 404 });
  }

  const { server, database } = stateBinding(item);
  const binding = resolveAasBinding(server, database);
  if (!binding) {
    return NextResponse.json(
      {
        ok: false,
        code: 'unbound',
        error:
          'This report item has no Azure Analysis Services binding. Set state.aasServer ' +
          '(XMLA URI, e.g. asazure://eastus2.asazure.windows.net/my-server) + state.aasDatabase ' +
          'on the item, or configure LOOM_AAS_SERVER + LOOM_AAS_DATABASE environment variables ' +
          '(admin-plane/main.bicep). The Console UAMI must be a server admin on the AAS instance.',
      },
      { status: 412 },
    );
  }

  try {
    // Real TMSCHEMA Discover against the bound model — no mock.
    const tables = await readModel(binding.database);
    const out: FieldTable[] = tables.map((t) => ({
      name: t.name,
      columns: (t.columns || [])
        // Hide RowNumber/internal columns; keep author-relevant fields.
        .filter((c) => !c.isHidden)
        .map((c) => ({
          name: c.name,
          dataType: String(c.dataType || 'string'),
          summarizeBy: c.summarizeBy ? String(c.summarizeBy) : undefined,
          isHidden: !!c.isHidden,
        })),
      measures: (t.measures || [])
        .filter((m) => !m.isHidden)
        .map((m) => ({ name: m.name, isHidden: !!m.isHidden })),
    }))
    // Drop tables that have nothing the author can bind.
    .filter((t) => t.columns.length > 0 || t.measures.length > 0);

    return NextResponse.json({
      ok: true,
      aasServer: server || process.env.LOOM_AAS_SERVER || null,
      aasDatabase: binding.database,
      database: binding.database,
      tables: out,
    });
  } catch (e: any) {
    // readModel() throws AasError(412) when no XMLA endpoint is configured.
    if (e instanceof AasError && e.status === 412) {
      return NextResponse.json(
        {
          ok: false,
          code: 'unbound',
          error:
            'The Fields pane reads the model schema over XMLA. Set LOOM_AAS_SERVER_URL to the ' +
            'AAS XMLA endpoint of the bound model (e.g. asazure://eastus2.asazure.windows.net/my-server) ' +
            'so the designer can list tables, columns and measures. The Console UAMI must be a server ' +
            'admin on that AAS instance.',
        },
        { status: 412 },
      );
    }
    const status = e instanceof AasError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), status }, { status });
  }
}
