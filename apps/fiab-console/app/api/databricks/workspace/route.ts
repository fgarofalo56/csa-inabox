/**
 * GET /api/databricks/workspace
 *   Returns the Databricks workspace configured for this Loom instance.
 *   Loom assumes a single workspace (LOOM_DATABRICKS_HOSTNAME); if multi-
 *   workspace support lands later, this endpoint will switch to returning
 *   an array.
 *
 * Used by the DbtJobEditor (and future Databricks editors) to disclose
 * which workspace will execute jobs — no more silent assumptions.
 */

import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const hostname = process.env.LOOM_DATABRICKS_HOSTNAME;
  if (!hostname) {
    return NextResponse.json({
      ok: false,
      error: 'LOOM_DATABRICKS_HOSTNAME not configured',
      hint: 'Set LOOM_DATABRICKS_HOSTNAME on the Console Container App (e.g. adb-7405613013893759.19.azuredatabricks.net) to enable Databricks-backed editors.',
    }, { status: 500 });
  }

  const clean = hostname.replace(/^https?:\/\//, '').replace(/\/$/, '');
  return NextResponse.json({
    ok: true,
    workspace: {
      hostname: clean,
      url: `https://${clean}`,
    },
  });
}
