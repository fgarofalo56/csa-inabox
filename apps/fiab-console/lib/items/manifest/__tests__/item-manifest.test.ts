/**
 * EH-P1-MANIFEST (#1801) — item-type manifest registry tests.
 *
 * Three layers:
 *   1. Registry completeness + self-consistency (checkManifestConsistency).
 *   2. Cross-registry DRIFT guards: the manifest's capability source lists must
 *      equal the live registries they mirror (THREAD_ACTIONS fromTypes,
 *      PBI_RESOLVABLE_TYPES, PROVISIONERS keys) — editing one side without the
 *      other fails here.
 *   3. Wired-consumer EQUIVALENCE proof: thread-actions' manifest-driven
 *      PBI_SOURCEABLE is identical (members AND order) to the previous
 *      hard-coded list, so the swap is behavior-preserving by construction.
 */
import { describe, it, expect, vi } from 'vitest';
import { FABRIC_ITEM_TYPES, findItemType } from '@/lib/catalog/fabric-item-types';
import { ITEM_PAIRING_RULES } from '@/lib/items/registry';
import {
  DATA_AGENT_SOURCEABLE_ITEM_TYPES,
  NOTEBOOK_ATTACHABLE_ITEM_TYPES,
  PBI_SOURCEABLE_ITEM_TYPES,
  POWERBI_MODELABLE_ITEM_TYPES,
  PROVISIONABLE_ITEM_TYPES,
  WEAVE_SOURCEABLE_ITEM_TYPES,
} from '../item-manifest';
import {
  checkManifestConsistency,
  getItemManifest,
  listItemManifests,
  pbiSourceableTypes,
} from '../registry';
import { THREAD_ACTIONS, actionsFor, PBI_SOURCEABLE } from '@/lib/thread/thread-actions';

// The provisioning engine transitively pulls large Azure SDKs; stub the
// credential chain like lib/install/__tests__/provisioners.test.ts does and
// give the cold transform a generous budget.
vi.mock('@azure/identity', async () => {
  class Cred {
    async getToken() {
      return { token: 'test-token', expiresOnTimestamp: Date.now() + 3600_000 };
    }
  }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});
const COLD_TRANSFORM_TIMEOUT_MS = 120_000;

/** The exact PBI_SOURCEABLE list as hard-coded in thread-actions.ts BEFORE #1801. */
const PRIOR_HARDCODED_PBI_SOURCEABLE = [
  'lakehouse', 'warehouse', 'eventhouse', 'kql-database', 'mirrored-database',
  'dataset', 'semantic-model', 'data-product',
  'synapse-serverless-sql-pool', 'synapse-dedicated-sql-pool',
];

describe('item-type manifest registry — completeness', () => {
  it('resolves a manifest for every catalog item type (no orphans either way)', () => {
    const slugs = new Set(FABRIC_ITEM_TYPES.map((t) => t.slug));
    for (const slug of slugs) {
      expect(getItemManifest(slug), `manifest for '${slug}'`).toBeDefined();
    }
    expect(listItemManifests()).toHaveLength(slugs.size);
    for (const m of listItemManifests()) {
      expect(slugs.has(m.type), `manifest '${m.type}' has a catalog entry`).toBe(true);
    }
  });

  it('mirrors findItemType first-wins semantics for duplicate slugs', () => {
    for (const m of listItemManifests()) {
      const c = findItemType(m.type)!;
      expect(m.displayName).toBe(c.displayName);
      expect(m.family).toBe(c.category);
      expect(m.restType).toBe(c.restType);
      expect(m.editorSlug).toBe(c.aliasOf ?? c.slug);
    }
  });

  it('returns undefined for unknown slugs', () => {
    expect(getItemManifest('not-a-real-item-type')).toBeUndefined();
  });

  it('passes the dev-time consistency check', () => {
    const report = checkManifestConsistency();
    expect(report.problems).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('derives pairsWith from ITEM_PAIRING_RULES 1:1', () => {
    for (const [slug, rules] of Object.entries(ITEM_PAIRING_RULES)) {
      const m = getItemManifest(slug);
      expect(m, `pairing rule parent '${slug}' is a cataloged type`).toBeDefined();
      expect(m!.pairsWith).toEqual(rules.map((r) => r.pairedType));
    }
    // No manifest invents a pairing the rules don't declare.
    for (const m of listItemManifests()) {
      if (m.pairsWith.length > 0) {
        expect(Object.keys(ITEM_PAIRING_RULES)).toContain(m.type);
      }
    }
  });

  it('capability flags are well-formed booleans and coherent', () => {
    for (const m of listItemManifests()) {
      for (const [k, v] of Object.entries(m.capabilities)) {
        expect(typeof v, `capabilities.${k} on '${m.type}'`).toBe('boolean');
      }
      expect(m.defaultBackend).toMatch(/^(azure-native|cosmos-only)$/);
      expect(['fabric-parity', 'azure-service', 'loom-native']).toContain(m.familyKind);
      if (m.capabilities.provisionable) {
        expect(m.azureBackend, `azureBackend on provisionable '${m.type}'`).toBeTruthy();
        expect(m.defaultBackend).toBe('azure-native');
      } else {
        expect(m.azureBackend).toBeUndefined();
        expect(m.defaultBackend).toBe('cosmos-only');
      }
      if (m.fabricEquivalent) expect(m.familyKind).toBe('fabric-parity');
    }
  });
});

describe('item-type manifest registry — cross-registry drift guards', () => {
  it('weaveSourceable matches the live THREAD_ACTIONS fromTypes union, per type', () => {
    for (const m of listItemManifests()) {
      const hasEdge = actionsFor(m.type).length > 0;
      expect(m.capabilities.weaveSourceable, `weaveSourceable('${m.type}')`).toBe(hasEdge);
    }
    // And the static union list contains nothing the live registry doesn't.
    const liveUnion = new Set<string>();
    for (const a of THREAD_ACTIONS) {
      if (a.fromTypes === '*') continue;
      for (const s of a.fromTypes) liveUnion.add(s);
    }
    expect(new Set(WEAVE_SOURCEABLE_ITEM_TYPES)).toEqual(liveUnion);
  });

  it('notebookAttachable / dataAgentSourceable / powerBiModelable mirror the live edges', () => {
    const fromTypesOf = (id: string): string[] => {
      const a = THREAD_ACTIONS.find((x) => x.id === id)!;
      return a.fromTypes === '*' ? [] : a.fromTypes;
    };
    expect([...NOTEBOOK_ATTACHABLE_ITEM_TYPES]).toEqual(fromTypesOf('analyze-in-notebook'));
    expect([...DATA_AGENT_SOURCEABLE_ITEM_TYPES]).toEqual(fromTypesOf('add-data-agent-source'));
    expect([...POWERBI_MODELABLE_ITEM_TYPES]).toEqual(fromTypesOf('build-powerbi-model'));
  });

  it(
    'pbiSourceable stays set-equal to PBI_RESOLVABLE_TYPES in the resolver',
    async () => {
      const { PBI_RESOLVABLE_TYPES } = await import('@/lib/azure/pbi-source-resolver');
      expect(new Set(PBI_SOURCEABLE_ITEM_TYPES)).toEqual(new Set(PBI_RESOLVABLE_TYPES));
    },
    COLD_TRANSFORM_TIMEOUT_MS,
  );

  it(
    'PROVISIONABLE_ITEM_TYPES equals the live PROVISIONERS map keys',
    async () => {
      const { PROVISIONERS } = await import('@/lib/install/provisioning-engine');
      expect([...PROVISIONABLE_ITEM_TYPES].sort()).toEqual(Object.keys(PROVISIONERS).sort());
    },
    COLD_TRANSFORM_TIMEOUT_MS,
  );
});

describe('wired consumer — thread-actions PBI_SOURCEABLE equivalence proof', () => {
  it('manifest-driven PBI_SOURCEABLE is IDENTICAL (members and order) to the prior hard-coded list', () => {
    expect(PBI_SOURCEABLE).toEqual(PRIOR_HARDCODED_PBI_SOURCEABLE);
    expect(pbiSourceableTypes()).toEqual(PRIOR_HARDCODED_PBI_SOURCEABLE);
  });

  it('the analyze-in-powerbi edge gates on exactly the same types as before', () => {
    for (const m of listItemManifests()) {
      const offered = actionsFor(m.type).some((a) => a.id === 'analyze-in-powerbi');
      const prior = PRIOR_HARDCODED_PBI_SOURCEABLE.includes(m.type);
      expect(offered, `analyze-in-powerbi offered on '${m.type}'`).toBe(prior);
      expect(m.capabilities.pbiSourceable, `pbiSourceable('${m.type}')`).toBe(prior);
    }
  });
});
