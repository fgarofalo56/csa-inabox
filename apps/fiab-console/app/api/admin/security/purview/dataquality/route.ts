/**
 * /api/admin/security/purview/dataquality
 *
 * GET → list data-quality rules (preview).
 *
 * Note: Purview Data Quality is in public preview as of this build. Some
 * Purview accounts will return 404 on this endpoint entirely; the client
 * lib treats that as "feature not enabled / no rules" and returns [].
 * The panel renders a Caption1 hint when the list is empty to distinguish
 * "no rules configured" from "DQ preview not enabled".
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listDataQualityRules } from '@/lib/azure/purview-client';
import { handleSecurityError } from '../../_lib/error-handling';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const rules = await listDataQualityRules();
    return NextResponse.json({
      ok: true,
      rules,
      preview: true,
      note: rules.length === 0
        ? 'No DQ rules returned. Either no rules are configured in this Purview account, or the Data Quality preview is not enabled for the tenant. Enable it in the Purview portal → Settings → Data quality.'
        : undefined,
    });
  } catch (e) { return handleSecurityError(e); }
}
