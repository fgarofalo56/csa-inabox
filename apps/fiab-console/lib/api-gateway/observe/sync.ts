/**
 * Inventory sync (W1-3): read one gateway, write redacted observed documents
 * into `apiplane-observed`, sweep what disappeared, then record counts on the
 * gateway record.
 *
 * Invariants (each has a test):
 *  - ids are deterministic (observedId), so a re-sync is an upsert;
 *  - a type whose list was failed/partial/unavailable is never swept;
 *  - one sync per gateway at a time (in-flight admission set);
 *  - the gateway record is RE-READ immediately before the write and only
 *    `inventory` / `capabilities` are replaced, so a concurrent classification
 *    (`environmentKey`) is never overwritten.
 */
import { ClassificationConflictError } from '../environments/types';
import type { GatewayRepo } from '../registry/gateway-service';
import type { GatewayDoc } from '../registry/types';
import type { ApiplaneRepo } from '../types';
import { detectAiSurface, mergeSelection } from './detect';
import { observedId } from './ids';
import { analyzePolicy, redactUrl } from './policy-analysis';
import { sweep } from './sweep';
import type { ObservedDoc, ObservedType, ObserveSource, PolicyAnalysis, TypeListing } from './types';

export interface SyncDeps {
  gateways: GatewayRepo;
  observed: ApiplaneRepo<ObservedDoc>;
  source: (gateway: GatewayDoc) => ObserveSource;
  now?: () => Date;
}

export type SyncResult =
  | {
      ok: true;
      status: 'synced';
      gatewayId: string;
      counts: Record<ObservedType, number>;
      partialTypes: ObservedType[];
      swept: number;
      mcp: 'available' | 'unavailable' | 'unknown';
    }
  | { ok: false; status: 'in_flight' | 'not_found' | 'no_access'; error: string };

/** Gateways with a sync running in this process. */
const inFlight = new Set<string>();
export function isSyncInFlight(gatewayId: string): boolean { return inFlight.has(gatewayId); }

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

function safeUrl(raw: unknown): string | undefined {
  const s = str(raw);
  return s ? redactUrl(s)?.url : undefined;
}

/** Redacted, type-specific metadata. Keys, values and e-mail addresses are never copied. */
function shapeProps(type: ObservedType, p: Record<string, unknown>): Record<string, unknown> {
  switch (type) {
    case 'api':
      return { path: str(p.path), protocols: p.protocols, serviceUrl: safeUrl(p.serviceUrl), apiType: str(p.type) ?? str(p.apiType), subscriptionRequired: p.subscriptionRequired, apiRevision: str(p.apiRevision) };
    case 'operation':
      return { method: str(p.method), urlTemplate: str(p.urlTemplate) };
    case 'product':
      return { state: str(p.state), subscriptionRequired: p.subscriptionRequired, approvalRequired: p.approvalRequired };
    case 'subscription':
      return { scope: str(p.scope), state: str(p.state), ownerId: str(p.ownerId) };
    case 'user':
      return { state: str(p.state) };
    case 'group':
      return { groupType: str(p.type) };
    case 'backend':
      return { url: safeUrl(p.url), protocol: str(p.protocol) };
    case 'namedValue':
      return { secret: p.secret === true, keyVault: p.keyVault ? true : false, tags: Array.isArray(p.tags) ? p.tags : undefined };
    case 'mcp':
      return { path: str(p.path), url: safeUrl(p.serviceUrl) };
    case 'fragment':
      return { description: str(p.description) };
  }
}

const DEFAULT_TYPES = ['api', 'product', 'subscription', 'user', 'group', 'backend', 'namedValue'] as const;

export async function syncGateway(deps: SyncDeps, tenantId: string, gatewayIdValue: string): Promise<SyncResult> {
  const gw = await deps.gateways.get(tenantId, gatewayIdValue);
  if (!gw || gw.docType !== 'gateway') return { ok: false, status: 'not_found', error: `Gateway ${gatewayIdValue} is not registered.` };
  if (!gw.access.canRead) return { ok: false, status: 'no_access', error: `The Console identity cannot read ${gw.resourceId}; grant the role named on the gateway record first.` };
  if (inFlight.has(gatewayIdValue)) return { ok: false, status: 'in_flight', error: `A sync of ${gatewayIdValue} is already running.` };
  inFlight.add(gatewayIdValue);
  try {
    return await run(deps, tenantId, gw);
  } finally {
    inFlight.delete(gatewayIdValue);
  }
}

async function safe(fn: () => Promise<TypeListing>): Promise<TypeListing> {
  try {
    return await fn();
  } catch (e) {
    return { items: [], complete: false, error: (e as Error)?.message ?? String(e) };
  }
}

async function run(deps: SyncDeps, tenantId: string, gw: GatewayDoc): Promise<SyncResult> {
  const at = (deps.now ?? (() => new Date()))().toISOString();
  const src = deps.source(gw);
  const gid = gw.id;
  const prior = (await deps.observed.list(tenantId)).filter((d) => d.gatewayId === gid && d.docType.startsWith('observed:'));
  const priorById = new Map(prior.map((d) => [d.id, d]));
  const partial = new Set<ObservedType>();
  const next = new Map<string, ObservedDoc>();

  const put = (type: ObservedType, name: string, extra: Partial<ObservedDoc>, raw: Record<string, unknown>, keepPriorPolicy = false) => {
    const id = observedId(gid, type, name);
    const old = priorById.get(id);
    const doc: ObservedDoc = {
      id, tenantId, docType: `observed:${type}`, gatewayId: gid, observedType: type, name,
      displayName: str(rec(raw.properties).displayName),
      observedAt: at,
      props: shapeProps(type, rec(raw.properties)),
      ...extra,
    };
    // Manual selections survive a sync; a failed policy read keeps the previous analysis.
    const ai = mergeSelection(old?.aiSurface, doc.aiSurface);
    if (ai) doc.aiSurface = ai; else delete doc.aiSurface;
    if (old?.mcp?.selection === 'manual') doc.mcp = old.mcp;
    if (keepPriorPolicy && old?.policyAnalysis) doc.policyAnalysis = old.policyAnalysis;
    next.set(id, doc);
    return doc;
  };

  for (const type of DEFAULT_TYPES) {
    const l = await safe(() => src.list(type));
    if (!l.complete) partial.add(type);
    for (const raw of l.items) {
      const name = str(raw.name);
      if (!name) continue;
      if (type !== 'api') { put(type, name, {}, raw); continue; }
      const p = rec(raw.properties);
      let analysis: PolicyAnalysis | undefined;
      let policyFailed = false;
      try {
        const xml = await src.apiPolicy(name);
        analysis = xml ? analyzePolicy(xml) : undefined;
      } catch {
        policyFailed = true; // keep the previous analysis rather than erasing it
      }
      const ai = detectAiSurface({ serviceUrl: str(p.serviceUrl), path: str(p.path), policy: analysis });
      put('api', name, { policyAnalysis: analysis, aiSurface: ai }, raw, policyFailed);
      const ops = await safe(() => src.operations(name));
      if (!ops.complete) partial.add('operation');
      for (const op of ops.items) {
        const on = str(op.name);
        if (on) put('operation', `${name}/${on}`, {}, op);
      }
    }
  }

  // A failed API list means operations were never enumerated for the missing APIs either.
  if (partial.has('api')) partial.add('operation');

  const frag = await safe(() => src.fragments());
  if (!frag.complete) partial.add('fragment');
  for (const raw of frag.items) {
    const name = str(raw.name);
    if (!name) continue;
    const value = str(rec(raw.properties).value);
    put('fragment', name, { policyAnalysis: value ? analyzePolicy(value) : undefined }, raw);
  }

  let mcpState: 'available' | 'unavailable' | 'unknown' = 'available';
  try {
    const m = await src.mcpApis();
    if (m.status === 'unavailable') {
      mcpState = 'unavailable';
      partial.add('mcp');
    } else {
      if (!m.complete) partial.add('mcp');
      for (const raw of m.items) {
        const name = str(raw.name);
        if (!name) continue;
        const url = safeUrl(rec(raw.properties).serviceUrl);
        put('mcp', name, { mcp: { selection: 'detected', url } }, raw);
      }
    }
  } catch {
    mcpState = 'unknown';
    partial.add('mcp');
  }

  for (const d of next.values()) await deps.observed.upsert(d);
  const stale = sweep(prior, new Set(next.keys()), partial);
  for (const id of stale) await deps.observed.remove(tenantId, id);

  const kept = new Map(prior.filter((d) => !stale.includes(d.id)).map((d) => [d.id, d]));
  for (const d of next.values()) kept.set(d.id, d);
  const counts = {} as Record<ObservedType, number>;
  for (const t of ['api', 'operation', 'product', 'subscription', 'user', 'group', 'backend', 'namedValue', 'mcp', 'fragment'] as const) counts[t] = 0;
  for (const d of kept.values()) counts[d.observedType]++;

  await recordOnGateway(deps, tenantId, gw.id, counts, [...partial].sort(), mcpState, at, [...kept.values()]);
  return { ok: true, status: 'synced', gatewayId: gid, counts, partialTypes: [...partial].sort(), swept: stale.length, mcp: mcpState };
}

/** Re-read the gateway and replace ONLY inventory/capabilities, etag-guarded. environmentKey comes from the fresh read. */
async function recordOnGateway(
  deps: SyncDeps, tenantId: string, id: string, counts: Record<ObservedType, number>,
  partialTypes: ObservedType[], mcp: 'available' | 'unavailable' | 'unknown', at: string, docs: ObservedDoc[],
): Promise<void> {
  const llm = docs.some((d) => d.policyAnalysis?.facets.llm || d.aiSurface) ? 'available' : 'unknown';
  for (let attempt = 0; ; attempt++) {
    const cur = await deps.gateways.get(tenantId, id);
    if (!cur) return; // removed while syncing: nothing to record on
    const next: GatewayDoc = {
      ...cur,
      capabilities: { ...cur.capabilities, mcpServers: mcp, llmPolicies: llm === 'available' ? 'available' : cur.capabilities.llmPolicies },
      inventory: {
        apis: counts.api, products: counts.product, subscriptions: counts.subscription, backends: counts.backend,
        namedValues: counts.namedValue, mcpServers: counts.mcp, lastSyncAt: at, partialTypes,
      },
    };
    try {
      await deps.gateways.replaceBatch(tenantId, [{ doc: next, expectedEtag: cur._etag }]);
      return;
    } catch (e) {
      if (!(e instanceof ClassificationConflictError) || attempt >= 2) throw e;
    }
  }
}
