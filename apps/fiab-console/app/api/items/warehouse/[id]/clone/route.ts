/**
 * POST /api/items/warehouse/[id]/clone
 *
 * Fabric Warehouse "table clone" parity (rel-T82). Two REAL Azure-native paths,
 * no Fabric dependency:
 *
 *  - mode 'ctas'  (DEFAULT — the warehouse's canonical Synapse Dedicated SQL
 *    pool backend): runs a real `CREATE TABLE [tgt] WITH (DISTRIBUTION=…) AS
 *    SELECT * FROM [src]` on the live pool. Dedicated pools have no zero-copy
 *    CLONE statement, so CTAS-as-clone is the Azure-native equivalent — an
 *    independent copy, exactly the outcome Fabric's clone gives.
 *  - mode 'delta-shallow' (for a Delta lakehouse table): runs a real Databricks
 *    `CREATE TABLE delta.`<tgt>` SHALLOW CLONE delta.`<src>` [VERSION AS OF n]`
 *    on a Databricks SQL Warehouse — a genuine zero-copy metadata clone.
 *    Honest-gates when Databricks is not configured.
 *
 * Grounded in:
 *   https://learn.microsoft.com/fabric/data-warehouse/clone-table
 *   https://learn.microsoft.com/azure/databricks/delta/clone
 */

import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { apiOk, apiError, apiServerError, apiUnauthorized } from '@/lib/api/respond';
import { dedicatedTarget, executeQuery } from '@/lib/azure/synapse-sql-client';
import { getPoolState } from '@/lib/azure/synapse-pool-arm';
import { databricksConfigGate, listWarehouses, executeStatement } from '@/lib/azure/databricks-client';
import { getAccountName } from '@/lib/azure/adls-client';
import { toAbfss } from '@/lib/azure/delta-source-uri';
import { cleanTablePath, isKnownContainer } from '@/lib/azure/delta-history';
import { bracket } from '@/lib/sql/quoting';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// T-SQL identifiers are restricted to name chars; reject anything else early so
// a bad payload never reaches the (already bracket-quoted) statement builder.
function safeIdent(v: unknown): string | null {
  const s = String(v ?? '').trim();
  if (!s || s.length > 128 || !/^[A-Za-z0-9_ .$#@-]+$/.test(s)) return null;
  return s;
}

const DISTRIBUTIONS = new Set(['ROUND_ROBIN', 'HEAP']);

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return apiUnauthorized();

  const body = await req.json().catch(() => ({}));
  const mode = body?.mode === 'delta-shallow' ? 'delta-shallow' : 'ctas';

  // ── Delta shallow clone (zero-copy) via Databricks ───────────────────────
  if (mode === 'delta-shallow') {
    const container = String(body?.container || '');
    const sourcePath = cleanTablePath(String(body?.sourceTablePath || ''));
    const targetPath = cleanTablePath(String(body?.targetTablePath || ''));
    const version = body?.version === undefined || body?.version === null ? undefined : Number(body.version);
    if (!isKnownContainer(container)) return apiError(`unknown container: ${container}`, 404);
    if (!sourcePath || !targetPath) return apiError('sourceTablePath and targetTablePath are required', 400);
    if (version !== undefined && (!Number.isInteger(version) || version < 0)) {
      return apiError('version must be a non-negative integer', 400);
    }

    const gate = databricksConfigGate();
    if (gate) {
      return apiError(
        `Set ${gate.missing} to enable Delta SHALLOW CLONE. Zero-copy Delta clones run on a Databricks SQL Warehouse — Synapse Serverless cannot. Use CTAS-as-clone (mode 'ctas') for a Synapse Dedicated pool table instead.`,
        503, { gated: true, code: 'no_databricks' },
      );
    }
    let warehouseId: string;
    let account: string;
    try {
      const warehouses = await listWarehouses();
      const wh = warehouses.find((w) => w.state === 'RUNNING') || warehouses[0];
      if (!wh) return apiError('Databricks has no SQL Warehouse to run the clone. Create one (Compute → SQL Warehouses).', 503, { gated: true, code: 'no_warehouse' });
      warehouseId = wh.id;
      account = getAccountName();
    } catch (e) {
      return apiServerError(e, 'Failed to resolve Databricks warehouse / storage account', 'clone_setup_failed');
    }
    const srcUri = toAbfss({ account, container, path: sourcePath }).replace(/`/g, '');
    const tgtUri = toAbfss({ account, container, path: targetPath }).replace(/`/g, '');
    const asOf = version !== undefined ? ` VERSION AS OF ${version}` : '';
    const sql = `CREATE TABLE delta.\`${tgtUri}\` SHALLOW CLONE delta.\`${srcUri}\`${asOf}`;
    try {
      const result = await executeStatement(warehouseId, sql);
      return apiOk({ mode, engine: 'databricks-delta', sql, version: version ?? null, result });
    } catch (e) {
      return apiServerError(e, 'Delta SHALLOW CLONE failed', 'clone_failed');
    }
  }

  // ── CTAS-as-clone (default) on the Synapse Dedicated SQL pool ─────────────
  const srcSchema = safeIdent(body?.sourceSchema ?? 'dbo');
  const srcTable = safeIdent(body?.sourceTable);
  const tgtSchema = safeIdent(body?.targetSchema ?? 'dbo');
  const tgtTable = safeIdent(body?.targetTable);
  const distribution = DISTRIBUTIONS.has(String(body?.distribution || '').toUpperCase())
    ? String(body.distribution).toUpperCase()
    : 'ROUND_ROBIN';
  if (!srcSchema || !srcTable) return apiError('sourceSchema and sourceTable are required', 400);
  if (!tgtSchema || !tgtTable) return apiError('targetSchema and targetTable are required', 400);

  const state = await getPoolState().catch(() => null);
  if (state && state.state !== 'Online') {
    return apiError(`Warehouse compute is ${state.state}. Resume the Synapse Dedicated SQL pool, then clone.`, 409, { code: 'pool_offline', state: state.state });
  }

  // Identifiers are validated + bracket-quoted (bracket() doubles `]`). The
  // CTAS distribution is from a fixed whitelist. No user value is concatenated
  // raw — this is DDL, which cannot be parameterized.
  const src = `${bracket(srcSchema)}.${bracket(srcTable)}`;
  const tgt = `${bracket(tgtSchema)}.${bracket(tgtTable)}`;
  const withClause = distribution === 'HEAP' ? 'HEAP' : 'DISTRIBUTION = ROUND_ROBIN';
  const sql = `CREATE TABLE ${tgt} WITH ( ${withClause} ) AS SELECT * FROM ${src};`;
  try {
    const result = await executeQuery(dedicatedTarget(), sql, 120_000);
    return apiOk({
      mode, engine: 'synapse-dedicated', sql,
      source: `${srcSchema}.${srcTable}`, target: `${tgtSchema}.${tgtTable}`,
      recordsAffected: result.recordsAffected, executionMs: result.executionMs,
      executedBy: session.claims.upn,
    });
  } catch (e) {
    return apiServerError(e, 'CTAS clone failed', 'clone_failed');
  }
}
