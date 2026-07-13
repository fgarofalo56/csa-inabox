/**
 * attached-discovery — the pure Resource-Graph query + row mapper for the
 * brownfield attach wizard's Discover step (§2.2 of the design doc).
 *
 * Enumerates every EXISTING Azure resource of an attachable kind (Synapse, ADX,
 * ADLS, Databricks, SQL, Cosmos, Event Hubs, ADF, Purview, AML, AI Search,
 * APIM, Stream Analytics, AOAI, Maps) the caller can reach across ALL their
 * subscriptions (their own RBAC + ABAC via a delegated token). This mirrors the
 * proven /api/azure/connectables engine but over the fuller AttachedServiceKind
 * set and returning registry-shaped candidates (kind, not ConnectionType).
 *
 * Kept free of the Azure SDK so it is unit-testable and importable by both the
 * route and the tests. The route does the token acquisition + fetch.
 */
import {
  ATTACHED_KIND_DEFS,
  armTypeToKind,
  type AttachedServiceKind,
} from './attached-service-kinds';

/** One discovered candidate the wizard offers as a dropdown pick. */
export interface AttachedServiceCandidate {
  kind: AttachedServiceKind;
  /** Full ARM resource id (the coordinate source pinned onto the registry doc). */
  armResourceId: string;
  name: string;
  /** Raw ARM resource type (lower-case), e.g. 'microsoft.synapse/workspaces'. */
  armType: string;
  subscriptionId: string;
  subscriptionName?: string;
  resourceGroup: string;
  location?: string;
}

export interface ArgResourceRow {
  id: string;
  name: string;
  type: string;
  kind?: string;
  location?: string;
  resourceGroup?: string;
  subscriptionId?: string;
  subName?: string;
}

/**
 * The single multi-type ARG query for discovery. `type in~` is case-insensitive;
 * the leftouter join attaches each resource's subscription display name. Kind is
 * projected so AOAI (AIServices Cognitive account) is disambiguated from other
 * Cognitive/Maps accounts by the mapper.
 */
export function buildDiscoveryQuery(kinds?: AttachedServiceKind[]): string {
  const defs = kinds?.length
    ? ATTACHED_KIND_DEFS.filter((d) => kinds.includes(d.kind))
    : ATTACHED_KIND_DEFS;
  const armTypes = Array.from(new Set(defs.map((d) => d.armType)));
  const types = armTypes.map((t) => `'${t}'`).join(',');
  return [
    'resources',
    `| where type in~ (${types})`,
    '| join kind=leftouter (',
    '    ResourceContainers',
    "    | where type =~ 'microsoft.resources/subscriptions'",
    '    | project subscriptionId, subName = name',
    '  ) on subscriptionId',
    '| project id, name, type, kind, location, resourceGroup, subscriptionId, subName',
    '| order by name asc',
  ].join('\n');
}

/** Extract `subscriptionId` and `resourceGroup` out of a full ARM resource id. */
export function coordsFromArmId(id: string): { subscriptionId: string; resourceGroup: string } {
  const sub = /\/subscriptions\/([^/]+)/i.exec(id || '')?.[1] || '';
  const rg = /\/resourcegroups\/([^/]+)/i.exec(id || '')?.[1] || '';
  return { subscriptionId: sub, resourceGroup: rg };
}

/**
 * Map one ARG row to a candidate. Returns null when the ARM type/kind isn't an
 * attach target (e.g. a Cognitive Services account that isn't AIServices). When
 * `kinds` is supplied, candidates outside the requested set are dropped.
 */
export function argRowToCandidate(
  row: ArgResourceRow,
  kinds?: AttachedServiceKind[],
): AttachedServiceCandidate | null {
  const kind = armTypeToKind(row.type, row.kind);
  if (!kind) return null;
  if (kinds?.length && !kinds.includes(kind)) return null;
  const coords = coordsFromArmId(row.id);
  return {
    kind,
    armResourceId: row.id,
    name: row.name,
    armType: (row.type || '').toLowerCase(),
    subscriptionId: row.subscriptionId || coords.subscriptionId,
    subscriptionName: row.subName || undefined,
    resourceGroup: row.resourceGroup || coords.resourceGroup,
    location: row.location || undefined,
  };
}

/** Map many ARG rows → candidates (dropping non-targets). */
export function argRowsToCandidates(
  rows: ArgResourceRow[],
  kinds?: AttachedServiceKind[],
): AttachedServiceCandidate[] {
  const out: AttachedServiceCandidate[] = [];
  for (const r of rows) {
    const c = argRowToCandidate(r, kinds);
    if (c) out.push(c);
  }
  return out;
}

/** Parse a `?kinds=synapse,adx` query param into a validated kind list. */
export function parseKindsParam(raw: string | null | undefined): AttachedServiceKind[] | undefined {
  if (!raw) return undefined;
  const valid = new Set<AttachedServiceKind>(ATTACHED_KIND_DEFS.map((d) => d.kind));
  const picked = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is AttachedServiceKind => valid.has(s as AttachedServiceKind));
  return picked.length ? picked : undefined;
}
