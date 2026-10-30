/**
 * W1-9 discovery service.
 *
 * Breaking values (assertion-design.md):
 *  - partial: with sub B answering 403, `partial` must be true and failures must hold
 *    {scope: SUB_B, status: 403}. Dropping the failure push / hard-coding partial:false fails
 *    both. Paired with the all-readable double, where partial must be false and failures [].
 *  - registered mark: the candidate whose id was registered (in DIFFERENT casing) is true, its
 *    sibling false; a case-sensitive match or an always-false mark fails the first, an
 *    always-true mark fails the second.
 *  - zero writes: MemoryGatewayRepo.writes stays 0 across a scan. Positive control: the same
 *    repo's registerGateway() DOES raise writes to 1, so the counter can move. ARM side: the
 *    ArmPort has only get(); the double records every URL and each must be a GET to a
 *    subscriptions path (a write verb cannot be expressed through the port - disclosed, not
 *    counted as coverage).
 *  - concurrency: 20 subscriptions with a 5ms delay must peak above 1 in flight (sequential
 *    scan = peak 1) and never above DISCOVERY_CONCURRENCY.
 *  - paging: a nextLink on subscription list page 1 must yield the sub on page 2; ignoring
 *    nextLink drops it. A failing page 2 keeps page-1 items AND flags partial.
 */
import { describe, expect, it } from 'vitest';
import { MemoryGatewayRepo } from '../../__tests__/memory-gateway-repo';
import { fakeJwt, OID, CONTRIBUTOR_PERMS, READER_PERMS } from '../../__tests__/arm-double';
import { registerGateway, type RegistryDeps } from '../../gateway-service';
import type { ArmPort } from '../../preflight';
import { discoverGateways, DISCOVERY_CONCURRENCY, observeSummary } from '../scan';

const SUB_A = 'aaaaaaaa-1111-2222-3333-444444444444';
const SUB_B = 'bbbbbbbb-1111-2222-3333-444444444444';
const rid = (sub: string, name: string) =>
  `/subscriptions/${sub}/resourceGroups/rg-${name}/providers/Microsoft.ApiManagement/service/${name}`;
const svc = (sub: string, name: string, extra: Record<string, unknown> = {}) => ({
  id: rid(sub, name), name, location: 'eastus2', sku: { name: 'Developer' },
  properties: { virtualNetworkType: 'Internal' }, ...extra,
});

interface World {
  subs?: Array<{ subscriptionId: string }>;
  subsStatus?: number;
  /** sub -> response; default 200 with []. */
  services?: Record<string, { status?: number; value?: unknown[]; nextLink?: string; body?: unknown }>;
  permissions?: Record<string, Array<{ actions?: string[]; notActions?: string[] }> | undefined>;
  delayMs?: number;
  extra?: Record<string, { status: number; body: unknown }>;
}

function world(w: World) {
  const calls: string[] = [];
  let inflight = 0;
  let peak = 0;
  const arm: ArmPort = {
    armBase: () => 'https://management.usgovcloudapi.net',
    getToken: async () => fakeJwt({ oid: OID }),
    async get(url) {
      calls.push(url);
      inflight++;
      peak = Math.max(peak, inflight);
      try {
        if (w.delayMs) await new Promise((r) => setTimeout(r, w.delayMs));
        if (w.extra?.[url]) return w.extra[url];
        if (url.includes('/subscriptions?api-version')) {
          return w.subsStatus && w.subsStatus !== 200
            ? { status: w.subsStatus, body: { error: { code: 'AuthorizationFailed', message: 'no' } } }
            : { status: 200, body: { value: w.subs ?? [] } };
        }
        const m = /\/subscriptions\/([^/]+)\/providers\/Microsoft\.ApiManagement\/service\?/.exec(url);
        if (m) {
          const s = w.services?.[m[1]] ?? {};
          return s.body !== undefined || (s.status && s.status !== 200)
            ? { status: s.status ?? 200, body: s.body }
            : { status: 200, body: { value: s.value ?? [], ...(s.nextLink ? { nextLink: s.nextLink } : {}) } };
        }
        if (url.includes('/providers/Microsoft.Authorization/permissions')) {
          const sub = /\/subscriptions\/([^/]+)\//.exec(url)![1];
          const p = w.permissions?.[sub];
          return p ? { status: 200, body: { value: p } } : { status: 403, body: {} };
        }
        return { status: 404, body: {} };
      } finally {
        inflight--;
      }
    },
  };
  return { arm, calls, peak: () => peak };
}

const NOW = () => new Date('2026-10-30T00:00:00Z');

describe('partial reads', () => {
  const services = {
    [SUB_A]: { value: [svc(SUB_A, 'apim-a')] },
    [SUB_B]: { status: 403, body: { error: { code: 'AuthorizationFailed', message: 'Caller cannot list services' } } },
  };
  it('one unreadable subscription: readable candidates returned AND partial:true naming it with the real status', async () => {
    const w = world({ subs: [{ subscriptionId: SUB_A }, { subscriptionId: SUB_B }], services, permissions: { [SUB_A]: READER_PERMS } });
    const r = await discoverGateways({ arm: w.arm, repo: new MemoryGatewayRepo(), now: NOW }, 't1');
    expect(r.candidates.map((c) => c.name)).toEqual(['apim-a']);
    expect(r.partial).toBe(true);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toMatchObject({ scope: SUB_B, kind: 'service-list', status: 403 });
    expect(r.failures[0].reason).toContain('Caller cannot list services');
    expect(r.subscriptionsScanned).toBe(2);
  });

  it('paired: both subscriptions readable -> partial:false, no failures, both candidates', async () => {
    const w = world({
      subs: [{ subscriptionId: SUB_A }, { subscriptionId: SUB_B }],
      services: { [SUB_A]: { value: [svc(SUB_A, 'apim-a')] }, [SUB_B]: { value: [svc(SUB_B, 'apim-b')] } },
    });
    const r = await discoverGateways({ arm: w.arm, repo: new MemoryGatewayRepo(), now: NOW }, 't1');
    expect(r.partial).toBe(false);
    expect(r.failures).toEqual([]);
    expect(r.candidates.map((c) => c.name)).toEqual(['apim-a', 'apim-b']);
  });

  it('subscription list refused: partial:true with scope subscriptions and zero candidates is NOT a complete empty result', async () => {
    const w = world({ subsStatus: 403 });
    const r = await discoverGateways({ arm: w.arm, repo: new MemoryGatewayRepo(), now: NOW }, 't1');
    expect(r.candidates).toEqual([]);
    expect(r.partial).toBe(true);
    expect(r.failures[0]).toMatchObject({ scope: 'subscriptions', kind: 'subscription-list', status: 403 });
  });

  it('control: readable subscriptions with zero services -> partial:false (an empty COMPLETE result)', async () => {
    const w = world({ subs: [{ subscriptionId: SUB_A }] });
    const r = await discoverGateways({ arm: w.arm, repo: new MemoryGatewayRepo(), now: NOW }, 't1');
    expect(r).toMatchObject({ candidates: [], partial: false, failures: [], subscriptionsScanned: 1 });
  });

  it('a failing second page keeps page-1 items and flags partial; nextLink is followed on success', async () => {
    const next = 'https://management.usgovcloudapi.net/subscriptions?api-version=2022-12-01&$skiptoken=p2';
    const ok = world({
      subs: [{ subscriptionId: SUB_A }],
      extra: { [next]: { status: 200, body: { value: [{ subscriptionId: SUB_B }] } } },
      services: { [SUB_A]: { value: [svc(SUB_A, 'apim-a')] }, [SUB_B]: { value: [svc(SUB_B, 'apim-b')] } },
    });
    // page 1 carries nextLink: wrap the double so the first subscriptions call advertises it
    const first = ok.arm.get;
    ok.arm.get = async (url, tok) => {
      const res = await first(url, tok);
      return url.includes('/subscriptions?api-version') && url !== next
        ? { status: 200, body: { ...(res.body as object), nextLink: next } }
        : res;
    };
    const good = await discoverGateways({ arm: ok.arm, repo: new MemoryGatewayRepo(), now: NOW }, 't1');
    expect(good.candidates.map((c) => c.name)).toEqual(['apim-a', 'apim-b']);
    expect(good.partial).toBe(false);

    const bad = world({
      subs: [{ subscriptionId: SUB_A }],
      extra: { [next]: { status: 429, body: { error: { code: 'TooManyRequests', message: 'slow down' } } } },
      services: { [SUB_A]: { value: [svc(SUB_A, 'apim-a')] } },
    });
    const f = bad.arm.get;
    bad.arm.get = async (url, tok) => {
      const res = await f(url, tok);
      return url.includes('/subscriptions?api-version') && url !== next
        ? { status: 200, body: { ...(res.body as object), nextLink: next } }
        : res;
    };
    const r = await discoverGateways({ arm: bad.arm, repo: new MemoryGatewayRepo(), now: NOW }, 't1');
    expect(r.candidates.map((c) => c.name)).toEqual(['apim-a']);
    expect(r.partial).toBe(true);
    expect(r.failures[0]).toMatchObject({ scope: 'subscriptions', status: 429 });
  });

  it('an access check that throws is a failure (partial) and the candidate is Access unchecked, not read:false by assumption', async () => {
    const w = world({ subs: [{ subscriptionId: SUB_A }], services: { [SUB_A]: { value: [svc(SUB_A, 'apim-a')] } } });
    let n = 0;
    const first = w.arm.getToken;
    w.arm.getToken = async () => {
      if (n++ > 0) throw new Error('token endpoint down');
      return first();
    };
    const r = await discoverGateways({ arm: w.arm, repo: new MemoryGatewayRepo(), now: NOW }, 't1');
    expect(r.partial).toBe(true);
    expect(r.failures[0]).toMatchObject({ kind: 'access-check', scope: rid(SUB_A, 'apim-a') });
    expect(r.failures[0].reason).toContain('token endpoint down');
    expect(r.candidates[0].access.source).toBe('unavailable');
  });
});

describe('candidate fields and registered mark', () => {
  it('maps sku, location, network mode, access; marks only the registered one (case-insensitive id)', async () => {
    const repo = new MemoryGatewayRepo();
    const w = world({
      subs: [{ subscriptionId: SUB_A }],
      services: { [SUB_A]: { value: [svc(SUB_A, 'apim-a'), svc(SUB_A, 'apim-z', { sku: { name: 'Premium' }, location: 'usgovvirginia', properties: { virtualNetworkType: 'None' } })] } },
      permissions: { [SUB_A]: CONTRIBUTOR_PERMS },
    });
    // register apim-a through the real service with the id in UPPER case
    const deps: RegistryDeps = { repo, arm: w.arm, writeAudit: async () => {}, cloud: () => 'AzureUSGovernment' };
    const reg = await registerGateway(deps, { tenantId: 't1', who: 'u', actorOid: OID, capability: 'tenant-admin' }, { resourceId: rid(SUB_A, 'apim-a') });
    expect(reg.ok).toBe(true);
    const doc = (await repo.list('t1', 'gateway'))[0];
    await repo.upsert({ ...doc, resourceId: doc.resourceId.toUpperCase() });

    const r = await discoverGateways({ arm: w.arm, repo, now: NOW }, 't1');
    const a = r.candidates.find((c) => c.name === 'apim-a')!;
    const z = r.candidates.find((c) => c.name === 'apim-z')!;
    expect(a.alreadyRegistered).toBe(true);
    expect(a.registeredGatewayId).toBe(doc.id);
    expect(z.alreadyRegistered).toBe(false);
    expect(z.registeredGatewayId).toBeUndefined();
    expect(z).toMatchObject({ sku: 'Premium', location: 'usgovvirginia', networkMode: 'None', subscriptionId: SUB_A, resourceGroup: 'rg-apim-z' });
    expect(z.access).toEqual({ canRead: true, canWrite: true, source: 'permissions' });
    expect(a.networkMode).toBe('Internal');
  });

  it('another tenant registration does not mark a candidate registered', async () => {
    const repo = new MemoryGatewayRepo();
    const w = world({ subs: [{ subscriptionId: SUB_A }], services: { [SUB_A]: { value: [svc(SUB_A, 'apim-a')] } }, permissions: { [SUB_A]: READER_PERMS } });
    const deps: RegistryDeps = { repo, arm: w.arm, writeAudit: async () => {}, cloud: () => 'AzureCloud' };
    await registerGateway(deps, { tenantId: 'other', who: 'u', actorOid: OID, capability: 'tenant-admin' }, { resourceId: rid(SUB_A, 'apim-a') });
    const r = await discoverGateways({ arm: w.arm, repo, now: NOW }, 't1');
    expect(r.candidates[0].alreadyRegistered).toBe(false);
  });

  it('uses the ArmPort base (sovereign host), never a hard-coded commercial host', async () => {
    const w = world({ subs: [{ subscriptionId: SUB_A }], services: { [SUB_A]: { value: [svc(SUB_A, 'apim-a')] } } });
    await discoverGateways({ arm: w.arm, repo: new MemoryGatewayRepo(), now: NOW }, 't1');
    expect(w.calls.length).toBeGreaterThan(2);
    expect(w.calls.every((u) => u.startsWith('https://management.usgovcloudapi.net/'))).toBe(true);
  });
});

describe('observe statement (R7: states only what was established)', () => {
  it('differs by established access', () => {
    const rw = observeSummary('g', { canRead: true, canWrite: true, source: 'permissions' }, false);
    const ro = observeSummary('g', { canRead: true, canWrite: false, source: 'permissions' }, false);
    const probe = observeSummary('g', { canRead: true, canWrite: false, source: 'probe' }, false);
    const none = observeSummary('g', { canRead: false, canWrite: false, source: 'permissions' }, false);
    const unk = observeSummary('g', { canRead: false, canWrite: false, source: 'unavailable' }, false);
    expect(ro).toContain('read-only');
    expect(probe).toContain('could not be established');
    expect(probe).not.toContain('read-only');
    expect(rw).toContain('can also write');
    expect(none).toContain('cannot read');
    expect(unk).toContain('could not check');
    expect(unk).not.toContain('cannot read');
    expect(observeSummary('g', { canRead: true, canWrite: true, source: 'permissions' }, true)).toContain('already registered');
  });
});

describe('zero writes', () => {
  it('a scan leaves the repo untouched; positive control: register DOES write in the same harness', async () => {
    const repo = new MemoryGatewayRepo();
    const w = world({ subs: [{ subscriptionId: SUB_A }], services: { [SUB_A]: { value: [svc(SUB_A, 'apim-a')] } }, permissions: { [SUB_A]: CONTRIBUTOR_PERMS } });
    const audits: unknown[] = [];
    await discoverGateways({ arm: w.arm, repo, now: NOW }, 't1');
    expect(repo.writes).toBe(0);
    expect(await repo.list('t1')).toEqual([]);
    expect(w.calls.every((u) => /^https:\/\/management\.usgovcloudapi\.net\/subscriptions/.test(u))).toBe(true);

    const deps: RegistryDeps = { repo, arm: w.arm, writeAudit: async (r) => { audits.push(r); }, cloud: () => 'AzureCloud' };
    const reg = await registerGateway(deps, { tenantId: 't1', who: 'u', actorOid: OID, capability: 'tenant-admin' }, { resourceId: rid(SUB_A, 'apim-a') });
    expect(reg.ok).toBe(true);
    expect(repo.writes).toBe(1);
    expect(audits.length).toBe(1);
  });
});

describe('bounded concurrency', () => {
  it('peaks above 1 (not sequential) and never above DISCOVERY_CONCURRENCY', async () => {
    const ids = Array.from({ length: 20 }, (_, i) => `${String(i).padStart(8, '0')}-1111-2222-3333-444444444444`);
    const w = world({
      subs: ids.map((subscriptionId) => ({ subscriptionId })),
      services: Object.fromEntries(ids.map((s, i) => [s, { value: [svc(s, `apim-${i}`)] }])),
      delayMs: 5,
    });
    const r = await discoverGateways({ arm: w.arm, repo: new MemoryGatewayRepo(), now: NOW }, 't1');
    expect(r.candidates).toHaveLength(20);
    expect(w.peak()).toBeGreaterThan(1);
    expect(w.peak()).toBeLessThanOrEqual(DISCOVERY_CONCURRENCY);
  });
});
