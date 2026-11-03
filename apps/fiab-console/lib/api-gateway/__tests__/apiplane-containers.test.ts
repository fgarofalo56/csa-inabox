/**
 * W1-1 — the five apiplane-* containers: accessor resolution + bicep declaration.
 *
 * Each assertion names the value that breaks it:
 *  - accessor test: an accessor that creates its container with any PK other than
 *    '/tenantId' (or a different id) fails the exact-definition match below.
 *  - bicep test: a row missing from cosmos.bicep, or declared with another PK,
 *    fails the per-name row match.
 *  - census: a sixth/removed accessor changes the created apiplane-* id list.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';

const created: Array<{ id: string; pk: string[]; defaultTtl?: number }> = [];

vi.mock('@azure/cosmos', () => {
  const mkContainer = (id: string) => ({
    id,
    read: async () => ({ resource: { id, defaultTtl: -1 } }),
    replace: async () => ({}),
  });
  class CosmosClient {
    databases = {
      createIfNotExists: async () => ({
        database: {
          containers: {
            createIfNotExists: async (def: { id: string; partitionKey: { paths: string[] }; defaultTtl?: number }) => {
              created.push({ id: def.id, pk: def.partitionKey.paths, defaultTtl: def.defaultTtl });
              return { container: mkContainer(def.id) };
            },
          },
        },
      }),
    };
  }
  return { CosmosClient };
});
vi.mock('@azure/identity', () => ({
  ChainedTokenCredential: class {},
  DefaultAzureCredential: class {},
  ManagedIdentityCredential: class {},
}));
vi.mock('@/lib/azure/aca-managed-identity', () => ({ AcaManagedIdentityCredential: class {} }));

import * as cosmos from '@/lib/azure/cosmos-client';
import { APIPLANE_CONTAINERS, APIPLANE_PARTITION_KEY } from '../types';

const ACCESSORS: Array<[string, () => Promise<{ id: string }>]> = [
  ['apiplane-desired', () => cosmos.apiplaneDesiredContainer()],
  ['apiplane-observed', () => cosmos.apiplaneObservedContainer()],
  ['apiplane-plans', () => cosmos.apiplanePlansContainer()],
  ['apiplane-usage', () => cosmos.apiplaneUsageContainer()],
  ['apiplane-notify', () => cosmos.apiplaneNotifyContainer()],
];

beforeAll(() => {
  process.env.LOOM_COSMOS_ENDPOINT = 'https://cosmos.test.invalid:443/';
});

describe('apiplane Cosmos accessors', () => {
  it.each(ACCESSORS)('%s resolves to a container of that id created with PK /tenantId', async (name, accessor) => {
    const c = await accessor();
    expect(c.id, `accessor for ${name} returned a different container`).toBe(name);
    const defs = created.filter((d) => d.id === name);
    // exactly one definition, PK exactly ['/tenantId'], TTL enabled (-1)
    expect(defs, `${name} must be created exactly once with PK /tenantId`).toEqual([
      { id: name, pk: ['/tenantId'], defaultTtl: -1 },
    ]);
  });

  it('creates exactly the five names in APIPLANE_CONTAINERS (no extra apiplane-* container)', () => {
    const ids = created.filter((d) => d.id.startsWith('apiplane-')).map((d) => d.id).sort();
    expect(ids).toEqual([...APIPLANE_CONTAINERS].sort());
    expect(APIPLANE_PARTITION_KEY).toBe('/tenantId');
  });
});

describe('landing-zone/cosmos.bicep declares the five containers', () => {
  const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..', '..');
  const bicep = readFileSync(join(REPO_ROOT, 'platform/fiab/bicep/modules/landing-zone/cosmos.bicep'), 'utf8');

  it.each([...APIPLANE_CONTAINERS])('%s is a row with partitionKey /tenantId', (name) => {
    const re = new RegExp(`\\{\\s*name:\\s*'${name}'\\s*,\\s*partitionKey:\\s*'([^']+)'`);
    const m = bicep.match(re);
    expect(m, `${name} missing from loomContainers in cosmos.bicep`).not.toBeNull();
    expect(m![1], `${name} declared with the wrong partition key`).toBe('/tenantId');
  });

  it('declares no extra apiplane-* row', () => {
    const names = [...bicep.matchAll(/name:\s*'(apiplane-[a-z]+)'/g)].map((m) => m[1]).sort();
    expect(names).toEqual([...APIPLANE_CONTAINERS].sort());
  });
});
