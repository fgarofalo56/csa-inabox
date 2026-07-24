/**
 * GET /api/items/activation-sync/[id]/schema
 *   ?container=&path=            → { sourceColumns: [{name,type}] } via DuckDB delta_scan
 *   ?envId=&logicalName=         → { targetFields: [{name,label,type}] } via Dataverse schema
 *
 * Powers the field-mapping dropdowns (loom_no_freeform_config): the editor
 * picks a source column and a destination field from real, live schemas — never
 * a freeform text box. Owner-scoped; honest gates when a backend is unset.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { jerr, loadOwnedItem } from '../../../_lib/item-crud';
import { duckdbQueryJson, isDuckDbConfigured, buildLakeScanSql } from '@/lib/azure/duckdb-client';
import { getAccountName } from '@/lib/azure/adls-client';
import { getTableSchema, dataverseConfigGate } from '@/lib/azure/powerplatform-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'activation-sync';

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return jerr('unauthenticated', 401);
  const { id } = await ctx.params;
  const item = await loadOwnedItem(id, ITEM_TYPE, session.claims.oid, { allowReadRoles: true });
  if (!item) return jerr('not found', 404);

  const url = new URL(req.url);
  const container = url.searchParams.get('container')?.trim();
  const path = url.searchParams.get('path')?.trim();
  const envId = url.searchParams.get('envId')?.trim();
  const logicalName = url.searchParams.get('logicalName')?.trim();

  const out: Record<string, unknown> = { ok: true };

  // ── Source columns (DuckDB delta_scan) ──────────────────────────────────
  if (container && path) {
    if (!isDuckDbConfigured()) {
      out.sourceError = 'The DuckDB serving tier is not deployed (set LOOM_DUCKDB_URL) — source columns cannot be read.';
      out.sourceMissing = 'LOOM_DUCKDB_URL';
    } else {
      try {
        const sql = buildLakeScanSql(getAccountName(), { container, path, format: 'delta', limit: 1 });
        const body = await duckdbQueryJson(sql, 1);
        out.sourceColumns = (body.columns || []).map((c) => ({ name: c.name, type: c.type || '' }));
      } catch (e: any) {
        out.sourceError = e?.message || String(e);
      }
    }
  }

  // ── Dataverse target fields (attribute schema) ──────────────────────────
  if (envId && logicalName) {
    const gate = dataverseConfigGate();
    if (gate) {
      out.targetError = `Dataverse is not configured: set ${gate.missing}.`;
      out.targetMissing = gate.missing;
    } else {
      try {
        const attrs = await getTableSchema(envId, logicalName);
        out.targetFields = attrs
          .filter((a) => a.AttributeType && a.AttributeType !== 'Virtual')
          .map((a) => ({
            name: a.LogicalName,
            label: a.DisplayName?.UserLocalizedLabel?.Label || a.LogicalName,
            type: a.AttributeType || '',
            isPrimaryId: !!a.IsPrimaryId,
          }));
      } catch (e: any) {
        // Surface the Dataverse error inline (200) so the mapping panel can show
        // it without failing the whole schema fetch (source columns may still be present).
        out.targetError = e?.message || String(e);
      }
    }
  }

  return NextResponse.json(out);
}
