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
| D6 | Plane administrator | Loom tenant admin (`withTenantAdmin`) | W1 | Q9 |
| D7 | Key reveal | owner-only, 60 s transient, audited; admin handoff route exists but shows no key to the admin | W3 | an operator asks for admin reveal (would need its own audit review) |
| D8 | Cost-center auto-bind | one per workspace on create; `code` = workspace slug (deduplicated deterministically); a backfill job creates centers for existing workspaces at W4 deploy; `general` is the tenant default | W4 | Q15 |
| D9 | Environment seed | Mosaic's six built-ins plus Loom pipeline stage names not already present; everything starts Unclassified; require-classification off | W1 | an operator wants production-class by default |
| D10 | Price seed | Mosaic `model_prices.json` + schema ported as the first version with Mosaic's source URLs and read dates; Loom's `price-seed.py` refresh; Government prices "No price" until seeded | W4 | Q14 |
| D11 | Budget cadence | full check every 15 min after rollup; fast path 5 min at ≥ 90%; named-value cap (315 blocks) disclosed on the Overview | W5 | — |
| D12 | Notification channels v1 | in-app, Graph email (mailbox gate), Teams Workflows; personal Teams bot deferred | W5 | Q12 |
| D13 | Cross-cloud infra | `apiplane-mgmt-vault.bicep` as its own deploy unit, opt-in flag, Console UAMI Secrets Officer only | W8 | — |
| D14 | Day-one gateway ownership | bicep keeps authoring the #4442 pool; the plane registers it `ownedBy:'deploy'` (observe, drift reported) in W1 and adopts it in W7 through a reviewed apply that flips `loomBackends.aoaiGateway` to `'plane'` | W1, W7 | Q10 |
| D15 | Loom's own MCP items | console-hosted endpoint stays for in-product use; "Publish through gateway" offered on the same dialog | W6 | — |
| D16 | Unified model API (preview) | not used; pools give one URL per vendor and shape | — | review 2027-04-28 with Q3 |
| D17 | Sovereign LLM-policy gap | consumed from #4460 / #4442 Wave D; where `llm-token-limit` is unavailable, grants use `rate-limit-by-key` / `quota-by-key` labelled **request-counting**; token limits are refused on that gateway, never silently substituted | W3 | #4460 closes |
| D18 | Graph permissions | `User.ReadBasic.All`, `GroupMember.Read.All`, `AgentIdentity.Read.All` requested by bootstrap; `Application.Read.All` optional via Fix-it | W3 | — |
| D19 | Retention | daily facts/summaries 400 days (min 62); monthly kept; first rollup backfills 90 days; manual backfill ≤ 730 | W4 | storage cost evidence |
| D20 | Monitoring Reader | granted by bicep on the deploy-owned gateway; Fix-it `role-grant` for registered ones | W1 | — |
| D21 | Entity scope | plane entities are tenant-scoped admin objects, not workspace items; cost centers bind to workspaces; the marketplace is the user surface | W1 | a customer asks for workspace-owned publications |
| D22 | Foundry-side AI gateway integration | not adopted (`AZURE-PARITY-INVENTORY.md` § 7) | — | review 2027-04-28 |
| D23 | Legacy `environmentLabel`-style free text | none introduced; classification only | W1 | — |
| D24 | Token-limit counters | per grant (keys and tokens share one counter identity); publication safeguards separate; group counters per member `oid` | W3 | — |
| D25 | Anthropic shape limits on classic tiers | token metering only on v2 tiers; classic tiers use call limits with a plan warning; unknown tier blocks publishing until the access check runs | W2 | — |

## 2. Questions for the operator

| Id | Question | Recommended default | Needed by |
|---|---|---|---|
| Q9 | Who is a gateway administrator? Tenant admin for every plane write, or a scoped `apiplane-admin` capability (`withCapability`) assignable to a group? | tenant admin now; scoped capability as a W9 item | W1 |
| Q10 | Should the plane take ownership of the bicep-authored day-one gateway (#4442 B1) in W7, or stay observe-only over it? | adopt in W7 via reviewed apply (D14) | W7 |
| Q11 | Which mailbox sends plane email (Graph, mailbox-scoped Exchange Application RBAC)? A shared mailbox per boundary is a tenant action only an Exchange admin can perform. | one shared mailbox per boundary; gate until configured | W5 |
| Q12 | Teams: shared Workflows only, or also the personal bot (requires an app registration and bot installation)? | Workflows only in v1 | W5 |
| Q13 | Cross-cloud: who creates the Government service principal and its roles when the opt-in is used? | the operator, in the Government tenant, per Mosaic's `azure-government.md` steps; Loom stores the secret write-only | W8 |
| Q14 | Price seed refresh: per release (Mosaic's model) or a monthly job that proposes a new version for review? | per release plus an on-demand "Check for newer prices" admin action that proposes versions | W4 |
| Q15 | Budgets on auto-created workspace cost centers: none, warn-only at a default amount, or block? | none until an owner sets one; the Overview lists centers without budgets | W5 |
| Q16 | Do Loom's own Copilot calls move onto a governed pool model under a `platform` cost center at W7 (R9), accepting that platform usage then appears in chargeback? | yes | W7 |

## 3. Risks

| Risk | Why it matters | Mitigation |
|---|---|---|
| `llm-*` policies, LLM logs or `TraceRecords` absent in a Government tier | metering and token limits are the plane's spine | W0-1/W0-2 measure through Actions; declared gaps with substitutes (D17); readiness states per boundary |
| APIM preview surfaces (MCP APIs `2025-09-01-preview`, `.well-known` paths) change | MCP publishing breaks silently | W0-3 measures; the MCP client pins the version; plan refuses unknown shapes; Mosaic's live-verification list is carried in `TEST-STRATEGY.md` |
| Entra Agent ID unavailable in a tenant or boundary | agent grants cannot be created | W0-4; `agentIdentity` principals gated per boundary with a stated reason |
| Tenant blocks user consent for the model client | Entra-token access fails for users | Fix-it gate with the exact command; key access unaffected; documented |
| Two writers (bicep and the plane) on one gateway | drift and overwrites on Loom's own APIM | D14: deploy-owned resources are read-only to the plane until adopted; plan refuses to take over resources it did not create |
| ARM template headroom (7,624 B) | new modules cannot be wired into `main.bicep` | job and vault as their own deploy units (`LOOM-INTEGRATION.md` § 5) |
| Rollup cost (Log Analytics queries, Cosmos RU) | estate spend is watched (`csa_loom_cost_and_estate_power_findings_2026_10_19`) | windows halve to fit limits; pages read only Cosmos summaries; retention defaults; W4 records RU/day on the estate |
| Personal data in rollups | object IDs and client IDs | retention, user-scoped views, documented in `SECURITY-AND-COMPLIANCE.md` § 2 |
| Budget block latency misread as a hard cap | up to 30 min of spend past the amount | copy on the budget form states it; forecast shown |
| Cross-cloud boundary misunderstood as sovereign | compliance exposure | opt-in flag, disclosure text, readiness label, key-only runtime, blocked list |
| Scope creep into APIM features outside the AI gateway (developer portal designer, certificates, workspaces) | this set never finishes | `PRD.md` § 4 non-goals; parity rows stay on `apim-service.md` |
| Review load | gateway-write waves need a reviewer | one reviewer, one round where possible; findings fixed in-round |
