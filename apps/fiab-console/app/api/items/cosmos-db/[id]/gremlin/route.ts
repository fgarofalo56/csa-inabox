/**
 * POST /api/items/cosmos-db/[id]/gremlin
 *   body { query, lang? } — runs a Gremlin (Apache TinkerPop) traversal against
 *   the Cosmos DB Gremlin API and returns the raw GraphSON rows so the
 *   gremlin-graph-canvas can map them to vertices + edges.
 *
 * Honest gates (per no-vaporware.md / no-fabric-dependency.md — this is a
 * 100% Azure-native path, no Fabric anywhere):
 *
 *   1. **not_gremlin_account (422)** — the Cosmos account being explored does
 *      NOT have the Gremlin API enabled (ARM `capabilities` has no
 *      `EnableGremlin`) AND no dedicated Gremlin runtime is wired. Cosmos can't
 *      turn an existing NoSQL account into a Gremlin account, so the surface
 *      tells the operator to provision a Gremlin-capable account (the
 *      `cosmos-graph-vector.bicep` module does exactly this) and set
 *      `LOOM_COSMOS_GREMLIN_ENDPOINT`.
 *   2. **not_configured (503)** — a Gremlin account exists but the runtime
 *      endpoint / npm driver isn't wired. `executeGremlin` raises this with the
 *      exact env var + role to set.
 *
 * Traversal mutations (addV / addE) flow through the same `executeGremlin`
 * path as reads — the canvas re-queries `g.V()` afterwards to confirm
 * persistence (real round-trip, not a fake "saved" toast).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { executeGremlin, GremlinError } from '@/lib/azure/gremlin-client';
import { gqlToGremlin, TranslationError } from '@/lib/azure/cypher-kql-translator';
import { cosmosConfigGate, getAccountInfo } from '@/lib/azure/cosmos-account-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NOT_GREMLIN_MESSAGE =
  'This Cosmos DB account does not have the Gremlin (graph) API enabled. The Gremlin API ' +
  'cannot be turned on for an existing NoSQL account — it requires a dedicated account ' +
  'provisioned with capability EnableGremlin. Deploy one with ' +
  'platform/fiab/bicep/modules/landing-zone/cosmos-graph-vector.bicep (it creates a ' +
  'GlobalDocumentDB account + loom-graph database + default graph), then set ' +
  'LOOM_COSMOS_GREMLIN_ENDPOINT (e.g. wss://<account>.gremlin.cosmos.azure.com:443/) on the ' +
  'Console Container App and grant the Console UAMI the Cosmos DB Built-in Data Contributor role.';

export async function POST(req: NextRequest, _ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  let query = String(body?.query || '').trim();
  const lang = String(body?.lang || 'gremlin');
  if (!query) return NextResponse.json({ ok: false, error: 'query is required' }, { status: 400 });

  // GQL best-effort: translate ISO GQL MATCH…RETURN to a Gremlin traversal
  // before execution (parity with the cosmos-gremlin-graph editor route).
  let translated: string | undefined;
  if (lang === 'gql') {
    try {
      translated = gqlToGremlin(query);
      query = translated;
    } catch (e: any) {
      const t = e instanceof TranslationError ? e : new TranslationError(String(e));
      return NextResponse.json(
        { ok: false, error: `GQL → Gremlin translation failed: ${t.message}`, hint: t.hint },
        { status: 422 },
      );
    }
  }

  // Honest gate (1): when a dedicated Gremlin runtime endpoint isn't wired,
  // verify the navigator account is actually Gremlin-capable. A non-Gremlin
  // account (no EnableGremlin capability) gets a precise 422 — no fake result.
  if (!process.env.LOOM_COSMOS_GREMLIN_ENDPOINT && !cosmosConfigGate()) {
    let info: Awaited<ReturnType<typeof getAccountInfo>> = null;
    try {
      info = await getAccountInfo();
    } catch {
      // ARM read failed (e.g. RBAC) — fall through to the runtime gate below,
      // which surfaces the precise endpoint/role remediation.
      info = null;
    }
    if (info && !info.capabilities.includes('EnableGremlin')) {
      return NextResponse.json(
        { ok: false, error: NOT_GREMLIN_MESSAGE, gate: 'not_gremlin_account', capabilities: info.capabilities },
        { status: 422 },
      );
    }
  }

  // Honest gate (2) + real backend: executeGremlin runs the traversal against
  // the live Cosmos Gremlin endpoint, or raises GremlinError(503) naming the
  // exact env var / role / npm package to wire.
  try {
    const result = await executeGremlin(query);
    return NextResponse.json({ ok: true, translated, ...result });
  } catch (e: any) {
    const status = e instanceof GremlinError ? e.status : 502;
    return NextResponse.json(
      { ok: false, error: e?.message || String(e), deferred: status === 503 },
      { status },
    );
  }
}
