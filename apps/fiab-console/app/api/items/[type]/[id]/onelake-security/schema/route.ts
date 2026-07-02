/**
 * OneLake Security — table + column INTROSPECTION for the Row/Column-security
 * authoring dialogs (the guided RLS predicate builder's column dropdown + the
 * CLS checkbox grid).
 *
 *   GET /api/items/[type]/[id]/onelake-security/schema
 *       → { ok, tables: [{ schema, name, label, status }] }
 *         The REAL Delta tables under each configured medallion container's
 *         `Tables/` dir (synapse-catalog-client.scanLakehouseTables). `schema`
 *         is the container (bronze|silver|gold|landing) — it is the first part
 *         of the `schema.name` key the rls/cls routes split via splitSchemaTable.
 *
 *   GET /api/items/[type]/[id]/onelake-security/schema?table=<schema.name>
 *       → { ok, columns: [{ name, type }] }
 *         The columns of ONE table, read straight from its Delta transaction log
 *         (`_delta_log/0.json` → metaData.schemaString) via the SAME ADLS read +
 *         pure parser the Notebook Copilot grounding uses (delta-schema). No
 *         Spark session, no Synapse pool.
 *
 * REUSE, not new introspection: this is a thin adapter over the existing
 * scanLakehouseTables + downloadFile + parseDeltaSchema. There was no item-level
 * tables+columns route (connector-objects is report-scoped and stops at the
 * table level, returning no columns), so this is the minimal GET that the
 * dialogs need — nothing more.
 *
 * Azure-native (no-fabric): every read is an ADLS Gen2 data-plane call via the
 * Console UAMI; NO Fabric / OneLake host is reached. no-vaporware: a deployment
 * with no lakehouse storage configured returns an honest `gate` (200, empty
 * arrays) naming the env var to set — never a mock table/column. Session-gated +
 * PDP-read-checked exactly like the sibling [role]/rls + [role]/cls routes.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { pdpCheck } from '@/lib/auth/pdp/enforce';
import { KNOWN_CONTAINERS } from '@/lib/azure/adls-client';
import { downloadFile } from '@/lib/azure/adls-client';
import { scanLakehouseTables } from '@/lib/azure/synapse-catalog-client';
import { parseDeltaSchema } from '@/lib/azure/delta-schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPES = ['lakehouse', 'mirrored-database', 'mirrored-catalog'];

/** Honest gate string when no lakehouse storage is wired (no-vaporware). */
const STORAGE_GATE =
  'No lakehouse storage configured — set LOOM_{BRONZE,SILVER,GOLD,LANDING}_URL ' +
  '(deployed by the DLZ Bicep) and grant the Console UAMI Storage Blob Data ' +
  'Reader on the container.';

/** True when at least one medallion container URL is configured. */
function anyStorageConfigured(): boolean {
  return (KNOWN_CONTAINERS as readonly string[]).some(
    (c) => !!process.env[`LOOM_${c.toUpperCase()}_URL`],
  );
}

/** Split a `schema.name` (or bare `name`) key into its container + table parts. */
function splitTableKey(key: string): { container: string; name: string } {
  const t = String(key || '').trim();
  const dot = t.indexOf('.');
  if (dot < 0) return { container: '', name: t };
  return { container: t.slice(0, dot), name: t.slice(dot + 1) };
}

export async function GET(req: NextRequest, props: { params: Promise<{ type: string; id: string }> }) {
  const params = await props.params;
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  if (!ITEM_TYPES.includes(params.type)) {
    return NextResponse.json({ ok: false, error: `unsupported item type: ${params.type}` }, { status: 400 });
  }
  const blocked = await pdpCheck(session, { level: 'item', id: params.id, itemType: params.type }, 'read');
  if (blocked) return blocked;

  const tableKey = req.nextUrl.searchParams.get('table')?.trim() || '';

  // Honest infra-gate — no crash, no mock; empty arrays + actionable `gate`.
  if (!anyStorageConfigured()) {
    return NextResponse.json({ ok: true, tables: [], columns: [], gate: STORAGE_GATE });
  }

  try {
    // ── Columns of one table (CLS grid + RLS column dropdown) ──────────────
    if (tableKey) {
      const { container, name } = splitTableKey(tableKey);
      if (!container || !name) {
        return NextResponse.json({ ok: false, error: 'table must be "<container>.<name>"' }, { status: 400 });
      }
      if (!(KNOWN_CONTAINERS as readonly string[]).includes(container)) {
        return NextResponse.json({ ok: false, error: `unknown container "${container}"` }, { status: 400 });
      }
      try {
        const { body } = await downloadFile(container, `Tables/${name}/_delta_log/00000000000000000000.json`);
        const fields = parseDeltaSchema(body.toString('utf-8'));
        return NextResponse.json({ ok: true, columns: fields.map((f) => ({ name: f.name, type: f.type })) });
      } catch (e: any) {
        // Table's Delta log unreadable (no _delta_log, or identity lacks Reader)
        // → honest empty, not a 500. The dialog renders an empty-state.
        return NextResponse.json({ ok: true, columns: [], note: e?.message || String(e) });
      }
    }

    // ── Table list (default) ────────────────────────────────────────────────
    const tables = await scanLakehouseTables({});
    return NextResponse.json({
      ok: true,
      tables: tables
        .filter((t) => t.status !== 'broken')
        .map((t) => ({ schema: t.schema, name: t.name, label: `${t.schema}.${t.name}`, status: t.status })),
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e?.status || 502 });
  }
}
