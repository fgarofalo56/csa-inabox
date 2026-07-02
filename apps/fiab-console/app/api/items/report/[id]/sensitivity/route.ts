/**
 * /api/items/report/[id]/sensitivity — WAVE-9 Microsoft Information Protection
 * (MIP) sensitivity-label ribbon for a Loom-native report.
 *
 * Azure-native default (no-fabric-dependency.md): labels come from the tenant's
 * Microsoft Information Protection policy via Microsoft Graph (mip-graph-client,
 * Console UAMI app-only). NO Power BI / Fabric workspace is involved; applying a
 * label is a Cosmos state write on the report item — the same state the data
 * catalog (governance-catalog-shapes.docForGovernanceItem) reads back as the
 * item's `sensitivityLabel`. The actual label-protection enforcement happens at
 * EXPORT time (report-export-label.applySensitivityStamp / checkExportProtection)
 * — this route only owns the read of available labels + the persisted choice.
 *
 *   GET  → { ok:true, labels:SensitivityLabel[], applied:{labelId,labelName}|null }
 *          On MipNotConfiguredError (LOOM_MIP_ENABLED !== 'true') we DON'T 500 —
 *          we honest-gate: 200 { ok:false, code:'mip-gate', gate:<hint>, applied }
 *          so the ribbon can still show the currently-applied label and render a
 *          Fluent MessageBar naming LOOM_MIP_ENABLED + the admin-plane bicep +
 *          grant-graph-approles.sh (no-vaporware.md honest infra gate).
 *
 *   PUT body { labelId:string }  ('' clears the label)
 *        → resolves the label via Graph, then persists onto the report item's
 *          state:
 *            state.sensitivityLabel          = label.name   (NAME — catalog reads this)
 *            state.sensitivityLabelId        = label.id     (GUID)
 *            state.sensitivityLabelInherited = false         (a manual, explicit choice)
 *        → { ok:true, applied:{labelId,labelName}|null }
 *
 * `[id]` is the report's Loom Cosmos item id (a `loom:` content-id is also
 * accepted). Ownership is verified via the parent workspace tenant, mirroring
 * the sibling …/definition + …/visual routes.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  isLoomContentId,
  cosmosIdFromLoomId,
  loadContentBackedItem,
} from '../../../_lib/pbi-content-fallback';
import { updateOwnedItem } from '../../../_lib/item-crud';
import {
  listSensitivityLabels,
  getSensitivityLabel,
  MipNotConfiguredError,
  MipError,
} from '@/lib/azure/mip-graph-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The label currently persisted on the item, in the GET/PUT response shape. */
function appliedFromState(state: Record<string, unknown> | undefined): { labelId: string; labelName: string } | null {
  const st = state || {};
  const labelId = typeof st.sensitivityLabelId === 'string' ? st.sensitivityLabelId : '';
  if (!labelId) return null;
  const labelName =
    typeof st.sensitivityLabel === 'string' && st.sensitivityLabel ? st.sensitivityLabel : labelId;
  return { labelId, labelName };
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const rawId = (await ctx.params).id;
  const cosmosId = isLoomContentId(rawId) ? cosmosIdFromLoomId(rawId) : rawId;

  const item = await loadContentBackedItem(cosmosId, 'report', session.claims.oid);
  if (!item) {
    return NextResponse.json({ ok: false, error: 'report item not found or not owned by you' }, { status: 404 });
  }
  const applied = appliedFromState(item.state as Record<string, unknown> | undefined);

  try {
    const labels = await listSensitivityLabels();
    return NextResponse.json({ ok: true, labels, applied });
  } catch (e: unknown) {
    // Honest MIP gate — env not wired. Still return `applied` so the ribbon can
    // show the report's current label and render the remediation MessageBar.
    if (e instanceof MipNotConfiguredError) {
      return NextResponse.json({ ok: false, code: 'mip-gate', gate: e.hint, applied });
    }
    // Graph reachable but refused (e.g. 403 — AppRole grant / admin consent
    // missing). Surface the real error verbatim; keep `applied` for the ribbon.
    const status = e instanceof MipError ? e.status : 502;
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e), applied },
      { status },
    );
  }
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const rawId = (await ctx.params).id;
  const cosmosId = isLoomContentId(rawId) ? cosmosIdFromLoomId(rawId) : rawId;

  let body: { labelId?: unknown } = {};
  try { body = await req.json(); } catch {}
  if (typeof body.labelId !== 'string') {
    return NextResponse.json(
      { ok: false, error: 'labelId is required (pass "" to clear the label)' },
      { status: 400 },
    );
  }
  const labelId = body.labelId.trim();

  const item = await loadContentBackedItem(cosmosId, 'report', session.claims.oid);
  if (!item) {
    return NextResponse.json({ ok: false, error: 'report item not found or not owned by you' }, { status: 404 });
  }

  // ADDITIVE state merge — keep every other state key (content, dataSource, the
  // AAS binding, …) untouched; only the sensitivity-label triplet changes.
  const st = { ...((item.state as Record<string, unknown>) || {}) };
  let applied: { labelId: string; labelName: string } | null = null;

  if (labelId === '') {
    // Clear the label entirely (catalog falls back to no/inherited label).
    delete st.sensitivityLabel;
    delete st.sensitivityLabelId;
    delete st.sensitivityLabelInherited;
    delete st.sensitivityLabelSource;
  } else {
    let label;
    try {
      label = await getSensitivityLabel(labelId);
    } catch (e: unknown) {
      if (e instanceof MipNotConfiguredError) {
        return NextResponse.json({ ok: false, code: 'mip-gate', gate: e.hint }, { status: 200 });
      }
      const status = e instanceof MipError ? e.status : 502;
      return NextResponse.json(
        { ok: false, error: e instanceof Error ? e.message : String(e) },
        { status },
      );
    }
    if (!label) {
      return NextResponse.json({ ok: false, error: 'sensitivity label not found' }, { status: 404 });
    }
    const labelName = label.name || label.displayName || label.id;
    st.sensitivityLabel = labelName; // NAME — the governance catalog reads this.
    st.sensitivityLabelId = label.id; // GUID — used by the export protection gate.
    st.sensitivityLabelInherited = false; // an explicit, manual choice (not upstream-inherited).
    delete st.sensitivityLabelSource;
    applied = { labelId: label.id, labelName };
  }

  const updated = await updateOwnedItem(cosmosId, 'report', session.claims.oid, { state: st });
  if (!updated) {
    return NextResponse.json({ ok: false, error: 'failed to persist sensitivity label' }, { status: 502 });
  }

  return NextResponse.json({ ok: true, applied });
}
