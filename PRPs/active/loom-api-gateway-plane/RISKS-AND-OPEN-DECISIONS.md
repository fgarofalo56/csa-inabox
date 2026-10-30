# Risks and open decisions

D-items are designer decisions with a default a wave may take without asking;
a wave that departs from a default records why in its item row. Q-items need
the operator. Operator decisions Q1–Q8 (2026-10-28) are fixed inputs
(`OPERATOR-DECISIONS-2026-10-28.md`) and are not repeated here.

## 1. Decisions with defaults

| Id | Decision | Default | Wave | Revisit when |
|---|---|---|---|---|
| D1 | Cosmos layout | five `apiplane-*` containers, PK `/tenantId` (`ARCHITECTURE.md` § 3) | W1 | a tenant's observed state exceeds a logical partition |
| D2 | Audit mechanism | existing `auditLogContainer`, written in the same request; no separate outbox | W1 | a cross-container transaction is needed |
| D3 | Worker hosting | one Container Apps Job on the `loom-uat` image (as the existing jobs), cron `*/15` | W4 | rollup lag exceeds two intervals on the estate |
| D4 | Naming | `loom-` fragments and named values, `x-loom-*` headers, `loom-attribution|deny|attempt v=1` traces | W2 | never (wire format) |
| D5 | API shapes | `azureOpenAi`, `foundryModels`, `anthropicMessages` ported; `azureOpenAiV1` (`/openai/v1/`) added when a deployment needs it; one shape per PR | W2 | the unified model API reaches GA (D16) |
| D6 | Plane administrator | **Decided (Q9, 2026-10-29):** a scoped `apiplane-admin` capability through `withCapability` (`lib/api/route-toolkit.ts:254`), declared in `lib/auth/feature-catalog.ts`, assignable to an Entra group, enforced on every plane admin route from **W1-8**; tenant admins are a superset; audit records the capability used | W1 | — |
| D7 | Key reveal | owner-only, 60 s transient, audited; admin handoff route exists but shows no key to the admin | W3 | an operator asks for admin reveal (would need its own audit review) |
| D8 | Cost-center auto-bind | one per workspace on create; `code` = workspace slug (deduplicated deterministically); a backfill job creates centers for existing workspaces at W4 deploy; `general` is the tenant default | W4 | — (Q15 answered 2026-10-29: no default budget) |
| D9 | Environment seed | Mosaic's six built-ins plus Loom pipeline stage names not already present; everything starts Unclassified; require-classification off | W1 | an operator wants production-class by default |
| D10 | Price seed | Mosaic `model_prices.json` + schema ported as the first version with Mosaic's source URLs and read dates; Loom's `price-seed.py` refresh; Government prices "No price" until seeded | W4 | — (Q14 answered 2026-10-29: per release plus an on-demand check) |
| D11 | Budget cadence | full check every 15 min after rollup; fast path 5 min at ≥ 90%; named-value cap (315 blocks) disclosed on the Overview | W5 | — |
| D12 | Notification channels v1 | in-app, Graph email (mailbox gate), Teams Workflows; personal Teams bot deferred | W5 | — (Q12 answered 2026-10-29: Workflows only) |
| D13 | Cross-cloud infra | `apiplane-mgmt-vault.bicep` as its own deploy unit, opt-in flag, Console UAMI Secrets Officer only | W8 | — |
| D14 | Day-one gateway ownership | bicep keeps authoring the #4442 pool; the plane registers it `ownedBy:'deploy'` (observe, drift reported) in W1 and adopts it in W7 through a reviewed apply that flips `loomBackends.aoaiGateway` to `'plane'` | W1, W7 | — (Q10 confirmed 2026-10-29) |
| D15 | Loom's own MCP items | console-hosted endpoint stays for in-product use; "Publish through gateway" offered on the same dialog | W6 | — |
| D16 | Unified model API (preview) | not used; pools give one URL per vendor and shape | — | review 2027-04-28 with Q3 |
| D17 | Sovereign LLM-policy gap | consumed from #4460 / #4442 Wave D. MEASURED in W0 (2026-10-29, `W0-RECEIPT.md` sections 2 and 9.2): `llm-token-limit` and `llm-emit-token-metric` are authorable on Commercial PremiumV2 and on GCC-High Premium, so the gap #4460 assumed does not exist there; the measured GCC-High gaps are LLM logs (`GatewayLlmLogs` absent) and the MCP API type (api-version `2025-09-01-preview` not registered); runtime enforcement on GCC-High is unmeasured; IL5 and GCC are not measured and keep the rule below. Where `llm-token-limit` is unavailable, grants use `rate-limit-by-key` / `quota-by-key` labelled **request-counting**; token limits are refused on that gateway, never silently substituted | W3 | #4460 closes |
| D18 | Graph permissions | `User.ReadBasic.All`, `GroupMember.Read.All`, `AgentIdentity.Read.All` requested by bootstrap; `Application.Read.All` optional via Fix-it | W3 | — |
| D19 | Retention | daily facts/summaries 400 days (min 62); monthly kept; first rollup backfills 90 days; manual backfill ≤ 730 | W4 | storage cost evidence |
| D20 | Monitoring Reader | granted by bicep on the deploy-owned gateway; Fix-it `role-grant` for registered ones | W1 | — |
| D21 | Entity scope | plane entities are tenant-scoped admin objects, not workspace items; cost centers bind to workspaces; the marketplace is the user surface | W1 | a customer asks for workspace-owned publications |
| D22 | Foundry-side AI gateway integration | not adopted (`AZURE-PARITY-INVENTORY.md` § 7) | — | review 2027-04-28 |
| D23 | Legacy `environmentLabel`-style free text | none introduced; classification only | W1 | — |
| D24 | Token-limit counters | per grant (keys and tokens share one counter identity); publication safeguards separate; group counters per member `oid` | W3 | — |
| D25 | Anthropic shape limits on classic tiers | token metering only on v2 tiers; classic tiers use call limits with a plan warning; unknown tier blocks publishing until the access check runs | W2 | — |
| D26 | `apiplaneLlmLogs` per boundary | Commercial `true`; GCC-High `false`; IL5 `false`; GCC `false` (IL5 and GCC not measured, so off until measured); written by W1-2 | W1 | an IL5 or GCC measurement, or a Government category list that offers `GatewayLlmLogs` |
| D27 | Diagnostic destination type | the live setting `diag-loom-stdz` is the legacy `AzureDiagnostics` destination on both gateways; the resource-specific table `ApiManagementGatewayLlmLog` needs a Dedicated destination, so W1-2 plans that move and offers it and never flips an existing setting silently | W1 | - |

## 2. Questions for the operator — answered 2026-10-29

All eight were answered in chat on 2026-10-29 (`OPERATOR-DECISIONS-2026-10-29.md`,
which also records #4442's Q5, the PR handling and the shared W0 probes). The
original question and default stay beside the answer so a later reader sees
where the operator departed from the recommendation (only Q9).

| Id | Question | Recommended default | Answer (2026-10-29) | Needed by |
|---|---|---|---|---|
| Q9 | Who is a gateway administrator? Tenant admin for every plane write, or a scoped `apiplane-admin` capability (`withCapability`) assignable to a group? | tenant admin now; scoped capability as a W9 item | **Scoped `apiplane-admin` capability from W1** (new item W1-8; tenant admins a superset) — departs from the default | W1 |
| Q10 | Should the plane take ownership of the bicep-authored day-one gateway (#4442 B1) in W7, or stay observe-only over it? | adopt in W7 via reviewed apply (D14) | **Adopt in W7** (default) | W7 |
| Q11 | Which mailbox sends plane email (Graph, mailbox-scoped Exchange Application RBAC)? A shared mailbox per boundary is a tenant action only an Exchange admin can perform. | one shared mailbox per boundary; gate until configured | **New shared mailbox per boundary** (default) | W5 |
| Q12 | Teams: shared Workflows only, or also the personal bot (requires an app registration and bot installation)? | Workflows only in v1 | **Workflows only** (default) | W5 |
| Q13 | Cross-cloud: who creates the Government service principal and its roles when the opt-in is used? | the operator, in the Government tenant, per Mosaic's `azure-government.md` steps; Loom stores the secret write-only | **The operator, in the Government tenant** (default) | W8 |
| Q14 | Price seed refresh: per release (Mosaic's model) or a monthly job that proposes a new version for review? | per release plus an on-demand "Check for newer prices" admin action that proposes versions | **Per release plus the on-demand check** (default) | W4 |
| Q15 | Budgets on auto-created workspace cost centers: none, warn-only at a default amount, or block? | none until an owner sets one; the Overview lists centers without budgets | **None until an owner sets one** (default) | W5 |
| Q16 | Do Loom's own Copilot calls move onto a governed pool model under a `platform` cost center at W7 (R9), accepting that platform usage then appears in chargeback? | yes | **Yes, visible in chargeback** (default) | W7 |
| Q17 | Are the plane's worker job (W4-3) and management vault (W8-1) still their own deploy units, now that `main.json` has 196,393 B of ARM headroom at `007da59c4` (this set said 7,624 B)? | wire the small job module into `main.bicep` after `cost-anomaly-monitor-job.bicep` (it fits); keep LHDS-scale stamps separate; decide the vault when W8 is planned | **Open** (raised by W0, 2026-10-29) | W4 |
| Q18 | The GCC-High gateway is VNet-internal and unreachable from GitHub-hosted runners: add an in-boundary measurement path (an in-boundary runner or a probe Container Apps Job) so latency and runtime enforcement can be measured there? | yes, as part of W1's Government verifier; until then those cells stay declared gaps | **Open** (raised by W0, 2026-10-29) | W1 |
| Q19 | Grant the Government deploy SP `Application.Read.All` (application permission, admin consent in the Government tenant) so the three W0-4 Government cells can be measured? | yes, read-only; then re-run the `identity` family | **Open** (raised by W0, 2026-10-29) | W3 |
| Q20 | The sign-in app is named `CSA Loom Console (<resource group>)` by `main.bicep` and `(<KEYVAULT_NAME>)` by `bootstrap-msal-app-reg.sh` (#5184): which form is canonical? | the script form (the live Commercial app uses it); find the app by a stable key, not a display name | **Open** (raised by W0, 2026-10-29) | W1 |

## 3. Risks

| Risk | Why it matters | Mitigation |
|---|---|---|
| `llm-*` policies, LLM logs or `TraceRecords` absent in a Government tier | metering and token limits are the plane's spine | MEASURED in W0 (2026-10-29): LLM logs are absent on GCC-High, the `llm-*` elements are authorable on both clouds and the `TraceRecords` column exists (`W0-RECEIPT.md` 9.2 and 9.5); declared gaps with substitutes (D17); readiness states per boundary |
| APIM preview surfaces (MCP APIs `2025-09-01-preview`, `.well-known` paths) change | MCP publishing breaks silently | W0-3 measures; the MCP client pins the version; plan refuses unknown shapes; Mosaic's live-verification list is carried in `TEST-STRATEGY.md` |
| Entra Agent ID unavailable in a tenant or boundary | agent grants cannot be created | W0-4; `agentIdentity` principals gated per boundary with a stated reason |
| Tenant blocks user consent for the model client | Entra-token access fails for users | Fix-it gate with the exact command; key access unaffected; documented |
| Two writers (bicep and the plane) on one gateway | drift and overwrites on Loom's own APIM | D14: deploy-owned resources are read-only to the plane until adopted; plan refuses to take over resources it did not create |
| ARM template headroom (196,393 B at `007da59c4`; this row said 7,624 B, the W1-1-embedded intermediate) | a LHDS-scale stamp cannot be wired into `main.bicep`; a small job module can | Q17: job and vault as their own deploy units (`LOOM-INTEGRATION.md` section 5) or wired into `main.bicep`; re-measure with `git cat-file -s` at the ref before wiring |
| Rollup cost (Log Analytics queries, Cosmos RU) | estate spend is watched (`csa_loom_cost_and_estate_power_findings_2026_10_19`) | windows halve to fit limits; pages read only Cosmos summaries; retention defaults; W4 records RU/day on the estate |
| Personal data in rollups | object IDs and client IDs | retention, user-scoped views, documented in `SECURITY-AND-COMPLIANCE.md` § 2 |
| Budget block latency misread as a hard cap | up to 30 min of spend past the amount | copy on the budget form states it; forecast shown |
| Cross-cloud boundary misunderstood as sovereign | compliance exposure | opt-in flag, disclosure text, readiness label, key-only runtime, blocked list |
| Scope creep into APIM features outside the AI gateway (developer portal designer, certificates, workspaces) | this set never finishes | `PRD.md` § 4 non-goals; parity rows stay on `apim-service.md` |
| Review load | gateway-write waves need a reviewer | one reviewer, one round where possible; findings fixed in-round |
| A fragment PUT is not a verdict | APIM answers 201 for an invalid policy fragment and then drops it (GET 404), measured on Commercial and GCC-High | W2 apply verifies by read-back and treats a 404 after a 2xx as rejected (ADR-003) |
| GCC-High has no LLM logs and no MCP API type | `GatewayLlmLogs` is absent; api-version `2025-09-01-preview` is not registered (newest `2024-10-01-preview`) | declared gaps with owners and dates in `W0-RECEIPT.md` 9.5; substitutes per D26 and D15 |
| The Government gateway is unreachable from Actions | VNet-internal gateway, DNS failure from a hosted runner; latency and runtime enforcement are unmeasured there | Q18: the W1 Government verifier runs in-boundary |
| The live diagnostic setting is the legacy destination | moving to a resource-specific table changes where `GatewayLogs` lands and can break existing queries | D27: plan and offer the move, never flip silently |
