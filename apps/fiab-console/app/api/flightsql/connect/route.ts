/**
 * GET /api/flightsql/connect — the Connect tab's payload (N3).
 *
 * Returns everything the lakehouse / warehouse / SQL-endpoint **Connect** tab
 * renders: the Flight endpoint's real exposure, the ADBC / Flight / JDBC
 * snippets, and the audited URL that mints a ticket.
 *
 * Two invariants this route enforces (and its tests pin):
 *   1. **No secrets.** Snippets read the ticket from the reader's OWN
 *      environment variable; the signing key and any minted ticket are never
 *      rendered. `snippetIsSecretFree` re-checks every body before it ships.
 *   2. **No internal hosts.** An internal-ingress container FQDN is never
 *      echoed into a copy-paste snippet — it would not resolve for the reader.
 *      When only the in-VNet address exists the payload says so plainly.
 *
 * The tab renders fully in every state — deployed + published, deployed but
 * in-VNet, or not deployed at all — because Arrow still flows over the audited
 * HTTP tier in each case. Nothing here is a blocking gate.
 *
 * 200 → { ok:true, endpoint, ticketMintUrl, snippets, arrowThreshold }
 * 401 → unauthenticated
 */
import { apiOk } from '@/lib/api/respond';
import { withSession } from '@/lib/api/route-toolkit';
import { externalOrigin } from '@/lib/auth/auth-breaker';
import {
  buildFlightSnippets,
  resolveFlightEndpoint,
  snippetIsSecretFree,
} from '@/lib/azure/flight-sql-client';
import { arrowRowThreshold } from '@/lib/arrow/transport-policy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withSession(async (req) => {
  const endpoint = resolveFlightEndpoint();
  const sampleSql = (req.nextUrl.searchParams.get('sql') || '').trim().slice(0, 500);
  // The audited mint route, on the ORIGIN the caller actually reached us on —
  // never an internal container address.
  //
  // #3443: this read `req.nextUrl.origin`, which is EXACTLY the internal
  // container address this comment and invariant 2 above both forbid. Under
  // `output: 'standalone'` with `HOSTNAME=0.0.0.0`, Next builds the handler's
  // request URL from its own listen address (next-server.js:1312) and `NextURL`
  // has no `x-forwarded-*` handling — so clients were handed
  // `https://0.0.0.0:3000/api/flightsql/session` in a copy-paste snippet.
  // `externalOrigin` reads the forwarded host, the same header this app already
  // trusts for the OAuth redirect_uri. Same defect as #3442, different route.
  const ticketMintUrl = new URL('/api/flightsql/session', externalOrigin(req.headers)).toString();

  const snippets = buildFlightSnippets({
    endpoint,
    ticketMintUrl,
    sampleSql: sampleSql || undefined,
  }).filter((s) => snippetIsSecretFree(s.code));

  return apiOk({
    endpoint,
    ticketMintUrl,
    snippets,
    arrowThreshold: arrowRowThreshold(process.env.LOOM_FLIGHT_ROW_THRESHOLD),
    // What Loom itself does with the same Arrow batches, so the tab can explain
    // the relationship rather than implying Flight is the only Arrow path.
    loomTransportNote:
      "Loom's own result grids take the identical Arrow batches over the audited HTTP tier once a "
      + 'result crosses the Arrow threshold; external clients take them over Flight. Same engine, same '
      + 'batches, no row-by-row re-serialization on either path.',
  });
});
