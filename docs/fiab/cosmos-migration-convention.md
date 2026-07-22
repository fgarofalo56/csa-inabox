# Cosmos doc-migration convention — `schemaVersion` + lazy on-read upgrade (MIG1)

**Status:** Active convention (PRP `loom-next-level` MIG1, Phase 0).
**Code:** `apps/fiab-console/lib/azure/cosmos-migrations.ts` (registry +
`migrateOnRead` + `withMigrations`), wired into every container that
`apps/fiab-console/lib/azure/cosmos-client.ts` `ensure()` hands out.
**Test:** `apps/fiab-console/lib/azure/__tests__/cosmos-migrations.test.ts`.

## The problem this solves

Loom's Cosmos doc shapes historically evolved by **optional fields + tolerant
readers** — fine for additive changes, but there was no sanctioned way to make
a **breaking** shape change (rename a field, restructure a sub-object, change a
value encoding) without either a stop-the-world rewrite or scattering
`doc.newField ?? legacyFallback(doc)` shims across every reader forever. This
convention gives breaking changes a paved road **before** the first consumer
needs it.

## The convention

### 1. `schemaVersion` field

- Every doc **may** carry a numeric `schemaVersion`.
- **A doc without the field is version 1 by definition.** The entire
  pre-convention corpus is therefore already v1 — no backfill is required to
  adopt the convention.
- A breaking shape change to a container bumps its current version N → N+1.

### 2. Register a migrator (lazy on-read upgrade)

The module that owns the doc shape registers a **pure, synchronous** upgrade
step for each version transition, at module scope:

```ts
import { registerMigrator } from '@/lib/azure/cosmos-migrations';

// v1 → v2: ownerEmail (string) → owner: { email }
registerMigrator('my-container', 1, (doc) => {
  const { ownerEmail, ...rest } = doc as any;
  return { ...rest, owner: { email: ownerEmail }, schemaVersion: 2 };
});
```

Rules for a migrator:

- Upgrades from **exactly** `fromVersion` to `fromVersion + 1` — one step, one
  owner. Chains compose (`v1→v2→v3`) automatically.
- Returns a **new object**; never mutates its input.
- Stamps `schemaVersion: fromVersion + 1` (if it forgets, `migrateOnRead`
  stamps it — the chain must advance or a loop guard throws).
- Must be total over every v‹from› doc that ever existed in the container —
  including docs missing optional fields.

### 3. Readers upgrade lazily — automatically

`cosmos-client.ts` wraps **every** container it hands out with
`withMigrations(container, id)`, which applies `migrateOnRead(containerId, doc)`
at each central materialization point:

- `container.items.query(...)` — `fetchAll()`, `fetchNext()`, async iteration
- `container.items.readAll(...)` — same three
- `container.item(id, pk).read()`

so **all existing call sites get the upgraded shape with zero changes**. Write
paths (`create`/`upsert`/`replace`/`patch`/`batch`) and container-metadata ops
pass through untouched. When no migrator is registered for a container — the
state of every container today — the wrapper is **behaviorally inert**.

Because upgrades are applied on read (not persisted by the read path), a doc is
physically rewritten only when the caller next saves it, or when the optional
backfill sweeps it. Both are safe: `migrateOnRead` is **idempotent** — a doc at
the latest version passes through unchanged.

### 4. Optional backfill script — `scripts/csa-loom/cosmos-backfill-<container>.mjs`

Lazy upgrade means the migrator must live until every old doc has been
rewritten. To retire a migrator, sweep the container at leisure with a backfill
script following the existing precedent
(`scripts/csa-loom/backfill-workspace-tid.mjs`):

- **Dry-run by default; `--apply` to write.** Print per-doc intent.
- Query `SELECT * FROM c WHERE NOT IS_DEFINED(c.schemaVersion) OR c.schemaVersion < <latest>`,
  apply the same migrator chain (import it, or re-state the pure transform),
  and upsert **within the same partition** (partition keys are immutable — a
  migration that must move partitions is a container-copy, see §6).
- **Idempotent:** re-running on migrated docs is a no-op (the WHERE clause
  skips them; and the chain is a fixpoint at the latest version).
- Auth: AAD data-plane (`DefaultAzureCredential`) with Cosmos Built-in Data
  Contributor, `LOOM_COSMOS_ENDPOINT` / `LOOM_COSMOS_DATABASE` env.

After the backfill reports zero remaining sub-latest docs, the migrator for
the retired transition may be deleted in a follow-up PR.

### 5. Rollback

- **Rolling back the app** (shipping a build without the new migrator) is safe
  **iff no writer persisted the vN+1 shape yet** — reads simply see v‹N› docs
  again. Once vN+1 docs exist, the old build must tolerate them; therefore:
  ship the migrator + tolerant writer **one release before** any writer starts
  producing the new shape when a rollback window matters.
- **Rolling back data:** write a **down-migrator as a backfill script**
  (`cosmos-backfill-<container>.mjs --down`) restating the inverse transform —
  down-migrators are NOT registered in the on-read registry (the registry only
  moves forward). Keep the up-migrator's transform lossless (carry unknown
  fields through via `...rest`) so down-migration is possible.
- The read path itself never destroys information: `migrateOnRead` returns a
  new object and never persists, so a buggy migrator is fixed by shipping a
  corrected build — stored docs are untouched until save/backfill.

### 6. What this convention does NOT cover

- **Partition-key changes.** A partition key is immutable per container; that
  migration is a change-feed **container copy** (`items` → `items-v2`), not an
  in-place upgrade. See the coordination note below — the copy's read/write
  bridge still uses `schemaVersion` + this registry for the doc-shape half.
- **Cross-container moves** and TTL/index policy changes (those are container
  ops, handled in `ensure()` / bicep).

## Coordination note — first real consumer

`PRPs/active/enterprise-hardening/appendix-scale-cosmos-data-tier.md` **§4.2
(partition migration + capacity flip)** is the first real consumer of this
convention: the `items` → `items-v2` change-feed copy stamps `tenantId` and
offloads oversized state, and the doc-shape half of that copy (new fields,
`schemaVersion: 2` stamp, lazy read bridge during the dual-read window) MUST go
through this registry (`registerMigrator('items', 1, …)`) rather than ad-hoc
shims, per the loom-next-level master's sibling-PRP decision rules.

## Quick reference

| Task | How |
| --- | --- |
| Breaking shape change | Bump version, `registerMigrator(container, N, fn)` at module scope of the doc-model owner |
| Read old + new docs | Nothing — `withMigrations` upgrades on read everywhere |
| Persist upgrades eagerly | `scripts/csa-loom/cosmos-backfill-<container>.mjs` (dry-run → `--apply`) |
| Retire a migrator | Backfill to zero sub-latest docs, then delete the migrator |
| Roll back | Old builds tolerate vN+1 or run the `--down` backfill; see §5 |

Per-cloud: cloud-invariant (Cosmos data-plane only; no sovereign-endpoint
surface). Cost: $0 — no new Azure resources; lazy reads add a Map lookup.
