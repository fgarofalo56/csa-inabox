import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { JobRunner } from '../src/jobs/runner.js';
import {
  ArmError,
  stampResourceGroup,
  tenantNames,
  type KeyReadback,
  type ResourceReadback,
  type TenantArm,
  type TenantManifest,
} from '../src/jobs/tenant-arm.js';
import { tenantHandlers } from '../src/jobs/tenant-jobs.js';
import type { JobDoc } from '../src/jobs/types.js';
import { Registry } from '../src/registry/registry.js';
import type { StampDoc, TenantDoc } from '../src/registry/types.js';
import { MemoryCollection } from './helpers.js';

const SUB = '00000000-0000-0000-0000-000000000001';
const STAMP = 'dev01';
const SLUG = 'acme-health';
const RG = stampResourceGroup(STAMP, 'eastus2');
const VAULT = 'https://kv-lhds-dev01-abc.vault.azure.net/';
const id = (type: string, name: string) => `/subscriptions/${SUB}/resourceGroups/${RG}/providers/${type}/${name}`;

class FakeArm implements TenantArm {
  resources = new Map<string, string>(); // id -> name as ARM reports it
  keys = new Map<string, KeyReadback>();
  deployCalls = 0;
  deleteCalls: string[] = [];
  keyOps: string[] = [];
  stampManifest: Record<string, unknown> | undefined = { keyVaultUri: VAULT, stampName: STAMP };
  throwOnDeploy: Error | undefined;
  stickyIds = new Set<string>(); // delete silently does nothing
  keyDeleteIsNoop = false;
  renameOnDeploy: { suffix: string; to: string } | undefined;
  private manifest: TenantManifest | undefined;

  async getStampManifest() {
    return this.stampManifest;
  }
  async getTenantManifest() {
    return this.manifest;
  }
  async deployTenant(i: { slug: string }): Promise<TenantManifest> {
    this.deployCalls++;
    if (this.throwOnDeploy) throw this.throwOnDeploy;
    const n = tenantNames(STAMP, i.slug);
    const m: TenantManifest = {
      tenantSlug: i.slug,
      stampName: STAMP,
      pixelAccountId: id('Microsoft.Storage/storageAccounts', 'sthpxacmehealth1'),
      pixelAccountName: 'sthpxacmehealth1',
      auditAccountId: id('Microsoft.Storage/storageAccounts', 'sthtaacmehealth1'),
      auditAccountName: 'sthtaacmehealth1',
      databaseId: id('Microsoft.DBforPostgreSQL/flexibleServers', 'pg') + `/databases/${n.databaseName}`,
      databaseName: n.databaseName,
      eventHubId: id('Microsoft.EventHub/namespaces', 'evh') + `/eventhubs/${n.eventHubName}`,
      eventHubName: n.eventHubName,
      identityId: id('Microsoft.ManagedIdentity/userAssignedIdentities', n.identityName),
      identityPrincipalId: 'p',
      capacityAlertId: id('Microsoft.Insights/metricAlerts', n.alertName),
      maxStorageGiB: 100,
      keyIds: n.keyNames.map((k) => id('Microsoft.KeyVault/vaults', 'kv') + `/keys/${k}`),
      keyNames: n.keyNames,
    };
    for (const [, rid] of [['p', m.pixelAccountId], ['a', m.auditAccountId], ['d', m.databaseId], ['e', m.eventHubId], ['i', m.identityId], ['q', m.capacityAlertId], ...m.keyIds.map((k) => ['k', k])] as [string, string][]) {
      const name = rid.split('/').pop() as string;
      this.resources.set(rid, this.renameOnDeploy && rid.endsWith(this.renameOnDeploy.suffix) ? this.renameOnDeploy.to : name);
    }
    for (const k of m.keyNames) if (!this.keys.has(k)) this.keys.set(k, { name: k, exists: true, enabled: true });
    this.manifest = m;
    return m;
  }
  async readResource(rid: string): Promise<ResourceReadback> {
    const name = this.resources.get(rid);
    return name === undefined ? { id: rid, exists: false } : { id: rid, exists: true, name };
  }
  async deleteResource(rid: string) {
    this.deleteCalls.push(rid);
    if (!this.stickyIds.has(rid)) this.resources.delete(rid);
  }
  async readKey(_v: string, name: string): Promise<KeyReadback> {
    return this.keys.get(name) ?? { name, exists: false };
  }
  async disableKey(_v: string, name: string) {
    this.keyOps.push(`disable:${name}`);
    const k = this.keys.get(name);
    if (k) k.enabled = false;
  }
  async deleteKey(_v: string, name: string) {
    this.keyOps.push(`delete:${name}`);
    if (this.keyDeleteIsNoop) return;
    for (const rid of [...this.resources.keys()]) if (rid.endsWith(`/keys/${name}`)) this.resources.delete(rid);
    this.keys.set(name, { name, exists: false, deletedDate: '2026-10-26T00:00:00.000Z', scheduledPurgeDate: '2027-01-24T00:00:00.000Z' });
  }
}

function setup(stampStatus: StampDoc['status'] = 'healthy', tenantStatus: TenantDoc['status'] = 'creating') {
  const stamps = new MemoryCollection<StampDoc>();
  const tenants = new MemoryCollection<TenantDoc>();
  const jobsStore = new MemoryCollection<JobDoc>();
  const ts = '2026-10-26T00:00:00.000Z';
  stamps.docs.set(STAMP, {
    id: STAMP, displayName: 'Dev', cloud: 'commercial', region: 'eastus2', class: 'S', status: stampStatus,
    baseUrl: 'https://x.example', engineVersions: {}, createdAt: ts, updatedAt: ts, updatedBy: 't', _etag: 'e0',
  });
  tenants.docs.set(SLUG, {
    id: SLUG, displayName: 'Acme', stampId: STAMP, status: tenantStatus,
    quotas: { maxRequestsPerMinute: 10, maxStorageGiB: 100 }, createdAt: ts, updatedAt: ts, updatedBy: 't', _etag: 'e0',
  });
  const arm = new FakeArm();
  const registry = new Registry(stamps, tenants);
  const runner = new JobRunner(jobsStore, async (_t, i) => i === SLUG, () => {});
  for (const h of tenantHandlers({ stamps, tenants, registry, arm })) runner.register(h);
  const run = async (kind: 'tenant.create' | 'tenant.destroy', key: string, input: Record<string, unknown> = {}) => {
    const { job } = await runner.submit({ kind, subjectType: 'tenant', subjectId: SLUG, idempotencyKey: key, input, requestedBy: 't' });
    await runner.idle();
    return runner.get(job.id);
  };
  return { arm, tenants, run };
}

describe('names agree with tenant.bicep', () => {
  const bicep = readFileSync(new URL('../../../platform/fiab/bicep/modules/health/tenant.bicep', import.meta.url), 'utf8');
  // Lift each literal from the bicep source instead of transcribing it (assertion-design 3).
  const lift = (re: RegExp): string => {
    const m = re.exec(bicep);
    if (!m?.[1]) throw new Error(`pattern not found in tenant.bicep: ${re}`);
    return m[1];
  };
  const n = tenantNames('S1', 'abc-d');
  const sub = (tpl: string) => tpl.replaceAll('${stampName}', 'S1').replaceAll('${tenantSlug}', 'abc-d');

  it('event hub, identity, alert, key and database names equal the bicep templates', () => {
    expect(sub(lift(/resource tenantHub[\s\S]*?name: '([^']+)'/))).toBe(n.eventHubName);
    expect(sub(lift(/resource tenantIdentity[\s\S]*?name: '([^']+)'/))).toBe(n.identityName);
    expect(sub(lift(/resource capacityAlert[\s\S]*?name: '([^']+)'/))).toBe(n.alertName);
    expect(sub(lift(/var keyNameList = \[for k in keySuffixes: '([^']+)'\]/)).replace('${k}', 'st-pixel')).toBe(n.keyNames[0]);
    // 'lhds_${replace(tenantSlug, '-', '_')}' -> lhds_abc_d
    expect(lift(/name: '(lhds_)\$\{replace\(tenantSlug, '-', '_'\)\}'/) + 'abc_d').toBe(n.databaseName);
  });
  it('key suffix order equals the bicep keySuffixes order (readback pairs keys by index)', () => {
    expect(lift(/var keySuffixes = \[([^\]]+)\]/).replaceAll("'", '').split(', ')).toEqual(n.keyNames.map((k) => k.replace('t-abc-d-', '')));
  });
});

describe('tenant.create', () => {
  it('provisions, reads back every resource id and key state, and activates the tenant', async () => {
    const { arm, tenants, run } = setup();
    const job = await run('tenant.create', 'k1');
    expect(job.state, JSON.stringify(job.error)).toBe('succeeded');
    expect(tenants.docs.get(SLUG)?.status).toBe('active');
    const readbacks = job.receipts.filter((r) => r.step === 'readback');
    // 5 fixed resources + database + 4 keys = 10; fewer means a resource was skipped.
    expect(readbacks).toHaveLength(10);
    for (const rid of arm.resources.keys()) expect(readbacks.some((r) => r.detail.includes(rid)), rid).toBe(true);
    expect(job.receipts.filter((r) => r.step === 'key.state').map((r) => r.detail)).toEqual(
      tenantNames(STAMP, SLUG).keyNames.map((k) => `key=${k} exists=true enabled=true`),
    );
  });

  it('fails readback_mismatch when ARM reports a different name than the derived one (tenant stays creating)', async () => {
    const { arm, tenants, run } = setup();
    // Input that breaks it: the event hub exists but under another name. A handler that compared
    // ARM's name with ARM's own manifest name would pass.
    arm.renameOnDeploy = { suffix: `/eventhubs/eh-t-${SLUG}`, to: 'eh-t-other' };
    const job = await run('tenant.create', 'k1');
    expect(job.state).toBe('failed');
    expect(job.error?.code).toBe('readback_mismatch');
    expect(job.error?.message).toContain('named eh-t-other, expected eh-t-acme-health');
    expect(tenants.docs.get(SLUG)?.status).toBe('creating');
  });

  it('fails when a tenant key is disabled', async () => {
    const { arm, tenants, run } = setup();
    for (const k of tenantNames(STAMP, SLUG).keyNames) arm.keys.set(k, { name: k, exists: true, enabled: true });
    arm.keys.set(`t-${SLUG}-pg`, { name: `t-${SLUG}-pg`, exists: true, enabled: false });
    const job = await run('tenant.create', 'k1');
    expect(job.error?.code).toBe('readback_mismatch');
    expect(job.error?.message).toContain(`key t-${SLUG}-pg is not enabled`);
    expect(tenants.docs.get(SLUG)?.status).toBe('creating');
  });

  it('self-heals: re-running on an active tenant recreates a resource deleted out of band', async () => {
    const { arm, tenants, run } = setup();
    expect((await run('tenant.create', 'k1')).state).toBe('succeeded');
    const hubId = [...arm.resources.keys()].find((k) => k.includes('/eventhubs/')) as string;
    arm.resources.delete(hubId);
    // The DEPLOY is what recreates it; the fake recreates on every deployTenant like incremental ARM.
    const job = await run('tenant.create', 'k2');
    expect(job.state, JSON.stringify(job.error)).toBe('succeeded');
    expect(arm.deployCalls).toBe(2); // 1 would mean the second run skipped the deployment
    expect(arm.resources.has(hubId)).toBe(true);
    expect(tenants.docs.get(SLUG)?.status).toBe('active');
  });

  it('refuses a stamp that is not healthy and never deploys', async () => {
    const { arm, run } = setup('creating');
    const job = await run('tenant.create', 'k1');
    expect(job.error?.code).toBe('stamp_not_ready');
    expect(arm.deployCalls).toBe(0);
  });

  it('names the missing stamp deployment instead of guessing', async () => {
    const { arm, run } = setup();
    arm.stampManifest = undefined;
    const job = await run('tenant.create', 'k1');
    expect(job.error?.code).toBe('stamp_manifest_missing');
    expect(job.error?.message).toContain(`lhds-stamp-${STAMP}`);
  });

  it('maps an ARM 403 to a permission failure naming the operation, without the body', async () => {
    const { arm, run } = setup();
    arm.throwOnDeploy = new ArmError(403, 'AuthorizationFailed', 'start tenant deployment');
    const job = await run('tenant.create', 'k1');
    expect(job.error?.code).toBe('permission');
    expect(job.error?.message).toContain('start tenant deployment');
  });
});

describe('tenant.destroy', () => {
  async function created() {
    const s = setup();
    expect((await s.run('tenant.create', 'k1')).state).toBe('succeeded');
    return s;
  }

  it('refuses without the matching confirmation and changes nothing', async () => {
    const { arm, tenants, run } = await created();
    const job = await run('tenant.destroy', 'd1', { confirmTenantId: 'someone-else' });
    expect(job.error?.code).toBe('confirmation_mismatch');
    expect(arm.deleteCalls).toEqual([]);
    expect(arm.keyOps).toEqual([]);
    expect(tenants.docs.get(SLUG)?.status).toBe('active');
  });

  it('deletes every resource, THEN shreds the keys, and reads the key state back as deleted', async () => {
    const { arm, tenants, run } = await created();
    const job = await run('tenant.destroy', 'd1', { confirmTenantId: SLUG });
    expect(job.state, JSON.stringify(job.error)).toBe('succeeded');
    expect(arm.resources.size).toBe(0);
    expect(tenants.docs.get(SLUG)?.status).toBe('destroying');
    const steps = job.receipts.map((r) => r.step);
    const lastDelete = steps.lastIndexOf('resource.deleted');
    const firstShred = steps.indexOf('key.shredded');
    // Input that breaks it: shredding before the accounts are gone makes lastDelete > firstShred.
    expect(lastDelete).toBeGreaterThanOrEqual(0);
    expect(lastDelete).toBeLessThan(firstShred);
    // disable precedes delete for each key
    for (const k of tenantNames(STAMP, SLUG).keyNames) {
      expect(arm.keyOps.indexOf(`disable:${k}`)).toBeGreaterThanOrEqual(0);
      expect(arm.keyOps.indexOf(`disable:${k}`)).toBeLessThan(arm.keyOps.indexOf(`delete:${k}`));
    }
    const shred = job.receipts.filter((r) => r.step === 'key.shredded');
    expect(shred).toHaveLength(4);
    for (const r of shred) expect(r.detail).toMatch(/live=false deletedDate=2026-10-26T00:00:00\.000Z scheduledPurgeDate=2027-01-24/);
  });

  it('does NOT shred any key while a resource survives the delete', async () => {
    const { arm, run } = await created();
    const sticky = [...arm.resources.keys()].find((k) => k.includes('storageAccounts/sthpx')) as string;
    arm.stickyIds.add(sticky);
    const job = await run('tenant.destroy', 'd1', { confirmTenantId: SLUG });
    expect(job.error?.code).toBe('destroy_incomplete');
    expect(job.error?.message).toContain('storage.pixel');
    expect(arm.keyOps).toEqual([]); // any entry means keys were shredded under a live account
    for (const k of tenantNames(STAMP, SLUG).keyNames) expect(arm.keys.get(k)?.enabled).toBe(true);
  });

  it('fails shred_unverified when the vault still reports the key live after delete', async () => {
    const { arm, run } = await created();
    arm.keyDeleteIsNoop = true;
    const job = await run('tenant.destroy', 'd1', { confirmTenantId: SLUG });
    expect(job.error?.code).toBe('shred_unverified');
    expect(job.error?.message).toContain(`t-${SLUG}-st-pixel`);
  });
});
