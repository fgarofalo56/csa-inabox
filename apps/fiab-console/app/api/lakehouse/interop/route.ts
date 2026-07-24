/**
 * N1 — lakehouse Delta↔Iceberg INTEROP BFF.
 *
 *   GET /api/lakehouse/interop?container=<c>
 *     → the real per-table interop state for the container (from the
 *       loom-lakehouse-interop Cosmos container), the catalog endpoint external
 *       engines point at, and the honest gate block when the catalog service is
 *       not deployed. Never empty, never mock.
 *
 *   PUT /api/lakehouse/interop
 *     body { container, tableName, iceberg: boolean, pool?, namespace? }
 *     → flips ONE table's Iceberg exposure. This submits a REAL Synapse Spark
 *       Livy statement (Delta UniForm first, Apache XTable fallback — see
 *       lib/azure/iceberg-metadata) that writes Iceberg V2 metadata beside the
 *       Delta log in the customer's OWN ADLS Gen2, persists the new state, and
 *       (when the REST catalog is deployed) registers/de-registers the table
 *       pointer in the catalog. Zero copy: the Parquet data files and the
 *       `_delta_log` are never touched, so Delta readability cannot be lost.
 *
 * Azure-native end to end: Synapse Spark + ADLS Gen2 + the self-hosted Unity
 * Catalog OSS container. No Microsoft Fabric / OneLake / Power BI, and — unlike
 * the older UniForm toggle in /api/lakehouse/settings — no Databricks SQL
 * Warehouse either, so this works with Databricks entirely unconfigured.
 *
 * Auth: session required. Every flip writes an audit row (the toggle is a
 * privileged data-plane mutation) plus the catalog registration's own row.
 */
import { NextResponse } from 'next/server';
import { withSession } from '@/lib/api/route-toolkit';
import { buildGateEnvelope } from '@/lib/api/gate-envelope';
import {
  auditLogContainer,
  lakehouseInteropContainer,
  maintenanceJobsContainer,
} from '@/lib/azure/cosmos-client';
import { emitAuditEvent } from '@/lib/admin/audit-stream';
import { getAccountName } from '@/lib/azure/adls-client';
import { createLivySessionAsync } from '@/lib/azure/synapse-dev-client';
import { defaultSparkPool } from '@/lib/azure/synapse-livy-client';
import { buildAbfssUri, buildMaintenancePySpark, validateMaintenanceRequest } from '@/lib/azure/delta-maintenance';
import { icebergMetadataLocation } from '@/lib/azure/iceberg-metadata';
import {
  ICEBERG_CATALOG_GATE_ID,
  icebergCatalogConfigGate,
  icebergWarehouse,
  logIcebergAccess,
  registerTable,
  dropTableRegistration,
} from '@/lib/azure/iceberg-catalog-client';
import {
  emptyInteropDoc,
  interopDocId,
  defaultNamespaceFor,
  normalizeTableKey,
  tableNameOf,
  upsertTableState,
  type InteropTableState,
  type LakehouseInteropDoc,
} from '@/lib/azure/lakehouse-interop-model';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CONTAINER_RE = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

function sanitize(e: unknown): string {
  return (e instanceof Error ? e.message : String(e))
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 600);
}

async function loadDoc(tenantId: string, container: string): Promise<LakehouseInteropDoc | null> {
  const c = await lakehouseInteropContainer();
  try {
    const r = await c.item(interopDocId(container), tenantId).read<LakehouseInteropDoc>();
    return r.resource ?? null;
  } catch (e) {
    if ((e as { code?: number })?.code === 404) return null;
    throw e;
  }
}

function catalogBlock(origin: string) {
  const gate = icebergCatalogConfigGate();
  return {
    configured: !gate,
    uri: `${origin}/api/catalog/iceberg`,
    warehouse: icebergWarehouse(),
    ...(gate ? { gate: buildGateEnvelope(ICEBERG_CATALOG_GATE_ID, { missing: [gate.missing] }).gate } : {}),
  };
}

function originOf(url: string): string {
  try { return new URL(url).origin; } catch { return (process.env.LOOM_PUBLIC_BASE_URL || '').replace(/\/+$/, ''); }
}

export const GET = withSession(async (req, { session }) => {
  const container = (req.nextUrl.searchParams.get('container') || '').trim();
  if (!container || !CONTAINER_RE.test(container)) {
    return NextResponse.json({ ok: false, error: 'a valid container query param is required' }, { status: 400 });
  }
  const tenantId = session.claims.oid;

  let doc: LakehouseInteropDoc | null = null;
  let storeError: string | null = null;
  try {
    doc = await loadDoc(tenantId, container);
  } catch (e) {
    storeError = sanitize(e);
  }

  // The lake account is what makes the metadata paths real; an unset account is
  // an honest Azure-side gate (never a Fabric one).
  let account: string | null = null;
  let accountGate: string | null = null;
  try {
    account = getAccountName();
  } catch {
    accountGate =
      'No Loom ADLS Gen2 account is configured, so Iceberg metadata has no target storage. Set '
      + 'LOOM_BRONZE_URL / LOOM_SILVER_URL / LOOM_GOLD_URL / LOOM_LANDING_URL (or LOOM_ADLS_ACCOUNT) on the '
      + 'Console Container App — these are emitted by the DLZ storage bicep module.';
  }

  return NextResponse.json({
    ok: true,
    container,
    account,
    ...(accountGate ? { accountGate } : {}),
    ...(storeError ? { storeError } : {}),
    catalog: catalogBlock(originOf(req.url)),
    defaultPool: defaultSparkPool(),
    tables: (doc?.tables || []).map((t) => ({
      ...t,
      icebergTableName: tableNameOf(normalizeTableKey(t.table)),
    })),
  });
});

export const PUT = withSession(async (req, { session }) => {
  const body = (await req.json().catch(() => ({}))) as {
    container?: string;
    tableName?: string;
    iceberg?: boolean;
    pool?: string;
    namespace?: string;
  };
  const container = String(body?.container ?? '').trim();
  const tableKey = normalizeTableKey(body?.tableName);
  const iceberg = body?.iceberg === true;
  const pool = String(body?.pool ?? '').trim() || defaultSparkPool();

  if (!container || !CONTAINER_RE.test(container)) {
    return NextResponse.json({ ok: false, error: 'a valid container is required' }, { status: 400 });
  }
  if (!tableKey) {
    return NextResponse.json({ ok: false, error: 'tableName is required and must be a valid table path' }, { status: 400 });
  }

  let account: string;
  try {
    account = getAccountName();
  } catch {
    return NextResponse.json({
      ok: false,
      code: 'adls_unconfigured',
      error:
        'No Loom ADLS Gen2 account is configured, so there is nowhere to write the Iceberg metadata. Set '
        + 'LOOM_BRONZE_URL / LOOM_SILVER_URL / LOOM_GOLD_URL / LOOM_LANDING_URL on the Console Container App '
        + '(emitted by the DLZ storage bicep module).',
    }, { status: 503 });
  }

  // Reuse the SAME validated request shape + PySpark builder the maintenance
  // dialog uses, so the interop job is generated by one code path (and the
  // identifier/pool guards apply identically).
  const v = validateMaintenanceRequest({
    container,
    tableName: tableKey,
    pool,
    compaction: false,
    vacuumRetentionHours: 0,
    zorderColumns: [],
    icebergMetadata: iceberg,
  });
  if (!v.ok) return NextResponse.json({ ok: false, error: v.error }, { status: 400 });

  const { code, ops } = buildMaintenancePySpark(v.value, account);
  const tableRootUri = buildAbfssUri(container, account, tableKey);
  const metadataLocation = icebergMetadataLocation(tableRootUri);
  const namespace = String(body?.namespace ?? '').trim() || defaultNamespaceFor(container, tableKey);
  const icebergTableName = tableNameOf(tableKey);
  const now = new Date().toISOString();
  const tenantId = session.claims.oid;

  // ── Submit the REAL Spark job. The session is created here (a cold pool
  //    returns 'starting'; we never block on warm-up) and the job is recorded
  //    in the SAME `maintenance-jobs` container the Delta-maintenance dialog
  //    uses, so the EXISTING lazy poller on GET /api/lakehouse/maintenance
  //    submits the statement once the session is idle and then tracks it to a
  //    terminal state. One job engine, one jobs list — no parallel machinery. ──
  let sessionId: number | null = null;
  let jobId: string | null = null;
  let jobError: string | null = null;
  try {
    const sess = await createLivySessionAsync(pool, 'pyspark', `loom-interop-${Date.now()}`);
    sessionId = sess.id;
    jobId = crypto.randomUUID();
    const jobs = await maintenanceJobsContainer();
    await jobs.items.upsert({
      id: jobId,
      tenantId,
      container,
      tableName: tableKey,
      pool,
      ops,
      code,
      account,
      sessionId,
      state: 'starting',
      submittedAt: now,
      updatedAt: now,
      submittedBy: session.claims.upn,
    });
  } catch (e) {
    jobError = sanitize(e);
  }

  // ── Persist the new state (durable even when the pool is cold/unavailable,
  //    so the toggle is never silently lost). ──
  const state: InteropTableState = {
    table: tableKey,
    namespace,
    delta: true,
    iceberg,
    via: iceberg ? 'delta-uniform' : 'none',
    metadataLocation: iceberg ? metadataLocation : undefined,
    tableRootUri,
    registeredInCatalog: false,
    lastJobId: jobId ?? undefined,
    lastJobState: jobError ? 'failed' : 'starting',
    lastDetail: jobError
      ? `Spark session could not be started on pool "${pool}": ${jobError}`
      : `Submitted ${ops.join(' + ')} on pool "${pool}".`,
    updatedAt: now,
    updatedBy: session.claims.upn,
  };

  let persistError: string | null = null;
  let doc: LakehouseInteropDoc;
  try {
    const existing = await loadDoc(tenantId, container);
    doc = upsertTableState(existing ?? emptyInteropDoc(tenantId, container), state);
    const c = await lakehouseInteropContainer();
    await c.items.upsert(doc);
  } catch (e) {
    persistError = sanitize(e);
    doc = upsertTableState(emptyInteropDoc(tenantId, container), state);
  }

  // ── Catalog registration (only when the catalog service is deployed). The
  //    metadata file may not exist until the Spark statement completes, so a
  //    registration failure here is reported honestly, not swallowed. ──
  let catalogNote: string | null = null;
  if (!icebergCatalogConfigGate()) {
    try {
      if (iceberg) {
        await registerTable(namespace, icebergTableName, metadataLocation);
        state.registeredInCatalog = true;
      } else {
        await dropTableRegistration(namespace, icebergTableName);
      }
      await logIcebergAccess({
        actorOid: session.claims.oid,
        actorUpn: session.claims.upn,
        tenantId: session.claims.tid || session.claims.oid,
        operation: iceberg ? 'table.register' : 'table.deregister',
        namespace,
        table: icebergTableName,
        outcome: 'success',
      });
      try {
        const c = await lakehouseInteropContainer();
        await c.items.upsert(upsertTableState(doc, state));
      } catch { /* the state row is already persisted; the flag re-syncs on next GET */ }
    } catch (e) {
      catalogNote =
        `Iceberg metadata is being written, but the catalog ${iceberg ? 'registration' : 'de-registration'} `
        + `for ${namespace}.${icebergTableName} did not succeed yet: ${sanitize(e)}. This is expected while the `
        + 'Spark job is still running (the metadata file must exist before it can be registered) — re-toggle or '
        + 'refresh once the job reports succeeded.';
      await logIcebergAccess({
        actorOid: session.claims.oid,
        actorUpn: session.claims.upn,
        tenantId: session.claims.tid || session.claims.oid,
        operation: iceberg ? 'table.register' : 'table.deregister',
        namespace,
        table: icebergTableName,
        outcome: 'failure',
        detail: sanitize(e),
      });
    }
  }

  // ── Audit the privileged mutation itself. ──
  const summary =
    `Lakehouse interop: ${iceberg ? 'exposed' : 'un-exposed'} ${container}/${tableKey} as Iceberg `
    + `(namespace ${namespace}) by ${session.claims.upn}`;
  try {
    const al = await auditLogContainer();
    await al.items.create({
      id: crypto.randomUUID(),
      tenantId,
      itemId: `${container}/${tableKey}`,
      itemType: 'lakehouse-interop',
      action: iceberg ? 'lakehouse-interop.expose-iceberg' : 'lakehouse-interop.remove-iceberg',
      summary,
      container,
      namespace,
      metadataLocation,
      pool,
      upn: session.claims.upn,
      at: now,
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[lakehouse-interop] audit row write failed:', sanitize(e));
  }
  try {
    emitAuditEvent({
      actorOid: session.claims.oid,
      actorUpn: session.claims.upn,
      action: iceberg ? 'lakehouse-interop.expose-iceberg' : 'lakehouse-interop.remove-iceberg',
      targetType: 'lakehouse-interop',
      targetId: `${container}/${tableKey}`,
      outcome: jobError ? 'failure' : 'success',
      tenantId: session.claims.tid || tenantId,
      timestamp: now,
      detail: { container, table: tableKey, namespace, metadataLocation, pool, iceberg },
    });
  } catch { /* best-effort fan-out */ }

  const status = jobError ? 502 : 200;
  return NextResponse.json({
    ok: !jobError,
    container,
    table: tableKey,
    namespace,
    icebergTableName,
    iceberg,
    ops,
    pool,
    sessionId,
    jobId,
    tableRootUri,
    metadataLocation,
    state,
    catalog: catalogBlock(originOf(req.url)),
    ...(catalogNote ? { catalogNote } : {}),
    ...(persistError ? { persistError } : {}),
    ...(jobError ? { error: `Could not start the Spark session on pool "${pool}": ${jobError}`, code: 'livy_submit_error' } : {}),
    /** The generated statement, so the operator can see EXACTLY what runs. */
    code,
  }, { status });
});
