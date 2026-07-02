/**
 * POST /api/items/data-product-template/[id]/instantiate
 *   body {
 *     workspaceId, displayName,
 *     components?: Array<{ slug; label; renameTo? }>   // optional customization — subset/renamed
 *     provision?: boolean                              // also deploy artifacts to live Azure backends
 *   }
 *
 * Walks the template's `components[]` (or the caller-customized subset) and
 * creates each as a real item in the caller's workspace (via the existing
 * _lib/item-crud.createOwnedItem), then persists a parent `data-product-instance`
 * linking them all. When `provision` is true, runs the SAME Phase-2 provisioning
 * engine every other install path uses (real Azure side-effects, honest gates)
 * and stamps the per-component report onto the instance.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { createOwnedItem } from '../../../_lib/item-crud';
import { CURATED_TEMPLATES } from '@/lib/catalog/data-product-templates';
import { runProvisioning } from '@/lib/install/provisioning-engine';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const workspaceId = String(body?.workspaceId || '').trim();
  const displayName = String(body?.displayName || '').trim();
  const provision = body?.provision === true;
  if (!workspaceId || !displayName) {
    return NextResponse.json({ ok: false, error: 'workspaceId and displayName are required' }, { status: 400 });
  }
  const { id: templateSlug } = await ctx.params;
  const template = CURATED_TEMPLATES.find((t) => t.slug === templateSlug);
  if (!template) return NextResponse.json({ ok: false, error: 'template not found' }, { status: 404 });

  // Resolve which components to materialize: the caller may pass a customized
  // subset (toggled-off rows dropped, rows renamed). Match by slug+label so a
  // template with two same-slug rows (3× lakehouse) stays unambiguous. Falls
  // back to the full template when no customization is supplied.
  const overrides: Array<{ slug: string; label: string; renameTo?: string }> = Array.isArray(body?.components) ? body.components : [];
  const plan = overrides.length
    ? template.components
        .map((c) => {
          const o = overrides.find((x) => x.slug === c.slug && x.label === c.label);
          return o ? { ...c, label: (o.renameTo || c.label).trim() || c.label } : null;
        })
        .filter((c): c is typeof template.components[number] => c !== null)
    : [...template.components];
  if (plan.length === 0) {
    return NextResponse.json({ ok: false, error: 'no components selected' }, { status: 400 });
  }

  // Materialize each component as a child item.
  const created: Array<{ slug: string; itemId: string; displayName: string }> = [];
  const errors: Array<{ slug: string; error: string }> = [];
  for (const comp of plan) {
    const r = await createOwnedItem(session, comp.slug, {
      workspaceId,
      displayName: `${displayName} — ${comp.label}`,
      description: comp.description,
      state: { ...(comp.defaultState || {}), spawnedFromTemplate: template.slug },
    });
    if (r.ok) created.push({ slug: comp.slug, itemId: r.item.id, displayName: r.item.displayName });
    else errors.push({ slug: comp.slug, error: r.error });
  }

  // Optional: provision each created child against its real Azure backend
  // (lakehouse→ADLS, adf-pipeline→ARM, etc.). Best-effort — a provisioner that
  // hits an honest infra gate returns status:'remediation' and is reported, not
  // thrown. Cosmos-only types (no provisioner) are silently fine.
  let provisionReport: unknown = null;
  if (provision && created.length) {
    try {
      const report = await runProvisioning(
        session, `dpt:${template.slug}`, workspaceId,
        created.map((c) => ({ itemType: c.slug, id: c.itemId, displayName: c.displayName })),
        { deploy: true, mode: 'shared' },
      );
      provisionReport = report;
    } catch (e: any) {
      provisionReport = { outcome: 'partial', error: e?.message || String(e) };
    }
  }

  // Persist the parent instance.
  const parent = await createOwnedItem(session, 'data-product-instance', {
    workspaceId,
    displayName,
    description: template.description,
    state: {
      template: template.slug,
      components: created,
      errors,
      provisionReport,
      instantiatedAt: new Date().toISOString(),
    },
  });

  if (!parent.ok) {
    return NextResponse.json({ ok: false, error: parent.error, created, errors }, { status: parent.status });
  }
  return NextResponse.json({ ok: true, instance: parent.item, created, errors, provisionReport }, { status: 201 });
}
