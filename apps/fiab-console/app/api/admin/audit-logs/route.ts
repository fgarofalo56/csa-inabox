/**
 * GET /api/admin/audit-logs?q=&type=&since=&top=
 *   Returns the tenant's audit-log entries from Cosmos. The audit-log
 *   container is partitioned by /itemId (created by tenant-settings PUT,
 *   item edits, share grants, etc.).
 *
 * Query params:
 *   q     — free-text search across who / kind / key
 *   type  — restrict to a specific event kind (e.g. tenant-settings.toggle)
 *   since — ISO timestamp, lower bound
 *   top   — max rows (default 200, max 1000)
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { auditLogContainer } from '@/lib/azure/cosmos-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const tenantId = s.claims.oid;

  const q = (req.nextUrl.searchParams.get('q') || '').toLowerCase().trim();
  const type = (req.nextUrl.searchParams.get('type') || '').trim();
  const since = (req.nextUrl.searchParams.get('since') || '').trim();
  const top = Math.min(1000, Math.max(1, Number(req.nextUrl.searchParams.get('top') || 200)));

  try {
    const c = await auditLogContainer();
    // Cross-partition query — audit container partitions on itemId, and a
    // tenant view spans many itemIds. We filter to this tenant + order by
    // timestamp DESC. Audit container shouldn't be too large (≤ 50k/tenant
    // before archival).
    const whereParts: string[] = ['c.tenantId = @tenant'];
    const params: any[] = [{ name: '@tenant', value: tenantId }];
    if (type) { whereParts.push('c.kind = @kind'); params.push({ name: '@kind', value: type }); }
    if (since) { whereParts.push('c.at >= @since'); params.push({ name: '@since', value: since }); }

    const { resources } = await c.items.query({
      query: `SELECT TOP @top * FROM c WHERE ${whereParts.join(' AND ')} ORDER BY c.at DESC`,
      parameters: [...params, { name: '@top', value: top }],
    }).fetchAll();

    let rows = resources;
    if (q) {
      rows = rows.filter((r: any) =>
        (r.who || '').toLowerCase().includes(q) ||
        (r.kind || '').toLowerCase().includes(q) ||
        (r.key || '').toLowerCase().includes(q) ||
        (r.itemId || '').toLowerCase().includes(q)
      );
    }

    // Distinct event kinds for the type filter dropdown.
    const kinds = Array.from(new Set(resources.map((r: any) => r.kind).filter(Boolean))).sort();

    return NextResponse.json({
      ok: true,
      total: rows.length,
      rows,
      kinds,
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}
