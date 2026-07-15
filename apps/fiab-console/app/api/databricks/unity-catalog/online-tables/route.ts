/**
 * Unity Catalog ONLINE TABLES (Feature Store serving) — DBX-14.
 *
 *   GET    /api/databricks/unity-catalog/online-tables?name=<3-part>  → { ok, onlineTable }
 *   GET    /api/databricks/unity-catalog/online-tables?catalog=&schema=
 *                                                        → { ok, sources[] }  (candidate source tables)
 *   POST   /api/databricks/unity-catalog/online-tables               → create
 *            { name, sourceTableFullName, primaryKeyColumns[], timeseriesKey?, runMode, performFullCopy? }
 *   DELETE /api/databricks/unity-catalog/online-tables?name=<3-part>  → delete
 *
 * An online table gives lower-latency, higher-QPS access to a UC Delta/feature
 * table for real-time feature lookup. Real Databricks REST (/api/2.0/online-
 * tables). Honest gate when Databricks is unconfigured or at the GCC-High / DoD
 * boundary (Online Tables are a Unity Catalog feature; the Gov OSS-UC / Hive
 * path has no online-table serving).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { databricksConfigGate } from '@/lib/azure/databricks-client';
import { isGovCloud, cloudBoundaryLabel } from '@/lib/azure/cloud-endpoints';
import {
  primaryWorkspaceHost,
  listTables,
  createOnlineTable,
  getOnlineTable,
  deleteOnlineTable,
  UnityCatalogError,
  type OnlineTableRunMode,
} from '@/lib/azure/unity-catalog-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Gate { gated: true; error: string }

function resolveGate(): Gate | null {
  const cfg = databricksConfigGate();
  if (cfg) {
    return { gated: true, error: `Databricks is not configured in this deployment. Set ${cfg.missing} on the Console (landing-zone bicep deploys the Databricks workspace).` };
  }
  if (isGovCloud()) {
    return {
      gated: true,
      error:
        `Unity Catalog Online Tables are not available at the ${cloudBoundaryLabel()} boundary. ` +
        `They require a Commercial or GCC Databricks account with a Microsoft Entra-connected Unity Catalog metastore. ` +
        `At this boundary, serve features from the Lakebase Postgres (lakebase-postgres) item instead.`,
    };
  }
  return null;
}

function fail(e: any) {
  const status = e instanceof UnityCatalogError ? (e.status || 400) : (e?.status || 502);
  return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
}

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const gate = resolveGate();
  if (gate) return NextResponse.json({ ok: false, gated: true, error: gate.error }, { status: 200 });

  const sp = req.nextUrl.searchParams;
  let host: string;
  try {
    host = await primaryWorkspaceHost();
  } catch (e: any) {
    return NextResponse.json({ ok: false, gated: true, error: e?.message || String(e) }, { status: 200 });
  }

  try {
    const name = sp.get('name')?.trim();
    if (name) {
      const onlineTable = await getOnlineTable(host, name);
      return NextResponse.json({ ok: true, onlineTable });
    }
    // Source-table picker: list candidate Delta tables in a schema.
    const catalog = sp.get('catalog')?.trim();
    const schema = sp.get('schema')?.trim();
    if (catalog && schema) {
      const sources = await listTables(host, catalog, schema);
      return NextResponse.json({ ok: true, sources });
    }
    return NextResponse.json(
      { ok: false, error: 'Provide ?name=<catalog.schema.table> for one online table, or ?catalog=&schema= to list source tables.' },
      { status: 400 },
    );
  } catch (e: any) {
    return fail(e);
  }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const gate = resolveGate();
  if (gate) return NextResponse.json({ ok: false, gated: true, error: gate.error }, { status: 200 });

  let host: string;
  try {
    host = await primaryWorkspaceHost();
  } catch (e: any) {
    return NextResponse.json({ ok: false, gated: true, error: e?.message || String(e) }, { status: 200 });
  }

  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 }); }

  const runModeRaw = String(body?.runMode || 'triggered').toLowerCase();
  const runMode: OnlineTableRunMode = runModeRaw === 'continuous' ? 'continuous' : 'triggered';
  const primaryKeyColumns = Array.isArray(body?.primaryKeyColumns)
    ? body.primaryKeyColumns.map((c: any) => String(c || '').trim()).filter(Boolean)
    : [];

  try {
    const onlineTable = await createOnlineTable(host, {
      name: String(body?.name || '').trim(),
      sourceTableFullName: String(body?.sourceTableFullName || '').trim(),
      primaryKeyColumns,
      timeseriesKey: body?.timeseriesKey ? String(body.timeseriesKey).trim() : undefined,
      runMode,
      performFullCopy: body?.performFullCopy === true,
    });
    return NextResponse.json({ ok: true, onlineTable, createdBy: session.claims.upn });
  } catch (e: any) {
    return fail(e);
  }
}

export async function DELETE(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const gate = resolveGate();
  if (gate) return NextResponse.json({ ok: false, gated: true, error: gate.error }, { status: 200 });

  const name = req.nextUrl.searchParams.get('name')?.trim();
  if (!name) return NextResponse.json({ ok: false, error: 'name is required' }, { status: 400 });

  let host: string;
  try {
    host = await primaryWorkspaceHost();
  } catch (e: any) {
    return NextResponse.json({ ok: false, gated: true, error: e?.message || String(e) }, { status: 200 });
  }

  try {
    await deleteOnlineTable(host, name);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return fail(e);
  }
}
