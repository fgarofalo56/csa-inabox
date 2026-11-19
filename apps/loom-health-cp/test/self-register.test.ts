import { describe, expect, it } from 'vitest';
import { ConfigError } from '../src/config.js';
import { ArmError, type Lookup, type TenantArm } from '../src/jobs/tenant-arm.js';
import { Registry } from '../src/registry/registry.js';
import {
  ensureStampRegistered,
  loadStampSelfRegistration,
  scheduleStampSelfRegistration,
  type StampSelfRegistration,
} from '../src/registry/self-register.js';
import type { StampDoc, TenantDoc } from '../src/registry/types.js';
import { MemoryCollection } from './helpers.js';

const cfg: StampSelfRegistration = { id: 'dev01', cloud: 'commercial', region: 'centralus', class: 'S', baseUrl: 'https://dev01.example.net' };

function setup(lookup: () => Promise<Lookup<Record<string, unknown>>>) {
  const stamps = new MemoryCollection<StampDoc>();
  const registry = new Registry(stamps, new MemoryCollection<TenantDoc>());
  const rgs: string[] = [];
  const arm = {
    getStampManifest: async (rg: string) => {
      rgs.push(rg);
      return lookup();
    },
  } as unknown as TenantArm;
  const events: { event: string; fields: Record<string, string | number> }[] = [];
  const log = (event: string, fields: Record<string, string | number>): void => void events.push({ event, fields });
  return { stamps, registry, arm, rgs, events, deps: { registry, arm, log } };
}

const found = async (): Promise<Lookup<Record<string, unknown>>> => ({ state: 'found', value: { keyVaultUri: 'https://v/' } });

describe('stamp self-registration: ensureStampRegistered (#5377)', () => {
  it('creates the stamp with the configured values and moves it to healthy when the stamp deployment reads back', async () => {
    // Breaks if the healthy transition is skipped (status stays "creating", the Console says no-stamp) or a field is dropped.
    const s = setup(found);
    expect(await ensureStampRegistered(s.deps, cfg)).toBe('healthy');
    const doc = s.stamps.docs.get('dev01')!;
    expect(doc.status).toBe('healthy');
    expect(doc).toMatchObject({ cloud: 'commercial', region: 'centralus', class: 'S', baseUrl: 'https://dev01.example.net' });
    // Breaks if the ARM read targets another resource group than the one tenant.create resolves.
    expect(s.rgs).toEqual(['rg-csa-loom-health-dev01-centralus']);
  });

  it.each([
    ['absent', { state: 'absent' } as Lookup<Record<string, unknown>>],
    ['no_outputs', { state: 'no_outputs' } as Lookup<Record<string, unknown>>],
  ])('does NOT mark healthy when the stamp deployment is %s (nothing established)', async (_n, lookup) => {
    // Breaks if healthy is asserted unconditionally (deploy-integrity R7).
    const s = setup(async () => lookup);
    expect(await ensureStampRegistered(s.deps, cfg)).toBe('created_pending');
    expect(s.stamps.docs.get('dev01')!.status).toBe('creating');
    expect(await ensureStampRegistered(s.deps, cfg)).toBe('pending');
    expect(s.stamps.docs.get('dev01')!.status).toBe('creating');
  });

  it('promotes a stamp left in creating by an earlier failed pass once the read succeeds', async () => {
    let ok = false;
    const s = setup(async () => (ok ? found() : { state: 'absent' }));
    await ensureStampRegistered(s.deps, cfg);
    ok = true;
    expect(await ensureStampRegistered(s.deps, cfg)).toBe('healthy');
    expect(s.stamps.docs.get('dev01')!.status).toBe('healthy');
  });

  it.each(['paused', 'draining', 'evacuated'] as const)('leaves an operator-set %s stamp alone and never reads ARM', async (status) => {
    // Breaks if self-registration flips an operator-paused stamp back to healthy.
    const s = setup(found);
    await s.stamps.create({ id: 'dev01', displayName: 'dev01', cloud: 'commercial', region: 'centralus', class: 'M', status, baseUrl: 'https://op.example.net', engineVersions: {}, pauseReason: 'ops', createdAt: 't', updatedAt: 't', updatedBy: 'op' } as StampDoc);
    expect(await ensureStampRegistered(s.deps, cfg)).toBe('left_alone');
    const doc = s.stamps.docs.get('dev01')!;
    expect(doc.status).toBe(status);
    expect(doc.class).toBe('M'); // existing values are not overwritten either
    expect(s.rgs).toEqual([]);
  });

  it('is idempotent on an already-healthy stamp', async () => {
    const s = setup(found);
    await ensureStampRegistered(s.deps, cfg);
    const etag = s.stamps.docs.get('dev01')!._etag;
    expect(await ensureStampRegistered(s.deps, cfg)).toBe('already_healthy');
    expect(s.stamps.docs.get('dev01')!._etag).toBe(etag); // no write
  });

  it('treats a create conflict from a concurrent replica as success', async () => {
    // The other replica wins the create between our get (404) and our create (conflict).
    const s = setup(found);
    const realGet = s.stamps.get.bind(s.stamps);
    let first = true;
    s.stamps.get = async (id: string) => {
      if (first) {
        first = false;
        await s.stamps.create({ id, displayName: id, cloud: 'commercial', region: 'centralus', class: 'S', status: 'creating', baseUrl: cfg.baseUrl, engineVersions: {}, createdAt: 't', updatedAt: 't', updatedBy: 'other' } as StampDoc);
        return undefined;
      }
      return realGet(id);
    };
    await expect(ensureStampRegistered(s.deps, cfg)).resolves.toBe('healthy');
    expect(s.stamps.docs.get('dev01')!.updatedBy).toBe('system:self-register');
  });

  it('a lost etag race on the healthy move is success only if the stamp left creating', async () => {
    const s = setup(found);
    await ensureStampRegistered({ ...s.deps, arm: { getStampManifest: async () => ({ state: 'absent' }) } as unknown as TenantArm }, cfg);
    const realReplace = s.stamps.replace.bind(s.stamps);
    s.stamps.replace = async () => {
      throw new (await import('../src/http/errors.js')).StoreConflictError('stale');
    };
    // Still creating after three lost races: the pass must report failure so the timer retries.
    await expect(ensureStampRegistered(s.deps, cfg)).rejects.toMatchObject({ status: 409 });
    s.stamps.replace = realReplace;
  });
});

describe('stamp self-registration: scheduler never throws and logs only ids and codes (#5377)', () => {
  it('logs an ARM 403 as status+code, keeps retrying, and stops after healthy', async () => {
    let mode: 'deny' | 'ok' = 'deny';
    const s = setup(async () => {
      if (mode === 'deny') throw new ArmError(403, 'AuthorizationFailed', 'read stamp deployment');
      return found();
    });
    const stop = scheduleStampSelfRegistration(s.deps, cfg, 5);
    await new Promise((r) => setTimeout(r, 40));
    const err = s.events.find((e) => e.event === 'stamp.self_register_error');
    expect(err?.fields).toMatchObject({ stamp: 'dev01', status: 403, code: 'AuthorizationFailed' });
    expect(s.events.filter((e) => e.event === 'stamp.self_register_error').length).toBeGreaterThan(1); // retried
    expect(s.stamps.docs.get('dev01')!.status).toBe('creating');
    mode = 'ok';
    await new Promise((r) => setTimeout(r, 60));
    stop();
    expect(s.stamps.docs.get('dev01')!.status).toBe('healthy');
    expect(s.events.some((e) => e.event === 'stamp.self_register' && e.fields.outcome === 'healthy')).toBe(true);
  });

  it('does not put a raw exception message in the log line', async () => {
    // Breaks if e.message is logged: the secret-looking text below would appear in the serialised event.
    const s = setup(async () => {
      throw new Error('boom https://secret.vault.example/keys/k?sig=TOPSECRET');
    });
    const stop = scheduleStampSelfRegistration(s.deps, cfg, 1000);
    await new Promise((r) => setTimeout(r, 20));
    stop();
    const line = JSON.stringify(s.events);
    expect(line).toContain('stamp.self_register_error');
    expect(line).not.toContain('TOPSECRET');
  });
});

describe('stamp self-registration: loadStampSelfRegistration (#5377)', () => {
  const full = {
    LOOM_HEALTH_CP_STAMP_ID: 'dev01',
    LOOM_HEALTH_CP_STAMP_REGION: 'centralus',
    LOOM_HEALTH_CP_STAMP_CLASS: 'S',
    LOOM_HEALTH_CP_STAMP_BASE_URL: 'https://dev01.example.net',
  };
  it('returns undefined when the stamp id is unset and no other stamp var is', () => {
    expect(loadStampSelfRegistration('commercial', {})).toBeUndefined();
  });
  it('builds the config in every boundary, taking the cloud from the service config', () => {
    for (const cloud of ['commercial', 'gcc', 'gcc-high', 'il5', 'dod'] as const) {
      expect(loadStampSelfRegistration(cloud, full)).toEqual({ id: 'dev01', cloud, region: 'centralus', class: 'S', baseUrl: 'https://dev01.example.net' });
    }
  });
  it('names the missing variable on a partial set', () => {
    expect(() => loadStampSelfRegistration('commercial', { ...full, LOOM_HEALTH_CP_STAMP_BASE_URL: '' })).toThrow(/LOOM_HEALTH_CP_STAMP_BASE_URL/);
    expect(() => loadStampSelfRegistration('commercial', { LOOM_HEALTH_CP_STAMP_REGION: 'centralus' })).toThrow(ConfigError);
  });
  it.each([
    ['class', { LOOM_HEALTH_CP_STAMP_CLASS: 'XL' }],
    ['http baseUrl', { LOOM_HEALTH_CP_STAMP_BASE_URL: 'http://dev01.example.net' }],
    ['region with a dash', { LOOM_HEALTH_CP_STAMP_REGION: 'central-us' }],
    ['uppercase id', { LOOM_HEALTH_CP_STAMP_ID: 'Dev01' }],
  ])('rejects an invalid %s at startup', (_n, over) => {
    expect(() => loadStampSelfRegistration('commercial', { ...full, ...over })).toThrow(ConfigError);
  });
});
