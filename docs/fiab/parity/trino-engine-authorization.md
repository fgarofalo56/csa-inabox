# trino-engine-authorization — parity with Databricks Unity Catalog external-engine governance (LU-7 / LU-11 / LU-12)

Source UI / spec:
- Trino **file-based system access control** — <https://trino.io/docs/current/security/file-system-access-control.html>
- Trino **Open Policy Agent access control** — <https://trino.io/docs/current/security/opa-access-control.html>
- Databricks **Lakehouse Federation / foreign catalogs** — <https://learn.microsoft.com/azure/databricks/query-federation/>
- Databricks **row filters & column masks** — <https://learn.microsoft.com/azure/databricks/tables/row-and-column-filters>

Azure-native default: **Loom Unity (OSS UC) + Iceberg REST Catalog + Trino**, all
self-hosted in the deployment's own VNet. **No Databricks and no Fabric on any
path** (`no-fabric-dependency.md`). This matters more than usual here: **Unity
Catalog is not available in Azure Government**, so for a sovereign customer this
stack is not a parity checkbox — it *is* the catalog and federation story
(`cloud-parity.md`).

---

## 1. Feature inventory → Loom coverage

| Databricks UC / engine-governance capability | Loom coverage | Backend |
|---|---|---|
| Governance policy authored once, applied to many engines | ✅ one `PolicyCodeSet` compiles to **6** backends in one pass (synapse, unity-catalog, adx, **trino**, purview, api-scope) | `lib/governance/policy-code/compile.ts` |
| Table `GRANT` at the engine | ✅ `privileges: [SELECT \| INSERT,DELETE,UPDATE \| …OWNERSHIP,GRANT_SELECT]` per principal | `compilers/trino.ts` → Trino `tables` rule |
| Explicit `DENY` that beats a grant | ✅ zero-privilege rule emitted FIRST (first-match-wins) | `compilers/trino.ts` |
| **Row filter** (RLS) at the engine | ✅ DAX row filter → Trino predicate on the rule's `filter` field; `USERPRINCIPALNAME()` → `current_user` | `daxFilterToTrinoSql` |
| **Column mask** (CLS) at the engine | ✅ `columns[].mask = NULL` — same semantics as the Synapse compiler's `DENY SELECT ON tbl(col)` | `compilers/trino.ts` |
| Per-caller (not per-service) enforcement | ✅ compiled `impersonation` rule + the BFF presenting the signed-in UPN as `X-Trino-User` | `buildTrinoRulesDocument`, `trino-client.ts` |
| Group-based rules | ✅ `group`-keyed rules + a Trino **file group provider** rendered from resolved Entra membership | `buildTrinoGroupFile`, `resolveTrinoGroupMemberships` |
| OPA policy engine option | ✅ equivalent `package trino` rego with `allow` / `rowFilters` / `columnMask` | `buildTrinoRego` |
| Policy change takes effect without redeploy | ✅ engine PULLS on `security.refresh-period`; entrypoint refresh loop re-fetches | `docker-entrypoint.sh`, engine-rules route |
| Drift detection / reconcile | ✅ publish + diff; **"applied" is gated on an engine FETCH receipt**, not on the write | `reconcileTrino`, `trinoEnforcementStatus` |
| Foreign catalog inventory | ✅ read live from `system.metadata.catalogs` (never from the config bag) | `GET /api/catalog/unity/foreign-catalogs` |
| Foreign catalog UI surface | ✅ **Federation** tab on `/catalog/unity` (live catalogs + registered sources) | `FederationPane` |
| Register an external source (Postgres/MySQL/SQL Server/Kafka/Mongo) | ✅ declarative `loomBackends.trinoCatalogs` + `trinoCatalogSecrets`, with the connector properties rendered from the connection's real coordinates | `trino-catalogs.ts`, `admin-plane/main.bicep` |
| Foreign-catalog credentials never in the template | ✅ Key Vault secretRef only; the renderer emits the KV reference, never a password | `renderCatalogProperties` (asserted by test) |
| Register-through to Purview | ✅ pre-existing for Loom Connections | `connections-store.registerConnectionInPurview` |
| Per-caller catalog authorization at the BFF | ✅ pre-existing deny-by-default | `trino-authz.ts` (#2678) |
| Metric views (semantic tier) | ✅ typed spec → runnable `GROUP BY` on Synapse + DAX + YAML + `CREATE VIEW` DDL; Databricks UC metric view is the opt-in alternative | `lib/sql/metric-view-builders.ts`, `/api/semantic-model/metric-view` |
| NL2SQL over metric views (Genie parity) | ✅ `metric-view` source kind executes real read-only SQL with the metric definitions as grounding | `data-agent-execute.ts`, `metricViewGroundingText` |
| **Vector index as a governed securable** | ✅ LU-12 — `vector-index` overlay securable with a three-part canonical name that joins the lineage graph | `uc-overlay/model.ts` `vectorIndexFullName` |
| **Metric view as a governed securable** | ✅ LU-12 — `metric-view` overlay securable | `uc-overlay/model.ts` `metricViewFullName` |
| Registering a foreign catalog from the UI in one click | ⚠️ **honest gate** — the tab renders the exact IaC value and marks the source Available; committing it is a deploy, by design (see §3) | `renderCatalogProperties` |
| Per-caller enforcement at the engine before the first fetch | ⚠️ **honest, self-healing** — the BFF retries once as the mapped session user and logs that engine-level per-caller policy is not in force for that query | `trino-client.ts` `isImpersonationDenial` |

**Real ❌ count: 0.**
**⚠️ honest-gate count: 2** (both documented above with the reason and the code path).

---

## 2. What was actually missing before this change (the premise, verified)

Grepped on `origin/main` at `fd847154`:

- `grep -rin "rego\|open policy agent"` over `apps/` + `platform/` → **one** hit,
  in an unrelated multi-cloud doc. No OPA anywhere, no Trino policy compiler.
- `POLICY_BACKENDS` was `synapse | unity-catalog | adx | purview | api-scope` —
  no `trino`, and `validatePolicyCodeSet` actively **warned** that a row filter
  targeting Trino "will be ignored".
- `grep -rn "SHOW CATALOGS\|system.metadata.catalogs"` → no Trino catalog listing
  anywhere in the product; no `/catalog/unity` Federation tab.
- `UC_SECURABLE_TYPES` had no `vector-index`, so the governance route **rejected**
  any attempt to tag or certify an AI Search index (`securableType must be one of …`).

Genuinely **STALE** (already shipped, not rebuilt):

- The `LOOM_TRINO_CATALOG_<NAME>` env→catalog rendering and the
  `loomBackends.trinoCatalogs` / `trinoCatalogSecrets` IaC path
  (`docker-entrypoint.sh`, `admin-plane/main.bicep:815`).
- The BFF per-catalog grant table (`trino-authz.ts`, #2678).
- The metric-view compile/run/DAX/YAML/DDL core and its builder UI
  (`metric-view-builders.ts`, `semantic-model-editor.tsx:2122`).
- NL2SQL over metric views (`data-agent-execute.ts` `metric-view` case).
- Purview register-through for connections (`connections-store.ts:191`).

---

## 3. Design decisions worth challenging

**Why the engine PULLS instead of the Console pushing.** The Console cannot
write into the engine container's filesystem, and an OPA server would be a
second thing to deploy, secure and keep alive. Trino already solves this:
`security.config-file` accepts an HTTP URL and `security.refresh-period` re-reads
it. The fetch is performed by the **entrypoint** rather than by Trino itself for
one reason — Trino issues a plain GET with no way to attach a credential, and
this document names group ids, table names and row predicates. The entrypoint
fetches with the token in a header (never in the URL: Trino logs the configured
URI on failure) and writes the local file Trino then re-reads.

**Why "published" is not "enforced".** Persisting a rules document is a write.
The reconcile receipt reports `drift` with the honest reason until the engine has
actually fetched the published version, and only a confirmed fetch reports
converged (`deploy-integrity.md` R2 applied to a control plane).

**Why a global allow tail.** Trino denies a table no rule matches. Without a
tail, adding one governed table would deny every other table in the estate — a
self-inflicted outage, not security. Governed tables get a per-table catch-all
deny; ungoverned tables keep their pre-policy behaviour, with the catalog rules
still the outer floor. Asserted by test.

**Why registration is IaC, not a UI button.** `auto-bind-by-default` requires the
platform to do the binding — and it does: the catalog is rendered by the deploy
from `loomBackends.trinoCatalogs`, with the password on a Key Vault secretRef.
Making the button mutate the running container with `az containerapp update`
would produce exactly the drift the bicep header warns about (the next deploy
silently reverts it). The tab therefore renders the exact value to commit.

---

## 4. Per-cloud status

| | Commercial | Gov (GCC / GCC-High / IL5) |
|---|---|---|
| Bicep emits `LOOM_TRINO_POLICY_URL` + the dedicated pull secret | ✅ same `admin-plane/main.bicep` path | ✅ same path — Gov params set `containerPlatform='containerApps'` + `deployAppsEnabled=true`, so `trinoEngineActive` is true |
| Compiler / route / UI | ✅ cloud-agnostic (no cloud-specific host on any path) | ✅ same code |
| Entrypoint fetch + refresh loop | ⚠️ needs a **loom-trino image rebuild** to ship | ⚠️ same, and Gov image production is the known gap (`gov-build-images`, `gov-provision-trino.yml` have never run) |
| Live verification | **OWED** | **OWED** — Gov is Actions-only, never local `az` |

Nothing here is Commercial-only by design. The Gov lag is **image production**,
not design, and is tracked by the G2 lane (four never-run Gov workflows, plus
`gov-provision-trino.yml`).

**Gov Loom Unity durability caveat, stated because it changes what a reader
should expect:** Gov `loom-unity` currently runs on `h2-ephemeral` — no Postgres
is provisioned in that boundary — so its catalog metadata does not survive a
restart. The Trino engine rules published by this change live in **Cosmos**, not
in the Unity metastore, so they are durable in Gov regardless; but any Gov
catalog/schema/table those rules *reference* is only as durable as that store
until the LU-1 Postgres cutover lands there.

---

## 5. Verification

- `tsc -p tsconfig.build.json --noEmit` — clean.
- `vitest` — 70 new/affected tests green (34 compiler, 16 foreign-catalog, 6
  LU-12 securable, plus the existing policy-code + overlay suites).
- `az bicep build` (pinned 0.45.15) + `check-deploy-template-sync` — PASS,
  byte-identical.
- **OWED — live browser E2E (G1).** `loom-ui-verify` has been red since
  2026-08-04 (C13 lane repairing). The command that resolves it:
  `gh workflow run loom-ui-verify.yml --ref main -f target_route=/catalog/unity`
- **OWED — live Trino receipt.** Requires the loom-trino image rebuild
  (entrypoint change) plus a roll; until then the engine runs its start-up
  catalog floor and the BFF continues to enforce per-caller catalog
  authorization exactly as before. **Merged is not deployed.**
