# L1 — Security & AuthZ

**Parent:** [`PRP.md`](./PRP.md) (OMNIBUS master, 2026-08-22) · **Wave:** 0 · **BLOCKING — Wave 1 does not start until this lane is green**
**Rigor:** FULL mutation-proof (auth + data)
**Suggested concurrency:** up to **3** agents in this lane simultaneously.
**Inventory:** **48 open issues** (15 bugs, 0 epics, 7 labelled security).

## 1. Thesis

Highest blast radius in the program. Every item here is assumed exploitable until a mutation proves otherwise.

## 2. Declared file ownership — this is what makes the fan-out safe

Parallel safety in this repo is a FILE property, not a topic property. An agent in this
lane may edit ONLY these paths:

- `apps/fiab-console/lib/auth/**`
- `apps/fiab-console/lib/api/route-toolkit.ts`
- `apps/fiab-console/lib/azure/workspace-roles-client.ts`
- `scripts/ci/check-tid-boundary-chokepoint.mjs`
- `scripts/ci/check-owner-only-workspace-guard.mjs`
- `scripts/ci/check-tenant-singleton-scope.mjs`
- `scripts/ci/_route-auth-scope.mjs`
- `an EXPLICIT, ledger-declared list of app/api/**/route.ts files (see §4)`

It must NOT touch (another lane owns them, and a shared-file edit must be sequenced,
never parallelised):

- `apps/fiab-console/app/api/** except its declared list (L4 owns the rest)`
- `platform/fiab/bicep/** (L0)`

If an item genuinely needs a file this lane does not own, it does **not** take the file.
It stops and routes through the master's §6 cross-lane procedure.

## 3. Gates — the bar for "done" in this lane

- `pnpm vitest run <the suites covering the changed guard>`
- `the guard's own mutation test: break the fix, prove the guard goes RED`
- `temp/safety-grep.py on every published artifact (public repo)`

`make validate` remains the whole-repo bar. A narrow gate passing is not `make validate`
passing, and neither is a merge: **done means DEPLOYED and verified live.**

## 4. Landmines — read before writing any code here

These are measured, not theoretical. Each one has already cost this repo real time.

- MUTATE THE GUARD, NOT THE CODE. Seven prior gate-fix PRs shipped defeatable guards; none passed first review.
- The NARROW bypass is the evasion that works: scope a mutation to one itemType/cursor/page and it passes RC=0 plus a 259-test suite. Invent a mutation the author did NOT try.
- A guard with zero population proves nothing — check the POPULATION, not the verdict.
- The admin bypass is a FAMILY with two greppable shapes: `isTenantAdmin(session)) return null` and unfiltered `loadWorkspaceAdmin`. Grep BOTH before any authz fix.
- A COUNT is an ORACLE when the caller picks the scope — 404-not-403 before the query.
- This lane's 48 items include security-ADJACENT matches (token/redact/oid keywords). Triage into true-security vs adjacent in the first sprint; adjacent items may drop to normal rigor with that decision recorded.

## 5. Fan-out plan

1. **Triage pass first (1 agent, sp:1).** Walk the inventory in §7 and split it into
   `real` / `stale` / `duplicate` / `already-fixed`. Verify "already-fixed" by measurement
   — several issues in this repo claim a current failure that is no longer true, and
   several claim a fix that never deployed. Record the verdict as an issue comment.
2. **Batch the survivors by shared file.** Two items touching the same file become ONE
   work item, or they run sequentially. This is the step that prevents the merge
   treadmill, and it is where most of the wall-clock is won or lost.
3. **Fan out to 3 concurrent agents**, each in its own worktree, each owning a
   disjoint file set from step 2.
4. **Serialize the merges.** Branch protection is `strict`, so every merge invalidates
   the branches behind it. Merge one, re-verify, merge the next. Prefer batching several
   fixes per PR over one PR per issue: with strict protection, N PRs cost N CI cycles.

## 6. Definition of done for this lane

- Every §7 issue is closed, or re-scoped with its reason recorded, or explicitly deferred
  by the operator.
- Every closure is on DEPLOYED-and-verified evidence, never on a merge.
- No guard introduced by this lane passes when its subject is mutated.
- The lane's own landmine list in §4 has been extended with anything new it learned.

## 7. Issue inventory (48)

| # | title | labels |
|---|---|---|
| #3877 | check-tid-boundary-chokepoint: section 10's stale-pin arm blesses four states it cannot verify |  |
| #3876 | ci: the publication-surface checker has 4 measured enumerator bypasses (follow-up to #3835) |  |
| #3861 | converge-role-assignment: per-site redaction, and a raw e.message reaching the public run log via an inherited | security |
| #3855 | security-roles route: tenant admin bypasses the boundary before any read, over caller-supplied itemId | security |
| #3850 | #3830 residuals: NON_AUTHORIZERS entries are not content-pinned, plus five smaller findings from the round-5 r |  |
| #3849 | redaction: an undisclosed stdout carve-out in deploy-retry.mjs, unpinned in both directions, plus one untested |  |
| #3845 | cli-session service-principal flow mints sessions with no tid — the absent-tid state has a live generator, so  |  |
| #3843 | items/by-type re-derives the workspace tenant boundary in the pre-#3824 shape — a tid-less session enumerates  |  |
| #3840 | auth: resolveWorkspaceRole is a fourth independent copy of the workspace tenant decision | security |
| #3834 | SECURITY: graphUserInGroup reads any 2xx as membership — fail-OPEN in 2 of 9 measured Graph failure modes |  |
| #3833 | SECURITY: the tenant-admin bypass is a PATTERN with 3 more members — bulk-delete ends in a cascade delete |  |
| #3829 | deploy-retry: decision.reason bypasses redact(), so the auto-issue-poster published a raw Entra object id to a | bug,deploy-validation |
| #3826 | SECURITY: three more admin paths carry the same tid fall-through — one is a write-side escalation around the # | bug |
| #3818 | placeholder-oid: 4 sites the #3805 review found, and no ratchet closing the class | bug |
| #3794 | Tenant-settings singleton is written under the caller oid and read under tenantScopeId — the chargeback-taggin | bug,csa-loom,lane:console,sprint:next |
| #3777 | Model gateway: per-cloud model registry + capability routing + central cost/safety enforcement (Foundation Mod | csa-feature-request,csa-loom,enhancement,lane:dataplane,spri |
| #3776 | Governed workspace secrets: Key Vault-backed secret scopes with runtime resolution + audit (UC Secrets parity) | csa-feature-request,csa-loom,enhancement,lane:console,sprint |
| #3757 | Workspace Settings → Encryption tab leaks a raw Azure ARM 404 instead of an honest gate | bug,csa-loom,lane:console,sprint:next |
| #3755 | data-pipeline-editor's own Run / Debug / Schedule bypass the #3549 empty-pipeline gate (templated + fabric run | lane:console,sprint:next |
| #3751 | Permissions to Workspace access: any workspace not created by the current admin 404s 'workspace not found' (re | bug,csa-loom,lane:console,sprint:next |
| #3750 | Unity Catalog audit rows write operation, not kind — Security to Audit's Kind column and Event-kind filter are | bug,csa-loom,lane:console,sprint:next |
| #3747 | Domains page: 'Federated data-mesh' and the domain List disagree on workspace counts (109 vs 0) — mesh route s | bug,csa-loom,lane:console,sprint:next |
| #3741 | MCP Servers: Microsoft Foundry card shows a 'Connected' badge while its own body says 'Sign-in required' (no t | bug,csa-loom,lane:console,sprint:next |
| #3740 | Copilot usage 'Daily token trend' sparkline renders as one misleading full-width/full-height block on sparse d | bug,csa-loom,lane:console,sprint:next |
| #3717 | security: SIX credential-bearing urlopen sites follow cross-origin redirects with Authorization attached (defa | lane:dataplane,sprint:active |
| #3706 | security(latent): loadRecycledItem (item-crud.ts:637) is a #2941-shaped owner-only point read — migrating it w | lane:console,security,sprint:next |
| #3676 | P0: the scheduled deploy silently REVERTS rolled images — PR #3665's security fix was live 9 minutes then undo | bug,csa-loom,deploy-validation,lane:ci,sprint:active |
| #3637 | There is no rotate-after-compromise path: the MSAL provisioner's REUSE gate keeps serving a disclosed credenti | lane:console,sprint:active |
| #3611 | P1: any authenticated user can make the Console soft-delete loom-msal-client-secret from the main vault — the  | lane:console,sprint:active |
| #3608 | lz-rbac.ts carries a wrong Contributor role GUID — ARM would reject every landing-zone Contributor grant | lane:bicep,sprint:active |
| #3588 | Is the git-integration SPN auth path functional? spnTenantId/spnClientId are persisted and read by nothing | bug,lane:console,sprint:next |
| #3580 | The ports route's allowlist reason says 'contract summaries'; it returns every port REF — a 26th instance of G | lane:console,security,sprint:active |
| #3547 | Raw HTML 504 error page leaks into item-creation dialog — workspaces.ts has its own non-compliant fetchJson | lane:console,sprint:next |
| #3540 | Databricks Unity Catalog credential dialog requires typing Access Connector ARM id + managed identity id by ha | bug,csa-loom,lane:console,sprint:next |
| #3531 | security: starlette <0.42 cap excludes ALL five fixes — accepted exception pending a fastapi>=0.139 migration | lane:ci,security,sprint:blocked |
| #3525 | kql-database provisioner's 5 identical AllDatabasesAdmin remediation gates may be one systemic RBAC gap, not f | csa-loom,lane:dataplane,sprint:next |
| #3512 | mirrored-database run-auth gate mixes a self-grantable Loom-side RBAC gap with a genuine customer-side gap — s | bug,csa-loom,lane:dataplane,sprint:next |
| #3501 | security: updateOwnedItem mirrors the search doc under the CALLER's tenant, so attribution follows whoever las | lane:console,security,sprint:active |
| #3463 | grant-navigator-rbac.sh: the shared probe helper was adopted at 2 call sites and grant() still does the old un | lane:ci,sprint:next |
| #3457 | security: Dependabot #94 — Apache Thrift excessive memory allocation; establish reachability before acting | lane:ci,sprint:next |
| #3430 | cloud-parity: the Gov console has NEVER held an internal token — loom-internal-token-drift's Gov job is 24/24  | lane:bicep,sprint:active |
| #3429 | P0: deploy-copilot-function has failed 7 straight runs since 2026-07-02 — a security fix + an identifier scrub | lane:ci,sprint:active |
| #3354 | Purview DSPM / data-security-posture deepening | csa-feature-request,csa-loom,lane:dataplane,sprint:next |
| #3335 | MSAL secret sprawl: bootstrap appends a 2-year secret on EVERY run and nothing prunes | csa-bug,csa-loom,lane:bicep,sprint:next |
| #3110 | F1 federation residue: amnesiac Iceberg catalog, 30s cold-start 504s, Trino file-ACL, zero credential vending, | lane:bicep,sprint:next |
| #3056 | internal-token rotation strands stale copies (jobs + Actions secret) and detonates on replica restart - broke  | lane:ci,sprint:next |
| #2678 | svc-loom-trino: default-ON Federated SQL engine + a working Entra posture (split out of #2641) | lane:dataplane,sprint:next |
| #2622 | LU-3 follow-up: audit the un-audited Unity Catalog exits (shortcut-credentials, SQL DDL, account-plane) | lane:dataplane,sprint:next |

