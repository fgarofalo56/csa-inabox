/**
 * LOOM BRAIN — Azure Resource Graph collection.
 *
 * READ-ONLY, AND STRUCTURALLY SO. The only Azure call in this module is
 * `POST {arm}/providers/Microsoft.ResourceGraph/resources`, which is a QUERY
 * endpoint: there is no ARM verb reachable from here that can create, scale or
 * delete anything. Per PRP §1 decision 1 the Brain is recommend-only, and the
 * measured reason is blast radius — of the 13 Container App environments across
 * these subscriptions ONE is Loom's; the other 12 are the operator's blog,
 * Sentinel, two Atlas estates and more.
 *
 * ── WHY PAGINATION IS NOT OPTIONAL ─────────────────────────────────────────
 * ARG caps a single response (1000 rows by default) and hands back a
 * `$skipToken`. A collector that ignores the token gets a plausible-looking
 * partial estate and then reports reachability over it. Every node in the
 * unread remainder would be "found" with zero inbound edges — a page-boundary
 * artifact rendered as a fleet of unreachable services, indistinguishable from
 * a real finding.
 *
 * So this module follows the token to exhaustion AND cross-checks the row count
 * against ARG's own `totalRecords`. `CollectionReport.complete` is true only
 * when those agree; when they do not, the caller must render the snapshot as
 * PARTIAL rather than as an estate.
 *
 * ── WHY THE QUERY PROJECTS `properties` WHOLESALE ──────────────────────────
 * One pull feeds two extractors. `properties` carries `template.scale`
 * (minReplicas / cpu / memory), `configuration.ingress` (external / fqdn) AND
 * `template.containers[].env` — so the resource facts and the live `configured`
 * wires come from the SAME read, at the same instant. Two separate pulls could
 * observe an app mid-revision and produce a graph in which a node's scale and
 * its env disagree.
 *
 * ── CLOUD INVARIANCE ───────────────────────────────────────────────────────
 * The ARM host comes from `armBase()` and the token audience from `armScope()`,
 * never from a literal. That is what makes this work unchanged in Commercial,
 * GCC, GCC-High, IL5 and DoD (`cloud-parity.md`). NOTE HONESTLY: that is an
 * argument from construction, not a receipt. This code has NOT been executed
 * against Azure Government — see the PR body.
 *
 * ── R7: AN ERROR SAYS WHAT IT ESTABLISHED ──────────────────────────────────
 * `2>/dev/null`-shaped error handling is what turned "I could not reach the
 * registry" into "the tag does not exist" on 2026-08-05 and sent two
 * investigations down the wrong path. So there is no bare `catch { return [] }`
 * here: a failure throws `ResourceGraphCollectionError` carrying the HTTP
 * status and the response body, and an empty result set is only ever returned
 * when ARG actually returned zero rows.
 */

import { loomServerCredential } from '@/lib/azure/aca-managed-identity';
import { armBase, armScope, cloudBoundaryLabel } from '@/lib/azure/cloud-endpoints';
import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import type { ResourceGraphRow } from '@/lib/brain/graph';

const RESOURCE_GRAPH_API = '2022-10-01';

/** ARG's server-side page ceiling. Requesting more does not raise it. */
const PAGE_SIZE = 1000;

/**
 * Hard stop on pagination. At 1000 rows/page this admits 50,000 resources —
 * two orders of magnitude above the measured estate (2,438 nodes) — while
 * making a server-side `$skipToken` loop that never terminates a bounded
 * failure rather than a hung request. Exhausting it is reported, never
 * silently treated as the end of the data.
 */
const MAX_PAGES = 50;

/**
 * A collection failure that knows WHAT it established.
 *
 * Never collapsed into "no resources". A caller that cannot tell "ARG returned
 * zero rows" from "ARG returned 403" will eventually report an empty estate as
 * a clean one.
 */
export class ResourceGraphCollectionError extends Error {
  readonly status: number;
  readonly detail: string;
  constructor(message: string, status: number, detail: string) {
    super(message);
    this.name = 'ResourceGraphCollectionError';
    this.status = status;
    this.detail = detail;
  }
}

/** What the pull actually read. Reported alongside every snapshot. */
export interface CollectionStats {
  readonly rowsFetched: number;
  /** ARG's own count. `null` when the response omitted it — unknown, not zero. */
  readonly totalRecords: number | null;
  readonly pages: number;
  /** True iff `totalRecords` is KNOWN and equals `rowsFetched`. */
  readonly complete: boolean;
  readonly subscriptionsSeen: number;
  readonly durationMs: number;
  readonly cloud: string;
  /** True when MAX_PAGES was hit with a token still outstanding. */
  readonly truncatedByPageCap: boolean;
}

export interface CollectionResult {
  readonly rows: readonly ResourceGraphRow[];
  readonly stats: CollectionStats;
}

/**
 * THE QUERY.
 *
 * Scoped to the container tier — Container Apps, Container App Jobs and their
 * managed environments — because that is where the measured spend is: 19 of
 * Loom's 29 apps run `minReplicas > 0`. Widening the type filter is a
 * deliberate change with a cost (every additional type multiplies the rows a
 * reachability query ranges over), not a default.
 *
 * `tags` is projected explicitly. ARG returns `null` for a resource with no
 * tags AND omits nothing on failure — the extractor reads `null` as
 * INDETERMINATE rather than "no tags", which is what keeps a fail-open
 * ownership inference out of a cleanup recommendation.
 */
const ESTATE_QUERY = [
  'Resources',
  "| where type =~ 'Microsoft.App/containerApps'",
  "   or type =~ 'Microsoft.App/jobs'",
  "   or type =~ 'Microsoft.App/managedEnvironments'",
  '| project id, name, type, resourceGroup, subscriptionId, location, tags, properties',
  '| order by id asc',
].join('\n');

interface ArgResponse {
  readonly data?: unknown;
  readonly totalRecords?: unknown;
  readonly count?: unknown;
  readonly $skipToken?: unknown;
}

function asRows(data: unknown): ResourceGraphRow[] {
  if (!Array.isArray(data)) return [];
  return data.filter(
    (r): r is ResourceGraphRow => typeof r === 'object' && r !== null,
  );
}

/**
 * Pull the container-tier estate across every subscription the console identity
 * can read.
 *
 * NOTE ON SCOPE: no `subscriptions` array is supplied, so ARG defaults to every
 * subscription the caller's token grants Reader on. That is exactly PRP §1
 * decision 4 — reports cover ALL subscriptions — and it is also why the result
 * necessarily contains non-Loom resources. Ownership scoping happens later, on
 * evidence, and never by assuming everything returned is ours.
 */
export async function collectEstate(opts?: {
  /** Test seam. Production passes nothing and the real ARM endpoint is used. */
  readonly fetchImpl?: typeof fetchWithTimeout;
  readonly credential?: { getToken(scope: string): Promise<{ token: string } | null> };
  readonly armBaseOverride?: string;
}): Promise<CollectionResult> {
  const startedAt = Date.now();
  const base = (opts?.armBaseOverride || armBase()).replace(/\/+$/, '');
  const credential = opts?.credential ?? loomServerCredential;
  const doFetch = opts?.fetchImpl ?? fetchWithTimeout;

  const token = await credential.getToken(armScope());
  if (!token?.token) {
    // R7 — this states exactly what happened. It does NOT claim there are no
    // resources, because nothing was asked.
    throw new ResourceGraphCollectionError(
      'could not acquire an ARM token for the console identity; NO query was issued, ' +
        'so nothing is known about the estate',
      0,
      'credential.getToken returned no token',
    );
  }

  const rows: ResourceGraphRow[] = [];
  let skipToken: string | undefined;
  let totalRecords: number | null = null;
  let pages = 0;
  let truncatedByPageCap = false;

  for (;;) {
    if (pages >= MAX_PAGES) {
      // Reported, not swallowed: `complete` will be false and the caller renders
      // the snapshot as partial.
      truncatedByPageCap = true;
      break;
    }

    const body: Record<string, unknown> = {
      query: ESTATE_QUERY,
      options: {
        resultFormat: 'objectArray',
        $top: PAGE_SIZE,
        ...(skipToken ? { $skipToken: skipToken } : {}),
      },
    };

    const res = await doFetch(
      `${base}/providers/Microsoft.ResourceGraph/resources?api-version=${RESOURCE_GRAPH_API}`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    );

    if (!res.ok) {
      const detail = await res.text().catch(() => '<response body unreadable>');
      throw new ResourceGraphCollectionError(
        `Azure Resource Graph returned HTTP ${res.status} on page ${pages + 1}. ` +
          `${rows.length} row(s) had been read before the failure; the estate is ` +
          'therefore INCOMPLETE and no reachability verdict may be drawn from it.',
        res.status,
        detail.slice(0, 600),
      );
    }

    const json = (await res.json()) as ArgResponse;
    const page = asRows(json.data);
    rows.push(...page);
    pages += 1;

    if (totalRecords === null && typeof json.totalRecords === 'number') {
      totalRecords = json.totalRecords;
    }

    const next = typeof json.$skipToken === 'string' ? json.$skipToken : '';
    // An empty page with a token would loop forever; treat it as the end and let
    // the totalRecords cross-check decide whether that was complete.
    if (!next || page.length === 0) break;
    skipToken = next;
  }

  const subs = new Set<string>();
  for (const r of rows) {
    const s = r.subscriptionId;
    if (typeof s === 'string' && s !== '') subs.add(s.toLowerCase());
  }

  return {
    rows,
    stats: {
      rowsFetched: rows.length,
      totalRecords,
      pages,
      // Deliberately conservative: an UNKNOWN totalRecords is not completeness.
      complete: totalRecords !== null && totalRecords === rows.length && !truncatedByPageCap,
      subscriptionsSeen: subs.size,
      durationMs: Date.now() - startedAt,
      cloud: cloudBoundaryLabel(),
      truncatedByPageCap,
    },
  };
}

/** The query text, exported so a finding can cite the exact query it ranged over. */
export const ESTATE_QUERY_TEXT = ESTATE_QUERY;
