/**
 * POST /api/items/data-product-instance/[id]/provision
 *
 * Deploy (or re-deploy) every component of an already-spawned data product to
 * its real Azure backend via the shared Phase-2 provisioning engine — the SAME
 * one the install wizard uses (lakehouse→ADLS, adf-pipeline→ARM, kql→ADX, …).
 * Honest infra gates surface as status:'remediation' rows; nothing is faked.
 * The per-component report is persisted onto the instance state so the editor
 * can show live status after a refresh.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem, updateOwnedItem, jerr } from '../../../_lib/item-crud';
import { runProvisioning } from '@/lib/install/provisioning-engine';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return jerr('unauthenticated', 401);
  const id = (await ctx.params).id;
  const item = await loadOwnedItem(id, 'data-product-instance', session.claims.oid);
  if (!item) return jerr('not found', 404);

  const components: Array<{ slug: string; itemId: string; displayName: string }> =
    (item.state as any)?.components || [];
  if (components.length === 0) return jerr('no components to provision', 400);

  let report: unknown;
  try {
    report = await runProvisioning(
      session, `dpi:${id}`, item.workspaceId,
      components.map((c) => ({ itemType: c.slug, id: c.itemId, displayName: c.displayName })),
      { deploy: true, mode: 'shared' },
    );
  } catch (e: any) {
    return jerr(e?.message || String(e), 500);
  }

  await updateOwnedItem(id, 'data-product-instance', session.claims.oid, {
    state: { ...(item.state || {}), provisionReport: report, provisionedAt: new Date().toISOString() },
  }).catch(() => null);

  return NextResponse.json({ ok: true, report });
}
