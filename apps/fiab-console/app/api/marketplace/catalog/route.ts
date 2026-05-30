/**
 * GET /api/marketplace/catalog
 *
 * The consumer/catalog view over the tenant's published APIM surface — the
 * Loom equivalent of the APIM developer portal "APIs" gallery. Returns:
 *   - products:  every product, each with the APIs associated to it
 *   - apis:      flat list of all APIs (so APIs not in any product still show)
 *   - service:   gateway URL + provisioning state (for "Try it" base URL)
 *
 * Real Azure REST:
 *   GET .../products                      (listProducts)
 *   GET .../products/{id}/apis            (listProductApis, per product)
 *   GET .../apis                          (listApis)
 *   GET .../ (service)                    (getServiceInfo)
 *
 * Query: ?published=1 restricts products to state === 'published' (the
 * developer-portal default — only published products are discoverable).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listProducts, listProductApis, listApis, getServiceInfo, ApimError,
  type ApimProductSummary, type ApimApiSummary,
} from '@/lib/azure/apim-client';
import { apimGate, gateResponse } from '../_gate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export interface MarketplaceProduct extends ApimProductSummary {
  apis: ApimApiSummary[];
}

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const gate = apimGate();
  const gated = gateResponse(gate);
  if (gated) return gated;

  const onlyPublished = req.nextUrl.searchParams.get('published') === '1';

  try {
    const [allProducts, apis, service] = await Promise.all([
      listProducts(),
      listApis(),
      getServiceInfo().catch(() => null),
    ]);

    const products = onlyPublished
      ? allProducts.filter((p) => p.state === 'published')
      : allProducts;

    // Fan out per-product API associations in parallel.
    const withApis: MarketplaceProduct[] = await Promise.all(
      products.map(async (p) => {
        const productApis = await listProductApis(p.name || p.id).catch(() => []);
        return { ...p, apis: productApis };
      }),
    );

    return NextResponse.json({
      ok: true,
      service: service
        ? { name: service.name, gatewayUrl: service.gatewayUrl, state: service.state }
        : null,
      products: withApis,
      apis,
    });
  } catch (e: any) {
    const status = e instanceof ApimError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}
