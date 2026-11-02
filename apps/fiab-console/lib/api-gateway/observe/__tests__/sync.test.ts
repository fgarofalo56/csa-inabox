import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryApiplaneRepo } from '../../__tests__/repos/in-memory-repo';
import { MemoryGatewayRepo } from '../../registry/__tests__/memory-gateway-repo';
import type { GatewayDoc } from '../../registry/types';
import { observedFindingsSource } from '../findings-source';
import { observedId } from '../ids';
import { sweep } from '../sweep';
import { isSyncInFlight, syncGateway, type SyncDeps } from '../sync';
import type { McpListing, ObservedDoc, ObservedType, ObserveSource, TypeListing } from '../types';

const T = 'tenant-1';
const GW = 'gw-1';

function gateway(over: Partial<GatewayDoc> = {}): GatewayDoc {
  return {
    id: GW, tenantId: T, docType: 'gateway', kind: 'gateway', displayName: 'g', cloud: 'AzureCloud',
    resourceId: '/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg/providers/Microsoft.ApiManagement/service/apim1',
    managementMode: 'observe', environmentKey: null,
    access: { canRead: true, canWrite: false, checkedAt: 'x', source: 'permissions' },
    capabilities: { tier: 'v2', mcpServers: 'unknown', llmPolicies: 'unknown' },
    inventory: { apis: 0, products: 0, subscriptions: 0, backends: 0, namedValues: 0, mcpServers: 0, partialTypes: [] },
    ownedBy: 'registered', createdAt: 'x', createdBy: 'o',
    ...over,
  };
}

const ok = (...names: string[]): TypeListing => ({ items: names.map((name) => ({ name, properties: { displayName: name } })), complete: true });

interface Script {
  lists: Partial<Record<string, TypeListing | Error>>;
  mcp: McpListing | Error;
  policies: Record<string, string | null | Error>;
  ops: Record<string, TypeListing>;
  onList?: () => Promise<void>;
}
function source(s: Script): ObserveSource {
  return {
    async list(type) {
      await s.onList?.();
      const r = s.lists[type] ?? ok();
      if (r instanceof Error) throw r;
      return r;
    },
    async operations(api) { return s.ops[api] ?? ok(); },
    async fragments() { return ok(); },
    async mcpApis() { if (s.mcp instanceof Error) throw s.mcp; return s.mcp; },
    async apiPolicy(api) { const p = s.policies[api] ?? null; if (p instanceof Error) throw p; return p; },
  };
}

let gateways: MemoryGatewayRepo;
let observed: InMemoryApiplaneRepo<ObservedDoc>;
let script: Script;
let deps: SyncDeps;

beforeEach(async () => {
  gateways = new MemoryGatewayRepo();
  observed = new InMemoryApiplaneRepo<ObservedDoc>();
  script = { lists: {}, mcp: { status: 'ok', ...ok() }, policies: {}, ops: {} };
  deps = { gateways, observed, source: () => source(script), now: () => new Date('2026-10-30T00:00:00Z') };
  await gateways.upsert(gateway());
});

const names = async (t: ObservedType) => (await observed.list(T, `observed:${t}`)).map((d) => d.name).sort();

describe('sweep()', () => {
  const prior = [
    { id: 'a', observedType: 'api' as const },
    { id: 'b', observedType: 'api' as const },
    { id: 'p', observedType: 'product' as const },
  ];
  it('removes a doc absent from a complete snapshot and keeps present ones', () => {
    expect(sweep(prior, new Set(['a', 'p']), new Set())).toEqual(['b']);
  });
  it('a partial type keeps every prior doc (sweeping it would delete b)', () => {
    expect(sweep(prior, new Set(['a', 'p']), new Set(['api']))).toEqual([]);
  });
  it('partial exemption is per type: product still sweeps while api is exempt', () => {
    expect(sweep(prior, new Set(['a']), new Set(['api']))).toEqual(['p']);
  });
});

describe('syncGateway', () => {
  it('ids are deterministic: a re-sync upserts the same documents (count stays 2, ids equal)', async () => {
    script.lists.api = ok('Alpha', 'Beta');
    await syncGateway(deps, T, GW);
    const first = (await observed.list(T, 'observed:api')).map((d) => d.id).sort();
    await syncGateway(deps, T, GW);
    const second = (await observed.list(T, 'observed:api')).map((d) => d.id).sort();
    expect(second).toEqual(first);
    expect(first).toHaveLength(2);
    expect(first).toContain(observedId(GW, 'api', 'alpha')); // case-insensitive key
  });

  it('a COMPLETE list sweeps a removed API (positive)', async () => {
    script.lists.api = ok('keep', 'gone');
    await syncGateway(deps, T, GW);
    script.lists.api = ok('keep');
    const r = await syncGateway(deps, T, GW);
    expect(await names('api')).toEqual(['keep']);
    expect(r.ok && r.swept).toBe(1);
  });

  it('a FAILED list is not swept, and the type is reported partial (breaks if failure is read as empty)', async () => {
    script.lists.api = ok('keep', 'other');
    await syncGateway(deps, T, GW);
    script.lists.api = new Error('429 throttled');
    script.lists.product = ok('p1');
    const r = await syncGateway(deps, T, GW);
    expect(await names('api')).toEqual(['keep', 'other']);
    expect(r.ok && r.partialTypes).toContain('api');
    expect((await gateways.get(T, GW))!.inventory.partialTypes).toContain('api');
    expect(await names('product')).toEqual(['p1']);
  });

  it('an INCOMPLETE (paged) list is not swept either', async () => {
    script.lists.backend = ok('b1', 'b2');
    await syncGateway(deps, T, GW);
    script.lists.backend = { items: [{ name: 'b1', properties: {} }], complete: false, error: 'page cap' };
    await syncGateway(deps, T, GW);
    expect(await names('backend')).toEqual(['b1', 'b2']);
  });

  it('MCP unavailable on rejection: capability unavailable, no mcp docs invented, prior mcp docs not swept', async () => {
    script.mcp = { status: 'ok', items: [{ name: 'm1', properties: { displayName: 'm1', serviceUrl: 'https://t.example/mcp?k=SECRET' } }], complete: true };
    await syncGateway(deps, T, GW);
    expect((await gateways.get(T, GW))!.capabilities.mcpServers).toBe('available');
    script.mcp = { status: 'unavailable', reason: 'rejected 2025-09-01-preview (HTTP 400)' };
    const r = await syncGateway(deps, T, GW);
    expect((await gateways.get(T, GW))!.capabilities.mcpServers).toBe('unavailable');
    expect(r.ok && r.mcp).toBe('unavailable');
    expect(await names('mcp')).toEqual(['m1']);
    const m = (await observed.list(T, 'observed:mcp'))[0];
    expect(m.mcp?.url).toBe('https://t.example/mcp');
    expect(JSON.stringify(m)).not.toContain('SECRET');
  });

  it('an MCP call that throws (not a rejection) leaves capability unknown, not unavailable', async () => {
    script.mcp = new Error('503');
    await syncGateway(deps, T, GW);
    expect((await gateways.get(T, GW))!.capabilities.mcpServers).toBe('unknown');
  });

  it('never overwrites environmentKey classified while the sync was reading (re-read before write)', async () => {
    script.lists.api = ok('a');
    script.onList = async () => {
      const cur = (await gateways.get(T, GW))!;
      await gateways.replaceBatch(T, [{ doc: { ...cur, environmentKey: 'prod' }, expectedEtag: cur._etag }]);
      script.onList = undefined;
    };
    await syncGateway(deps, T, GW);
    const g = (await gateways.get(T, GW))!;
    expect(g.environmentKey).toBe('prod');
    expect(g.inventory.apis).toBe(1);
    expect(g.inventory.lastSyncAt).toBe('2026-10-30T00:00:00.000Z');
  });

  it('second concurrent sync of the same gateway is refused; admission is released afterwards', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    script.onList = () => gate;
    const first = syncGateway(deps, T, GW);
    await new Promise((r) => setTimeout(r, 5));
    expect(isSyncInFlight(GW)).toBe(true);
    const second = await syncGateway(deps, T, GW);
    expect(second).toMatchObject({ ok: false, status: 'in_flight' });
    release();
    await first;
    expect(isSyncInFlight(GW)).toBe(false);
    script.onList = undefined;
    expect((await syncGateway(deps, T, GW)).ok).toBe(true);
  });

  it('refuses an unreadable or unknown gateway', async () => {
    expect(await syncGateway(deps, T, 'nope')).toMatchObject({ ok: false, status: 'not_found' });
    await gateways.upsert(gateway({ id: 'gw-2', access: { canRead: false, canWrite: false, checkedAt: 'x', source: 'probe' } }));
    expect(await syncGateway(deps, T, 'gw-2')).toMatchObject({ ok: false, status: 'no_access' });
  });

  it('stores facets and no policy XML or secrets; subscriptions carry no keys; named values carry no values', async () => {
    script.lists.api = { items: [{ name: 'chat', properties: { displayName: 'chat', path: 'openai', serviceUrl: 'https://acct.openai.azure.com/openai?sig=SECRETSIG' } }], complete: true };
    script.policies.chat = '<policies><inbound><set-backend-service base-url="https://h/p?code=SECRET" /><llm-token-limit tokens-per-minute="100" counter-key="k" /></inbound></policies>';
    script.lists.subscription = { items: [{ name: 's1', properties: { scope: '/apis', state: 'active', primaryKey: 'PRIMKEY', secondaryKey: 'SECKEY' } }], complete: true };
    script.lists.namedValue = { items: [{ name: 'nv', properties: { displayName: 'nv', secret: true, value: 'NVSECRET' } }], complete: true };
    await syncGateway(deps, T, GW);
    const all = JSON.stringify(await observed.list(T));
    const api = (await observed.list(T, 'observed:api'))[0];
    expect(api.policyAnalysis?.facets.backendHosts).toEqual(['h']);
    expect(api.aiSurface).toMatchObject({ selection: 'detected' });
    expect(api.aiSurface?.kinds).toEqual(['azure-openai', 'llm-policy']);
    for (const n of ['code=', 'SECRET', 'PRIMKEY', 'SECKEY', 'NVSECRET', 'sig=', '<policies', '<inbound']) expect(all, n).not.toContain(n);
    expect((await names('subscription'))).toEqual(['s1']);
    expect((await names('namedValue'))).toEqual(['nv']);
  });

  it('a manual AI selection survives a sync; a failed policy read keeps the previous analysis', async () => {
    script.lists.api = ok('chat');
    script.policies.chat = '<policies><inbound><llm-token-limit tokens-per-minute="100" counter-key="k" /></inbound></policies>';
    await syncGateway(deps, T, GW);
    const d = (await observed.list(T, 'observed:api'))[0];
    await observed.upsert({ ...d, aiSurface: { selection: 'manual', kinds: ['custom'], reasons: [] } });
    script.policies.chat = new Error('policy 500');
    await syncGateway(deps, T, GW);
    const after = (await observed.list(T, 'observed:api'))[0];
    expect(after.aiSurface).toMatchObject({ selection: 'manual', kinds: ['custom'] });
    expect(after.policyAnalysis?.facets.llm).toBe(true);
  });

  it('operations are recorded under their API', async () => {
    script.lists.api = ok('a1');
    script.ops.a1 = ok('get-x', 'post-y');
    const r = await syncGateway(deps, T, GW);
    expect(await names('operation')).toEqual(['a1/get-x', 'a1/post-y']);
    expect(r.ok && r.counts.operation).toBe(2);
  });
});

describe('observedFindingsSource', () => {
  it('maps observed mcp docs to gateway MCP servers and skips docs without a url', async () => {
    script.mcp = { status: 'ok', complete: true, items: [
      { name: 'm1', properties: { displayName: 'M1', serviceUrl: 'https://t.example/mcp' } },
      { name: 'm2', properties: { displayName: 'M2' } },
    ] };
    await syncGateway(deps, T, GW);
    const s = observedFindingsSource(() => observed);
    const servers = await s.gatewayMcpServers(T);
    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({ gatewayId: GW, name: 'M1', url: 'https://t.example/mcp' });
    expect(await s.mcpEndpoints(T)).toEqual([]);
  });
});
