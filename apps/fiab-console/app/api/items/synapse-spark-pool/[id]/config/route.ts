/**
 * POST /api/items/synapse-spark-pool/[id]/config
 *
 * Inline Configuration-tab save. Body (any subset):
 *   {
 *     nodeSize?: 'Small'|'Medium'|'Large'|'XLarge'|'XXLarge',
 *     sparkVersion?: string,
 *     autoPause?: { enabled: boolean, delayInMinutes?: number },
 *     autoScale?: { enabled: boolean, minNodeCount?: number, maxNodeCount?: number },
 *     nodeCount?: number,           // applied when autoScale.enabled === false
 *   }
 *
 * PATCHes Microsoft.Synapse/workspaces/{ws}/bigDataPools/{name} via ARM. A 403
 * from ARM (Console identity lacks Contributor on the workspace) is surfaced as
 * an honest gate — { ok:false, forbidden:true } with HTTP 403 — so the editor
 * can render a remediation MessageBar rather than a generic error.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { updateBigDataPool } from '@/lib/azure/synapse-dev-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VALID_NODE_SIZES = ['Small', 'Medium', 'Large', 'XLarge', 'XXLarge'] as const;
type NodeSize = (typeof VALID_NODE_SIZES)[number];

export async function POST(req: NextRequest, ctx: { params: { id: string } }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const body = await req.json().catch(() => ({}));

  const nodeSize = typeof body?.nodeSize === 'string' ? (body.nodeSize as string) : undefined;
  if (nodeSize && !VALID_NODE_SIZES.includes(nodeSize as NodeSize)) {
    return NextResponse.json({ ok: false, error: `nodeSize must be one of ${VALID_NODE_SIZES.join(', ')}` }, { status: 400 });
  }
  const sparkVersion = typeof body?.sparkVersion === 'string' && body.sparkVersion.trim() ? body.sparkVersion.trim() : undefined;

  let autoPause: { enabled: boolean; delayInMinutes?: number } | undefined;
  if (body?.autoPause && typeof body.autoPause === 'object') {
    const enabled = !!body.autoPause.enabled;
    const delayInMinutes = typeof body.autoPause.delayInMinutes === 'number' ? body.autoPause.delayInMinutes : undefined;
    if (enabled && (delayInMinutes == null || !Number.isFinite(delayInMinutes) || delayInMinutes < 5)) {
      return NextResponse.json({ ok: false, error: 'autoPause.delayInMinutes ≥ 5 required when auto-pause is enabled' }, { status: 400 });
    }
    autoPause = { enabled, delayInMinutes };
  }

  let autoScale: { enabled: boolean; minNodeCount?: number; maxNodeCount?: number } | undefined;
  if (body?.autoScale && typeof body.autoScale === 'object') {
    const enabled = !!body.autoScale.enabled;
    if (enabled) {
      const minNodeCount = Number(body.autoScale.minNodeCount);
      const maxNodeCount = Number(body.autoScale.maxNodeCount);
      if (!Number.isFinite(minNodeCount) || !Number.isFinite(maxNodeCount) || minNodeCount < 3 || maxNodeCount < minNodeCount) {
        return NextResponse.json({ ok: false, error: 'autoScale.minNodeCount must be ≥ 3 and ≤ maxNodeCount' }, { status: 400 });
      }
      autoScale = { enabled, minNodeCount, maxNodeCount };
    } else {
      autoScale = { enabled };
    }
  }

  const nodeCount = typeof body?.nodeCount === 'number' ? body.nodeCount : undefined;
  if (nodeCount != null && (!Number.isFinite(nodeCount) || nodeCount < 3)) {
    return NextResponse.json({ ok: false, error: 'nodeCount must be ≥ 3' }, { status: 400 });
  }

  if (nodeSize === undefined && sparkVersion === undefined && !autoPause && !autoScale && nodeCount == null) {
    return NextResponse.json({ ok: false, error: 'no configuration fields supplied' }, { status: 400 });
  }

  try {
    const pool = await updateBigDataPool(ctx.params.id, {
      nodeSize: nodeSize as NodeSize | undefined,
      sparkVersion,
      autoPause,
      autoScale,
      nodeCount,
      location: typeof body?.location === 'string' ? body.location : undefined,
    });
    return NextResponse.json({ ok: true, pool });
  } catch (e: any) {
    const msg = e?.message || String(e);
    const forbidden = /\b403\b|AuthorizationFailed|does not have authorization|Forbidden/i.test(msg);
    return NextResponse.json({ ok: false, error: msg, forbidden }, { status: forbidden ? 403 : 502 });
  }
}
