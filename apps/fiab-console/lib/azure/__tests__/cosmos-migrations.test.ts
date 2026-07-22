/**
 * cosmos-migrations (MIG1) — unit tests.
 *
 * Proves the versioned doc-migration convention: a v1 fixture doc (no
 * schemaVersion) upgrades to v2 on read, migrateOnRead is idempotent (a
 * fixpoint at the latest version — the property that makes the optional
 * backfill script re-runnable), chains compose v1→v2→v3, and the
 * withMigrations Container wrapper migrates docs at every central
 * materialization point (query fetchAll/fetchNext/async-iterate,
 * item().read()) while staying behaviorally inert when no migrator is
 * registered.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  hasMigrators,
  migrateOnRead,
  registerMigrator,
  resetMigratorsForTest,
  withMigrations,
  type VersionedDoc,
} from '@/lib/azure/cosmos-migrations';
import type { Container } from '@azure/cosmos';

afterEach(() => resetMigratorsForTest());

/** v1 fixture — the pre-convention shape: no schemaVersion, legacy field name. */
const v1Doc = () => ({ id: 'doc-1', tenantId: 't1', ownerEmail: 'a@b.c' });

/** v1 → v2: rename ownerEmail → owner.email, stamp schemaVersion 2. */
function registerV1toV2(containerId = 'test-container') {
  registerMigrator(containerId, 1, (doc: VersionedDoc) => {
    const { ownerEmail, ...rest } = doc as VersionedDoc & { ownerEmail?: string };
    return { ...rest, owner: { email: ownerEmail }, schemaVersion: 2 };
  });
}

describe('migrateOnRead', () => {
  it('upgrades a v1 fixture doc (absent schemaVersion) to v2 on read', () => {
    registerV1toV2();
    const out = migrateOnRead('test-container', v1Doc()) as VersionedDoc & {
      owner?: { email: string };
      ownerEmail?: string;
    };
    expect(out.schemaVersion).toBe(2);
    expect(out.owner).toEqual({ email: 'a@b.c' });
    expect(out.ownerEmail).toBeUndefined();
    expect(out.id).toBe('doc-1');
  });

  it('is idempotent — migrating an already-migrated doc changes nothing', () => {
    registerV1toV2();
    const once = migrateOnRead('test-container', v1Doc());
    const twice = migrateOnRead('test-container', once);
    expect(twice).toBe(once); // same reference: no migrator applies at v2
    expect(twice).toEqual(once);
  });

  it('composes a chain v1 → v2 → v3', () => {
    registerV1toV2();
    registerMigrator('test-container', 2, (doc) => ({ ...doc, region: 'unknown', schemaVersion: 3 }));
    const out = migrateOnRead('test-container', v1Doc()) as VersionedDoc & { region?: string };
    expect(out.schemaVersion).toBe(3);
    expect(out.region).toBe('unknown');
  });

  it('returns the doc untouched (same reference) for a container with no migrators', () => {
    const doc = v1Doc();
    expect(migrateOnRead('unregistered-container', doc)).toBe(doc);
    expect(hasMigrators('unregistered-container')).toBe(false);
  });

  it('passes through null/undefined/non-object values', () => {
    registerV1toV2();
    expect(migrateOnRead('test-container', null)).toBeNull();
    expect(migrateOnRead('test-container', undefined)).toBeUndefined();
    expect(migrateOnRead('test-container', 42)).toBe(42);
  });

  it('stamps schemaVersion when a migrator forgets to advance it', () => {
    registerMigrator('test-container', 1, (doc) => ({ ...doc, patched: true })); // no stamp
    const out = migrateOnRead('test-container', v1Doc()) as VersionedDoc & { patched?: boolean };
    expect(out.schemaVersion).toBe(2);
    expect(out.patched).toBe(true);
  });

  it('rejects duplicate migrator registration for the same (container, fromVersion)', () => {
    registerV1toV2();
    expect(() => registerV1toV2()).toThrow(/duplicate migrator/);
  });
});

// ---------------------------------------------------------------------------
// withMigrations — read-path wiring over a structural fake of the SDK shapes.
// ---------------------------------------------------------------------------

function fakeContainer(docs: VersionedDoc[]) {
  const calls: string[] = [];
  const iterator = {
    fetchAll: async () => ({ resources: docs.map((d) => ({ ...d })), requestCharge: 2.5 }),
    fetchNext: async () => ({ resources: docs.map((d) => ({ ...d })), hasMoreResults: false }),
    getAsyncIterator: () =>
      (async function* () {
        yield { resources: docs.map((d) => ({ ...d })) };
      })(),
  };
  const container = {
    id: 'fake',
    items: {
      query: (..._args: unknown[]) => {
        calls.push('query');
        return iterator;
      },
      readAll: () => {
        calls.push('readAll');
        return iterator;
      },
      upsert: async (doc: VersionedDoc) => {
        calls.push('upsert');
        return { resource: doc };
      },
    },
    item: (id: string, _pk?: unknown) => ({
      read: async () => ({ resource: { ...docs.find((d) => d.id === id)! }, statusCode: 200 }),
      delete: async () => {
        calls.push('delete');
        return {};
      },
    }),
    read: async () => {
      calls.push('container.read');
      return { resource: { id: 'fake', defaultTtl: -1 } };
    },
  };
  return { container: container as unknown as Container, calls };
}

describe('withMigrations (Container read-path wrapper)', () => {
  it('migrates docs materialized via items.query().fetchAll()', async () => {
    registerV1toV2('wrapped-container');
    const { container } = fakeContainer([v1Doc()]);
    const wrapped = withMigrations(container, 'wrapped-container');
    const { resources } = await wrapped.items.query('SELECT * FROM c').fetchAll();
    expect((resources[0] as VersionedDoc).schemaVersion).toBe(2);
    expect((resources[0] as { owner?: { email: string } }).owner).toEqual({ email: 'a@b.c' });
  });

  it('migrates docs materialized via fetchNext() and async iteration', async () => {
    registerV1toV2('wrapped-container');
    const { container } = fakeContainer([v1Doc()]);
    const wrapped = withMigrations(container, 'wrapped-container');
    const next = await wrapped.items.readAll().fetchNext();
    expect((next.resources[0] as VersionedDoc).schemaVersion).toBe(2);
    for await (const page of wrapped.items.query('SELECT * FROM c').getAsyncIterator()) {
      expect((page.resources[0] as VersionedDoc).schemaVersion).toBe(2);
    }
  });

  it('migrates docs materialized via item(id, pk).read()', async () => {
    registerV1toV2('wrapped-container');
    const { container } = fakeContainer([v1Doc()]);
    const wrapped = withMigrations(container, 'wrapped-container');
    const { resource } = await wrapped.item('doc-1', 't1').read();
    expect((resource as VersionedDoc).schemaVersion).toBe(2);
  });

  it('is behaviorally inert when no migrator is registered', async () => {
    const { container } = fakeContainer([v1Doc()]);
    const wrapped = withMigrations(container, 'wrapped-container');
    const { resources } = await wrapped.items.query('SELECT * FROM c').fetchAll();
    expect((resources[0] as VersionedDoc).schemaVersion).toBeUndefined();
    expect(resources[0]).toEqual(v1Doc());
    const { resource } = await wrapped.item('doc-1', 't1').read();
    expect(resource).toEqual(v1Doc());
  });

  it('leaves write paths and container-metadata ops untouched', async () => {
    registerV1toV2('wrapped-container');
    const { container, calls } = fakeContainer([v1Doc()]);
    const wrapped = withMigrations(container, 'wrapped-container');
    const up = await (wrapped.items as unknown as { upsert: (d: VersionedDoc) => Promise<{ resource: VersionedDoc }> }).upsert({ id: 'x' });
    expect(up.resource).toEqual({ id: 'x' }); // upsert response NOT migrated
    const meta = await wrapped.read();
    expect((meta as { resource?: { defaultTtl?: number } }).resource?.defaultTtl).toBe(-1);
    expect(calls).toContain('upsert');
    expect(calls).toContain('container.read');
  });

  it('preserves feed metadata (requestCharge) alongside migrated resources', async () => {
    registerV1toV2('wrapped-container');
    const { container } = fakeContainer([v1Doc()]);
    const wrapped = withMigrations(container, 'wrapped-container');
    const resp = await wrapped.items.query('SELECT * FROM c').fetchAll();
    expect((resp as unknown as { requestCharge: number }).requestCharge).toBe(2.5);
  });
});
