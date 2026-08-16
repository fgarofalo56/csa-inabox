/**
 * POST /api/items/graphql-api/[id]/publish
 *   Push the saved SDL spec for this item up to APIM as a GraphQL API
 *   (apiType=graphql). Body: { displayName, path, sdl, serviceUrl? }
 *   The Cosmos `state` itself is persisted via the generic
 *   PATCH /api/items/graphql-api/[id]. This route only handles the
 *   APIM-side publish action.
 *
 * AUTHORIZATION (GHSA-hf73-rp4q-66pf) — `withWorkspaceOwner('graphql-api')`.
 *   This handler PUBLISHED AN API TO THE DEPLOYMENT'S APIM INSTANCE under the
 *   caller-supplied `[id]` with no item-level check, so any signed-in caller
 *   could create or OVERWRITE the APIM API belonging to another tenant's
 *   graphql-api item — including its `path`, its SDL and its backend
 *   `serviceUrl`, which is what every subsequent gateway call resolves through.
 *
 *   It was excused by check-route-guards' SHARED_BACKEND_ITEM_ROUTES on the
 *   premise "specific-per-item-TYPE route over a SHARED Azure backend … no
 *   per-tenant Cosmos ownership to scope". Its own sibling `graphql-api/[id]`
 *   resolves the SAME `[id]` through `loadOwnedItem` / `updateOwnedItem` /
 *   `deleteOwnedItem`, so the second half of that premise was provably false.
 *   The path graduates into NOW_GUARDED rather than staying allowlisted-but-
 *   guarded, so dropping the wrapper re-flags instead of staying masked.
 *
 * WHY `withWorkspaceOwner` HERE AND NOT `authorizeItemWorkspace` — unlike the
 *   Power BI family in this same advisory, a `graphql-api` `[id]` is ALWAYS a
 *   Loom Cosmos item (there is no list route that enumerates raw backend ids for
 *   this type — the APIM api id is minted FROM the Loom item id by this very
 *   route). So the stricter wrapper, which 404s an id with no item behind it, is
 *   correct and costs no reachable caller.
 *
 * NO `allowReadRoles`: publishing is a mutation of the shared APIM instance.
 *
 * THE APIM api id STILL USES THE RAW ROUTE ID, DELIBERATELY. `[id]/query`
 *   resolves the published API with `getApi(rawId)` from the same raw route
 *   param, while `loadOwnedItem` resolves the `loom:` synthetic-id prefix
 *   internally for the OWNERSHIP lookup only. Naming the APIM upsert from the
 *   resolved `item.id` would diverge for every bundle-installed API — whose
 *   route id is `loom:<cosmosId>` — and publish would write to one apiId while
 *   query read another. There is a test for exactly that.
 */
import { NextResponse } from 'next/server';
import { withWorkspaceOwner } from '@/lib/api/route-toolkit';
import { publishGraphqlApi, ApimError } from '@/lib/azure/apim-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'graphql-api';

export const POST = withWorkspaceOwner(ITEM_TYPE, async (req, { params }) => {
  const body = await req.json().catch(() => ({}));
  const displayName = String(body?.displayName || '').trim();
  const path = String(body?.path || '').trim();
  const sdl = String(body?.sdl || '');
  if (!displayName) return NextResponse.json({ ok: false, error: 'displayName required' }, { status: 400 });
  if (!path) return NextResponse.json({ ok: false, error: 'path required' }, { status: 400 });
  if (!sdl.trim()) return NextResponse.json({ ok: false, error: 'sdl (schema) required' }, { status: 400 });
  try {
    const api = await publishGraphqlApi(params.id, {
      displayName,
      path,
      sdl,
      protocols: ['https'],
      subscriptionRequired: body?.subscriptionRequired ?? true,
      serviceUrl: body?.serviceUrl,
      description: body?.description,
    });
    return NextResponse.json({ ok: true, api });
  } catch (e: any) {
    const status = e instanceof ApimError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body, status }, { status });
  }
});
