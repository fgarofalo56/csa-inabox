import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Stub - real impl dispatches to Databricks SQL Warehouse OR Synapse
// Serverless based on engine selection. Returns an explanatory empty
// result so the warehouse pane renders.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const sql = (body?.sql || '').toString();
  return NextResponse.json({
    columns: ['info'],
    rows: [[`Stub response. Real query dispatch wires up in v1.1. Submitted: ${sql.substring(0, 80)}`]],
    rowCount: 1,
    executionMs: 0,
    engine: 'databricks-sql',
  });
}
