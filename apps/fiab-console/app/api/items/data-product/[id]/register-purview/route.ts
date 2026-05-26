/**
 * POST /api/items/data-product/[id]/register-purview
 *
 * Phase 1 of the Purview Unified Catalog wiring. Loads a `data-product` item
 * from Cosmos, builds the Unified Catalog payload from `item.state`, calls
 * `registerDataProduct`, and persists the returned Purview id +
 * lastRegisteredAt back onto the item so the editor can switch from "pending"
 * to "registered" on the next render.
 *
 * Status semantics:
 *   200 — Purview registered + Cosmos updated. Body: { ok, purviewDataProductId, lastRegisteredAt, item, dataProduct }.
 *   401 — Unauthenticated.
 *   404 — Cosmos item not found (or not owned by caller's tenant).
 *   422 — `state.domain` is missing or is a free-text label rather than a Purview businessDomainId GUID.
 *         The editor surfaces a clear "first create/select a domain" guidance.
 *   501 — Purview is not provisioned in this deployment (LOOM_PURVIEW_ACCOUNT unset). Body carries the
 *         structured `hint` payload from PurviewNotConfiguredError so the operator sees the bicep module
 *         path + roles to grant.
 *   502 — Upstream Purview call failed (network / 5xx / RBAC denial). Body carries the Purview error body.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  registerDataProduct,
  PurviewNotConfiguredError,
  PurviewError,
  type PurviewDataProductPayload,
} from '@/lib/azure/purview-client';
import { loadOwnedItem, updateOwnedItem } from '../../../_lib/item-crud';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'data-product';

// Loose GUID-shaped check. Purview accepts the bare GUID for businessDomainId
// in the Unified Catalog data plane. We reject free-text labels here rather
// than silently substituting a placeholder.
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function err(error: string, status: number, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ ok: false, error, ...extra }, { status });
}

export async function POST(_req: NextRequest, ctx: { params: { id: string } }) {
  const session = getSession();
  if (!session) return err('unauthenticated', 401);

  // 1. Load the Cosmos item (tenant-scoped).
  const item = await loadOwnedItem(ctx.params.id, ITEM_TYPE, session.claims.oid);
  if (!item) return err('data-product item not found', 404);

  const state = (item.state || {}) as Record<string, unknown>;
  const displayName = (state.displayName as string) || item.displayName;
  const description = (state.description as string) || item.description || '';
  const domain = (state.domain as string) || '';
  const owner = (state.owner as string) || '';
  const sla = (state.sla as string) || '';
  const bundle = Array.isArray(state.bundle) ? (state.bundle as unknown[]).filter((x): x is string => typeof x === 'string') : [];

  if (!displayName?.trim()) {
    return err('displayName is required before registering with Purview', 422, {
      hint: 'Fill in the Display name field on the data-product editor, save, then try again.',
    });
  }

  if (!domain.trim()) {
    return err(
      'Purview businessDomainId is required',
      422,
      {
        hint: 'The data-product editor does not yet expose a governance-domain picker (Phase 2 of the parity spec). Set state.domain to a Purview businessDomainId GUID before registering. Until a domain picker ships, you can populate this by editing the Cosmos record directly or by running scripts/csa-loom/grant-purview-rbac.sh which seeds the default `csa-loom-default` governance domain.',
        field: 'state.domain',
      },
    );
  }

  if (!GUID_RE.test(domain.trim())) {
    return err(
      'state.domain must be a Purview businessDomainId GUID, not a free-text label',
      422,
      {
        hint: 'Purview requires the businessDomainId (a GUID returned by GET /datagovernance/catalog/businessdomains), not a label like "Finance" or "Sales". Phase 2 of the parity spec adds a governance-domain Dropdown that resolves labels to ids automatically. Until then, look up the GUID in the Purview portal under Catalog management → Governance domains, paste it into state.domain, save, then re-register.',
        field: 'state.domain',
        received: domain,
      },
    );
  }

  // 2. Build payload and call Purview.
  const payload: PurviewDataProductPayload = {
    displayName: displayName.trim(),
    description: description || undefined,
    domain: domain.trim(),
    owner: owner || undefined,
    sla: sla || undefined,
    bundle,
  };

  let dataProduct;
  try {
    dataProduct = await registerDataProduct(payload);
  } catch (e: any) {
    if (e instanceof PurviewNotConfiguredError) {
      return NextResponse.json(
        {
          ok: false,
          error: e.message,
          code: 'purview_not_configured',
          hint: e.hint,
        },
        { status: 501 },
      );
    }
    if (e instanceof PurviewError) {
      return NextResponse.json(
        {
          ok: false,
          error: e.message,
          code: 'purview_error',
          status: e.status,
          body: e.body,
        },
        { status: e.status >= 400 && e.status < 500 ? e.status : 502 },
      );
    }
    return err(e?.message || 'Unexpected error calling Purview', 502);
  }

  if (!dataProduct?.id) {
    return err('Purview accepted the request but returned no id', 502, { dataProduct });
  }

  // 3. Persist the Purview id + timestamp back to Cosmos. Preserve all
  // existing state fields by spreading `state` first.
  const lastRegisteredAt = new Date().toISOString();
  const nextState = {
    ...state,
    purviewDataProductId: dataProduct.id,
    lastRegisteredAt,
  };

  const updated = await updateOwnedItem(item.id, ITEM_TYPE, session.claims.oid, {
    state: nextState,
  });
  if (!updated) {
    // Purview succeeded but our write failed. Surface both so the operator
    // doesn't lose the id.
    return NextResponse.json(
      {
        ok: false,
        error: 'Purview registration succeeded but the Cosmos write to record purviewDataProductId failed. Retry to update the item.',
        code: 'cosmos_write_failed',
        purviewDataProductId: dataProduct.id,
        lastRegisteredAt,
        dataProduct,
      },
      { status: 500 },
    );
  }

  return NextResponse.json(
    {
      ok: true,
      purviewDataProductId: dataProduct.id,
      lastRegisteredAt,
      item: updated,
      dataProduct,
    },
    { status: 200 },
  );
}
