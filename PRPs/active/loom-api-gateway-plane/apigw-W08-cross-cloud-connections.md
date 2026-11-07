---
name: apigw-W08-cross-cloud-connections
status: backlog
priority: P1
order: 29
depends_on: [apigw-W02-publishing-plan-apply]
review: required
orchestrator_model: sonnet
implementer_model: sonnet
created: 2026-10-28
---
# W8 — Cross-cloud connections (opt-in): manage Government gateways from a Commercial Loom

**Goal**: with `LOOM_APIPLANE_CROSS_CLOUD=true` and an isolated management
vault, a Commercial Loom registers Government gateways and endpoints through a
Government-tenant service principal, publishes with key-only runtime access,
meters and prices by the served cloud, and discloses the data boundary.
Sovereign-native remains the default and needs nothing from this wave.
ADR-009. `review: required` (credential handling).

## Items

| ID | Title | Owns | Depends on | Model | Review | Verify |
|---|---|---|---|---|---|---|
| W8-1 | Infra: `apiplane-mgmt-vault.bicep` (own deploy unit; RBAC vault; soft delete; purge protection; Console UAMI Secrets Officer **only**; no APIM identity access; deny public network where the boundary pattern does), flag `LOOM_APIPLANE_CROSS_CLOUD` (default `false` in every param file), env `LOOM_APIPLANE_MGMT_KEY_VAULT_URI` (empty unless enabled), gate `api-gateway.cross-cloud-vault` (`provision` Fix-it) | `platform/fiab/bicep/modules/admin-plane/apiplane-mgmt-vault.bicep` (new), orchestrator wiring per the headroom rule, `main.bicep` (two env vars), `params/*.bicepparam` (one param each), `lib/gates/registry/api-gateway.ts` (one gate) | none | Sonnet | **required** (bicep + credential store) | `build-params` on every boundary; what-if on Commercial shows the vault only when the flag is true; a role-assignment scan shows exactly one principal with data access |
| W8-2 | Connections: `azureConnection` entity (name, cloud, tenant id, client id, authority, ARM and Log Analytics bases from closed cloud profiles, vault secret reference, tested-at), write-only secret input, **Test authentication** (token only; states that it proves no permissions), secret replacement verifying the candidate first, removal rules (refused while resources use it; deletes only the stored credential), cloud-profile binding threaded through every client (ARM, Log Analytics, APIM, Foundry, Graph **not** — Government Graph is blocked), rejection of cross-origin continuations; Settings → Connections with the disclosure text and "cross-cloud management (not sovereign)" readiness label; routes return 404 when the flag is off | `lib/api-gateway/connections/**`, `lib/api-gateway/secrets/key-vault-writer.ts` (management vault mode), `app/api/admin/api-gateway/connections/**`, `app/admin/api-gateway/settings/connections/**`, every `lib/api-gateway/**` client entry point (connection parameter) | W8-1 | Sonnet | **required** | with the flag off: route enumeration → 404 and no code path references the management vault URI; with it on: a saved secret is never returned by any route (paired with: the reference is stored and a test succeeds against a double); cloud inferred from an environment tag anywhere → test fails |
| W8-3 | Government resources via connection: register a Government gateway by explicit ARM id with the connection, preflight and inventory through `management.usgovcloudapi.net`, Government endpoints kept in the same cloud as their gateway, publication plan/apply with key-only governed access (Entra option disabled with the stated reason; operations must inherit the reviewed API policy; custom overrides rejected), initial key setup after a successful apply with durable retry, telemetry through `api.loganalytics.us`, pricing by the served deployment's cloud (Government rates or "No price"), **All clouds** and per-cloud filters in Analytics, shared cost centers and budgets with per-gateway enforcement through each connection, blocked list enforced (Government user sign-in, Graph expansion, runtime tokens, federation, certificates, backend-secret vault flows, unverified Anthropic shapes) | `lib/api-gateway/{registry,plan,telemetry,pricing,budgets}/**` (cloud/connection branches), analytics filters, `docs/fiab/api-gateway/cross-cloud.md` (new) | W8-2, W3, W4 | Sonnet | **required** | a Government gateway publication with Entra access requested → refused with reason; a failed Government query → freshness "failing", Commercial results intact and no zero shown; a Government call priced only from Government rates (a Commercial price for the same model is never applied) |
| W8-4 | Verifier and receipts: from the operator's Government subscription through Actions (Q13 names who creates the service principal): authentication, inventory, reviewed publication, key rejection and acceptance from a Government caller, backend identity, rotation, revocation, telemetry; docs; G1 walk of the Connections page in Commercial | `scripts/measure/apiplane/cross-cloud-probe.mjs` (new), `.github/workflows/apiplane-cross-cloud-probe.yml` (new, `workflow_dispatch`, fails closed on missing secrets), docs, `e2e/api-gateway-connections.uat.ts` (new) | W8-1..W8-3 | Sonnet | **required** (new Gov workflow) | run id; each probe step measured or **unknown** with reason; the disclosure text present in the screenshot |

Lanes: L1 = W8-1 → W8-2 → W8-3 → W8-4. Bicep: W8-1 only.

## Done receipt (per cloud)

Commercial (the managing side): vault deployed only when enabled; connection
created, tested, secret replaced, removed; disclosure shown. Government (the
managed side): the probe run id covering the list above. A sovereign-native
GCC-High Loom is unaffected and that is stated.

## Rollback

Flag off: routes 404, clients ignore connections, vault left in place (opt-in
resource); connections removed delete only stored credentials; the operator
removes the Government service principal.

## Cost / credit estimate

~8 Sonnet sessions; Azure: one Key Vault (opt-in), scratch Government
resources deleted in the probe.

## Execution state

| Item | Status | Branch | Model | Evidence | Updated |
|---|---|---|---|---|---|
| W8-1 | todo | | sonnet | | 2026-10-28 |
| W8-2 | todo | | sonnet | | 2026-10-28 |
| W8-3 | todo | | sonnet | | 2026-10-28 |
| W8-4 | todo | | sonnet | | 2026-10-28 |
