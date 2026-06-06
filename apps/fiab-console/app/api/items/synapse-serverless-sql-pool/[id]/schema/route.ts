/**
 * GET /api/items/synapse-serverless-sql-pool/[id]/schema
 * Returns the browseable surface for the Serverless editor's left tree:
 *   - User databases (created via CREATE DATABASE on Serverless)
 *   - ADLS containers known to Loom (bronze/silver/gold/landing) — for OPENROWSET
 *   - Sample queries
 */

import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { serverlessTarget, executeQuery, getSynapseSqlSuffix } from '@/lib/azure/synapse-sql-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

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
    endpoint: `${process.env.LOOM_SYNAPSE_WORKSPACE}-ondemand.${getSynapseSqlSuffix()}`,
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
