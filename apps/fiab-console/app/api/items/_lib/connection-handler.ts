/**
 * connection-handler — shared logic behind the per-engine
 * `GET /api/items/<engine>/[id]/connection` routes. Surfaces the REAL
 * connection coordinates (server hostname, HTTP path / database, JDBC URL,
 * CLI snippet, AAD auth mode) an external client uses to reach the SQL engine.
 *
 * Engines:
 *   databricks-sql-warehouse      — odbc_params from GET /api/2.0/sql/warehouses/{id}
 *   synapse-serverless-sql-pool   — <ws>-ondemand.<suffix> via serverlessTarget()
 *   synapse-dedicated-sql-pool    — <ws>.<suffix> / <pool> via dedicatedTarget()
 *
 * Cloud-aware: every host is resolved through cloud-endpoints / synapse-sql-client
 * so the Gov suffix (`*.usgovcloudapi.net`) appears automatically in GCC-High /
 * IL5 / DoD. No Fabric / Power BI dependency — Azure-native by default
 * (no-fabric-dependency.md). No mock data — an unconfigured engine or a
 * warehouse without odbc_params returns an honest gate, never a placeholder URL
 * (no-vaporware.md).
 *
 * Return shape (HTTP 200):
 *   { ok: true, engine, hostname, httpPath?, database?, port, jdbcUrl,
 *     cliSnippet, authMode, warehouseId?, warehouseName? }
 * Honest gates:
 *   503 { ok: false, code: 'not_configured', missing, error }
 *   400 { ok: false, code: 'not_configured', missing: 'warehouseId', error }
 *   422 { ok: false, code: 'odbc_params_unavailable', error }
 *   502 { ok: false, error }  (downstream REST failure)
 */

import { NextResponse } from 'next/server';
import { databricksConfigGate, getWarehouse } from '@/lib/azure/databricks-client';
import { dedicatedTarget, serverlessTarget } from '@/lib/azure/synapse-sql-client';
import { synapseSqlJdbcHostCert } from '@/lib/azure/cloud-endpoints';

export type ConnectionEngine =
  | 'databricks-sql-warehouse'
  | 'synapse-serverless-sql-pool'
  | 'synapse-dedicated-sql-pool';

export const CONNECTION_ENGINES: ConnectionEngine[] = [
  'databricks-sql-warehouse',
  'synapse-serverless-sql-pool',
  'synapse-dedicated-sql-pool',
];

const SYNAPSE_AUTH_MODE = 'Microsoft Entra (AAD token — ActiveDirectoryIntegrated)';

/**
 * Synapse JDBC URL for the Microsoft JDBC Driver for SQL Server, AAD-integrated
 * (per Microsoft Learn `azure/synapse-analytics/sql/connection-strings`). The
 * `hostNameInCertificate` wildcard is cloud-resolved so the cert validates in
 * every sovereign boundary.
 */
function synapseJdbcUrl(server: string, database: string): string {
  const cert = synapseSqlJdbcHostCert();
  return (
    `jdbc:sqlserver://${server}:1433;` +
    `database=${database};` +
    `authentication=ActiveDirectoryIntegrated;` +
    `encrypt=true;` +
    `trustServerCertificate=false;` +
    `hostNameInCertificate=${cert};` +
    `loginTimeout=30;`
  );
}

function synapseCliSnippet(server: string, database: string): string {
  return `sqlcmd -S ${server},1433 -d ${database} --authentication-method ActiveDirectoryIntegrated -C`;
}

export async function handleConnectionDetails(
  engine: ConnectionEngine,
  warehouseId?: string,
  database?: string,
): Promise<NextResponse> {
  switch (engine) {
    // ---- Databricks SQL Warehouse -----------------------------------------
    case 'databricks-sql-warehouse': {
      const gate = databricksConfigGate();
      if (gate) {
        return NextResponse.json(
          {
            ok: false,
            code: 'not_configured',
            missing: gate.missing,
            error: `Databricks not configured: set ${gate.missing}.`,
          },
          { status: 503 },
        );
      }
      // Fall back to the pinned warehouse when an explicit id is not supplied.
      const wid = warehouseId || process.env.LOOM_DATABRICKS_SQL_WAREHOUSE_ID;
      if (!wid) {
        return NextResponse.json(
          {
            ok: false,
            code: 'not_configured',
            missing: 'warehouseId',
            error:
              'warehouseId query param or LOOM_DATABRICKS_SQL_WAREHOUSE_ID required.',
          },
          { status: 400 },
        );
      }
      let warehouse;
      try {
        warehouse = await getWarehouse(wid);
      } catch (e: any) {
        return NextResponse.json(
          { ok: false, error: e?.message || String(e) },
          { status: 502 },
        );
      }
      const odbc = warehouse.odbc_params;
      if (!odbc?.hostname || !odbc?.path) {
        return NextResponse.json(
          {
            ok: false,
            code: 'odbc_params_unavailable',
            error:
              `Warehouse "${warehouse.name}" did not return odbc_params (state: ${warehouse.state}). ` +
              'Start the warehouse so Databricks provisions its ODBC/JDBC endpoint, then retry.',
          },
          { status: 422 },
        );
      }
      const port = odbc.port ?? 443;
      const jdbcUrl = `jdbc:databricks://${odbc.hostname}:${port};httpPath=${odbc.path}`;
      const cliSnippet = `databricks sql query --host ${odbc.hostname} --http-path ${odbc.path} --token <PAT>`;
      return NextResponse.json({
        ok: true,
        engine,
        hostname: odbc.hostname,
        httpPath: odbc.path,
        port,
        jdbcUrl,
        cliSnippet,
        authMode: 'Microsoft Entra (AAD access token) or Databricks PAT',
        warehouseId: wid,
        warehouseName: warehouse.name,
      });
    }

    // ---- Synapse Serverless SQL pool --------------------------------------
    case 'synapse-serverless-sql-pool': {
      if (!process.env.LOOM_SYNAPSE_WORKSPACE) {
        return NextResponse.json(
          {
            ok: false,
            code: 'not_configured',
            missing: 'LOOM_SYNAPSE_WORKSPACE',
            error: 'Synapse not configured: set LOOM_SYNAPSE_WORKSPACE.',
          },
          { status: 503 },
        );
      }
      const target = serverlessTarget(database || 'master');
      return NextResponse.json({
        ok: true,
        engine,
        hostname: target.server,
        database: target.database,
        port: 1433,
        jdbcUrl: synapseJdbcUrl(target.server, target.database),
        cliSnippet: synapseCliSnippet(target.server, target.database),
        authMode: SYNAPSE_AUTH_MODE,
      });
    }

    // ---- Synapse Dedicated SQL pool ---------------------------------------
    case 'synapse-dedicated-sql-pool': {
      if (!process.env.LOOM_SYNAPSE_WORKSPACE) {
        return NextResponse.json(
          {
            ok: false,
            code: 'not_configured',
            missing: 'LOOM_SYNAPSE_WORKSPACE',
            error: 'Synapse not configured: set LOOM_SYNAPSE_WORKSPACE.',
          },
          { status: 503 },
        );
      }
      if (!process.env.LOOM_SYNAPSE_DEDICATED_POOL) {
        return NextResponse.json(
          {
            ok: false,
            code: 'not_configured',
            missing: 'LOOM_SYNAPSE_DEDICATED_POOL',
            error: 'Dedicated pool not configured: set LOOM_SYNAPSE_DEDICATED_POOL.',
          },
          { status: 503 },
        );
      }
      const target = dedicatedTarget();
      return NextResponse.json({
        ok: true,
        engine,
        hostname: target.server,
        database: target.database,
        port: 1433,
        jdbcUrl: synapseJdbcUrl(target.server, target.database),
        cliSnippet: synapseCliSnippet(target.server, target.database),
        authMode: SYNAPSE_AUTH_MODE,
      });
    }

    default:
      return NextResponse.json(
        { ok: false, error: `Unsupported engine: ${engine}` },
        { status: 400 },
      );
  }
}
