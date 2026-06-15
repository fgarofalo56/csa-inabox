# PRP — CSA Loom day-one deploy readiness: push-button, 100% working, scan-and-choose

**Created 2026-06-15. Driver: operator. Status: active program.**

## Vision (verbatim intent)
A **single push-button deploy** produces a CSA Loom where **everything works on first login** — no missing configs, no unconfigured services, no manual troubleshooting. Where a backend choice exists, the deploy **scans every subscription first**, shows what already exists, and **asks the user**: use an existing service, provision a new one, or disable it — **with a recommendation**. Default posture is **everything ON (opt-out)** — the user disables what they don't want; nothing is left unconfigured by default. Customers must never have to figure out missing configs, options, or settings.

## Decisions (operator, 2026-06-15)
1. **UX = BOTH**: a pre-deploy CLI scanner (`scripts/csa-loom/scan-and-deploy.sh`) for first-bootstrap + CI/headless, AND the in-console **Setup Wizard** (`/setup`) for interactive selection/refinement after the console exists.
2. **Default = everything on (opt-out)**: provision the FULL stack new by default, including the expensive infra (Azure Firewall, Purview, dedicated Synapse/Databricks pools, AOAI + GPT model). Each is a disable flag.
3. **Execution = multi-agent workflow** (audit → build → integrate).

## Ground truth — gaps found in the live E2E of the centralus clean deploy (csa-loom.limitlessdata.ai)
The console code is sound (honest gates everywhere, no-vaporware). Every gap is **deploy-time wiring/provisioning** that bicep/bootstrap doesn't set, so a fresh deploy is broken/degraded until manually patched.

### Fixed live this session (MUST be codified so the next deploy is correct)
1. Console **crash-loop** → Envoy "Connection refused": probe `timeoutSeconds=1` too aggressive + `@azure/monitor-opentelemetry` SIGSEGV + 1Gi too small. (GH #1382)
2. **Login 500**: MSAL confidential client had no credential (`LOOM_MSAL_CLIENT_ID`/`LOOM_MSAL_CLIENT_SECRET` unset; fell back to the UAMI which can't do user login). (GH #1383)
3. **Signed-out after Entra login**: `SESSION_SECRET` unset → session cookie can't be encrypted. (GH #1383)
4. **All admin pages 403**: no bootstrap admin — `LOOM_TENANT_ADMIN_OID`/`loomTenantAdminGroupId` empty. Must be a required deploy input wired to the console env.
5. **Workspaces/domains 500** "collection count exceeded 25": the console `loom` Cosmos used a **shared-throughput database** (25-container cap); the console needs >25. Must be **serverless** (`capacityMode: 'Serverless'`).

### Honest-gated today → must be provisioned + wired ON by default (opt-out)
6. **AOAI + GPT model**: `/api/copilot/status` → "No AOAI deployment on Foundry hub. Deploy a gpt-4o-class model first." Copilot, data-agents, AI functions gated. → deploy a gpt-4o/gpt-4.1 model deployment; wire it.
7. **org-visuals storage** (`LOOM_ORG_VISUALS_URL`): embed-codes + org-visuals 503. → blob container + UAMI grant + env.
8. **Purview** (`LOOM_PURVIEW_ACCOUNT`): governance catalog azure-native fallback. → cross-region Purview (#229) when region lacks it.
9. **Maps**, **Fabric capacities** (honest free-text fallback), and any other `*_not_configured` / `missingEnvVar` gate surfaced per page.

## Deliverables (the program)
### A. Provisioning completeness (bicep + bootstrap) — opt-out
Every Azure backend Loom can use is provisioned new + wired (env + RBAC + private endpoint + DNS) **by default**, each behind a `loom<Service>Enabled` flag (default true). Covers: serverless console Cosmos; MSAL app-registration (Graph) + client secret in KV; stable `SESSION_SECRET` in KV; `LOOM_TENANT_ADMIN_OID`/group as a required input; AOAI account + gpt-4o deployment; org-visuals blob; Purview; Maps; APIM; AI Search; Synapse; Databricks; Event Hubs; ADX; PostgreSQL/Weave; everything the per-page audit surfaces. Right-size console (cpu/mem) + relax probes (#1382).

### B. Scan-and-choose
- `scripts/csa-loom/scan-and-deploy.sh`: enumerate subscriptions → for each Loom-integrable service, find existing instances (az graph) → prompt **use-existing / provision-new / disable** with a **recommendation** → emit the `.bicepparam` (existing IDs as `existing*` params, or `loom<Svc>Enabled=true` to provision) → run `az deployment sub create`. Non-interactive `--defaults` flag = everything new.
- **Setup Wizard** (`app/setup` + `app/api/setup/*`): the same scan + per-service choice UI, post-bootstrap, writing the chosen wiring (env updates / follow-on deploy) — with recommendations and existing-resource discovery.

### C. Per-page / per-tab config audit (feeds A)
Walk EVERY nav page + every tab + every editor; for each, enumerate the backends it needs and whether the default deploy provisions+wires them; record every `not_configured` / 403 / missing-env / un-granted-RBAC gate. Output a complete gap list → each becomes a provisioning task in A.

## Acceptance
A clean `scan-and-deploy.sh --defaults` (or the wizard with all-new) on an empty subscription set yields a console where **every nav page + every editor's primary action works against a real provisioned backend on first login**, zero `not_configured` gates unless the user explicitly disabled that service. Per `no-vaporware.md` + `no-fabric-dependency.md` (Azure-native default).

## Workflow
Audit (parallel: each agent owns a page-group or an Azure backend, grounded in this PRP + the live console + bicep/bootstrap/setup code) → Build (each gap → bicep/bootstrap/wizard implementation + opt-out flag + scan-and-choose option, PR, DO-NOT-MERGE) → Integrate (batched next build + admin-merge) → re-verify E2E.
