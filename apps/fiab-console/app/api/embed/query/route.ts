/**
 * POST /api/embed/query — serve a governed metric to an EMBED viewer (N18).
 *
 * The data endpoint the `<loom-report>` web component / `@csa-loom/embed` React
 * wrapper fetch. Authentication is the signed EMBED TOKEN itself (minted at
 * `POST /api/embed/token`), NOT a Loom session cookie — a public host page has
 * no cookie. The token is presented as `Authorization: Bearer loom_embed_…` or
 * an `x-loom-embed-token` header; {@link verifyEmbedToken} checks the HMAC
 * (constant-time), audience, and expiry, and yields the effective identity.
 *
 * ROW-LEVEL SECURITY, AT QUERY TIME: the token's `rls` claims are converted to
 * structured metric filters and passed as `rls` to the ONE governed execute
 * path {@link runGovernedMetricQuery}, which ANDs them into the compiled WHERE
 * as bound TDS parameters / centrally-escaped KQL literals BEFORE execution.
 * Two different token identities therefore read DIFFERENT rows from the SAME
 * governed metric — enforced at the Synapse/ADX engine, never by hiding rows in
 * the client. The RLS predicates are also folded into the result-cache key so
 * one identity can never serve another's cached rows.
 *
 * The governed spec + metric registry resolve under the TOKEN OWNER's oid (the
 * signed-in owner who minted the token), so the embed viewer reaches only that
 * owner's governed metrics — never arbitrary tenant data. Every read writes the
 * same audited data-access row as `/api/metrics/query`, with `actor.who` set to
 * the embed identity for provenance.
 *
 * Body: { metric, dimensions?, filters?, grain?, engine? } — same as the N15
 * endpoint. `engine` defaults to `synapse`. NO Power BI host, NO Fabric F-SKU —
 * identical on every cloud (this IS the Gov embed story). IL5: in-boundary.
 *
 * Auth model note (route-guards): this route intentionally does NOT call
 * `getSession()` — the embed token is the cryptographic credential, verified
 * server-side, carrying the owner identity the governed query is scoped to.
 */

import type { NextRequest } from 'next/server';
import { apiOk, apiError, apiServerError } from '@/lib/api/respond';
import { runtimeFlag } from '@/lib/admin/runtime-flags';
import { METRIC_ENGINES, type MetricEngine, type MetricFilter } from '@/lib/metrics/metric-compiler';
import { runGovernedMetricQuery } from '@/lib/metrics/run';
import { parseEmbedAuthHeader, verifyEmbedToken, rlsClaimsToFilters } from '@/lib/embed/embed-token';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The N18 FLAG0 kill-switch id (shared with the mint route). */
const EMBED_FLAG_ID = 'n18-embedded-analytics';

interface EmbedQueryBody {
  metric?: unknown;
  dimensions?: unknown;
  filters?: unknown;
  grain?: unknown;
  engine?: unknown;
}

function parseEngine(v: unknown): MetricEngine {
  return typeof v === 'string' && (METRIC_ENGINES as readonly string[]).includes(v)
    ? (v as MetricEngine)
    : 'synapse';
}

function parseDimensions(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean);
}

/** Coerce request `filters` into typed predicates (the compiler re-validates names). */
function parseFilters(v: unknown): MetricFilter[] {
  if (!Array.isArray(v)) return [];
  const out: MetricFilter[] = [];
  const ops = new Set(['=', '!=', '>', '>=', '<', '<=', 'in']);
  for (const raw of v) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const dimension = typeof r.dimension === 'string' ? r.dimension.trim() : '';
    const op = typeof r.op === 'string' && ops.has(r.op) ? (r.op as MetricFilter['op']) : '=';
    if (!dimension) continue;
    const value = r.value as MetricFilter['value'];
    if (value === undefined || value === null) continue;
    out.push({ dimension, op, value });
  }
  return out;
}

export async function POST(req: NextRequest) {
  // FLAG0 kill-switch (default-ON). OFF → guided "turned off" gate; already-issued
  // tokens stop resolving here.
  if (!(await runtimeFlag(EMBED_FLAG_ID, { default: true }))) {
    return apiError('Embedded analytics is turned off (admin → runtime flags).', 503, {
      code: 'embed_off',
    });
  }

  // Authenticate the EMBED TOKEN (not a session cookie).
  const token =
    parseEmbedAuthHeader(req.headers.get('authorization')) ??
    parseEmbedAuthHeader(req.headers.get('x-loom-embed-token'));
  const claims = verifyEmbedToken(token);
  if (!claims) {
    return apiError('invalid or expired embed token', 401, { code: 'embed_unauthorized' });
  }

  const body = (await req.json().catch(() => ({}))) as EmbedQueryBody;
  const metric = typeof body.metric === 'string' ? body.metric.trim() : '';
  if (!metric) return apiError('metric is required', 400);

  // The identity's RLS claims → structured filters, ANDed at the engine.
  const rls = rlsClaimsToFilters(claims.rls);

  try {
    const outcome = await runGovernedMetricQuery(
      {
        // Resolve the governed spec under the TOKEN OWNER; audit under the
        // effective embed identity for provenance.
        oid: claims.oid,
        who: `embed:${claims.sub}`,
        tenantId: claims.tid || claims.oid,
      },
      {
        metric,
        dimensions: parseDimensions(body.dimensions),
        filters: parseFilters(body.filters),
        rls,
        grain: typeof body.grain === 'string' ? body.grain.trim() : undefined,
        engine: parseEngine(body.engine),
      },
    );
    if (!outcome.ok) {
      return apiError(outcome.error, outcome.status, {
        ...(outcome.code ? { code: outcome.code } : {}),
        ...(outcome.missing ? { missing: outcome.missing } : {}),
      });
    }
    return apiOk({ ...outcome.result, reportId: claims.reportId });
  } catch (e) {
    return apiServerError(e);
  }
}
