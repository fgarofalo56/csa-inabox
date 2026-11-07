// The Azure seam for tenant.create / tenant.destroy (W1-2).
//
// `TenantArm` is the port the job handlers talk to; tests inject a fake. The
// shipped adapter, `RestTenantArm`, speaks ARM (deployments, resource reads and
// deletes) and the Key Vault data plane (key state, disable, delete) over fetch
// with an injected token provider, so nothing here holds a credential.
//
// Names are derived deterministically from the stamp and tenant slug and MUST
// equal the names modules/health/tenant.bicep declares (test/tenant-jobs.test.ts
// lifts the bicep literals and compares them, so a rename in one place fails).

import { JobFailure } from './types.js';

export interface TenantNames {
  keyNames: string[]; // order: st-pixel, st-audit, pg, backup
  eventHubName: string;
  databaseName: string;
  identityName: string;
  alertName: string;
}

export const KEY_SUFFIXES = ['st-pixel', 'st-audit', 'pg', 'backup'] as const;

export function tenantNames(stampName: string, slug: string): TenantNames {
  return {
    keyNames: KEY_SUFFIXES.map((k) => `t-${slug}-${k}`),
    eventHubName: `eh-t-${slug}`,
    databaseName: `lhds_${slug.replaceAll('-', '_')}`,
    identityName: `id-lhds-${stampName}-${slug}`,
    alertName: `alert-lhds-${stampName}-${slug}-capacity`,
  };
}

/** `rg-csa-loom-health-<stamp>-<region>`: the name health.bicep gives the stamp resource group. */
export function stampResourceGroup(stampId: string, region: string): string {
  return `rg-csa-loom-health-${stampId}-${region}`;
}

export function tenantDeploymentName(slug: string): string {
  return `lhds-tenant-${slug}`;
}

export function stampDeploymentName(stampId: string): string {
  return `lhds-stamp-${stampId}`;
}

/** The `tenant` output of tenant.bicep. */
export interface TenantManifest {
  tenantSlug: string;
  stampName: string;
  pixelAccountId: string;
  pixelAccountName: string;
  auditAccountId: string;
  auditAccountName: string;
  databaseId: string;
  databaseName: string;
  eventHubId: string;
  eventHubName: string;
  identityId: string;
  identityPrincipalId: string;
  capacityAlertId: string;
  maxStorageGiB: number;
  keyIds: string[];
  keyNames: string[];
}

export interface ResourceReadback {
  id: string;
  exists: boolean;
  /** Last path segment of the id as ARM reports it (`name`). */
  name?: string;
}

export interface KeyReadback {
  name: string;
  /** Live key exists in the vault. */
  exists: boolean;
  enabled?: boolean;
  /** Soft-deleted key present: deletedDate and scheduledPurgeDate (ISO) from the vault. */
  deletedDate?: string;
  scheduledPurgeDate?: string;
}

/**
 * Three-way answer for "read the outputs of deployment X". `absent` = ARM said 404.
 * `no_outputs` = the deployment record EXISTS but carries no usable outputs (for example a
 * failed incremental re-run overwrote the record). Callers must not conflate them.
 */
export type Lookup<T> = { state: 'absent' } | { state: 'no_outputs' } | { state: 'found'; value: T };

export interface TenantArm {
  /** Outputs of the stamp deployment (`stamp` object). */
  getStampManifest(resourceGroup: string, stampId: string): Promise<Lookup<Record<string, unknown>>>;
  /** Outputs of the tenant deployment record. */
  getTenantManifest(resourceGroup: string, slug: string): Promise<Lookup<TenantManifest>>;
  /** `/subscriptions/<id>/resourceGroups/<rg>`, so derived resource ids need no manifest. */
  scopeFor(resourceGroup: string): string;
  /** Ids of storage accounts tagged lhds-tenant=<slug> in the resource group (their names embed a hash, so they cannot be derived). */
  findTenantStorage(resourceGroup: string, slug: string): Promise<string[]>;
  /** Run tenant.bicep (incremental, idempotent) and return its outputs once provisioning succeeded. */
  deployTenant(input: {
    resourceGroup: string;
    slug: string;
    displayName: string;
    maxStorageGiB: number;
    stamp: Record<string, unknown>;
  }): Promise<TenantManifest>;
  readResource(id: string): Promise<ResourceReadback>;
  /** Delete and wait until a read says it is gone. */
  deleteResource(id: string): Promise<void>;
  readKey(vaultUri: string, keyName: string): Promise<KeyReadback>;
  disableKey(vaultUri: string, keyName: string): Promise<void>;
  deleteKey(vaultUri: string, keyName: string): Promise<void>;
}

/** ARM / Key Vault HTTP failure. Carries status and the service error CODE only, never the body. */
export class ArmError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly op: string,
  ) {
    super(`${op} failed: HTTP ${status} ${code}`);
  }
}

/** Turn an ArmError into an operator-actionable JobFailure; anything else passes through unchanged. */
export function classifyArm(e: unknown): unknown {
  if (!(e instanceof ArmError)) return e;
  if (e.status === 401 || e.status === 403) {
    return new JobFailure(
      'permission',
      `${e.op}: the control-plane identity is not authorised (HTTP ${e.status} ${e.code}). Grant it the role that covers this operation on the stamp resource group or vault, then retry.`,
    );
  }
  if (e.status === 429 || e.status >= 500 || e.status === 408) {
    return new JobFailure('transient', `${e.op}: Azure returned HTTP ${e.status} ${e.code}; retry the job.`);
  }
  return new JobFailure('arm_error', `${e.op}: Azure rejected the request (HTTP ${e.status} ${e.code}).`);
}

// ── REST adapter ──────────────────────────────────────────────────────────────

type Json = Record<string, unknown>;

export interface RestTenantArmOptions {
  /** `https://management.azure.com` or `https://management.usgovcloudapi.net`. */
  armEndpoint: string;
  subscriptionId: string;
  /** Returns a bearer token for a resource scope, for example `${armEndpoint}/.default`. */
  token: (scope: string) => Promise<string>;
  /** Key Vault data-plane scope: `https://vault.azure.net/.default` or `https://vault.usgovcloudapi.net/.default`. */
  vaultScope: string;
  /** Compiled tenant.bicep (az bicep build). */
  loadTemplate: () => Promise<Json>;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  maxPolls?: number;
}

const API_BY_TYPE: Record<string, string> = {
  'microsoft.storage/storageaccounts': '2024-01-01',
  'microsoft.eventhub/namespaces/eventhubs': '2024-05-01-preview',
  'microsoft.dbforpostgresql/flexibleservers/databases': '2024-08-01',
  'microsoft.managedidentity/userassignedidentities': '2023-01-31',
  'microsoft.insights/metricalerts': '2018-03-01',
  'microsoft.keyvault/vaults/keys': '2024-11-01',
};
const DEPLOYMENT_API = '2024-03-01';
const KV_API = '7.5';
const ARM_ID = /^\/subscriptions\/[0-9a-f-]{36}\/resourceGroups\/[A-Za-z0-9._()-]{1,90}\/providers\/[A-Za-z0-9.]+(?:\/[A-Za-z0-9._-]+){2,}$/i;

/** Resource type of an ARM id, lower-cased: `Microsoft.EventHub/namespaces/eventhubs`. */
export function resourceTypeOf(id: string): string {
  const after = id.split('/providers/')[1] ?? '';
  const seg = after.split('/');
  const out = [seg[0] ?? ''];
  for (let i = 1; i < seg.length; i += 2) out.push(seg[i] ?? '');
  return out.join('/').toLowerCase();
}

export class RestTenantArm implements TenantArm {
  private readonly f: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly pollMs: number;
  private readonly maxPolls: number;

  constructor(private readonly o: RestTenantArmOptions) {
    this.f = o.fetchFn ?? fetch;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.pollMs = o.pollMs ?? 5000;
    this.maxPolls = o.maxPolls ?? 360; // 30 min at the default
  }

  private async call(method: string, url: string, scope: string, op: string, body?: Json): Promise<{ status: number; json?: Json }> {
    const res = await this.f(url, {
      method,
      headers: {
        authorization: `Bearer ${await this.o.token(scope)}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    let json: Json | undefined;
    try {
      json = (await res.json()) as Json;
    } catch {
      json = undefined;
    }
    if (res.status >= 400 && res.status !== 404) {
      const err = json?.error as Json | undefined;
      const code = typeof err?.code === 'string' ? err.code.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 60) : 'Unknown';
      throw new ArmError(res.status, code || 'Unknown', op);
    }
    return { status: res.status, ...(json ? { json } : {}) };
  }

  private arm(path: string, q = DEPLOYMENT_API): string {
    return `${this.o.armEndpoint}${path}${path.includes('?') ? '&' : '?'}api-version=${q}`;
  }
  private get armScope(): string {
    return `${this.o.armEndpoint}/.default`;
  }
  private deploymentPath(rg: string, name: string): string {
    return `/subscriptions/${this.o.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.Resources/deployments/${name}`;
  }

  scopeFor(rg: string): string {
    return `/subscriptions/${this.o.subscriptionId}/resourceGroups/${rg}`;
  }

  async findTenantStorage(rg: string, slug: string): Promise<string[]> {
    const filter = encodeURIComponent(`tagName eq 'lhds-tenant' and tagValue eq '${slug.replace(/[^a-z0-9-]/g, '')}'`);
    const r = await this.call('GET', this.arm(`${this.scopeFor(rg)}/resources?$filter=${filter}`, '2021-04-01'), this.armScope, 'list tenant resources');
    const value = Array.isArray(r.json?.value) ? (r.json?.value as Json[]) : [];
    return value.map((v) => String(v.id ?? '')).filter((id) => resourceTypeOf(id) === 'microsoft.storage/storageaccounts');
  }

  async getStampManifest(rg: string, stampId: string): Promise<Lookup<Json>> {
    const r = await this.call('GET', this.arm(this.deploymentPath(rg, stampDeploymentName(stampId))), this.armScope, 'read stamp deployment');
    if (r.status === 404) return { state: 'absent' };
    const out = ((r.json?.properties as Json | undefined)?.outputs as Json | undefined)?.stamp as Json | undefined;
    const value = out?.value as Json | undefined;
    return value ? { state: 'found', value } : { state: 'no_outputs' };
  }

  async getTenantManifest(rg: string, slug: string): Promise<Lookup<TenantManifest>> {
    const r = await this.call('GET', this.arm(this.deploymentPath(rg, tenantDeploymentName(slug))), this.armScope, 'read tenant deployment');
    if (r.status === 404) return { state: 'absent' };
    const m = manifestFromOutputs((r.json?.properties as Json | undefined)?.outputs as Json | undefined);
    return m ? { state: 'found', value: m } : { state: 'no_outputs' };
  }

  async deployTenant(i: { resourceGroup: string; slug: string; displayName: string; maxStorageGiB: number; stamp: Json }): Promise<TenantManifest> {
    const path = this.deploymentPath(i.resourceGroup, tenantDeploymentName(i.slug));
    await this.call('PUT', this.arm(path), this.armScope, 'start tenant deployment', {
      properties: {
        mode: 'Incremental',
        template: await this.o.loadTemplate(),
        parameters: {
          stamp: { value: i.stamp },
          tenantSlug: { value: i.slug },
          displayName: { value: i.displayName },
          maxStorageGiB: { value: i.maxStorageGiB },
        },
      },
    });
    for (let n = 0; n < this.maxPolls; n++) {
      const r = await this.call('GET', this.arm(path), this.armScope, 'poll tenant deployment');
      const p = r.json?.properties as Json | undefined;
      const state = String(p?.provisioningState ?? '');
      if (state === 'Succeeded') {
        const m = manifestFromOutputs(p?.outputs as Json | undefined);
        if (!m) throw new JobFailure('no_outputs', 'the tenant deployment succeeded but returned no tenant manifest; check the deployed template version');
        return m;
      }
      if (state === 'Failed' || state === 'Canceled') {
        const code = String(((p?.error as Json | undefined)?.code as string | undefined) ?? 'Unknown').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 60);
        throw new JobFailure('deployment_failed', `tenant deployment ${state}: ${code}. Read the deployment operations for ${tenantDeploymentName(i.slug)} in the stamp resource group.`);
      }
      await this.sleep(this.pollMs);
    }
    throw new JobFailure('deployment_timeout', 'the tenant deployment did not finish in time; it may still be running. Retry the job to resume reading it.');
  }

  private apiFor(id: string, op: string): string {
    if (!ARM_ID.test(id)) throw new JobFailure('bad_resource_id', `${op}: refusing a malformed resource id`);
    const api = API_BY_TYPE[resourceTypeOf(id)];
    if (!api) throw new JobFailure('unsupported_resource', `${op}: no API version is known for ${resourceTypeOf(id)}`);
    return api;
  }

  async readResource(id: string): Promise<ResourceReadback> {
    const r = await this.call('GET', this.arm(id, this.apiFor(id, 'read resource')), this.armScope, 'read resource');
    if (r.status === 404) return { id, exists: false };
    const name = typeof r.json?.name === 'string' ? r.json.name : undefined;
    return { id: typeof r.json?.id === 'string' ? r.json.id : id, exists: true, ...(name ? { name } : {}) };
  }

  async deleteResource(id: string): Promise<void> {
    await this.call('DELETE', this.arm(id, this.apiFor(id, 'delete resource')), this.armScope, 'delete resource');
    for (let n = 0; n < this.maxPolls; n++) {
      if (!(await this.readResource(id)).exists) return;
      await this.sleep(this.pollMs);
    }
    throw new JobFailure('delete_timeout', `a resource was still present after the delete wait: ${id}`);
  }

  private keyUrl(vaultUri: string, name: string, deleted = false): string {
    const base = vaultUri.replace(/\/+$/, '');
    if (!/^https:\/\/[a-z0-9-]{3,24}\.[a-z0-9.-]+$/i.test(base)) throw new JobFailure('bad_vault_uri', 'the stamp manifest carries a malformed vault URI');
    return `${base}/${deleted ? 'deletedkeys' : 'keys'}/${encodeURIComponent(name)}?api-version=${KV_API}`;
  }

  async readKey(vaultUri: string, name: string): Promise<KeyReadback> {
    const live = await this.call('GET', this.keyUrl(vaultUri, name), this.o.vaultScope, 'read key');
    if (live.status !== 404) {
      return { name, exists: true, enabled: (live.json?.attributes as Json | undefined)?.enabled === true };
    }
    const del = await this.call('GET', this.keyUrl(vaultUri, name, true), this.o.vaultScope, 'read deleted key');
    if (del.status === 404) return { name, exists: false };
    const iso = (s: unknown): string | undefined => (typeof s === 'number' ? new Date(s * 1000).toISOString() : undefined);
    const deletedDate = iso(del.json?.deletedDate);
    const scheduledPurgeDate = iso(del.json?.scheduledPurgeDate);
    return {
      name,
      exists: false,
      ...(deletedDate ? { deletedDate } : {}),
      ...(scheduledPurgeDate ? { scheduledPurgeDate } : {}),
    };
  }

  async disableKey(vaultUri: string, name: string): Promise<void> {
    await this.call('PATCH', this.keyUrl(vaultUri, name), this.o.vaultScope, 'disable key', { attributes: { enabled: false } });
  }

  async deleteKey(vaultUri: string, name: string): Promise<void> {
    await this.call('DELETE', this.keyUrl(vaultUri, name), this.o.vaultScope, 'delete key');
  }
}

function manifestFromOutputs(outputs: Json | undefined): TenantManifest | undefined {
  const t = (outputs?.tenant as Json | undefined)?.value as Json | undefined;
  const ids = (outputs?.keyIds as Json | undefined)?.value;
  const names = (outputs?.keyNames as Json | undefined)?.value;
  if (!t || !Array.isArray(ids) || !Array.isArray(names)) return undefined;
  const s = (k: string): string => String(t[k] ?? '');
  return {
    tenantSlug: s('tenantSlug'),
    stampName: s('stampName'),
    pixelAccountId: s('pixelAccountId'),
    pixelAccountName: s('pixelAccountName'),
    auditAccountId: s('auditAccountId'),
    auditAccountName: s('auditAccountName'),
    databaseId: s('databaseId'),
    databaseName: s('databaseName'),
    eventHubId: s('eventHubId'),
    eventHubName: s('eventHubName'),
    identityId: s('identityId'),
    identityPrincipalId: s('identityPrincipalId'),
    capacityAlertId: s('capacityAlertId'),
    maxStorageGiB: Number(t.maxStorageGiB ?? 0),
    keyIds: ids.map(String),
    keyNames: names.map(String),
  };
}
