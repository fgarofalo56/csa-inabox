/**
 * GET /api/admin/permissions/capabilities — list the full Loom capability
 * catalog grouped into domain → workload → capability rows.  Drives the
 * /admin/permissions tree UI.
 *
 * Returns { ok, groups: [{ domain, workloads: [{ name, capabilities: [...] }] }] }
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { enforceCapability } from '@/lib/auth/feature-gate';
import { groupedCatalog } from '@/lib/auth/feature-catalog';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const s = getSession();
  const gate = await enforceCapability(s, 'admin.permissions', 'Reader');
  if (gate) return gate;
  return NextResponse.json({ ok: true, groups: groupedCatalog() });
}
