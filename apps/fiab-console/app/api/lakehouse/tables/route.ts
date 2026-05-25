import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Stub - real impl reads Unity Catalog / Synapse / Atlas through the
// MCP server. Returns deterministic sample tables so the Lakehouse
// pane renders an empty-but-meaningful state in unconfigured deploys.
export async function GET() {
  return NextResponse.json([
    { schema: 'bronze', name: 'orders_raw', rowCount: 0, sizeBytes: 0, format: 'delta', latestVersion: 0 },
    { schema: 'silver', name: 'orders_cleaned', rowCount: 0, sizeBytes: 0, format: 'delta', latestVersion: 0 },
    { schema: 'gold', name: 'orders_dim', rowCount: 0, sizeBytes: 0, format: 'delta', latestVersion: 0 },
  ]);
}
