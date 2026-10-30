import { describe, expect, it } from 'vitest';
import { createEnvironment, deleteEnvironment } from '../catalog';
import { runFindings, normalizeUrl, type FindingProducer } from '../findings';
import { lockOrder } from '../locks';
import { seedCatalog } from '../seed';
import { suggestFromTags } from '../tags';

describe('seed (D9)', () => {
  it('seeds exactly the six built-ins, all undeletable, only Production production-class, require-classification off', () => {
    const c = seedCatalog('t');
    expect(c.environments.map((e) => e.key)).toEqual(['development', 'test', 'qc', 'staging', 'production', 'sandbox']);
    expect(c.environments.every((e) => e.builtIn)).toBe(true);
    expect(c.environments.filter((e) => e.isProductionClass).map((e) => e.key)).toEqual(['production']);
    expect(c.settings.requireClassification).toBe(false);
  });

  it('adds a pipeline stage name only when not already present (case-insensitive, alias-aware)', () => {
    const c = seedCatalog('t', ['development', 'PROD', 'Pre-Release', 'UAT']);
    const added = c.environments.filter((e) => !e.builtIn);
    expect(added.map((e) => e.displayName)).toEqual(['Pre-Release']);
    expect(added[0].key).toBe('pre-release');
  });
});

describe('catalog edits', () => {
  const c = seedCatalog('t');
  it('refuses to delete a built-in, and an environment in use (listing the users)', () => {
    const d = deleteEnvironment(c, 'production', []);
    expect(d.ok).toBe(false);
    const made = createEnvironment(c, 'Perf');
    if (!made.ok) throw new Error(made.error);
    const inUse = deleteEnvironment(made.doc, 'perf', [{ kind: 'gateway', id: 'g1', displayName: 'Gateway One', environmentKey: 'perf' }]);
    expect(inUse).toMatchObject({ ok: false });
    expect((inUse as { error: string }).error).toContain('Gateway One');
    expect(deleteEnvironment(made.doc, 'perf', []).ok).toBe(true);
  });
  it('refuses a duplicate key and a reserved key', () => {
    expect(createEnvironment(c, 'development').ok).toBe(false);
    expect(createEnvironment(c, 'Matrix').ok).toBe(false);
  });
});

describe('lockOrder', () => {
  it('orders environments, then gateways, endpoints, publications, each sorted by id, without duplicates', () => {
    const got = lockOrder(['publication:b', 'endpoint:z', 'gateway:m', 'publication:a', 'gateway:c', 'environments:tenant', 'endpoint:a', 'gateway:c']);
    expect(got).toEqual(['environments:tenant', 'gateway:c', 'gateway:m', 'endpoint:a', 'endpoint:z', 'publication:a', 'publication:b']);
  });
});

describe('tag suggestions', () => {
  const envs = seedCatalog('t').environments;
  const r = (id: string, env: string | null, tags?: Record<string, string>) => ({ kind: 'gateway' as const, id, displayName: id, environmentKey: env, armTags: tags });
  it('suggests from environment/env tags by key, display name or alias, only for unclassified resources', () => {
    const s = suggestFromTags([
      r('a', null, { Environment: 'Prod' }),
      r('b', null, { env: 'development' }),
      r('c', 'test', { env: 'prod' }),
      r('d', null, { env: 'moonbase' }),
      r('e', null, { owner: 'prod' }),
    ], envs);
    expect(s.map((x) => [x.resourceId, x.environmentKey, x.matchedBy])).toEqual([['a', 'production', 'alias'], ['b', 'development', 'key']]);
  });
});

describe('findings', () => {
  const settings = { requireClassification: false, environments: seedCatalog('t').environments };
  const gw = (id: string, env: string | null) => ({ kind: 'gateway' as const, id, displayName: `gw-${id}`, environmentKey: env });
  const ep = (id: string, env: string | null, url: string) => ({ kind: 'mcp' as const, id, displayName: `ep-${id}`, environmentKey: env, url });

  it('reports a blocked gateway MCP pairing, matching URLs ignoring case, query and trailing slash; skips allowed pairings', () => {
    const out = runFindings({
      gateways: [gw('g1', 'production'), gw('g2', 'development')],
      mcpEndpoints: [ep('m1', 'development', 'https://MCP.contoso.com/sse/'), ep('m2', 'development', 'https://other.contoso.com/x')],
      gatewayMcpServers: [
        { gatewayId: 'g1', serverId: 's1', name: 'tools', url: 'https://mcp.contoso.com/sse?x=1' },
        { gatewayId: 'g2', serverId: 's2', name: 'tools', url: 'https://other.contoso.com/x' },
        { gatewayId: 'g1', serverId: 's3', name: 'unregistered', url: 'https://nobody.example/y' },
      ],
      settings,
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: 'gateway-mcp:g1:s1', severity: 'advisory', resourceId: 'm1' });
  });

  it('is extensible: a second producer (W2 shape) is merged and sorted by id', () => {
    const extra: FindingProducer = () => [{ id: 'a-first', producer: 'backend-url', severity: 'advisory', gatewayId: 'g', gatewayName: 'g', resourceKind: 'endpoint', resourceId: 'e', resourceName: 'e', message: 'm' }];
    const out = runFindings({ gateways: [], mcpEndpoints: [], gatewayMcpServers: [], settings }, [extra, () => [{ ...extra({} as never)[0], id: 'z-last' }]]);
    expect(out.map((f) => f.id)).toEqual(['a-first', 'z-last']);
  });

  it('normalizeUrl rejects non-URLs instead of matching everything', () => {
    expect(normalizeUrl('not a url')).toBeUndefined();
    expect(normalizeUrl('https://H.com/a/?q=1#f')).toBe('https://h.com/a');
  });
});
