/**
 * POST /api/dab/[id]/publish
 *   body { apiId, displayName?, path, productId?, subscriptionRequired? }
 *   → fetch the running DAB runtime's OpenAPI doc, import it into APIM as a REST
 *     API, optionally add it to a product + create a subscription, surfacing the
 *     keys. All real APIM control-plane via the existing apim-client.
 *
 * Honest gates:
 *   - DAB runtime unset (LOOM_DAB_PREVIEW_URL) → 503 (can't fetch OpenAPI).
 *   - APIM unconfigured (LOOM_SUBSCRIPTION_ID/LOOM_APIM_NAME) → importApiFromOpenApi
 *     throws; surfaced as 503 with the missing var.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { jerr } from '../../../items/_lib/item-crud';
import { dabRuntimeGate, fetchOpenApi } from '../../_lib/dab-runtime';
import {
  apimConfigGate,
  importApiFromOpenApi,
  addApiToProduct,
  createSubscription,
  getSubscriptionKeys,
  slugSid,
} from '@/lib/azure/apim-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return jerr('unauthenticated', 401);
  const { id } = await ctx.params;

  const dabGate = dabRuntimeGate();
  if (dabGate) {
    return NextResponse.json(
      { ok: false, gate: dabGate, error: `Cannot publish: the DAB runtime is not provisioned (set ${dabGate.missing}). The OpenAPI document is read from the running engine.` },
      { status: 503 },
    );
  }
  const apimGate = apimConfigGate();
  if (apimGate) {
    return NextResponse.json(
      { ok: false, gate: apimGate, error: `APIM not configured: set ${apimGate.missing}.` },
      { status: 503 },
    );
  }

  const body = await req.json().catch(() => ({}));
  const apiId = String(body.apiId || `dab-${id}`).trim();
  const path = String(body.path || `dab/${id}`).trim();
  const restBasePath = String(body.restBasePath || '/api');
  if (!apiId || !path) return jerr('apiId and path are required', 400);

  try {
    // 1. Pull the permission-aware OpenAPI doc from the running DAB engine.
    const { status, doc } = await fetchOpenApi(restBasePath);
    if (status >= 400 || !doc || typeof doc !== 'object') {
      return jerr(`DAB runtime returned ${status} for the OpenAPI document; ensure the engine is running this config.`, 502);
    }

    // 2. Import it into APIM as a REST API.
    const api = await importApiFromOpenApi({
      apiId,
      displayName: body.displayName ? String(body.displayName) : apiId,
      path,
      format: 'openapi+json',
      value: JSON.stringify(doc),
    });

    // 3. Optionally add to a product + create a subscription, surface keys.
    let subscription: { id: string; primaryKey?: string; secondaryKey?: string } | undefined;
    if (body.productId) {
      const productId = String(body.productId);
      await addApiToProduct(productId, apiId);
      if (body.subscriptionRequired) {
        const sid = slugSid(`dab-${apiId}`);
        const sub = await createSubscription({
          sid,
          displayName: `DAB ${apiId} subscription`,
          product: productId,
        });
        const subId = sub.name || sub.id || sid;
        const keys = await getSubscriptionKeys(subId);
        subscription = { id: subId, primaryKey: keys.primaryKey, secondaryKey: keys.secondaryKey };
      }
    }

    return NextResponse.json({ ok: true, api, subscription });
  } catch (e: any) {
    const msg = e?.message || String(e);
    // apim-client throws "APIM service not configured: set X" — surface as 503.
    if (/not configured/i.test(msg)) {
      return NextResponse.json({ ok: false, error: msg }, { status: 503 });
    }
    return jerr(msg, 502);
  }
}
