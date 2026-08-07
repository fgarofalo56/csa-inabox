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
| Per-caller (not per-service) enforcement | ✅ compiled `impersonation` rule bounded to policy-named users + the BFF presenting the signed-in UPN | `buildImpersonationRules`, `trino-client.ts` |
| Group-based rules | ✅ `group`-keyed rules + a Trino **file group provider** rendered from resolved Entra membership; the provider's liveness is OBSERVED, so a group rule that cannot match is warned about | `buildTrinoGroupFile`, `resolveTrinoGroupMemberships` |
| OPA policy engine option | ✅ equivalent `package trino` rego with `allow` / `rowFilters` / `columnMask`, **plus** the catalog floor and the same bounded `ImpersonateUser` restriction | `buildTrinoRego` |
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

**Why the filter and each mask are SEPARATE compiled ops.** `dedupeOps` is
first-wins. Folding the row filter and the column masks into the grant op — and
keying that op without the statement id — meant two statements over the same
(principal, table, action) collided, and an unconditional grant authored FIRST
silently destroyed the later statement's filter and mask before the document was
ever built. No attacker required; "ordering is the control" was defeated
upstream of ordering. Every sibling compiler (`synapse`, `adx`,
`unity-catalog`) already carried the statement id in its key — Trino was the
outlier. Fixed, with a two-statement regression test in both authoring orders.

**Why the document then MERGES them back.** Trino's `tables` rules are
first-match-wins and ONE rule carries privileges + `filter` + `columns`
together, so a separate filter rule for the same selector would never be
reached. Contributions for the same (principal, table) are merged: privileges
UNION, filters AND, masked columns UNION. The merge is deliberately
**restrictive** — a broader statement elsewhere in the set cannot strip a filter
another statement wrote for that principal.

**Why the version hash excludes `catalogs`.** The publisher (reconcile) has no
engine to ask for a catalog list; the engine always reports one. Hashing the
whole document made the two sides deterministically unequal *forever*: the
status was permanently `stale`, reconcile could never report applied, and the
emitted detail blamed an unreachable Console while the engine was fetching
successfully every refresh interval — a cause the code never established
(`deploy-integrity.md` R7). The hash now covers the policy sections only, so the
version means "this is the policy the engine is enforcing", and a catalog
appearing or disappearing is correctly not a policy change.

**Why "published" is not "enforced".** Persisting a rules document is a write.
The reconcile receipt reports `drift` with the honest reason until the engine
has actually fetched the published version, and only a confirmed fetch reports
converged (`deploy-integrity.md` R2 applied to a control plane).

**Why a global allow tail.** Trino's documented default is that "if no rules are
provided at all, then access is granted", and the pre-LU-7 document had no
`tables` section at all. Without a tail, adding one governed table would deny
every other table in the estate — a self-inflicted outage, not security.
Governed tables get a per-table catch-all deny; ungoverned tables keep their
pre-policy behaviour, with the catalog rules still the outer floor.

**Why registration is IaC, not a UI button.** `auto-bind-by-default` requires the
platform to do the binding — and it does: the catalog is rendered by the deploy
from `loomBackends.trinoCatalogs`, with the password on a Key Vault secretRef.
Making the button mutate the running container with `az containerapp update`
would produce exactly the drift the bicep header warns about (the next deploy
silently reverts it). The tab therefore renders the exact value to commit.

---

## 3a. Impersonation — the threat, and why it is a net REDUCTION

`X-Trino-User` is a caller-asserted header at the protocol level, and this
change is what unlocked it. Stating the analysis rather than the conclusion:

**Through the product it is not caller-asserted.** The BFF builds the header
from `session.claims.upn` (`app/api/sql/trino/route.ts:158,211`), and that claim
comes from an **AES-GCM authenticated-encryption cookie** the server minted at
sign-in (`lib/auth/session.ts:98-115`). A browser can neither forge the cookie
nor set the header — the BFF constructs it server-side. No request field reaches
`actorUpn`.

**The residual is a direct in-VNet caller** that can both reach the coordinator
and mint a bearer for the pinned Trino audience.

**That caller's reach SHRINKS, it does not grow.** Per the Trino docs, "if no
rules are provided at all, then access is granted" — and the pre-LU-7 rendered
document had **no `tables` section whatsoever**. So that same credential already
had unrestricted SELECT on every table in every wired catalog, with no
impersonation needed. After this change the un-impersonated mapped user matches
only the global tail and is **denied every governed table** (asserted by test:
*"an un-impersonated caller matches only the global tail"*).

**And the grant is bounded.** `new_user` is the exact set of user principals the
policy names — never `.*`. When the policy names no user principals, **no
impersonation rule is emitted at all** (asserted by test), which leaves Trino's
default: "if neither impersonation nor principal rules are defined, impersonation
is not allowed."

**Two independent off-switches**, both deploy-produced:
`loomBackends.trinoImpersonation='disabled'` (BFF sends the mapped user) and
`loomBackends.trinoAccessControl='none'`.

**What would strengthen it further** — a delegated (on-behalf-of) token so the
engine verifies the end user itself, rather than trusting a header from a
workload it already trusts. That is a real follow-up, not something this change
claims to have done.

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
- `vitest` — 109 tests green across the Trino surface, including the regressions
  for the two defects an independent security review found:
  - **dedupe destroying a narrower policy** — two statements over the same
    (principal, table, action) in BOTH authoring orders, asserting the filter AND
    the mask survive, that keys are unique, that multiple filters AND, that masks
    union, and that the merge yields ONE reachable rule.
  - **the enforcement receipt welded shut** — the publish-side and fetch-side
    version hashes now agree, so `trinoEnforcementStatus` genuinely reads
    `enforcing`, and its detail no longer asserts an unreachable Console.
  - impersonation bounded to policy-named users, absent entirely when no user
    principal exists, deploy-gated, self-healing, and not retried on a genuine
    data denial.
  - the OPA module carries the catalog floor and the same bounded
    `ImpersonateUser` restriction, or says it does not.
- `az bicep build` (pinned 0.45.15) + `check-deploy-template-sync` — PASS,
  byte-identical.
- All loom-guardrails checks pass locally (`actionlint` binary absent locally;
  this diff touches no workflow files).
- **OWED — live browser E2E (G1).** C13 repaired `loom-ui-verify` (#3076), but
  its OIDC credential is scoped to `refs/heads/main`, so the spec must merge
  before it can run:
  `gh workflow run loom-ui-verify.yml --ref main -f target_route=/catalog/unity`
- **OWED — live Trino receipt.** Requires the loom-trino image rebuild
  (entrypoint change) plus a roll. Until then the engine runs its start-up
  catalog floor and the BFF continues to enforce per-caller catalog
  authorization exactly as before. **Merged is not deployed.**

### What the missing live receipt cost

The review's sharpest point stands: **one live run would have shown permanent
drift.** The version-hash mismatch was not subtle in behaviour — the status
could never read `enforcing` — and no unit test covered the publish/fetch pair
because each side was tested alone. The regression above now closes that by
asserting the two producers agree, which is the property a live run would have
exposed. Absent evidence is not neutral, and it was treated as such.
