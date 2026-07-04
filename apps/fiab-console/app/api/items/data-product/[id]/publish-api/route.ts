/**
 * POST /api/items/data-product/[id]/publish-api
 *
 * F21 — Publish-as-API edge: expose a published data product as a consumable
 * API via Azure API Management. Confirms the backing query endpoint
 * (`serviceUrl`), then in one transaction:
 *   1. PUT /apis/{apiId}                  — create/replace the APIM API
 *   2. PUT /products/{productId}          — create/replace + publish an APIM product
 *   3. PUT /products/{productId}/apis/{apiId} — associate the API with the product
 *   4. PUT /subscriptions/{sid}           — mint an active subscription (skip approval)
 *   5. POST /subscriptions/{sid}/listSecrets — read the subscription key
 * and persists the resulting API/product/subscription/gateway refs back onto the
 * Cosmos data-product item so the editor shows the consumable URL + key guidance.
 *
 * The gateway URL is read live from ARM (getServiceInfo().gatewayUrl) — never
 * hardcoded — so the callable endpoint is correct in every sovereign cloud
 * (.azure-api.net / .azure-api.us / DoD).
 *
 * Status semantics:
 *   200 — APIM API+product+subscription created + Cosmos updated. Body carries
 *         { apiId, productId, sid, gatewayUrl, callableUrl, primaryKey, apimCreate }.
 *   400 — Missing/invalid serviceUrl.
 *   401 — Unauthenticated.
 *   404 — Cosmos item not found (or not owned by caller's tenant).
 *   502 — Upstream APIM call failed, or the APIM gateway URL could not be resolved.
 *   503 — APIM is not configured in this deployment (honest infra-gate).
 *
 * No Microsoft Fabric / OneLake / Power BI dependency — pure Azure ARM.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  apimConfigGate,
  apimTarget,
  getServiceInfo,
  upsertApi,
  upsertProduct,
  addApiToProduct,
  createSubscription,
  getSubscriptionKeys,
  ApimError,
} from '@/lib/azure/apim-client';
import { loadOwnedItem, updateOwnedItem } from '../../../_lib/item-crud';
import { apiError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'data-product';

function err(error: string, status: number, extra: Record<string, unknown> = {}) {
  return apiError(error, status, extra);
}

/** APIM entity ids must start alphanumeric, then [a-zA-Z0-9-], max 256. */
function apimBaseId(id: string): string {
  return id
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || `dp-${Date.now()}`;
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return err('unauthenticated', 401);

  // 1. Honest infra-gate — APIM must be configured for this deployment.
  const gate = apimConfigGate();
  if (gate) {
    const t = apimTarget();
    return NextResponse.json(
      {
        ok: false,
        gated: true,
        code: 'apim_not_configured',
        error: 'Azure API Management is not configured in this deployment.',
        missing: gate.missing,
        hint: `Set ${gate.missing} on the loom-console container app (LOOM_SUBSCRIPTION_ID is required; LOOM_APIM_NAME / LOOM_APIM_RG default to ${t.name} / ${t.resourceGroup}). Grant the Console UAMI "API Management Service Contributor" on the APIM service.`,
        bicepModule: 'platform/fiab/bicep/modules/admin-plane/apim.bicep',
      },
      { status: 503 },
    );
  }

  // 2. Validate body.
  const body = await req.json().catch(() => ({}));
  const serviceUrl = String(body?.serviceUrl || '').trim();
  if (!serviceUrl) {
    return err('serviceUrl (the backing query endpoint) is required', 400, {
      hint: 'Provide the HTTPS URL that serves this data product’s data — APIM proxies consumer calls to it.',
    });
  }
  if (!/^https?:\/\//i.test(serviceUrl)) {
    return err('serviceUrl must be an absolute http(s) URL', 400, { received: serviceUrl });
  }

  // 3. Load the Cosmos item (tenant-scoped).
  const { id } = await ctx.params;
  const item = await loadOwnedItem(id, ITEM_TYPE, session.claims.oid);
  if (!item) return err('data-product item not found', 404);

  const state = (item.state || {}) as Record<string, unknown>;

  // 4. Derive stable, APIM-valid ids from the item id.
  const base = apimBaseId(id);
  const apiId = `dp-${base}`.slice(0, 80);
  const productId = `dp-prod-${base}`.slice(0, 80);
  const sid = `sub-dp-${base}`.slice(0, 80);
  const apiPath = String(body?.path || '').trim() || `dp/${base}`;
  const displayName = (
    String(body?.displayName || '').trim() ||
    (state.displayName as string) ||
    item.displayName ||
    'Data Product API'
  ).slice(0, 300);
  const description = (
    String(body?.description || '').trim() ||
    (state.description as string) ||
    ''
  ).slice(0, 1000);

  // 5. Resolve the cloud-authoritative gateway URL from live ARM.
  let gatewayUrl: string | undefined;
  try {
    const svc = await getServiceInfo();
    gatewayUrl = svc?.gatewayUrl;
  } catch (e: any) {
    const status = e instanceof ApimError ? e.status : 502;
    return err(e?.message || 'Failed to read APIM service info', status, { body: e?.body });
  }
  if (!gatewayUrl) {
    return err(
      'Could not resolve the APIM gateway URL; verify LOOM_APIM_NAME and LOOM_APIM_RG point at a provisioned APIM service.',
      502,
    );
  }

  // 6. Real ARM sequence — any failure surfaces APIM's own validation message.
  let api, product, subscription, keys;
  try {
    api = await upsertApi(apiId, {
      displayName,
      path: apiPath,
      protocols: ['https'],
      subscriptionRequired: true,
      serviceUrl,
      description: description || undefined,
    });
    product = await upsertProduct(productId, {
      displayName,
      description: description || undefined,
      subscriptionRequired: true,
      approvalRequired: false,
      state: 'published',
    });
    await addApiToProduct(productId, apiId);
    subscription = await createSubscription({
      sid,
      displayName: `${displayName} — data product consumer`,
      product: productId,
      state: 'active',
    });
    keys = await getSubscriptionKeys(sid);
  } catch (e: any) {
    const status = e instanceof ApimError ? (e.status >= 400 && e.status < 500 ? e.status : 502) : 502;
    return err(e?.message || 'Upstream APIM call failed', status, { body: e?.body });
  }

  const callableUrl = `${gatewayUrl.replace(/\/+$/, '')}/${apiPath.replace(/^\/+/, '')}`;
  const apimPublishedAt = new Date().toISOString();

  // 7. Persist the API refs back to Cosmos (preserve all existing state). The
  // subscription KEY is intentionally NOT persisted — it is returned once to
  // the editor and never stored on the item.
  const nextState = {
    ...state,
    apimApiId: apiId,
    apimProductId: productId,
    apimSubscriptionId: sid,
    apimGatewayUrl: gatewayUrl,
    apimServiceUrl: serviceUrl,
    apimApiPath: apiPath,
    apimPublishedAt,
  };

  const updated = await updateOwnedItem(item.id, ITEM_TYPE, session.claims.oid, {
    state: nextState,
  });
  if (!updated) {
    // APIM succeeded but our write failed — surface everything so the operator
    // doesn't lose the callable endpoint + key.
    return NextResponse.json(
      {
        ok: false,
        code: 'cosmos_write_failed',
        error:
          'APIM published the data product API but the Cosmos write to record the API ref failed. The endpoint is live; retry to persist the ref.',
        apiId,
        productId,
        sid,
        gatewayUrl,
        callableUrl,
        primaryKey: keys.primaryKey,
        apimCreate: { api, product, subscription },
      },
      { status: 500 },
    );
  }

  return NextResponse.json(
    {
      ok: true,
      apiId,
      productId,
      sid,
      gatewayUrl,
      callableUrl,
      primaryKey: keys.primaryKey,
      secondaryKey: keys.secondaryKey,
      apimPublishedAt,
      apimCreate: { api, product, subscription },
      item: updated,
    },
    { status: 200 },
  );
}
