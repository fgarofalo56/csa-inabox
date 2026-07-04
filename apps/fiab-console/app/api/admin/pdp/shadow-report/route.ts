/**
 * GET /api/admin/pdp/shadow-report
 *
 * Review what the multi-domain ACL Policy Decision Point (PDP) WOULD decide,
 * from the `pdp.shadow` rows that `pdpCheck()` writes to `_auditLog` while
 * `LOOM_PDP_ENFORCE=shadow`. This is the migration tool: vet the PDP against
 * real traffic — especially its DENY decisions and any divergence from today's
 * behavior — BEFORE flipping `LOOM_PDP_ENFORCE=enforce` per domain.
 *
 * Tenant-administrator only. The shadow rows are scoped to the Entra tenant
 * (so an admin sees every user's would-be decision), matching the tenantId the
 * shadow writer (lib/auth/pdp/enforce.ts) stamps. The query is a bounded
 * TOP-N cross-partition read (admin tool, not a hot path).
 *
 * Query params: ?limit=200 (1..1000) · ?denyOnly=true · ?divergentOnly=true
 * Returns: { ok, mode, tenantScope, summary { total, allows, denies, divergences,
 *            bySource, byRoute, byAction }, rows[] }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { isTenantAdminTier, TENANT_ADMIN_TIER_REMEDIATION, TENANT_ADMIN_BOOTSTRAP_ENV } from '@/lib/auth/domain-role';
import { auditLogContainer } from '@/lib/azure/cosmos-client';
import { pdpEnforceMode } from '@/lib/auth/pdp/enforce';
import { apiServerError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The same tenant scope the shadow writer stamps onto each pdp.shadow row. */
function shadowTenantScope(): string {
  return process.env.LOOM_TENANT_ID || process.env.AZURE_TENANT_ID || 'common';
}

function tally(rows: Array<Record<string, unknown>>, key: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    const k = String(r[key] ?? 'unknown');
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

export async function GET(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  if (!isTenantAdminTier(s)) {
    return NextResponse.json(
      {
        ok: false,
        error: 'forbidden — the PDP shadow report is tenant-administrator only',
        remediation: TENANT_ADMIN_TIER_REMEDIATION,
        bootstrapEnv: TENANT_ADMIN_BOOTSTRAP_ENV,
      },
      { status: 403 },
    );
  }

  const url = new URL(req.url);
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '200', 10) || 200, 1), 1000);
  const denyOnly = url.searchParams.get('denyOnly') === 'true';
  const divergentOnly = url.searchParams.get('divergentOnly') === 'true';
  const tenantScope = shadowTenantScope();

  try {
    const c = await auditLogContainer();
    const where = ["c.kind = 'pdp.shadow'", 'c.tenantId = @tid'];
    if (denyOnly) where.push("c.effect = 'deny'");
    if (divergentOnly) where.push('c.divergence = true');
    const { resources } = await c.items
      .query<Record<string, unknown>>({
        query:
          'SELECT TOP @n c.id, c.ts, c.oid, c.action, c.route, c.effect, c.reason, c.source, ' +
          'c.obligations, c.divergence FROM c WHERE ' + where.join(' AND ') + ' ORDER BY c.ts DESC',
        parameters: [
          { name: '@n', value: limit },
          { name: '@tid', value: tenantScope },
        ],
      })
      .fetchAll();

    const rows = resources || [];
    const summary = {
      total: rows.length,
      allows: rows.filter((r) => r.effect === 'allow').length,
      denies: rows.filter((r) => r.effect === 'deny').length,
      // divergence is only populated when a caller passes legacyAllowed; true =
      // the PDP disagrees with today's behavior (the rows to vet most closely).
      divergences: rows.filter((r) => r.divergence === true).length,
      bySource: tally(rows, 'source'),
      byRoute: tally(rows, 'route'),
      byAction: tally(rows, 'action'),
    };

    return NextResponse.json({
      ok: true,
      mode: pdpEnforceMode(),
      tenantScope,
      note:
        summary.total === 0 && pdpEnforceMode() === 'off'
          ? 'No shadow decisions recorded yet. Set LOOM_PDP_ENFORCE=shadow on the Loom Console to start collecting PDP decisions against real traffic, then revisit this report before enabling enforce.'
          : undefined,
      summary,
      rows,
    });
  } catch (e: any) {
    return apiServerError(e);
  }
}
