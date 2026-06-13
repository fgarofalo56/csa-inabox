# Audit Wave 13b — deployment-unblock + topology enhancements (off settled main)

**Context:** Wave-13 core topology MERGED (t156 topology modes, t157 dlz-attach flow, t158
domain registry, t159 domain-aware routing, t160 RBAC tiers, t162 migration scripts/params,
t163 docs/diagrams). Three enhancement PRs (#1328/#1329/#1330) were closed because they were
built off a pre-topology base and conflicted on main.bicep. A real ARM-limit blocker was also
found. This wave rebuilds those three CLEAN off current main + fixes the blocker. **Every task
must `az bicep build --file platform/fiab/bicep/main.bicep` to GREEN before opening its PR** —
CI does not bicep-build (it builds the Next.js console), so bicep breaks are invisible to it.

## audit-t166 — P0 BLOCKER: admin-plane param count under ARM's 256 limit
`platform/fiab/bicep/modules/admin-plane/main.bicep` has **263 `param` declarations**; ARM's
hard limit is **256** — so `az deployment sub create` of main.bicep FAILS today (max-params
linter + ARM reality). This blocks the entire multi-sub rebuild.
**Fix:** bundle the cohesive `loom*Backend` selector cluster (~13 params: loomEventBackend,
loomActivatorBackend, loomDashboardBackend, loomMirrorBackend, loomLakehouseBackend,
loomCatalogBackend, loomBiBackend, loomDomainsBackend, loomDataflowBackend,
loomDataproductsBackend, loomActivatorDefaultTable, copyJobControlEnabled, …) into ONE
`param loomBackends object = { event: 'eventhubs', activator: 'azure-monitor', dashboard:
'adx', mirror: 'adf-cdc', lakehouse: 'adls', catalog: 'azure', bi: '', domains: 'cosmos',
dataflow: 'adf', dataproducts: '', … }` with a documented shape. Update EVERY internal
reference (`loomEventBackend` → `loomBackends.event`, etc. — grep to find all) AND the call
site in root `main.bicep` (the `module adminPlane` params block) AND any bicepparam files that
set them. Target ≤ ~248 params for headroom. Keep the AAS param cluster as a second bundle
(`loomAasConfig object`) if more headroom is needed.
**Verify:** `grep -cE '^param ' admin-plane/main.bicep` ≤ 250 AND `az bicep build` GREEN AND
no behavior change (same effective backend defaults). Add a CI guard: fail if any
`modules/**/main.bicep` exceeds 250 params (cheap grep step in fiab-console-ci or a bicep-lint
job) so this never recurs.

## audit-t167 — per-domain chargeback (re-do of closed #1328, off settled main)
Re-implement D4: dlz-attach stamps `loom-domain:<name>` + costCenter tags on every DLZ
resource (extend complianceTags); /admin/usage + domain detail show per-domain AND per-sub
cost rollup (Cost Management query by tag/sub) + export + per-domain budget+alert
(budgets.bicep wired into dlz-attach). Build on the MERGED domain registry (t158) + RBAC
tiers (t160). Honest gate if Cost Management API unavailable. bicep-build green.

## audit-t168 — adopt-existing discovery (re-do of closed #1329, off settled main)
Re-implement D6: Setup Wizard discovery step — ARG-scan target subs for existing instances
of each required shared service (Purview, LAW, Key Vault, AOAI, PBI gateway, …); offer
"use existing <resource>" vs "deploy new" per service; selections flow to bicep existing-
resource params (generalize the loomPurviewAccount pattern). Per-service compatibility checks
(region/SKU/permissions). bicep-build green.

## audit-t169 — RG layout / CAF naming (re-do of closed #1330, off settled main)
Re-implement D7: split the admin mega-RG into function RGs (rg-loom-console / -network /
-shared-data / -governance / -observability / -ai) + per-DLZ tiers (-core / -compute /
-storage / -streaming). CAF naming + tags on every RG. Align module scopes to the new RGs.
**Coordinate with t166** — if both touch main.bicep heavily, t169 rebases onto t166. Update
the migration runbook (topology-migration.md) + reference bicepparams. bicep-build green +
what-if clean on tenant/dlz-attach/single-sub modes.

**Sequencing:** t166 FIRST (everything else rebases onto the param-bundled admin-plane) →
{t167, t168} parallel → t169 last (RG structure). All bicep-build-verified.
**Rules:** no-vaporware, honest gates, bicep+bootstrap+docs sync, all 4 clouds, az-bicep-build
green is the gate (not just tsc).
