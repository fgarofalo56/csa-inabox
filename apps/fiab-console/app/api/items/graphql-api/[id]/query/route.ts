/**
 * POST /api/items/graphql-api/[id]/query
 *   Run a GraphQL query against the published APIM GraphQL endpoint for this
 *   item. Body: { query, variables? }. The route resolves the API path +
 *   gateway URL + all-access key server-side and POSTs the GraphQL request,
 *   exactly like the APIM GraphQL test console.
 *
 *   Returns { ok, status, body } where body is the GraphQL JSON response text.
 *   If the item has not been published to APIM yet, returns 409 with guidance.
 *
 * AUTHORIZATION (GHSA-hf73-rp4q-66pf) — `withWorkspaceOwner('graphql-api',
 *   { allowReadRoles: true })`. This handler executed a caller-authored GraphQL
 *   document against another tenant's published API with no item-level check,
 *   using the SERVER-HELD APIM all-access subscription key — so the caller never
 *   needed a credential of their own, and the query reached whatever backend that
 *   API's resolvers front.
 *
 *   It was excused by check-route-guards' SHARED_BACKEND_ITEM_ROUTES on "no
 *   per-tenant Cosmos ownership to scope"; its own sibling `graphql-api/[id]`
 *   resolves the SAME `[id]` through `loadOwnedItem`, so that premise was
 *   provably false. The path graduates into NOW_GUARDED.
 *
 *   `withWorkspaceOwner` (not `authorizeItemWorkspace`) because a `graphql-api`
 *   `[id]` is ALWAYS a Loom Cosmos item — the APIM apiId is minted FROM it by
 *   `[id]/publish` — so the stricter 404-on-no-item wrapper costs no reachable
 *   caller. `allowReadRoles` because running a query is what USING the API is;
 *   the mutation (publish) is write-scoped in its own route.
 *
 * THE APIM api id STILL USES THE RAW ROUTE ID, matching `[id]/publish`:
 *   `loadOwnedItem` resolves the `loom:` synthetic-id prefix for the OWNERSHIP
 *   lookup only, so resolving `getApi()` from `item.id` instead would look up a
 *   different apiId than publish wrote for every bundle-installed API.
 */
import { NextResponse } from 'next/server';
import { withWorkspaceOwner } from '@/lib/api/route-toolkit';
import { enforceRateLimit } from '@/lib/azure/rate-limiter';
import { getApi, testApiCall, ApimError } from '@/lib/azure/apim-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'graphql-api';

export const POST = withWorkspaceOwner(ITEM_TYPE, { allowReadRoles: true }, async (req, { session, params }) => {
  const limited = await enforceRateLimit(session, 'query');
  if (limited) return limited;
  const id = params.id;
  const b = await req.json().catch(() => ({}));
  const query = String(b?.query || '').trim();
  if (!query) return NextResponse.json({ ok: false, error: 'query is required' }, { status: 400 });
  try {
    // The publish route upserts the API under the Loom item id, so the APIM
    // apiId == item id. Resolve its path for the gateway URL.
    const api = await getApi(id);
    if (!api) {
      return NextResponse.json({
        ok: false,
        error: 'This GraphQL API is not published to APIM yet. Click "Publish to APIM" first.',
      }, { status: 409 });
    }
    const result = await testApiCall({
      apiPath: api.path || '',
      urlTemplate: '', // GraphQL APIs expose a single endpoint at the API path root
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables: b?.variables || {} }),
    });
    // HONEST GATE: a synthetic GraphQL API with NO field resolver policies and
    // no backend service URL answers every query with "Resolvers are not
    // defined and a service url is not configured". Surface the real cause —
    // nothing is mapped yet — instead of wrapping that raw backend error.
    const bodyText = typeof result.body === 'string' ? result.body : JSON.stringify(result.body ?? '');
    if (result.status >= 400 && /resolvers are not defined/i.test(bodyText)) {
      return NextResponse.json({
        ok: false,
        error: 'This GraphQL API has no entities/resolvers defined yet.',
        code: 'no_resolvers',
        gate: {
          reason: 'This GraphQL API has no entities/resolvers defined yet — no field is mapped to a backend, so every query fails.',
          remediation: 'Use the "Edit resolver policies" ribbon action (Home › Resolvers — opens the apim-policy editor for this API) to author set-graphql-resolver policies mapping each field to its backend, or set the "Backend service URL" field and republish.',
        },
      }, { status: 409 });
    }
    return NextResponse.json({ ok: true, status: result.status, body: result.body });
  } catch (e: any) {
    const status = e instanceof ApimError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), status }, { status });
  }
});
