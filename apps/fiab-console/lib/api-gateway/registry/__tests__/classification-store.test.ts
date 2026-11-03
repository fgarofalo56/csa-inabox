/**
 * W1-2 ClassificationStore. Each assertion names the value that breaks it:
 *  - stale etag: applyBatch with a stale etag on gateway B must throw
 *    ClassificationConflictError('B') AND leave gateway A (fresh etag, same batch)
 *    unchanged and writes === the pre-batch count. A non-atomic loop that writes A
 *    before checking B makes A.environmentKey 'prod' and fails the first block.
 *  - positive pair: the identical batch shape with fresh etags DOES write both; a
 *    store that always throws would pass the stale test but fail this one.
 *  - re-registration: refreshing an existing gateway after it was classified must
 *    keep environmentKey 'prod'; an upsert of a stale read resets it to null.
 *  - other fields: displayName survives classification (replace is not a rewrite).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { ClassificationConflictError } from '../../environments/types';
import { createGatewayClassificationStore } from '../classification-store';
import { ensureDeployGateway, gatewayId, registerGateway, type Actor, type RegistryDeps } from '../gateway-service';
import { armDouble, CONTRIBUTOR_PERMS, SUB } from './arm-double';
import { MemoryGatewayRepo } from './memory-gateway-repo';

const actor: Actor = { tenantId: 't1', who: 'a@x', actorOid: 'oid-a', capability: 'tenant-admin' };
const idA = `/subscriptions/${SUB}/resourceGroups/rg/providers/Microsoft.ApiManagement/service/apim-a`;
const idB = `/subscriptions/${SUB}/resourceGroups/rg/providers/Microsoft.ApiManagement/service/apim-b`;
let repo: MemoryGatewayRepo;
let deps: RegistryDeps;

beforeEach(async () => {
  repo = new MemoryGatewayRepo();
  deps = { repo, arm: armDouble({ permissions: CONTRIBUTOR_PERMS }), writeAudit: async () => {}, cloud: () => 'AzureCloud' };
  await registerGateway(deps, actor, { resourceId: idA, displayName: 'Alpha' });
  await registerGateway(deps, actor, { resourceId: idB, displayName: 'Beta' });
});

describe('list', () => {
  it('exposes environmentKey null (Unclassified) and an etag per gateway; other kinds are empty', async () => {
    const store = createGatewayClassificationStore(() => repo);
    const rows = await store.list('t1');
    expect(rows.map((r) => [r.displayName, r.environmentKey, r.kind])).toEqual([
      ['Alpha', null, 'gateway'],
      ['Beta', null, 'gateway'],
    ]);
    expect(rows.every((r) => typeof r.etag === 'string' && r.etag.length > 0)).toBe(true);
    expect(await store.list('t1', 'endpoint')).toEqual([]);
  });
});

describe('applyBatch', () => {
  it('a stale etag on one record writes NOTHING, even for the record whose etag is fresh', async () => {
    const store = createGatewayClassificationStore(() => repo);
    const [a, b] = await store.list('t1');
    // Someone else changes B after we read it.
    await store.applyBatch('t1', [{ kind: 'gateway', id: b.id, environmentKey: 'dev', expectedEtag: b.etag }]);
    const writesBefore = repo.writes;
    await expect(
      store.applyBatch('t1', [
        { kind: 'gateway', id: a.id, environmentKey: 'prod', expectedEtag: a.etag },
        { kind: 'gateway', id: b.id, environmentKey: 'prod', expectedEtag: b.etag }, // stale
      ]),
    ).rejects.toMatchObject({ name: 'ClassificationConflictError', resourceId: b.id });
    expect(repo.writes).toBe(writesBefore);
    const after = await store.list('t1');
    expect(after.map((r) => r.environmentKey)).toEqual([null, 'dev']);
  });

  it('positive pair: the same batch shape with fresh etags writes both and keeps other fields', async () => {
    const store = createGatewayClassificationStore(() => repo);
    const [a, b] = await store.list('t1');
    await store.applyBatch('t1', [
      { kind: 'gateway', id: a.id, environmentKey: 'prod', expectedEtag: a.etag },
      { kind: 'gateway', id: b.id, environmentKey: 'prod', expectedEtag: b.etag },
    ]);
    const after = await store.list('t1');
    expect(after.map((r) => [r.displayName, r.environmentKey])).toEqual([['Alpha', 'prod'], ['Beta', 'prod']]);
    const full = await repo.get('t1', gatewayId(idA));
    expect(full?.resourceId).toBe(idA);
    expect(full?.access.canRead).toBe(true);
  });

  it('an unknown id is a conflict and nothing is written; null clears a classification', async () => {
    const store = createGatewayClassificationStore(() => repo);
    const writes = repo.writes;
    await expect(store.applyBatch('t1', [{ kind: 'gateway', id: 'gw-missing', environmentKey: 'dev' }])).rejects.toBeInstanceOf(
      ClassificationConflictError,
    );
    expect(repo.writes).toBe(writes);
    const [a] = await store.list('t1');
    await store.applyBatch('t1', [{ kind: 'gateway', id: a.id, environmentKey: 'dev', expectedEtag: a.etag }]);
    const [a2] = await store.list('t1');
    await store.applyBatch('t1', [{ kind: 'gateway', id: a2.id, environmentKey: null, expectedEtag: a2.etag }]);
    expect((await store.list('t1'))[0].environmentKey).toBeNull();
  });

  it('refuses a non-gateway kind rather than silently ignoring it', async () => {
    const store = createGatewayClassificationStore(() => repo);
    await expect(store.applyBatch('t1', [{ kind: 'endpoint', id: 'e1', environmentKey: 'dev' }])).rejects.toThrow(/cannot classify/);
  });
});

describe('registry writes never overwrite environmentKey', () => {
  it('re-registering the deploy-owned gateway keeps its classification', async () => {
    const idC = idA.replace('apim-a', 'apim-c');
    const env = { LOOM_APIPLANE_DEPLOY_GATEWAY_ID: idC };
    const store = createGatewayClassificationStore(() => repo);
    const first = await ensureDeployGateway({ ...deps, arm: armDouble({ permissions: [] }) }, actor, env); // unreadable -> will be retried
    expect(first.ok && first.data?.access.canRead).toBe(false);
    const [a] = (await store.list('t1')).filter((r) => r.id === gatewayId(idC));
    await store.applyBatch('t1', [{ kind: 'gateway', id: a.id, environmentKey: 'prod', expectedEtag: a.etag }]);
    const again = await ensureDeployGateway(deps, actor, env); // now readable: refresh path
    expect(again.ok && again.data?.access.canRead).toBe(true);
    expect(again.ok && again.data?.environmentKey).toBe('prod');
    expect((await repo.get('t1', gatewayId(idC)))?.environmentKey).toBe('prod');
  });
});

describe('plug-in registration', () => {
  it('importing register.ts makes the environments deps expose a classification store', async () => {
    await import('../register');
    const { getEnvironmentDeps } = await import('../../environments/deps');
    expect(getEnvironmentDeps().classification).toBeDefined();
  });
});
