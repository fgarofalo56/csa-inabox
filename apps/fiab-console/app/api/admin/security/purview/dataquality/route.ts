/**
 * /api/admin/security/purview/dataquality
 *
 * GET → list data-quality rules from Purview (when configured) or Loom's native store.
 *
 * Purview Data Quality is in public preview. If Purview is not configured or returns
 * empty, transparently fall back to Loom's native rules (stored by
 * /api/admin/data-quality-rules). This ensures the admin-security panel always shows
 * real rules — no hard Purview dependency (no-fabric-dependency.md).
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listDataQualityRules, PurviewNotConfiguredError } from '@/lib/azure/purview-client';
import { tenantSettingsContainer } from '@/lib/azure/cosmos-client';
import { handleSecurityError } from '../../_lib/error-handling';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface DataQualityRule {
  id: string;
  name: string;
  scope: string;
  check: 'not-null' | 'unique' | 'range' | 'regex' | 'freshness';
  threshold: number;
  enabled: boolean;
  createdAt: string;
  createdBy?: string;
  source?: 'purview' | 'loom';
}

async function getLoomRules(tenantId: string): Promise<DataQualityRule[]> {
  try {
    const c = await tenantSettingsContainer();
    const docId = `dq-rules:${tenantId}`;
    const { resource } = await c.item(docId, tenantId).read<any>();
    if (!resource?.items) return [];
    return (resource.items || []).map((r: any) => ({ ...r, source: 'loom' as const }));
  } catch (e: any) {
    if (e?.code === 404) return [];
    throw e;
  }
}

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const tenantId = s.claims.oid;
  try {
    let rules: DataQualityRule[] = [];
    let source: 'purview' | 'loom' = 'loom';
    try {
      const purviewRules = await listDataQualityRules();
      if (purviewRules && purviewRules.length > 0) {
        rules = purviewRules as any;
        source = 'purview';
      }
    } catch (e: any) {
      if (!(e instanceof PurviewNotConfiguredError)) throw e;
      // Purview not configured; fall through to Loom rules.
    }
    if (rules.length === 0) {
      rules = await getLoomRules(tenantId);
    }
    return NextResponse.json({
      ok: true,
      rules,
      source,
      preview: source === 'purview',
      note:
        source === 'loom' && rules.length === 0
          ? 'No data-quality rules configured. Create one in Catalog → Data quality. Rules run on the next scan.'
          : undefined,
    });
  } catch (e) { return handleSecurityError(e); }
}
