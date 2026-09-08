/**
 * POST /api/items/[type]/[id]/export-check
 *
 * F19 pre-flight: given a Loom workspace item and a target export `format`,
 * decide whether the export is permitted under the item's sensitivity label.
 *
 * Protected labels (Graph beta `hasProtection`) block CSV / TXT exports — those
 * formats cannot carry AIP/RMS metadata, so the protection context would be
 * stripped on download. When the caller's per-user usage rights are available
 * (Commercial / GCC) and they lack the EXPORT right, the export is hard-blocked
 * for any format. Unprotected labels never block.
 *
 * Body:    { format: string }   e.g. 'csv' | 'txt' | 'xlsx' | 'pdf'
 * Returns: { ok: true, blocked: boolean, reason?: string, warning?: string }
 *
 * Honest gates (per no-vaporware.md):
 *   - no sensitivity label on the item        → { blocked: false }
 *   - LOOM_MIP_ENABLED !== 'true'             → { blocked: false, warning } (can't verify)
 *   - rights filter unavailable (GCC-High/IL5) → CSV/TXT still blocked by FORMAT
 */
import { NextRequest, NextResponse } from 'next/server';
import { apiError, apiServerError } from '@/lib/api/respond';
import { getSession } from '@/lib/auth/session';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import { loadAuthorizedItem } from '../_lib/load-item';
import type { WorkspaceItem } from '@/lib/types/workspace';
import { getSensitivityLabel, getSensitivityLabelWithRights } from '@/lib/azure/mip-graph-client';
import { checkExportProtection } from '@/lib/azure/label-protection';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';



export async function POST(req: NextRequest, props: { params: Promise<{ type: string; id: string }> }) {
  const params = await props.params;
  const session = getSession();
  if (!session) return apiError('Unauthorized', 401);

  let body: any;
  try { body = await req.json(); } catch { return apiError('Invalid JSON', 400); }
  const format = typeof body?.format === 'string' ? body.format : '';
  if (!format) return apiError('format is required', 400);

  try {
    const { item, denied } = await loadAuthorizedItem(session, {
      itemId: params.id, itemType: params.type, write: true, notFound: 'Item not found',
    });
    if (denied) return denied;
    if (!item) return apiError('Item not found', 404);

    const state = (item.state || {}) as Record<string, unknown>;
    const labelId = typeof state.sensitivityLabelId === 'string' ? state.sensitivityLabelId : '';
    if (!labelId) return NextResponse.json({ ok: true, blocked: false });

    if (process.env.LOOM_MIP_ENABLED !== 'true') {
      return NextResponse.json({
        ok: true,
        blocked: false,
        warning:
          'LOOM_MIP_ENABLED is not set on this deployment; export protection for sensitivity labels cannot be verified. ' +
          'Set LOOM_MIP_ENABLED=true on the loom-console Container App to enforce protected-label export rules.',
      });
    }

    const label = await getSensitivityLabel(labelId);
    if (!label) return NextResponse.json({ ok: true, blocked: false });

    // Best-effort per-user rights — null is fine (graceful Gov-cloud degrade).
    const callerUpn = session.claims.upn || session.claims.email || '';
    const rights = callerUpn ? await getSensitivityLabelWithRights(labelId, callerUpn) : null;

    const result = checkExportProtection(label, format, rights);
    return NextResponse.json({ ok: true, ...result });
  } catch (e: any) {
    // MIP upstream/config errors must not silently allow export — surface them.
    return apiServerError(e, 'Failed to evaluate export protection');
  }
}
