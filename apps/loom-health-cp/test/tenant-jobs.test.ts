import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { JobRunner } from '../src/jobs/runner.js';
import {
  ArmError,
  privateEndpointName,
  stampResourceGroup,
  tenantNames,
  type DeploymentSettle,
  type KeyReadback,
  type ResourceReadback,
  type TenantArm,
  type TenantManifest,
} from '../src/jobs/tenant-arm.js';
import { tenantHandlers, type FhirChain } from '../src/jobs/tenant-jobs.js';
import { fhirTenantHandlers, type FhirEngineHost } from '../src/jobs/fhir-tenant-jobs.js';
import { compose } from '../src/compose.js';
import { JobFailure, type JobDoc } from '../src/jobs/types.js';
import { Registry } from '../src/registry/registry.js';
import type { StampDoc, TenantDoc } from '../src/registry/types.js';
import { ADMIN_APP, AUDIENCE, AUTHORITY, MemoryCollection, memoryStores, TENANT, testKeyResolver } from './helpers.js';

const SUB = '00000000-0000-0000-0000-000000000001';
const STAMP = 'dev01';
const SLUG = 'acme-health';
const RG = stampResourceGroup(STAMP, 'eastus2');
const VAULT = 'https://kv-lhds-dev01-abc.vault.azure.net/';
const id = (type: string, name: string) => `/subscriptions/${SUB}/resourceGroups/${RG}/providers/${type}/${name}`;
const peId = (accountName: string) => id('Microsoft.Network/privateEndpoints', privateEndpointName(accountName));
const PIXEL_ID = id('Microsoft.Storage/storageAccounts', 'sthpxacmehealth1');
const AUDIT_ID = id('Microsoft.Storage/storageAccounts', 'sthtaacmehealth1');
const PE_PIXEL = peId('sthpxacmehealth1');
const PE_AUDIT = peId('sthtaacmehealth1');

class FakeArm implements TenantArm {
  resources = new Map<string, string>(); // id -> name as ARM reports it
  keys = new Map<string, KeyReadback>();
  deployCalls = 0;
  deleteCalls: string[] = [];
  keyOps: string[] = [];
  stampState: 'absent' | 'no_outputs' | 'found' = 'found';
  tenantState: 'absent' | 'no_outputs' | 'found' | undefined; // undefined = follow the deployment
  stampManifest: Record<string, unknown> = {
    keyVaultUri: VAULT,
    stampName: STAMP,
    keyVaultId: id('Microsoft.KeyVault/vaults', 'kv'),
    eventHubsNamespace: 'evh',
    postgresServerId: id('Microsoft.DBforPostgreSQL/flexibleServers', 'pg'),
  };
  throwOnDeploy: Error | undefined;
  stickyIds = new Set<string>(); // delete silently does nothing
  /** ids whose DELETE throws, as Azure does for an immutable account (AccountProtectedFromDeletion). */
  deleteThrows = new Map<string, Error>();
  /** ids that carry version-level immutability (readResource reports it). */
  immutableDays = new Map<string, number>();
  keyDeleteIsNoop = false;
  renameOnDeploy: { suffix: string; to: string } | undefined;
  /** provisioningState of lhds-tenant-<slug>; undefined = Succeeded once deployed, else absent. */
  deploymentState: string | undefined;
  settleCalls = 0;
  private manifest: TenantManifest | undefined;

  async awaitTenantDeployment(): Promise<DeploymentSettle> {
    this.settleCalls++;
    const s = this.deploymentState ?? (this.manifest ? 'Succeeded' : undefined);
    if (s === undefined) return { state: 'absent' };
    return ['Succeeded', 'Failed', 'Canceled'].includes(s)
      ? { state: 'terminal', provisioningState: s, polls: 1 }
      : { state: 'in_flight', provisioningState: s, polls: 181 };
  }
  async getStampManifest() {
    return this.stampState === 'found' ? { state: 'found' as const, value: this.stampManifest } : { state: this.stampState };
  }
  async getTenantManifest() {
    const s = this.tenantState ?? (this.manifest ? 'found' : 'absent');
    return s === 'found' && this.manifest ? { state: 'found' as const, value: this.manifest } : { state: s === 'found' ? ('absent' as const) : s };
  }
  scopeFor(rg: string) {
    return `/subscriptions/${SUB}/resourceGroups/${rg}`;
  }
  storageQuery: 'all' | 'empty' | 'pixelOnly' = 'all'; // what the tag query returns
  async findTenantStorage() {
    if (this.storageQuery === 'empty') return [];
    const all = [...this.resources.keys()].filter((k) => k.includes('storageAccounts/'));
    return this.storageQuery === 'pixelOnly' ? all.filter((k) => k.includes('/sthpx')) : all;
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
      fhirIdentity: {
        id: id('Microsoft.ManagedIdentity/userAssignedIdentities', n.fhirIdentityName),
        name: n.fhirIdentityName,
        clientId: '33333333-3333-4333-8333-333333333333',
        principalId: '44444444-4444-4444-8444-444444444444',
      },
      keyIds: n.keyNames.map((k) => id('Microsoft.KeyVault/vaults', 'kv') + `/keys/${k}`),
      keyNames: n.keyNames,
    };
    for (const [, rid] of [['p', m.pixelAccountId], ['a', m.auditAccountId], ['d', m.databaseId], ['e', m.eventHubId], ['i', m.identityId], ['f', m.fhirIdentity.id], ['q',m.capacityAlertId], ...m.keyIds.map((k) => ['k', k])] as [string, string][]) {
      const name = rid.split('/').pop() as string;
      this.resources.set(rid, this.renameOnDeploy && rid.endsWith(this.renameOnDeploy.suffix) ? this.renameOnDeploy.to : name);
    }
    // storage.bicep puts a private endpoint `pe-<account>-blob` beside each account (same RG).
    for (const acc of [m.pixelAccountName, m.auditAccountName]) this.resources.set(peId(acc), privateEndpointName(acc));
    // Like Azure: the immutable audit account refuses DELETE.
    this.immutableDays.set(m.auditAccountId, 2190);
    this.deleteThrows.set(m.auditAccountId, new ArmError(409, 'AccountProtectedFromDeletion', 'delete resource'));
    for (const k of m.keyNames) if (!this.keys.has(k)) this.keys.set(k, { name: k, exists: true, enabled: true });
    this.manifest = m;
    return m;
  }
  async readResource(rid: string): Promise<ResourceReadback> {
    const name = this.resources.get(rid);
    if (name === undefined) return { id: rid, exists: false };
    const days = this.immutableDays.get(rid);
    return { id: rid, exists: true, name, ...(days !== undefined ? { immutability: { enabled: true, periodDays: days, policyState: 'Unlocked' } } : {}) };
  }
  async deleteResource(rid: string) {
    this.deleteCalls.push(rid);
    const err = this.deleteThrows.get(rid);
    if (err) throw err;
    if (!this.stickyIds.has(rid)) this.resources.delete(rid);
  }
  /** Reads of a DELETED key that still return 404/404 ({exists:false}, no deletedDate) before the soft-delete record appears. */
  softDeleteLagReads = 0;
  /** Never produce the deleted-key record: every read after delete is 404/404. */
  softDeleteNeverAppears = false;
  readKeyCalls = new Map<string, number>();
  private lagLeft = new Map<string, number>();
  async readKey(_v: string, name: string): Promise<KeyReadback> {
    this.readKeyCalls.set(name, (this.readKeyCalls.get(name) ?? 0) + 1);
    const k = this.keys.get(name);
    if (k && !k.exists && k.deletedDate) {
      if (this.softDeleteNeverAppears) return { name, exists: false };
      const left = this.lagLeft.get(name) ?? 0;
      if (left > 0) {
        this.lagLeft.set(name, left - 1);
        return { name, exists: false };
      }
    }
    return k ?? { name, exists: false };
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
    this.lagLeft.set(name, this.softDeleteLagReads);
    this.readKeyCalls.set(name, 0); // count only the post-delete read-back
  }
}

function setup(stampStatus: StampDoc['status'] = 'healthy', tenantStatus: TenantDoc['status'] = 'creating', fhir?: FhirChain) {
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
  // A recording sleep: no test waits for real, and the shred poll's waits are observable.
  const sleeps: number[] = [];
  const sleep = async (ms: number) => {
    sleeps.push(ms);
  };
  for (const h of tenantHandlers({ stamps, tenants, registry, arm, sleep, shredReads: 6, shredPollMs: 5000, fhir })) runner.register(h);
  const run = async (kind: 'tenant.create' | 'tenant.destroy', key: string, input: Record<string, unknown> = {}) => {
    const { job } = await runner.submit({ kind, subjectType: 'tenant', subjectId: SLUG, idempotencyKey: key, input, requestedBy: 't' });
    await runner.idle();
    return runner.get(job.id);
  };
  return { arm, tenants, run, sleeps };
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
    expect(sub(lift(/resource fhirIdentity[\s\S]*?name: '([^']+)'/))).toBe(n.fhirIdentityName);
    expect(sub(lift(/resource capacityAlert[\s\S]*?name: '([^']+)'/))).toBe(n.alertName);
    expect(sub(lift(/var keyNameList = \[for k in keySuffixes: '([^']+)'\]/)).replace('${k}', 'st-pixel')).toBe(n.keyNames[0]);
    // 'lhds_${replace(tenantSlug, '-', '_')}' -> lhds_abc_d
    expect(lift(/name: '(lhds_)\$\{replace\(tenantSlug, '-', '_'\)\}'/) + 'abc_d').toBe(n.databaseName);
  });
  it('the private endpoint name destroy derives equals storage.bicep `pe-${accountName}-blob`', () => {
    const storage = readFileSync(new URL('../../../platform/fiab/bicep/modules/health/storage.bicep', import.meta.url), 'utf8');
    const m = /resource pe 'Microsoft\.Network\/privateEndpoints@[^']+' = \{\s*name: '([^']+)'/.exec(storage);
    if (!m?.[1]) throw new Error('private endpoint name not found in storage.bicep');
    // Input that breaks it: a rename in storage.bicep (e.g. pe-${accountName}) makes destroy delete a non-existent id.
    expect(m[1].replace('${accountName}', 'sthpxabc')).toBe(privateEndpointName('sthpxabc'));
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
    // 6 fixed resources (incl. the fhir identity) + database + 4 keys = 11; fewer means a resource was skipped.
    expect(readbacks).toHaveLength(11);
    // Private endpoints are not tenant.bicep outputs and create does not read them back (destroy derives them).
    for (const rid of arm.resources.keys()) if (!rid.includes('/privateEndpoints/')) expect(readbacks.some((r) => r.detail.includes(rid)), rid).toBe(true);
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
    expect(job.error?.message).toContain(`key t-${SLUG}-pg is disabled`);
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
    arm.stampState = 'absent';
    const job = await run('tenant.create', 'k1');
    expect(job.error?.code).toBe('stamp_manifest_missing');
    expect(job.error?.message).toContain('was not found');
  });

  it('a stamp deployment that exists without outputs is NOT reported as not found', async () => {
    const { arm, run } = setup();
    arm.stampState = 'no_outputs';
    const job = await run('tenant.create', 'k1');
    // Breaks if the two cases are conflated: the old wording said "was not found".
    expect(job.error?.code).toBe('stamp_manifest_unreadable');
    expect(job.error?.message).toContain('exists');
    expect(job.error?.message).not.toContain('was not found');
    expect(arm.deployCalls).toBe(0);
  });

  it('reports a key that is gone as missing, not disabled', async () => {
    const { arm, run } = setup();
    const gone = `t-${SLUG}-backup`;
    arm.keys.set(gone, { name: gone, exists: false });
    for (const k of tenantNames(STAMP, SLUG).keyNames) if (k !== gone) arm.keys.set(k, { name: k, exists: true, enabled: true });
    const job = await run('tenant.create', 'k1');
    expect(job.error?.message).toContain(`key ${gone} is missing`);
    expect(job.error?.message).not.toContain('disabled');
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

  it('deletes every resource but the retained audit account, THEN shreds the keys, and reads the key state back as deleted', async () => {
    const { arm, tenants, run } = await created();
    const job = await run('tenant.destroy', 'd1', { confirmTenantId: SLUG });
    expect(job.state, JSON.stringify(job.error)).toBe('succeeded');
    // Input that breaks it: any other surviving id (a PE, the identity) joins the audit account here.
    expect([...arm.resources.keys()]).toEqual([AUDIT_ID]);
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

  it('deletes the dedicated FHIR identity (manifest path) and reads it back as gone', async () => {
    const { arm, run } = await created();
    const fhirId = [...arm.resources.keys()].find((k) => k.endsWith(`/userAssignedIdentities/${tenantNames(STAMP, SLUG).fhirIdentityName}`)) as string;
    expect(fhirId, 'fake registered the fhir identity').toBeDefined();
    const job = await run('tenant.destroy', 'd1', { confirmTenantId: SLUG });
    expect(job.state, JSON.stringify(job.error)).toBe('succeeded');
    // Breaks if expectedResources omits fhirIdentity: the id is then absent from deleteCalls and still in arm.resources
    // (a live federated credential would survive a "successful" destroy).
    expect(arm.deleteCalls).toContain(fhirId);
    expect(arm.resources.has(fhirId)).toBe(false);
    expect(job.receipts.some((r) => r.step === 'resource.deleted' && r.detail.startsWith(`identity.fhir id=${fhirId}`))).toBe(true);
  });

  it('absent deployment record: fails naming 404, deletes and shreds nothing', async () => {
    const { arm, run } = await created();
    arm.tenantState = 'absent';
    const job = await run('tenant.destroy', 'd1', { confirmTenantId: SLUG });
    expect(job.error?.code).toBe('tenant_manifest_missing');
    expect(job.error?.message).toContain('was not found');
    expect(arm.deleteCalls).toEqual([]);
    expect(arm.keyOps).toEqual([]);
  });

  it('record present WITHOUT outputs (failed re-run): destroy still deletes by derived names and shreds the keys', async () => {
    const { arm, tenants, run } = await created();
    arm.tenantState = 'no_outputs';
    const job = await run('tenant.destroy', 'd1', { confirmTenantId: SLUG });
    // The old behaviour failed here with tenant_manifest_missing and left the tenant undeletable.
    expect(job.state, JSON.stringify(job.error)).toBe('succeeded');
    expect(job.receipts.some((r) => r.step === 'manifest.derived')).toBe(true);
    // Everything but the retained audit account: 5 resources + 2 PEs + 4 keys, the hash-named pixel account included.
    expect([...arm.resources.keys()]).toEqual([AUDIT_ID]);
    expect(arm.deleteCalls).toHaveLength(8); // 7 would mean the fhir identity or a PE was not derived; 6 both
    expect(arm.deleteCalls.some((id) => id.endsWith(`/userAssignedIdentities/${tenantNames(STAMP, SLUG).fhirIdentityName}`))).toBe(true);
    expect(arm.deleteCalls).not.toContain(AUDIT_ID);
    expect(job.receipts.find((r) => r.step === 'storage.audit.retained')?.detail).toContain(`id=${AUDIT_ID}`);
    expect(arm.deleteCalls.some((id) => id.endsWith(`/eventhubs/eh-t-${SLUG}`))).toBe(true);
    expect(arm.keyOps.filter((o) => o.startsWith('delete:'))).toHaveLength(4);
    expect(tenants.docs.get(SLUG)?.status).toBe('destroying');
  });

  it('derived fallback: a tag query that MISSES an account fails destroy_incomplete before anything is deleted or shredded', async () => {
    const { arm, tenants, run } = await created();
    arm.tenantState = 'no_outputs';
    arm.storageQuery = 'pixelOnly'; // input that breaks it: the audit account is skipped silently
    const job = await run('tenant.destroy', 'd1', { confirmTenantId: SLUG });
    expect(job.error?.code).toBe('destroy_incomplete');
    expect(job.error?.message).toContain('storage.audit');
    expect(job.error?.message).not.toContain('storage.pixel,'); // pixel was found
    expect(arm.deleteCalls).toEqual([]);
    expect(arm.keyOps).toEqual([]);
    // the receipt names found and skipped accounts
    const derived = job.receipts.find((r) => r.step === 'manifest.derived');
    expect(derived?.detail).toContain('found=[sthpxacmehealth1] skipped=[storage.audit]');
    expect(tenants.docs.get(SLUG)?.status).toBe('destroying');
  });

  it('derived fallback: an EMPTY tag result fails for both accounts; allowMissingStorage=true proceeds and records both as skipped', async () => {
    const { arm, run } = await created();
    arm.tenantState = 'no_outputs';
    arm.storageQuery = 'empty';
    const refused = await run('tenant.destroy', 'd1', { confirmTenantId: SLUG });
    expect(refused.error?.code).toBe('destroy_incomplete');
    expect(refused.error?.message).toContain('storage.pixel, storage.audit');
    expect(arm.keyOps).toEqual([]);
    const allowed = await run('tenant.destroy', 'd2', { confirmTenantId: SLUG, allowMissingStorage: true });
    expect(allowed.state, JSON.stringify(allowed.error)).toBe('succeeded');
    expect(allowed.receipts.find((r) => r.step === 'manifest.derived')?.detail).toContain('found=[] skipped=[storage.pixel,storage.audit]');
    expect(arm.deleteCalls).toHaveLength(5); // the 5 non-storage resources; the 2 skipped accounts are never touched
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

  describe('retain + crypto-shred the immutable audit account (#5392, operator decision 2026-11-20)', () => {
    it('succeeds without ever DELETEing the audit account, shreds its key, and records it retained', async () => {
      const { arm, run } = await created();
      const job = await run('tenant.destroy', 'd1', { confirmTenantId: SLUG });
      // Input that breaks it: re-adding storage.audit to the delete list -> the fake's 409 fails the job.
      expect(job.state, JSON.stringify(job.error)).toBe('succeeded');
      expect(arm.deleteCalls.filter((x) => x === AUDIT_ID)).toHaveLength(0);
      expect(arm.resources.has(AUDIT_ID)).toBe(true);
      const auditKey = `t-${SLUG}-st-audit`;
      expect(arm.keyOps).toEqual(expect.arrayContaining([`disable:${auditKey}`, `delete:${auditKey}`]));
      expect(arm.keys.get(auditKey)).toMatchObject({ exists: false, deletedDate: '2026-10-26T00:00:00.000Z' });
      // Exactly one of each, naming the account by name and id, its retention, and the key's shredded
      // state. Exact equality, so the runner's 300-char receipt cap truncating either one breaks it.
      expect(job.receipts.filter((r) => r.step === 'storage.audit.retained').map((r) => r.detail)).toEqual([
        `name=sthtaacmehealth1 id=${AUDIT_ID} exists=true`,
      ]);
      expect(job.receipts.filter((r) => r.step === 'storage.audit.retention').map((r) => r.detail)).toEqual([
        `name=sthtaacmehealth1 immutability=enabled retentionDays=2190 policy=Unlocked key=${auditKey} keyLive=false keyDeletedDate=2026-10-26T00:00:00.000Z`,
      ]);
      // The retained receipt follows the shred evidence, never precedes it.
      const steps = job.receipts.map((r) => r.step);
      expect(steps.indexOf('storage.audit.retained')).toBeGreaterThan(steps.lastIndexOf('key.shredded'));
    });

    it('deletes both private endpoints, each before its account, and proves them gone', async () => {
      const { arm, run } = await created();
      const job = await run('tenant.destroy', 'd1', { confirmTenantId: SLUG });
      expect(job.state, JSON.stringify(job.error)).toBe('succeeded');
      // Input that breaks it: dropping the PE derivation -> neither id is in deleteCalls and both survive.
      expect(arm.deleteCalls).toEqual(expect.arrayContaining([PE_PIXEL, PE_AUDIT]));
      expect(arm.resources.has(PE_PIXEL)).toBe(false);
      expect(arm.resources.has(PE_AUDIT)).toBe(false);
      expect(arm.deleteCalls.indexOf(PE_PIXEL)).toBeLessThan(arm.deleteCalls.indexOf(PIXEL_ID));
      expect(job.receipts.filter((r) => r.step === 'resource.deleted').map((r) => r.detail)).toEqual(
        expect.arrayContaining([`pe.pixel id=${PE_PIXEL}`, `pe.audit id=${PE_AUDIT}`]),
      );
    });

    it('a PE that survives its delete is caught by the proof of absence and no key is shredded', async () => {
      const { arm, run } = await created();
      arm.stickyIds.add(PE_AUDIT); // input that breaks it: excluding PEs from the readback lets this pass
      const job = await run('tenant.destroy', 'd1', { confirmTenantId: SLUG });
      expect(job.error?.code).toBe('destroy_incomplete');
      expect(job.error?.message).toContain('pe.audit');
      expect(arm.keyOps).toEqual([]);
    });

    it('a NON-audit storage delete failure still fails the job: it is not retained, and no key is shredded', async () => {
      const { arm, run } = await created();
      // The same 409 code Azure returns for the audit account, on the PIXEL account. A handler that
      // retained any storage failure would continue and report it retained.
      arm.deleteThrows.set(PIXEL_ID, new ArmError(409, 'AccountProtectedFromDeletion', 'delete resource'));
      const job = await run('tenant.destroy', 'd1', { confirmTenantId: SLUG });
      expect(job.state).toBe('failed');
      expect(job.error?.code).toBe('arm_error');
      expect(job.error?.message).toContain(`deleting storage.pixel (${PIXEL_ID})`);
      expect(job.error?.message).toContain('HTTP 409 AccountProtectedFromDeletion');
      expect(job.receipts.some((r) => r.step === 'storage.audit.retained')).toBe(false);
      expect(arm.keyOps).toEqual([]);
      expect(arm.resources.has(PIXEL_ID)).toBe(true);
    });
  });

  describe('destroy against an in-flight create (#5392 defect 1)', () => {
    it.each(['Running', 'Accepted'])('a %s tenant deployment fails deployment_in_flight with no delete and no shred', async (state) => {
      const { arm, tenants, run } = await created();
      arm.deploymentState = state;
      const job = await run('tenant.destroy', 'd1', { confirmTenantId: SLUG });
      // Input that breaks it: removing the settle check -> destroy sweeps and deleteCalls fills up.
      expect(job.error?.code).toBe('deployment_in_flight');
      expect(job.error?.message).toContain(`provisioningState=${state}`);
      expect(job.error?.message).toContain('nothing was deleted');
      expect(arm.settleCalls).toBe(1);
      expect(arm.deleteCalls).toEqual([]);
      expect(arm.keyOps).toEqual([]);
      expect(tenants.docs.get(SLUG)?.status).toBe('destroying'); // a new create is refused meanwhile
    });

    it('a terminal (Failed) deployment proceeds and records the settled state', async () => {
      const { arm, run } = await created();
      arm.deploymentState = 'Failed';
      const job = await run('tenant.destroy', 'd1', { confirmTenantId: SLUG });
      expect(job.state, JSON.stringify(job.error)).toBe('succeeded');
      expect(job.receipts.find((r) => r.step === 'deployment.settled')?.detail).toBe(`deployment=lhds-tenant-${SLUG} provisioningState=Failed reads=1`);
    });
  });

  it('fails shred_unverified when the vault still reports the key live after delete', async () => {
    const { arm, run } = await created();
    arm.keyDeleteIsNoop = true;
    const job = await run('tenant.destroy', 'd1', { confirmTenantId: SLUG });
    expect(job.error?.code).toBe('shred_unverified');
    expect(job.error?.message).toContain(`t-${SLUG}-st-pixel`);
    // A live key is polled to exhaustion too, and the failure names it as live.
    expect(job.error?.message).toContain(`t-${SLUG}-st-pixel (last read: live, deletedDate none)`);
  });

  describe('shred read-back polls the asynchronous soft-delete (#5392)', () => {
    it('a deleted-key record that appears only on the 3rd read still succeeds, with one receipt per key', async () => {
      const { arm, run, sleeps } = await created();
      // Mutation that turns this red: reverting the read-back to a single readKey per key
      // (the 2026-11-20 code) reads {exists:false} with no deletedDate and fails shred_unverified.
      arm.softDeleteLagReads = 2;
      const job = await run('tenant.destroy', 'd1', { confirmTenantId: SLUG });
      expect(job.state, JSON.stringify(job.error)).toBe('succeeded');
      const keys = tenantNames(STAMP, SLUG).keyNames;
      // Exactly 3 post-delete reads per key: 2 lagging + the one that saw deletedDate (a loop that kept reading would make it more).
      for (const k of keys) expect(arm.readKeyCalls.get(k)).toBe(3);
      // One sleep per ROUND, not per key: 2 rounds waited, at the configured interval.
      expect(sleeps).toEqual([5000, 5000]);
      const shred = job.receipts.filter((r) => r.step === 'key.shredded');
      // Once per key with the FINAL read: a receipt per poll would make this 12.
      expect(shred).toHaveLength(keys.length);
      for (const r of shred) expect(r.detail).toMatch(/live=false deletedDate=2026-10-26T00:00:00\.000Z scheduledPurgeDate=2027-01-24T00:00:00\.000Z reads=3$/);
    });

    it('a deleted-key record that never appears fails shred_unverified after exactly the bounded reads, naming the last read', async () => {
      const { arm, run, sleeps } = await created();
      arm.softDeleteNeverAppears = true;
      const job = await run('tenant.destroy', 'd1', { confirmTenantId: SLUG });
      expect(job.error?.code).toBe('shred_unverified');
      const keys = tenantNames(STAMP, SLUG).keyNames;
      // 6 distinguishes a single read (1) and an unbounded loop (never terminates / >6).
      for (const k of keys) expect(arm.readKeyCalls.get(k)).toBe(6);
      expect(sleeps).toEqual([5000, 5000, 5000, 5000, 5000]); // reads - 1 waits, at the configured interval
      expect(job.error?.message).toContain('after 6 read(s) over 25s');
      for (const k of keys) expect(job.error?.message).toContain(`${k} (last read: not live, deletedDate none)`);
      // The keys WERE deleted (positive pairing): the failure is the read-back, not a skipped delete.
      for (const k of keys) expect(arm.keyOps).toContain(`delete:${k}`);
      const shred = job.receipts.filter((r) => r.step === 'key.shredded');
      expect(shred).toHaveLength(keys.length);
      for (const r of shred) expect(r.detail).toMatch(/live=false deletedDate=none scheduledPurgeDate=none reads=6$/);
      // The retained receipt is withheld on a failed shred, and its absence is not from a missing audit account.
      expect(job.receipts.some((r) => r.step === 'storage.audit.retained')).toBe(false);
      expect(arm.resources.has(AUDIT_ID)).toBe(true);
    });

    it('the first read that shows deletedDate ends the poll without sleeping', async () => {
      const { arm, run, sleeps } = await created();
      const job = await run('tenant.destroy', 'd1', { confirmTenantId: SLUG });
      expect(job.state, JSON.stringify(job.error)).toBe('succeeded');
      // Input that breaks it: a poll that always sleeps once, or reads twice, before checking.
      expect(sleeps).toEqual([]);
      for (const k of tenantNames(STAMP, SLUG).keyNames) expect(arm.readKeyCalls.get(k)).toBe(1);
    });
  });
});

// #5442: nothing submitted fhir-tenant.create, so a new tenant had no engine; and nothing tore the engine down.
describe('FHIR engine chaining (#5442)', () => {
  /** A chain whose submit goes through a REAL JobRunner, so dedup is the runner's, not a fake's. */
  function chainWithRunner(events: string[]) {
    const runner = new JobRunner(new MemoryCollection<JobDoc>(), async () => true, () => {});
    let runs = 0;
    runner.register({ kind: 'fhir-tenant.create', subjectType: 'tenant', run: async () => { runs++; } });
    const chain: FhirChain = {
      submitCreate: async (tenantId, key) => {
        events.push(`submit:${key}`);
        const { job, created } = await runner.submit({ kind: 'fhir-tenant.create', subjectType: 'tenant', subjectId: tenantId, idempotencyKey: key, requestedBy: 't' });
        return { jobId: job.id, created };
      },
      teardown: async (ctx) => { events.push('teardown'); await ctx.receipt('engine.removed', 'configPresent=false'); },
    };
    return { chain, runner, runs: () => runs };
  }

  it('a successful tenant.create submits fhir-tenant.create once, keyed from its own key, AFTER the tenant is active', async () => {
    const events: string[] = [];
    const { chain, runner, runs } = chainWithRunner(events);
    const { run, tenants } = setup('healthy', 'creating', chain);
    const job = await run('tenant.create', 'create-2026');
    await runner.idle();
    expect(job.state, JSON.stringify(job.error)).toBe('succeeded');
    // Breaks if the chain is dropped: events is [] and runs() is 0.
    expect(events).toEqual(['submit:engine-create-2026']);
    expect(runs()).toBe(1);
    const steps = job.receipts.map((r) => r.step);
    expect(steps.indexOf('engine.chained'), 'chain receipt after tenant.active').toBeGreaterThan(steps.indexOf('tenant.active'));
    expect(job.receipts.find((r) => r.step === 'engine.chained')?.detail).toMatch(/^fhir-tenant\.create job=job-[0-9a-f]{32} created=true$/);
    expect(tenants.docs.get(SLUG)?.status).toBe('active');
  });

  it('the SAME engine key dedups in the runner (engine job ran once); a new verify key is a new engine job', async () => {
    const events: string[] = [];
    const { chain, runner, runs } = chainWithRunner(events);
    const { run } = setup('healthy', 'creating', chain);
    await run('tenant.create', 'verify-20261123');
    await run('tenant.create', 'verify-20261123'); // same tenant.create job id: returned, not re-run
    await runner.idle();
    expect(runs()).toBe(1); // 2 would mean the key is not idempotent
    await run('tenant.create', 'verify-20261124');
    await runner.idle();
    expect(runs()).toBe(2); // 1 would mean the daily verify never re-submits (no self-heal of a missing engine)
    expect(events).toEqual(['submit:engine-verify-20261123', 'submit:engine-verify-20261124']);
  });

  it('dedup is the runner\'s: submitting the same engine key twice gives created=false the second time', async () => {
    const { chain } = chainWithRunner([]);
    const a = await chain.submitCreate(SLUG, 'engine-k');
    const b = await chain.submitCreate(SLUG, 'engine-k');
    expect([a.created, b.created, a.jobId === b.jobId]).toEqual([true, false, true]);
  });

  it('with no engine configured the tenant still goes active and the receipt says the engine was NOT chained, and why', async () => {
    const { run, tenants } = setup();
    const job = await run('tenant.create', 'k1');
    expect(job.state, JSON.stringify(job.error)).toBe('succeeded');
    expect(tenants.docs.get(SLUG)?.status).toBe('active');
    const r = job.receipts.find((x) => x.step === 'engine.not_chained');
    expect(r?.detail).toContain('was NOT submitted');
    expect(r?.detail).toContain('host and PDP url');
    expect(job.receipts.some((x) => x.step === 'engine.chained')).toBe(false); // never pretends
  });

  it('a chain submit that throws does not fail the tenant, and the receipt carries a ref, not the raw error', async () => {
    const chain: FhirChain = { submitCreate: async () => { throw new Error('secret-internal-detail'); }, teardown: async () => {} };
    const { run, tenants } = setup('healthy', 'creating', chain);
    const job = await run('tenant.create', 'k1');
    expect(job.state).toBe('succeeded');
    expect(tenants.docs.get(SLUG)?.status).toBe('active');
    const r = job.receipts.find((x) => x.step === 'engine.chain_failed');
    expect(r?.detail).toMatch(/could not be submitted.*\(ref: [0-9a-f]{8}\)$/);
    expect(r?.detail).not.toContain('secret-internal-detail');
  });

  it('a readback failure never chains an engine (the tenant is not active)', async () => {
    const events: string[] = [];
    const { chain } = chainWithRunner(events);
    const { arm, run } = setup('healthy', 'creating', chain);
    arm.renameOnDeploy = { suffix: `/eventhubs/eh-t-${SLUG}`, to: 'eh-t-other' };
    const job = await run('tenant.create', 'k1');
    expect(job.state).toBe('failed');
    expect(events).toEqual([]);
  });

  it('tenant.destroy tears the engine down BEFORE the first delete', async () => {
    const events: string[] = [];
    const { chain } = chainWithRunner(events);
    const s = setup('healthy', 'creating', chain);
    expect((await s.run('tenant.create', 'k1')).state).toBe('succeeded');
    events.length = 0;
    const del = s.arm.deleteResource.bind(s.arm);
    s.arm.deleteResource = async (rid: string) => { events.push('delete'); return del(rid); };
    const job = await s.run('tenant.destroy', 'd1', { confirmTenantId: SLUG });
    expect(job.state, JSON.stringify(job.error)).toBe('succeeded');
    expect(events[0], 'teardown precedes the first delete').toBe('teardown');
    expect(events.filter((e) => e === 'teardown')).toHaveLength(1);
    expect(job.receipts.some((r) => r.step === 'engine.removed')).toBe(true);
  });

  it('a failed teardown fails destroy typed and deletes and shreds NOTHING', async () => {
    const chain: FhirChain = {
      submitCreate: async () => ({ jobId: 'j', created: true }),
      teardown: async () => { throw new JobFailure('teardown_incomplete', 'engine still present'); },
    };
    const s = setup('healthy', 'creating', chain);
    await s.run('tenant.create', 'k1');
    const job = await s.run('tenant.destroy', 'd1', { confirmTenantId: SLUG });
    expect(job.error?.code).toBe('teardown_incomplete');
    expect(s.arm.deleteCalls).toEqual([]); // 8 deletes would mean the database/identity went while the engine lived
    expect(s.arm.keyOps).toEqual([]);
  });

  it('tenant.destroy with no engine configured says so in a receipt and still destroys', async () => {
    const s = setup();
    await s.run('tenant.create', 'k1');
    const job = await s.run('tenant.destroy', 'd1', { confirmTenantId: SLUG });
    expect(job.state, JSON.stringify(job.error)).toBe('succeeded');
    expect(job.receipts.find((r) => r.step === 'engine.teardown_skipped')?.detail).toContain('no FHIR engine host');
  });

  describe('compose wiring', () => {
    const ts = '2026-11-23T00:00:00.000Z';
    function build(fhirEngine: { host: FhirEngineHost; pdpUrl: string } | undefined) {
      const stores = memoryStores();
      (stores.stamps as unknown as MemoryCollection<StampDoc>).docs.set(STAMP, { id: STAMP, displayName: 'Dev', cloud: 'commercial', region: 'eastus2', class: 'S', status: 'healthy', baseUrl: 'https://x.example', engineVersions: {}, createdAt: ts, updatedAt: ts, updatedBy: 't', _etag: 'e0' });
      (stores.tenants as unknown as MemoryCollection<TenantDoc>).docs.set(SLUG, { id: SLUG, displayName: 'Acme', stampId: STAMP, status: 'creating', quotas: { maxRequestsPerMinute: 10, maxStorageGiB: 100 }, createdAt: ts, updatedAt: ts, updatedBy: 't', _etag: 'e0' });
      return compose({
        stores,
        auth: { authorityHost: AUTHORITY, entraTenantId: TENANT, audiences: [AUDIENCE], allowedCallerAppIds: [ADMIN_APP], keyResolver: testKeyResolver },
        sloAvailabilityTarget: 0.999,
        log: () => {},
        tenantArm: new FakeArm(),
        fhirEngine,
      });
    }
    // The engine host is a stub: fhir-tenant.create itself is covered in fhir-tenant.test.ts; here only the WIRING is measured.
    const stubHost = () => ({ removeEngine: async () => {}, readEngineConfig: async () => undefined, readDatabaseRole: async () => ({ exists: false, connectableDatabases: [] }), removeDatabaseRole: async () => {} }) as unknown as FhirEngineHost;

    it('host + pdpUrl configured: tenant.create leaves a REAL fhir-tenant.create job on the tenant', async () => {
      const app = build({ host: stubHost(), pdpUrl: 'http://pdp.local' });
      await app.jobs.submit({ kind: 'tenant.create', subjectType: 'tenant', subjectId: SLUG, idempotencyKey: 'create-1', requestedBy: 't' });
      await app.jobs.idle();
      const fhirJobs = (await app.jobs.list()).filter((j) => j.kind === 'fhir-tenant.create');
      expect(fhirJobs.map((j) => [j.subjectId, j.idempotencyKey])).toEqual([[SLUG, 'engine-create-1']]);
    });

    it('pdpUrl blank: the engine kinds are not registered, tenant.create still succeeds and says not chained', async () => {
      const app = build({ host: stubHost(), pdpUrl: '  ' });
      const { job } = await app.jobs.submit({ kind: 'tenant.create', subjectType: 'tenant', subjectId: SLUG, idempotencyKey: 'create-1', requestedBy: 't' });
      await app.jobs.idle();
      const done = await app.jobs.get(job.id);
      expect(done.state, JSON.stringify(done.error)).toBe('succeeded');
      expect(done.receipts.some((r) => r.step === 'engine.not_chained')).toBe(true);
      expect(app.jobs.kinds().filter((k) => k.startsWith('fhir-tenant.'))).toEqual([]);
    });
  });
});

describe('tenant.destroy allowMissingEngine (#5442 review)', () => {
  const failing = (code: string): FhirChain => ({
    submitCreate: async () => ({ jobId: 'j', created: true }),
    teardown: async () => { throw new JobFailure(code, `host said ${code}`); },
  });
  async function destroyWith(code: string, input: Record<string, unknown>) {
    const s = setup('healthy', 'creating', failing(code));
    await s.run('tenant.create', 'k1');
    const job = await s.run('tenant.destroy', `d-${JSON.stringify(input).length}`, { confirmTenantId: SLUG, ...input });
    return { s, job };
  }

  it('default: an unreachable engine host fails closed, deletes and shreds nothing, and names allowMissingEngine as the escape hatch', async () => {
    const { s, job } = await destroyWith('stamp_manifest_missing', {});
    expect(job.state).toBe('failed');
    expect(job.error?.code).toBe('stamp_manifest_missing');
    expect(job.error?.message).toContain('allowMissingEngine=true');
    expect(s.arm.deleteCalls).toEqual([]); // 8 would mean the flag-less path proceeded
    expect(s.arm.keyOps).toEqual([]);
  });

  it('allowMissingEngine=true + an unreachable host: destroy proceeds, the receipt names the cause and that the engine may be left in place', async () => {
    const { s, job } = await destroyWith('arm_error', { allowMissingEngine: true });
    expect(job.state, JSON.stringify(job.error)).toBe('succeeded');
    const r = job.receipts.find((x) => x.step === 'engine.teardown_skipped');
    expect(r?.detail).toContain('arm_error');
    expect(r?.detail).toContain('may be left in place');
    expect(s.arm.deleteCalls).toHaveLength(8); // the tenant really was torn down
    expect(s.arm.keyOps.filter((o) => o.startsWith('delete:'))).toHaveLength(4);
  });

  it('allowMissingEngine=true does NOT skip a REAL teardown error on a reachable host (engine_remove_failed / teardown_incomplete / permission)', async () => {
    for (const code of ['engine_remove_failed', 'teardown_incomplete', 'permission']) {
      const { s, job } = await destroyWith(code, { allowMissingEngine: true });
      expect(job.state, code).toBe('failed');
      expect(job.error?.code, code).toBe(code);
      expect(job.error?.message, code).not.toContain('allowMissingEngine'); // no misleading escape hatch
      expect(s.arm.deleteCalls, code).toEqual([]);
    }
  });

  it('the flag is a typed boolean: a string "true" is refused at submit', async () => {
    const s = setup('healthy', 'creating', failing('arm_error'));
    await s.run('tenant.create', 'k1');
    await expect(s.run('tenant.destroy', 'd-str', { confirmTenantId: SLUG, allowMissingEngine: 'true' })).rejects.toThrow(/input/);
  });
});

describe('engine-affecting kinds share one exclusive group (#5442)', () => {
  it('tenant.create, tenant.destroy and all three fhir-tenant kinds are in group tenant-engine (a kind left out can race the others)', () => {
    const noop = {} as never;
    const kinds = [
      ...tenantHandlers({ stamps: noop, tenants: noop, registry: noop, arm: noop }),
      ...fhirTenantHandlers({ stamps: noop, tenants: noop, arm: noop, engine: noop, pdpUrl: 'http://pdp' }),
    ];
    expect(kinds.map((h) => [h.kind, h.exclusiveGroup])).toEqual([
      ['tenant.create', 'tenant-engine'], ['tenant.destroy', 'tenant-engine'],
      ['fhir-tenant.create', 'tenant-engine'], ['fhir-tenant.configure', 'tenant-engine'], ['fhir-tenant.teardown', 'tenant-engine'],
    ]);
  });
});
