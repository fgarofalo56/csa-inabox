/**
 * POST /api/thread/materialize-to-kql — Loom Thread (Weave) edge.
 *
 * From a `lakehouse`, bind one of its ADLS Gen2 Delta tables to an Azure Data
 * Explorer (ADX) EXTERNAL TABLE in a target Loom `kql-database` / `eventhouse`,
 * so the Delta data is queryable with KQL — the Azure-native "lakehouse → KQL"
 * bridge. Real ADX management command
 * (`.create-or-alter external table … kind=delta`, storage auth via the
 * cluster's system-assigned MI) + optional query-acceleration policy for
 * sub-second reads. NO Fabric RTI Eventhouse required (no-fabric-dependency.md);
 * NO mock (no-vaporware.md).
 *
 * Honest gates: `LOOM_KUSTO_CLUSTER_URI` unset → 503 naming it; no lakehouse
 * storage configured → 503; a KustoError (401/403 = UAMI needs AllDatabasesAdmin
 * / cluster MI needs Storage Blob Data Reader on the ADLS account) surfaces
 * verbatim with its status.
 *
 * Body: { from:{id,type,name}, values:{ table:'name|adlsPath', kqlDatabaseId, accelerate? } }
 * Returns: { ok, message, externalTable, database, link, linkLabel } | { ok:false, error }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem } from '../../items/_lib/item-crud';
import { recordThreadEdge } from '@/lib/thread/thread-edges';
import { resolveLakehouseAbfss } from '@/lib/azure/lakehouse-abfss';
import {
  createExternalDeltaTable,
  setQueryAccelerationPolicy,
  kustoConfigGate,
  defaultDatabase,
  KustoError,
} from '@/lib/azure/kusto-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Default hot-cache window (days) when query acceleration is enabled. */
const ACCEL_HOT_DAYS = 7;

function bad(error: string, status = 400) {
  return NextResponse.json({ ok: false, error }, { status });
}

/** ADX identifier from a free string (letters/digits/underscore; never empty). */
function adxIdent(s: string): string {
  const cleaned = String(s).replace(/[^A-Za-z0-9_]/g, '_').replace(/^_+|_+$/g, '');
  return cleaned || 'loom';
}

/**
 * The ADX database name backing a Loom kql-database / eventhouse item. Prefers a
 * name the provisioner stamped in state; else derives it exactly as the kql-db
 * provisioner does (sanitized displayName, ≤50 chars); else the env default.
 */
function kqlDatabaseName(item: { displayName: string; state?: unknown }): string {
  const state = (item.state as Record<string, any>) || {};
  const stamped =
    (typeof state.databaseName === 'string' && state.databaseName.trim()) ||
    (typeof state.provisioning?.secondaryIds?.database === 'string' && state.provisioning.secondaryIds.database.trim()) ||
    '';
  if (stamped) return stamped;
  const derived = String(item.displayName || '').replace(/[^A-Za-z0-9_]/g, '_').slice(0, 50);
  return derived || defaultDatabase() || 'loomdb';
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return bad('unauthenticated', 401);
  const oid = session.claims.oid;

  const body = await req.json().catch(() => ({} as any));
  const from = body?.from || {};
  const values = body?.values || {};
  const tableSel = String(values.table || '').trim();
  const kqlDatabaseId = String(values.kqlDatabaseId || '').trim();
  const accelerate = values.accelerate !== false; // default on

  if (from.type !== 'lakehouse' || !from.id) return bad('this edge is for lakehouse items', 400);
  if (!tableSel) return bad('pick a Delta table', 400);
  if (!kqlDatabaseId) return bad('pick a KQL database', 400);

  // Honest infra gate: no ADX cluster configured.
  const gate = kustoConfigGate();
  if (gate) {
    return NextResponse.json(
      {
        ok: false,
        gate,
        error:
          `Azure Data Explorer is not configured in this deployment. Set ${gate.missing} (an ADX cluster ` +
          `deployed by platform/fiab/bicep) to materialize lakehouse Delta tables to KQL.`,
      },
      { status: 503 },
    );
  }

  // Load both endpoints owner-scoped.
  const lake = await loadOwnedItem(from.id, from.type, oid, { allowReadRoles: true });
  if (!lake) return bad('lakehouse not found', 404);
  let kqlItem = await loadOwnedItem(kqlDatabaseId, 'kql-database', oid, { allowReadRoles: true });
  if (!kqlItem) kqlItem = await loadOwnedItem(kqlDatabaseId, 'eventhouse', oid, { allowReadRoles: true });
  if (!kqlItem) return bad('KQL database not found', 404);

  // Resolve the lakehouse's REAL ADLS root, then the Delta table's abfss folder.
  const root = await resolveLakehouseAbfss(from.id, lake.workspaceId);
  if (!root) {
    return NextResponse.json(
      {
        ok: false,
        gate: { missing: 'LOOM_{BRONZE,SILVER,GOLD,LANDING}_URL' },
        error:
          'No lakehouse storage configured — set LOOM_{BRONZE,SILVER,GOLD,LANDING}_URL and grant the ' +
          'Console UAMI Storage Blob Data Reader on the container.',
      },
      { status: 503 },
    );
  }
  const tableName = tableSel.split('|')[0]?.trim();
  if (!tableName) return bad('invalid table selection', 400);
  const abfssUri = `${root.abfss.replace(/\/+$/, '')}/Tables/${tableName}`;

  const db = kqlDatabaseName(kqlItem);
  const extName = adxIdent(`${lake.displayName}_${tableName}`).slice(0, 100);

  // Bind the Delta table as an ADX external table (real mgmt command).
  try {
    await createExternalDeltaTable(db, extName, abfssUri, {
      folder: 'Lakehouse (Weave)',
      docString: `Weaved from lakehouse "${lake.displayName}" table ${tableName}.`,
    });
  } catch (e: any) {
    if (e instanceof KustoError) {
      const status = e.status && e.status >= 400 && e.status < 600 ? e.status : 502;
      const hint =
        status === 401 || status === 403
          ? ' The Console UAMI needs AllDatabasesAdmin on the ADX cluster, and the cluster’s managed identity needs Storage Blob Data Reader on the ADLS account.'
          : '';
      return NextResponse.json({ ok: false, error: `${e.message}${hint}` }, { status });
    }
    return bad(`Could not create the ADX external table: ${e?.message || String(e)}`, 502);
  }

  // Optional query acceleration (best-effort — the external table already works
  // without it; a failure here is reported but not fatal).
  let accelerated = false;
  let accelNote = '';
  if (accelerate) {
    try {
      await setQueryAccelerationPolicy(db, extName, ACCEL_HOT_DAYS);
      accelerated = true;
    } catch (e: any) {
      accelNote = ` (query acceleration could not be enabled: ${e?.message || String(e)} — the external table still queries the Delta files directly)`;
    }
  }

  await recordThreadEdge(session, {
    fromItemId: from.id,
    fromType: from.type,
    fromName: from.name || lake.displayName,
    toItemId: kqlItem.id,
    toType: kqlItem.itemType,
    toName: kqlItem.displayName,
    toLink: `/items/${kqlItem.itemType}/${kqlItem.id}`,
    action: 'materialize-to-kql',
  });

  return NextResponse.json({
    ok: true,
    externalTable: extName,
    database: db,
    accelerated,
    message:
      `Bound lakehouse table "${tableName}" to ADX external table ["${extName}"] in database "${db}"` +
      `${accelerated ? ' with query acceleration on' : ''}. Query it with KQL: external_table("${extName}") | take 100.${accelNote}`,
    link: `/items/${kqlItem.itemType}/${kqlItem.id}`,
    linkLabel: `Open ${kqlItem.itemType === 'eventhouse' ? 'the Eventhouse' : 'the KQL database'}`,
  });
}
