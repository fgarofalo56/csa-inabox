// tenant.create / tenant.destroy (W1-2): lifecycle jobs that provision a tenant's
// Azure resources in its stamp and read every one of them back.
//
// auto-bind-by-default: creating the tenant provisions AND binds its backing
// resources; the names are derived (tenantNames) and the readback asserts the
// Azure object carries exactly that name. Re-running tenant.create against an
// active tenant is the self-heal path: the ARM deployment is incremental, so a
// resource deleted out of band is recreated, then read back again.
//
// Where the state lives: the job's receipts are the persisted readback (resource
// ids only, per JobReceipt). The tenant registry document gains no new field here
// (registry/types.ts is W1-3's); the console reads the receipts.

import { z } from 'zod';
import type { Registry } from '../registry/registry.js';
import type { StampDoc, TenantDoc } from '../registry/types.js';
import type { Collection } from '../store/types.js';
import {
  classifyArm,
  stampResourceGroup,
  tenantNames,
  type KeyReadback,
  type TenantArm,
  type TenantManifest,
} from './tenant-arm.js';
import { JobFailure, type JobContext, type JobHandler } from './types.js';

export interface TenantJobDeps {
  stamps: Collection<StampDoc>;
  tenants: Collection<TenantDoc>;
  registry: Registry;
  arm: TenantArm;
}

export function tenantHandlers(deps: TenantJobDeps): JobHandler[] {
  return [tenantCreateHandler(deps), tenantDestroyHandler(deps)];
}

interface Resolved {
  tenant: TenantDoc;
  stamp: StampDoc;
  stampManifest: Record<string, unknown>;
  rg: string;
  vaultUri: string;
}

async function resolve(ctx: JobContext, deps: TenantJobDeps, needHealthyStamp: boolean): Promise<Resolved> {
  const tenant = await deps.tenants.get(ctx.job.subjectId);
  if (!tenant) throw new JobFailure('tenant_missing', 'the tenant record no longer exists');
  const stamp = await deps.stamps.get(tenant.stampId);
  if (!stamp) throw new JobFailure('stamp_missing', 'the tenant references a stamp that is not registered');
  if (needHealthyStamp && stamp.status !== 'healthy') {
    throw new JobFailure('stamp_not_ready', `the stamp is ${stamp.status}; a tenant is created only on a healthy stamp`);
  }
  const rg = stampResourceGroup(stamp.id, stamp.region);
  let lookup;
  try {
    lookup = await deps.arm.getStampManifest(rg, stamp.id);
  } catch (e) {
    throw classifyArm(e);
  }
  if (lookup.state === 'absent') {
    throw new JobFailure(
      'stamp_manifest_missing',
      `the stamp deployment lhds-stamp-${stamp.id} was not found in ${rg}; it is the source of the stamp manifest (vault, DNS zones, subnet)`,
    );
  }
  if (lookup.state === 'no_outputs') {
    throw new JobFailure(
      'stamp_manifest_unreadable',
      `the stamp deployment lhds-stamp-${stamp.id} exists in ${rg} but returned no stamp outputs (a later run may have overwritten the record); redeploy the stamp so its outputs are recorded`,
    );
  }
  const stampManifest = lookup.value;
  const vaultUri = String(stampManifest.keyVaultUri ?? '');
  if (!vaultUri) throw new JobFailure('stamp_manifest_incomplete', 'the stamp manifest has no keyVaultUri');
  return { tenant, stamp, stampManifest, rg, vaultUri };
}

/** [kind, id, expected last path segment]. The expectation is the DERIVED name, never the one ARM returned. */
function expectedResources(m: TenantManifest, stampName: string, slug: string): [string, string, string][] {
  const n = tenantNames(stampName, slug);
  // An empty id means "not found by the destroy fallback": nothing to delete or read.
  const out: [string, string, string][] = [];
  if (m.pixelAccountId) out.push(['storage.pixel', m.pixelAccountId, m.pixelAccountName]);
  if (m.auditAccountId) out.push(['storage.audit', m.auditAccountId, m.auditAccountName]);
  out.push(
    ['eventhub', m.eventHubId, n.eventHubName],
    ['identity', m.identityId, n.identityName],
    ['alert.capacity', m.capacityAlertId, n.alertName],
  );
  if (m.databaseId) out.push(['database', m.databaseId, n.databaseName]);
  m.keyIds.forEach((id, i) => out.push([`key.${n.keyNames[i] ?? i}`, id, n.keyNames[i] ?? '']));
  return out;
}

/** Build a manifest from derived names plus the stamp manifest. Storage ids come from a tag query (hash in the name). */
async function deriveManifest(arm: TenantArm, r: Resolved): Promise<TenantManifest> {
  const slug = r.tenant.id;
  const n = tenantNames(r.stamp.id, slug);
  const scope = arm.scopeFor(r.rg);
  const sm = r.stampManifest;
  const ns = String(sm.eventHubsNamespace ?? '');
  const pg = String(sm.postgresServerId ?? '');
  const vaultId = String(sm.keyVaultId ?? '');
  if (!ns || !vaultId) throw new JobFailure('stamp_manifest_incomplete', 'the stamp manifest lacks eventHubsNamespace or keyVaultId, so tenant resource names cannot be derived');
  const storage = await arm.findTenantStorage(r.rg, slug);
  const pixel = storage.find((id) => lastSegment(id).startsWith('sthpx')) ?? '';
  const audit = storage.find((id) => lastSegment(id).startsWith('sthta')) ?? '';
  return {
    tenantSlug: slug,
    stampName: r.stamp.id,
    pixelAccountId: pixel,
    pixelAccountName: lastSegment(pixel),
    auditAccountId: audit,
    auditAccountName: lastSegment(audit),
    databaseId: pg ? `${pg}/databases/${n.databaseName}` : '',
    databaseName: n.databaseName,
    eventHubId: `${scope}/providers/Microsoft.EventHub/namespaces/${ns}/eventhubs/${n.eventHubName}`,
    eventHubName: n.eventHubName,
    identityId: `${scope}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/${n.identityName}`,
    identityPrincipalId: '',
    capacityAlertId: `${scope}/providers/Microsoft.Insights/metricAlerts/${n.alertName}`,
    maxStorageGiB: r.tenant.quotas.maxStorageGiB,
    keyIds: n.keyNames.map((k) => `${vaultId}/keys/${k}`),
    keyNames: n.keyNames,
  };
}

function lastSegment(id: string): string {
  return id.split('/').pop() ?? '';
}

export function tenantCreateHandler(deps: TenantJobDeps): JobHandler {
  return {
    kind: 'tenant.create',
    subjectType: 'tenant',
    inputSchema: z.strictObject({}),
    async run(ctx) {
      const r = await resolve(ctx, deps, true);
      if (r.tenant.status === 'destroying') throw new JobFailure('tenant_destroying', 'the tenant is being destroyed and cannot be created');
      let manifest: TenantManifest;
      try {
        manifest = await deps.arm.deployTenant({
          resourceGroup: r.rg,
          slug: r.tenant.id,
          displayName: r.tenant.displayName,
          maxStorageGiB: r.tenant.quotas.maxStorageGiB,
          stamp: r.stampManifest,
        });
      } catch (e) {
        throw classifyArm(e);
      }
      await ctx.receipt('tenant.deployed', `deployment=lhds-tenant-${r.tenant.id} rg=${r.rg}`);

      // Readback: every resource must exist AND carry the derived name.
      const expected = expectedResources(manifest, r.stamp.id, r.tenant.id);
      const problems: string[] = [];
      for (const [kind, id, wantName] of expected) {
        let rb;
        try {
          rb = await deps.arm.readResource(id);
        } catch (e) {
          throw classifyArm(e);
        }
        const gotName = rb.name ?? lastSegment(id);
        if (!rb.exists) problems.push(`${kind} missing`);
        else if (gotName !== wantName || lastSegment(id) !== wantName) problems.push(`${kind} named ${gotName}, expected ${wantName}`);
        await ctx.receipt('readback', `${kind} exists=${rb.exists} id=${id}`);
      }
      // Key state: a tenant key that is not enabled cannot wrap or unwrap.
      for (const name of manifest.keyNames) {
        let k: KeyReadback;
        try {
          k = await deps.arm.readKey(r.vaultUri, name);
        } catch (e) {
          throw classifyArm(e);
        }
        await ctx.receipt('key.state', `key=${name} exists=${k.exists} enabled=${String(k.enabled)}`);
        if (!k.exists || k.enabled !== true) problems.push(`key ${name} is ${k.exists ? 'disabled' : 'missing'}`);
      }
      if (problems.length > 0) {
        throw new JobFailure('readback_mismatch', `tenant resources did not read back: ${problems.join('; ')}`);
      }

      if (r.tenant.status === 'creating') {
        await deps.registry.updateTenant(r.tenant.id, { status: 'active' }, 'job:tenant.create');
        await ctx.receipt('tenant.active', `tenant=${r.tenant.id}`);
      }
    },
  };
}

export function tenantDestroyHandler(deps: TenantJobDeps): JobHandler {
  return {
    kind: 'tenant.destroy',
    subjectType: 'tenant',
    // The caller must restate the tenant id: a destroy is not something a stray retry or a
    // wrong-subject submit may trigger.
    inputSchema: z.strictObject({ confirmTenantId: z.string().min(1).max(60), allowMissingStorage: z.boolean().optional() }),
    async run(ctx) {
      if (ctx.input.confirmTenantId !== ctx.job.subjectId) {
        throw new JobFailure('confirmation_mismatch', 'confirmTenantId does not equal the tenant id; nothing was changed');
      }
      const r = await resolve(ctx, deps, false);
      if (r.tenant.status !== 'destroying') {
        await deps.registry.updateTenant(r.tenant.id, { status: 'destroying' }, 'job:tenant.destroy');
        await ctx.receipt('tenant.destroying', `tenant=${r.tenant.id}`);
      }

      let lookup;
      try {
        lookup = await deps.arm.getTenantManifest(r.rg, r.tenant.id);
      } catch (e) {
        throw classifyArm(e);
      }
      if (lookup.state === 'absent') {
        throw new JobFailure(
          'tenant_manifest_missing',
          `the tenant deployment lhds-tenant-${r.tenant.id} was not found in ${r.rg} (HTTP 404), so the resources to delete cannot be named; nothing was deleted and no key was shredded`,
        );
      }
      let manifest: TenantManifest;
      if (lookup.state === 'found') {
        manifest = lookup.value;
      } else {
        // The record exists but has no outputs (a failed re-run overwrote it). The names are
        // derived, so destroy proceeds from them instead of leaving the tenant undeletable.
        try {
          manifest = await deriveManifest(deps.arm, r);
        } catch (e) {
          throw classifyArm(e);
        }
        // The two storage accounts are found by tag query (their names embed a hash). One the query
        // MISSES would be neither deleted nor read back before the keys are shredded, so a miss is
        // recorded in the receipt and fails closed unless the caller states it has verified the account is gone.
        const skipped = [
          ...(manifest.pixelAccountId ? [] : ['storage.pixel']),
          ...(manifest.auditAccountId ? [] : ['storage.audit']),
        ];
        const found = [manifest.pixelAccountId, manifest.auditAccountId].filter((x) => x).map(lastSegment);
        await ctx.receipt(
          'manifest.derived',
          `deployment lhds-tenant-${r.tenant.id} has no outputs; deleting by derived names; storage found=[${found.join(',')}] skipped=[${skipped.join(',')}]`,
        );
        if (skipped.length > 0 && ctx.input.allowMissingStorage !== true) {
          throw new JobFailure(
            'destroy_incomplete',
            `the tag query lhds-tenant=${r.tenant.id} returned no account for: ${skipped.join(', ')}; nothing was deleted and no key was shredded. If you have confirmed those accounts no longer exist, resubmit with allowMissingStorage=true.`,
          );
        }
      }

      // 1. Data-bearing resources first. Keys outlive them until every consumer is gone.
      const all = expectedResources(manifest, r.stamp.id, r.tenant.id);
      const dataResources = all.filter(([kind]) => !kind.startsWith('key.'));
      // Order: consumers of the identity and keys before the identity itself.
      const order = ['database', 'eventhub', 'storage.pixel', 'storage.audit', 'alert.capacity', 'identity'];
      dataResources.sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
      for (const [kind, id] of dataResources) {
        try {
          await deps.arm.deleteResource(id);
        } catch (e) {
          throw classifyArm(e);
        }
        await ctx.receipt('resource.deleted', `${kind} id=${id}`);
      }

      // 2. Prove every consumer is really gone before any key is touched: a key shredded while
      // an account still exists would leave that account encrypted under nothing.
      const stillThere: string[] = [];
      for (const [kind, id] of dataResources) {
        let rb;
        try {
          rb = await deps.arm.readResource(id);
        } catch (e) {
          throw classifyArm(e);
        }
        if (rb.exists) stillThere.push(kind);
      }
      if (stillThere.length > 0) {
        throw new JobFailure('destroy_incomplete', `still present after delete: ${stillThere.join(', ')}; keys were NOT shredded. Retry the job.`);
      }

      // 3. Crypto-shred: disable, delete, then read the state back as evidence.
      const names = tenantNames(r.stamp.id, r.tenant.id);
      for (const name of names.keyNames) {
        try {
          const before = await deps.arm.readKey(r.vaultUri, name);
          if (before.exists) {
            await deps.arm.disableKey(r.vaultUri, name);
            await deps.arm.deleteKey(r.vaultUri, name);
          }
        } catch (e) {
          throw classifyArm(e);
        }
      }
      const unshredded: string[] = [];
      for (const name of names.keyNames) {
        let k: KeyReadback;
        try {
          k = await deps.arm.readKey(r.vaultUri, name);
        } catch (e) {
          throw classifyArm(e);
        }
        await ctx.receipt(
          'key.shredded',
          `key=${name} live=${k.exists} deletedDate=${k.deletedDate ?? 'none'} scheduledPurgeDate=${k.scheduledPurgeDate ?? 'none'}`,
        );
        if (k.exists || !k.deletedDate) unshredded.push(name);
      }
      if (unshredded.length > 0) {
        throw new JobFailure('shred_unverified', `key state did not read back as deleted for: ${unshredded.join(', ')}`);
      }
    },
  };
}
