# console-metadata-cosmos — deploy-readiness parity

**Domain:** the Console's own metadata store (the serverless `loom` Cosmos
database the BFF reads/writes: items, workspaces, configs, copilot sessions,
tenant-topology, …). Part of the day-one deploy-readiness PRP
(`docs/fiab/prp/deploy-readiness-100pct.md`, gap #5).

## What broke live
The `loom` Cosmos database used a **shared-throughput (provisioned/autoscale)**
database, which Azure caps at **25 containers**. The Console lazily
`createIfNotExists()`'s well over 25 (9 ARM-provisioned admin containers + the
BFF's `tenant-settings`, `connections`, `copilot-*`, `saved-queries`, … via
`cosmos-client.ts ensure()`). Result: live `workspaces`/`domains` 500s —
`collection count exceeded 25`.

## Fix — Serverless capacity mode (ON by default, opt-out)
| Topology | Account that hosts `loom` | Change |
|---|---|---|
| tenant / dlz-attach | hub `loom-console-cosmos.bicep` | `capacityMode: 'Serverless'`; removed database `autoscaleSettings` |
| single-sub | DLZ `landing-zone/cosmos.bicep` | same: `capacityMode: 'Serverless'`; removed autoscale on `loom` **and** the per-workload `dbs`; dropped the now-incompatible `zoneRedundant` param (serverless mandates single-zone) |

Serverless removes the 25-container cap and the per-DB/per-container throughput
requirement (consumption-billed). It requires a single write region, no zone
redundancy, no automatic failover — all already satisfied by both modules.

## Opt-out flag (default true)
`main.bicep` → `param loomConsoleCosmosEnabled bool = true`, threaded into the
hub derivation: `deployConsoleCosmos = loomConsoleCosmosEnabled && !useSingleDlz
&& empty(existingCosmosAccount)`. Disabling is only honest alongside a BYO
`existingCosmosAccount` (the `empty()` guard enforces it) — the Console cannot
run without a metadata store. `params/tenant-dmlz.bicepparam` sets it `= true`
explicitly for deploy-by-default.

## Wiring preserved (no change)
Env (`LOOM_COSMOS_ACCOUNT/ENDPOINT/DATABASE=loom`), control-plane grant
(DocumentDB Account Contributor `5bd9cd88-fe45-4216-938b-f97437e15450`),
data-plane grant (Cosmos DB Built-in Data Contributor
`00000000-0000-0000-0000-000000000002`), private endpoint + `privatelink.documents.*`
DNS, and diagnostics are unchanged — already ON by default.

## Scan-and-choose
- **CLI:** `scripts/csa-loom/scan-and-deploy.sh` → `choose_console_cosmos`
  scans all subs for existing Cosmos accounts and prompts
  use-existing / provision-new / disable (recommendation = **provision-new
  serverless**). `--defaults` = provision-new. Emits `loomConsoleCosmosEnabled`
  / `existingCosmos*` bicepparam lines (no free-form).
- **Wizard:** `GET /api/setup/scan-cosmos` returns the same real existing-account
  list + choice model + recommendation; `POST /api/setup/deploy` accepts
  `loomConsoleCosmosEnabled` + `existingCosmosAccount/Rg/Sub` and forwards them
  into the copy-paste `az deployment sub create` command (default = nothing
  extra → provision-new serverless). The route rejects disable-without-existing
  (no-vaporware).

## bicep ↔ bootstrap sync
**No bootstrap change needed.** The post-deploy bootstrap
(`csa-loom-post-deploy-bootstrap.yml` / `scripts/csa-loom/*`) does **not** seed
this Cosmos — container creation is owned by bicep (the 9 admin containers) plus
the BFF's idempotent `cosmos-client.ts ensure()` (the lazily-created rest). The
only DocumentDB reference in the bootstrap is the unrelated audit-activity
reader. Serverless changes capacity mode only; container names/partition keys
are unchanged, so `ensure()` remains the hotfix fallback.

## Verify (per merge)
- `az bicep build` on both cosmos modules: clean (EXIT 0, zero warnings).
- Full `main.bicep` build: identical error set to origin/main (the pre-existing
  258-param `max-params` on `admin-plane/main.bicep` is unrelated to this domain;
  this PR adds **zero** new bicep errors — only line-number shifts).
- `tsc --noEmit`: the two touched routes are clean.
- Acceptance: a `tenant` deploy with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset brings
  the Console up with a serverless `loom` Cosmos; `/workspaces` + `/domains`
  load (no 25-container 500). Azure-native by default (no Fabric dependency).
