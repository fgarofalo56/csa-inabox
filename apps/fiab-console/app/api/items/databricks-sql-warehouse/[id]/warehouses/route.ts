/**
 * GET /api/items/databricks-sql-warehouse/[id]/warehouses
 * Lists SQL Warehouses available on the deployed Databricks workspace.
 */

import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listWarehouses } from '@/lib/azure/databricks-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  try {
    const warehouses = await listWarehouses();
    return NextResponse.json({ ok: true, warehouses });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
