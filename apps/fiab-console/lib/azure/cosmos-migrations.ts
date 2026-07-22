/**
 * Versioned Cosmos doc-migration convention (PRP loom-next-level MIG1).
 *
 * Convention:
 * - Every doc MAY carry a numeric `schemaVersion`. A doc WITHOUT the field is
 *   version 1 by definition (the entire pre-convention corpus is v1).
 * - A breaking shape change bumps the container's current version N → N+1 and
 *   registers a migrator for `fromVersion: N` that returns the doc upgraded to
 *   N+1 (stamping `schemaVersion: N+1`).
 * - Readers upgrade LAZILY: `migrateOnRead(containerId, doc)` walks the
 *   registered chain (v1 → v2 → … → latest) at materialization time, so old
 *   docs keep working the moment the migrator ships — no downtime, no
 *   stop-the-world rewrite.
 * - An OPTIONAL backfill script (`scripts/csa-loom/cosmos-backfill-<container>.mjs`)
 *   sweeps the container at leisure, persisting the upgraded shape so the lazy
 *   path eventually becomes a no-op. Backfill is idempotent: re-running it on
 *   already-migrated docs changes nothing (migrateOnRead is a fixpoint at the
 *   latest version).
 *
 * Wiring: `withMigrations(container, id)` wraps the SDK Container returned by
 * cosmos-client's `ensure()` so every central read path — `items.query()`,
 * `items.readAll()`, and `item(id, pk).read()` — applies `migrateOnRead` where
 * docs are materialized. When NO migrator is registered for a container (the
 * state of every container today) the wrapper is behaviorally inert: responses
 * pass through untouched.
 *
 * First real consumer: the partition-key migration in
 * `PRPs/active/enterprise-hardening/appendix-scale-cosmos-data-tier.md` §4.2.
 * Full convention doc: `docs/fiab/cosmos-migration-convention.md`.
 */

import type { Container } from '@azure/cosmos';

/** A doc participating in the convention. Absent `schemaVersion` = version 1. */
export interface VersionedDoc {
  schemaVersion?: number;
  [key: string]: unknown;
}

/**
 * Upgrades a doc from exactly `fromVersion` to `fromVersion + 1`.
 * MUST return a NEW object (never mutate the input) and SHOULD stamp
 * `schemaVersion: fromVersion + 1`; if it forgets, `migrateOnRead` stamps it.
 */
export type DocMigrator = (doc: VersionedDoc) => VersionedDoc;

/** containerId → (fromVersion → migrator). */
const REGISTRY = new Map<string, Map<number, DocMigrator>>();

/** Hard ceiling on chain length — trips on a migrator that fails to advance. */
const MAX_MIGRATION_STEPS = 100;

/**
 * Register a migrator that upgrades `containerId` docs from `fromVersion` to
 * `fromVersion + 1`. Call at module scope of the owning doc-model module so
 * the chain is registered before any read materializes. Duplicate
 * registrations for the same (container, fromVersion) throw — one owner per
 * step.
 */
export function registerMigrator(
  containerId: string,
  fromVersion: number,
  migrate: DocMigrator,
): void {
  if (!Number.isInteger(fromVersion) || fromVersion < 1) {
    throw new Error(
      `cosmos-migrations: fromVersion must be an integer >= 1 (got ${fromVersion} for '${containerId}')`,
    );
  }
  let chain = REGISTRY.get(containerId);
  if (!chain) {
    chain = new Map();
    REGISTRY.set(containerId, chain);
  }
  if (chain.has(fromVersion)) {
    throw new Error(
      `cosmos-migrations: duplicate migrator for '${containerId}' v${fromVersion} → v${fromVersion + 1}`,
    );
  }
  chain.set(fromVersion, migrate);
}

/** True when at least one migrator is registered for the container. */
export function hasMigrators(containerId: string): boolean {
  return (REGISTRY.get(containerId)?.size ?? 0) > 0;
}

/** TEST-ONLY: drop registered migrators (all, or one container's). */
export function resetMigratorsForTest(containerId?: string): void {
  if (containerId) REGISTRY.delete(containerId);
  else REGISTRY.clear();
}

/**
 * Apply the registered migrator chain to one materialized doc. Absent
 * `schemaVersion` = v1. Returns the doc upgraded to the latest registered
 * version — or the input untouched (same reference) when no migrator applies,
 * so the call is behaviorally inert on unregistered containers and idempotent
 * on already-current docs.
 */
export function migrateOnRead<T>(containerId: string, doc: T): T {
  if (doc === null || doc === undefined || typeof doc !== 'object' || Array.isArray(doc)) {
    return doc;
  }
  const chain = REGISTRY.get(containerId);
  if (!chain || chain.size === 0) return doc;

  let current = doc as unknown as VersionedDoc;
  let steps = 0;
  for (;;) {
    const v = typeof current.schemaVersion === 'number' ? current.schemaVersion : 1;
    const step = chain.get(v);
    if (!step) return current as unknown as T;
    if (++steps > MAX_MIGRATION_STEPS) {
      throw new Error(
        `cosmos-migrations: migration chain for '${containerId}' exceeded ${MAX_MIGRATION_STEPS} steps — a migrator is not advancing schemaVersion`,
      );
    }
    const next = step(current);
    const nextV = typeof next?.schemaVersion === 'number' ? next.schemaVersion : undefined;
    // A migrator that forgets to stamp (or fails to advance) gets stamped for
    // it — the chain must make progress or the guard above trips.
    current = nextV === undefined || nextV <= v ? { ...next, schemaVersion: v + 1 } : next;
  }
}

// ---------------------------------------------------------------------------
// Read-path wiring: wrap an SDK Container so query()/readAll()/item().read()
// responses run through migrateOnRead where docs are materialized.
// ---------------------------------------------------------------------------

/** Replace `resp[key]` (resources / resource) with its migrated counterpart. */
function replaceResponseField(resp: unknown, key: 'resources' | 'resource', value: unknown): unknown {
  try {
    Object.defineProperty(resp as object, key, {
      value,
      configurable: true,
      enumerable: true,
      writable: true,
    });
    return resp;
  } catch {
    // Frozen/getter-only response object — fall back to a shadowing proxy.
    return new Proxy(resp as object, {
      get: (t, p, r) => (p === key ? value : Reflect.get(t, p, r)),
    });
  }
}

function migrateFeedResponse(containerId: string, resp: unknown): unknown {
  const resources = (resp as { resources?: unknown[] } | null | undefined)?.resources;
  if (!Array.isArray(resources) || !hasMigrators(containerId)) return resp;
  return replaceResponseField(
    resp,
    'resources',
    resources.map((d) => migrateOnRead(containerId, d)),
  );
}

function migrateItemResponse(containerId: string, resp: unknown): unknown {
  const resource = (resp as { resource?: unknown } | null | undefined)?.resource;
  if (resource === undefined || !hasMigrators(containerId)) return resp;
  return replaceResponseField(resp, 'resource', migrateOnRead(containerId, resource));
}

/** Delegate a property access, binding methods to the real target. */
function delegated(target: object, prop: string | symbol): unknown {
  const v = Reflect.get(target, prop, target);
  return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
}

function wrapQueryIterator(containerId: string, iterator: object): object {
  return new Proxy(iterator, {
    get(target, prop) {
      if (prop === 'fetchAll' || prop === 'fetchNext') {
        const fn = Reflect.get(target, prop, target) as (...a: unknown[]) => Promise<unknown>;
        return async (...args: unknown[]) =>
          migrateFeedResponse(containerId, await fn.apply(target, args));
      }
      if (prop === 'getAsyncIterator') {
        const fn = Reflect.get(target, prop, target) as (
          ...a: unknown[]
        ) => AsyncIterable<unknown>;
        return (...args: unknown[]) => {
          const inner = fn.apply(target, args);
          return (async function* () {
            for await (const page of inner) yield migrateFeedResponse(containerId, page);
          })();
        };
      }
      return delegated(target, prop);
    },
  });
}

function wrapItem(containerId: string, item: object): object {
  return new Proxy(item, {
    get(target, prop) {
      if (prop === 'read') {
        const fn = Reflect.get(target, prop, target) as (...a: unknown[]) => Promise<unknown>;
        return async (...args: unknown[]) =>
          migrateItemResponse(containerId, await fn.apply(target, args));
      }
      return delegated(target, prop);
    },
  });
}

/**
 * Wrap an SDK Container so its central read paths apply `migrateOnRead` at doc
 * materialization: `items.query()` / `items.readAll()` (fetchAll, fetchNext,
 * async iteration) and `item(id, pk).read()`. Write paths (create/upsert/
 * replace/patch/delete/batch) and container-metadata ops (read/readOffer/
 * replace) pass through untouched. The registry is consulted lazily at each
 * read, so registration order relative to `ensure()` never matters — and with
 * no migrator registered the wrapper is behaviorally inert.
 */
export function withMigrations(container: Container, containerId: string): Container {
  return new Proxy(container as unknown as object, {
    get(target, prop) {
      if (prop === 'items') {
        const items = Reflect.get(target, prop, target) as object;
        return new Proxy(items, {
          get(iTarget, iProp) {
            if (iProp === 'query' || iProp === 'readAll') {
              const fn = Reflect.get(iTarget, iProp, iTarget) as (...a: unknown[]) => object;
              return (...args: unknown[]) =>
                wrapQueryIterator(containerId, fn.apply(iTarget, args));
            }
            return delegated(iTarget, iProp);
          },
        });
      }
      if (prop === 'item') {
        const fn = Reflect.get(target, prop, target) as (...a: unknown[]) => object;
        return (...args: unknown[]) => wrapItem(containerId, fn.apply(target, args));
      }
      return delegated(target, prop);
    },
  }) as unknown as Container;
}
