/**
 * ESTATE PAUSE - discovery by the `loom-estate-id` ownership TAG (#5099 phase A).
 *
 * WHY THIS MODULE EXISTS. The pause set was the deploy manifest (four env-named
 * resources) plus Container Apps in one RG. AKS, VMs, Databricks, Stream Analytics
 * and web sites sat in `ESTATE_PAUSE_TIER` with working actuators and were never
 * discovered, so Estate Power silently left them billing. Ownership for those is
 * the tag (R-SCOPE-1/2/3): one Azure Resource Graph query for the tier's types
 * whose `loom-estate-id` equals THIS estate's id, across every subscription the
 * console identity can read. The subscription and the resource-group name never
 * establish ownership - only the tag value does, and it is RE-CHECKED on every
 * returned row so a wrong query cannot widen the set.
 *
 * Container Apps are NOT queried here: their per-app policy (global opt-out,
 * exemptions, scale-range capture) lives in `./pause-container-apps`, and a second
 * source for the same type would bypass it.
 *
 * FAIL CLOSED (deploy-integrity R7). A Resource Graph failure is reported as
 * `incomplete` with the reason, and the plan/panel say "discovery incomplete" - it
 * is never rendered as "nothing to pause". Two further ways to be incomplete are
 * checked, because Resource Graph silently returns only what the identity can
 * read: a page budget that ran out, and a subscription the console is configured
 * for that the identity cannot read.
 *
 * Pure classification (`classifyTagRows`, `unionDiscovered`) is split from the
 * transport (`queryAllPages`) so every branch is testable without a network.
 */
import { kqlEscapeSingle } from '@/lib/azure/kql-escape';
import { classifyTagReadFailure, type DiscoveryReadFailure } from './pause-discovery-classify';
import { aksPauseGuard } from './pause-guards';
import { LOOM_ESTATE_TAG_KEY, type DiscoveredResource } from './pause-inventory';
import { ESTATE_PAUSE_TIER } from './pause-tier';

const RESOURCE_GRAPH_PATH = '/providers/Microsoft.ResourceGraph/resources?api-version=2022-10-01';
const PAGE_SIZE = 1000;
/** 20 x 1000 rows. A tier-typed, estate-tagged result this large is itself an anomaly: refuse a partial list. */
export const MAX_PAGES = 20;

/** The tier types this source queries: everything except Container Apps (see header). */
export const TAG_DISCOVERY_TYPES: readonly string[] = ESTATE_PAUSE_TIER.filter(
  (t) => t !== 'microsoft.app/containerapps',
);

/** One Resource Graph row, as projected by {@link buildEstateTagQuery}. */
export interface ArgRow {
  id?: string;
  name?: string;
  type?: string;
  resourceGroup?: string;
  subscriptionId?: string;
  location?: string;
  tags?: Record<string, string> | null;
}

export interface TagHeldOut {
  resourceId: string;
  name: string;
  resourceType: string;
  reason: string;
}

export interface TagDiscoveryStatus {
  /** False only when the source did not run at all (no estate id to match). */
  queried: boolean;
  /** True when ANY part of the answer could not be established. NEVER read this as "nothing to pause". */
  incomplete: boolean;
  /** The truthful sentence, starting "discovery incomplete:" when `incomplete`. */
  note?: string;
  /** Rows Resource Graph returned for this estate id (before guards / union). */
  matched: number;
  pages: number;
  /** Tagged for this estate but held out of the pause set, each with the reason. */
  heldOut: TagHeldOut[];
  /** Subscriptions the console is configured for that the identity cannot read. */
  unreadableSubscriptions: string[];
}

export const emptyTagStatus = (extra: Partial<TagDiscoveryStatus> = {}): TagDiscoveryStatus => ({
  queried: false,
  incomplete: false,
  matched: 0,
  pages: 0,
  heldOut: [],
  unreadableSubscriptions: [],
  ...extra,
});

/** `post(body)` -> the parsed Resource Graph response. Throws on any non-2xx. */
export type ArgPost = (body: unknown) => Promise<{ data?: unknown; $skipToken?: string; count?: number }>;

/** KQL for this estate. The tag compare is `==` (case-sensitive), matching `resolveOwnership`'s exact equality. */
export function buildEstateTagQuery(estateId: string): string {
  const types = TAG_DISCOVERY_TYPES.map((t) => `'${kqlEscapeSingle(t)}'`).join(', ');
  return [
    'resources',
    `| where type in~ (${types})`,
    `| where tostring(tags['${LOOM_ESTATE_TAG_KEY}']) == '${kqlEscapeSingle(estateId)}'`,
    '| project id, name, type, resourceGroup, subscriptionId, location, tags',
    '| order by id asc',
  ].join('\n');
}

/** Subscriptions the identity can read - the completeness probe. */
export const READABLE_SUBSCRIPTIONS_QUERY = [
  'resourcecontainers',
  "| where type =~ 'microsoft.resources/subscriptions'",
  '| project subscriptionId',
].join('\n');

/** Subscriptions this console is configured for (any of them unreadable means a partial answer). */
export function configuredSubscriptions(env: NodeJS.ProcessEnv): string[] {
  const keys = [
    'LOOM_SUBSCRIPTION_ID',
    'LOOM_DLZ_SUBSCRIPTION_ID',
    'LOOM_DLZ_SUB',
    'LOOM_SYNAPSE_SUB',
    'LOOM_KUSTO_SUB',
    'LOOM_SHIR_SUB',
  ];
  const out = new Set<string>();
  for (const k of keys) {
    const v = String(env[k] ?? '').trim().toLowerCase();
    if (v) out.add(v);
  }
  return [...out];
}

/** Page through one query. Throws on a transport error; throws if the page budget runs out with a token left. */
export async function queryAllPages(query: string, post: ArgPost): Promise<{ rows: ArgRow[]; pages: number }> {
  const rows: ArgRow[] = [];
  let skipToken: string | undefined;
  let pages = 0;
  do {
    const options: Record<string, unknown> = { resultFormat: 'objectArray', $top: PAGE_SIZE };
    if (skipToken) options.$skipToken = skipToken;
    const body = await post({ query, options });
    pages += 1;
    // A 2xx whose body carries `error`, or no `data` array, is a failed read - never "zero rows, complete".
    const bodyError = (body as { error?: unknown } | undefined)?.error;
    if (bodyError) {
      const msg = typeof bodyError === 'object' ? JSON.stringify(bodyError) : String(bodyError);
      throw new Error(`Resource Graph returned an error body on page ${pages}: ${msg.slice(0, 300)}`);
    }
    if (!Array.isArray(body?.data)) {
      throw new Error(`Resource Graph page ${pages} has no data array; refusing to read it as zero rows.`);
    }
    rows.push(...(body.data as ArgRow[]));
    skipToken = typeof body?.$skipToken === 'string' && body.$skipToken ? body.$skipToken : undefined;
  } while (skipToken && pages < MAX_PAGES);
  if (skipToken) {
    throw new Error(`Resource Graph returned more than ${MAX_PAGES} pages (${MAX_PAGES * PAGE_SIZE} rows); refusing a partial list.`);
  }
  return { rows, pages };
}

/**
 * PURE. Turn Resource Graph rows into pause candidates for `estateId`.
 *
 * Each row is re-validated: it must carry the estate tag with EXACTLY the estate
 * id (so a query defect cannot widen ownership), be a tier type, and pass the
 * per-resource guards (AKS hosting the console, `loom-estate-pause=exempt`).
 * Duplicate ids collapse (lower-cased id).
 */
export function classifyTagRows(args: {
  rows: readonly ArgRow[];
  estateId: string;
  env: NodeJS.ProcessEnv;
}): { discovered: DiscoveredResource[]; heldOut: TagHeldOut[] } {
  const discovered: DiscoveredResource[] = [];
  const heldOut: TagHeldOut[] = [];
  const seen = new Set<string>();
  const tier = new Set(TAG_DISCOVERY_TYPES);
  for (const row of args.rows) {
    const resourceId = String(row.id ?? '').trim();
    const name = String(row.name ?? '').trim();
    const type = String(row.type ?? '').trim().toLowerCase();
    if (!resourceId || !name || !tier.has(type)) continue;
    const key = resourceId.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const tags = row.tags && typeof row.tags === 'object' ? row.tags : null;
    const estateTag = tags
      ? Object.entries(tags).find(([k]) => k.toLowerCase() === LOOM_ESTATE_TAG_KEY)?.[1]
      : undefined;
    if (estateTag !== args.estateId) continue; // ownership not established by THIS row's tags
    const hold = (reason: string) => heldOut.push({ resourceId, name, resourceType: type, reason });
    if (type === 'microsoft.containerservice/managedclusters') {
      const g = aksPauseGuard({ name, tags }, args.env);
      if (!g.eligible) {
        hold(g.reason);
        continue;
      }
    }
    const exempt = Object.entries(tags ?? {}).find(([k]) => k.toLowerCase() === 'loom-estate-pause');
    if (exempt && String(exempt[1]).trim().toLowerCase() === 'exempt') {
      hold(`${name} is tagged loom-estate-pause=exempt. Left RUNNING.`);
      continue;
    }
    discovered.push({
      resourceId,
      resourceType: type,
      name,
      resourceGroup: String(row.resourceGroup ?? ''),
      subscriptionId: String(row.subscriptionId ?? ''),
      ...(row.location ? { location: row.location } : {}),
      tags,
      discoverySource: 'resource-graph',
    });
  }
  return { discovered, heldOut };
}

/**
 * Union the tag-discovered rows into the rows the other sources already produced.
 * An id already present (manifest or Container Apps, compared lower-cased) KEEPS
 * its existing row - those carry tags freshly read from ARM and the Container Apps
 * policy verdict - so adding this source can never change what already worked.
 */
export function unionDiscovered(
  existing: readonly DiscoveredResource[],
  tagged: readonly DiscoveredResource[],
): DiscoveredResource[] {
  const ids = new Set(existing.map((d) => d.resourceId.toLowerCase()));
  const out = [...existing];
  for (const d of tagged) {
    const k = d.resourceId.toLowerCase();
    if (ids.has(k)) continue;
    ids.add(k);
    out.push(d);
  }
  return out;
}

export interface TagDiscoveryResult {
  discovered: DiscoveredResource[];
  status: TagDiscoveryStatus;
  /** Only a THROTTLED read blocks the pause (retry); any other failure is disclosed via `status`. */
  readFailures: DiscoveryReadFailure[];
}

async function defaultPost(body: unknown): Promise<{ data?: unknown; $skipToken?: string }> {
  const { armPost } = await import('@/lib/azure/arm-client');
  return armPost(RESOURCE_GRAPH_PATH, body);
}

/** Discover the estate-tagged resources. Never throws. */
export async function discoverByEstateTag(args: {
  estateId: string;
  env?: NodeJS.ProcessEnv;
  post?: ArgPost;
}): Promise<TagDiscoveryResult> {
  const env = args.env ?? process.env;
  const post = args.post ?? defaultPost;
  const estateId = String(args.estateId ?? '').trim();
  if (!estateId || estateId === 'loom:unbound') {
    return {
      discovered: [],
      readFailures: [],
      status: emptyTagStatus({
        incomplete: true,
        note: 'discovery incomplete: this console has no estate id (LOOM_ESTATE_ID, or LOOM_SUBSCRIPTION_ID with LOOM_ADMIN_RG), so resources cannot be matched to it by tag. Only the deploy-named resources are in this preview.',
      }),
    };
  }

  let rows: ArgRow[];
  let pages: number;
  try {
    ({ rows, pages } = await queryAllPages(buildEstateTagQuery(estateId), post));
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    const kind = classifyTagReadFailure(error);
    return {
      discovered: [],
      status: emptyTagStatus({
        queried: true,
        incomplete: true,
        note:
          `discovery incomplete: the Azure Resource Graph tag query failed${kind === 'throttled' ? ' (throttled; retry)' : ''}, `
          + 'so resources found by the loom-estate-id tag (AKS, VMs, Databricks, Stream Analytics, web sites) are NOT in this preview. '
          + `This is NOT a statement that there is nothing to pause. Raw: ${error.slice(0, 300)}`,
      }),
      readFailures:
        kind === 'throttled'
          ? [{
              resourceId: '/providers/Microsoft.ResourceGraph/resources',
              name: 'Resource Graph tag discovery',
              error,
              kind: 'throttled',
              throttled: true,
            }]
          : [],
    };
  }

  const { discovered, heldOut } = classifyTagRows({ rows, estateId, env });

  // Completeness: Resource Graph returns only what the identity can read, so an
  // unreadable subscription looks exactly like an empty one. Probe it.
  let unreadable: string[] = [];
  let probeError: string | undefined;
  const expected = configuredSubscriptions(env);
  if (expected.length) {
    try {
      const probe = await queryAllPages(READABLE_SUBSCRIPTIONS_QUERY, post);
      const readable = new Set(probe.rows.map((r) => String(r.subscriptionId ?? '').toLowerCase()));
      unreadable = expected.filter((s) => !readable.has(s));
    } catch (e) {
      probeError = (e instanceof Error ? e.message : String(e)).slice(0, 300);
    }
  }
  const incomplete = unreadable.length > 0 || probeError !== undefined;
  const note = unreadable.length
    ? `discovery incomplete: the console identity cannot read subscription(s) ${unreadable.join(', ')}, which this console is configured for, `
      + 'so estate-tagged resources there are NOT in this preview. Grant the console UAMI Reader (Contributor to pause) on them.'
    : probeError !== undefined
      ? `discovery incomplete: the tag query succeeded but the check that every configured subscription is readable failed, so a subscription may be missing from this preview. Raw: ${probeError}`
      : undefined;
  return {
    discovered,
    readFailures: [],
    status: {
      queried: true,
      incomplete,
      ...(note ? { note } : {}),
      matched: rows.length,
      pages,
      heldOut,
      unreadableSubscriptions: unreadable,
    },
  };
}
