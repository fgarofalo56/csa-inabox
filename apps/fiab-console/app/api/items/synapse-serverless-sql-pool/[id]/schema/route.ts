/**
 * GET /api/items/synapse-serverless-sql-pool/[id]/schema
 * Returns the browseable surface for the Serverless editor's left tree:
 *   - User databases (created via CREATE DATABASE on Serverless)
 *   - ADLS containers known to Loom (bronze/silver/gold/landing) — for OPENROWSET
 *   - Sample queries
 *
 * ?database=<db>&table=<schema.table> → { ok, columns } (INFORMATION_SCHEMA.COLUMNS
 * in the selected database) for editor IntelliSense.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { serverlessTarget, serverlessEndpoint, executeQuery } from '@/lib/azure/synapse-sql-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const tableParam = req.nextUrl.searchParams.get('table') || '';
  const dbParam = req.nextUrl.searchParams.get('database') || 'master';

  // Column-completion request → INFORMATION_SCHEMA.COLUMNS in the selected DB.
  if (tableParam) {
    const [schemaName, tableName] = tableParam.includes('.') ? tableParam.split('.', 2) : ['dbo', tableParam];
    try {
      const cols = await executeQuery(
        serverlessTarget(dbParam),
        `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = '${schemaName.replace(/'/g, "''")}'
           AND TABLE_NAME = '${tableName.replace(/'/g, "''")}'
         ORDER BY ORDINAL_POSITION`,
      );
      return NextResponse.json({ ok: true, columns: cols.rows.map((r) => String(r[0])) });
    } catch (e: any) {
      return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
    }
  }

  let databases: string[] = [];
  try {
    const r = await executeQuery(
      serverlessTarget('master'),
      `SELECT name FROM sys.databases WHERE database_id > 4 ORDER BY name`,
    );
    databases = r.rows.map((row) => String(row[0]));
  } catch {
    databases = [];
  }

  const lake = {
    bronze: process.env.LOOM_BRONZE_URL || '',
    silver: process.env.LOOM_SILVER_URL || '',
    gold: process.env.LOOM_GOLD_URL || '',
    landing: process.env.LOOM_LANDING_URL || '',
  };

  return NextResponse.json({
    ok: true,
    workspace: process.env.LOOM_SYNAPSE_WORKSPACE,
    endpoint: process.env.LOOM_SYNAPSE_WORKSPACE ? serverlessEndpoint() : '',
    databases,
    lake,
    samples: [
      {
        title: 'SELECT 1 — smoke',
        sql: `SELECT 1 AS smoke, SYSDATETIMEOFFSET() AS server_time, SUSER_NAME() AS upn;`,
      },
      lake.bronze && {
        title: 'OPENROWSET over bronze (Parquet)',
        sql: `SELECT TOP 100 *\nFROM OPENROWSET(BULK '${lake.bronze}/**', FORMAT='PARQUET') AS r;`,
      },
      lake.gold && {
        title: 'OPENROWSET over gold (Delta)',
        sql: `SELECT TOP 100 *\nFROM OPENROWSET(BULK '${lake.gold}/**', FORMAT='DELTA') AS r;`,
      },
    ].filter(Boolean),
  });
}
