# Loom API & AI Gateway Plane — PRD + PRP set

**Status (2026-10-28): DRAFT, design complete, docs only.** No product code
exists for the control plane. W0 (measurement spike, no product code) may
start in a fresh session; every later wave waits for W0's receipt or runs on
the recommended defaults in `RISKS-AND-OPEN-DECISIONS.md`. **The operator
answered Q9–Q16, #4442's Q5 and the sequencing questions on 2026-10-29**
(`OPERATOR-DECISIONS-2026-10-29.md`); nothing is waiting on an operator answer
before W0.

**Public repo rules**: no secrets, no subscription keys, no tenant IDs other
than the ones already in tracked files, no real usage figures. Every sample
in these documents uses placeholders.

## Operator mandate (verbatim intent, 2026-10-28)

> "I think for CSA API and APIM and AI Gateway management should be just like
> this: https://github.com/microsoft/mosaic-apim. Write the PRD/PRPs to enhance
> API management / AI gateway management for CSA Loom to fold in all the great
> features and work and capabilities of Mosaic so a single API management plane
> is built right into CSA Loom."

MOSAIC (Model Orchestration, Stewardship, Allocation, Insights, and Chargeback;
`microsoft/mosaic-apim`, MIT) is a self-service **control plane** over Azure
API Management's AI gateway: it onboards gateways, publishes models and MCP
servers through reviewed plans, governs who may call them, meters usage from
gateway logs, prices it, allocates it to cost centers, enforces budgets, and
gives end users a portal. It never proxies traffic and never replaces APIM.
This set folds those capabilities into Loom as native console + Cosmos +
Fluent v9 work, with Mosaic's 29 ADRs adopted as the design contract and its
MIT data artifacts ported where they are data.

## Operator decisions recorded 2026-10-28 (fixed inputs, not re-litigated)

Full text with consequences: `OPERATOR-DECISIONS-2026-10-28.md`. The follow-up
answers of 2026-10-29 (Q9–Q16, #4442's Q5, PR handling, shared W0 probes) are
in `OPERATOR-DECISIONS-2026-10-29.md`; the one departure from a recommended
default is Q9, a scoped `apiplane-admin` capability from W1 (item W1-8).

1. **Native rebuild in Loom** (TS BFF + Cosmos + Fluent v9), not a vendored
   Python service and not Mosaic-beside-Loom.
2. **New PRD + PRP set**, sibling to `PRPs/backlog/apim-ai-gateway/` (#4442),
   and **#4442 is greenlit**: its default-ON APIM direction is confirmed.
3. **Azure-hosted models, three API shapes**: Azure OpenAI, Foundry Models,
   Anthropic-on-Foundry. Bedrock, Vertex and SaaS endpoints are dated non-goals.
4. **Sovereign-native plus opt-in cross-cloud**: each boundary's Loom is its
   own control plane; a Commercial Loom may additionally register Government
   gateways through an isolated-vault service principal, disclosed and opt-in.
5. **Cost centers per workspace by default**, extensible to cross-workspace
   ones; header `x-loom-cost-center`; joins the existing Chargeback/FinOps pages.
6. **Keys and Entra tokens day one**: bootstrap adds the runtime-audience and
   model-client registrations and consent, with an honest Fix-it gate where
   tenant consent is withheld; security-group and Entra Agent ID grants ride
   the token path.
7. **P1, alongside LHDS**, under the one-bicep-PR-in-flight rule; Sonnet per
   wave, Opus only for the plan/apply engine and the entitlement policy
   renderer design passes; review required on gateway-write and entitlement
   waves only.
8. **Deliverable**: this docs-only PR plus one tracking issue; no implementation.

## Reading order

1. `PRD.md` — problem, personas, capability inventory, non-goals, binding
   requirements, metrics, releases, open decisions.
2. `ARCHITECTURE.md` — the control plane inside the console; then
   `adr/ADR-001` .. `ADR-010`.
3. `MOSAIC-CAPABILITY-MAP.md` — every Mosaic capability and ADR → Loom
   disposition (adopt / adapt / reject, with reason) → wave.
4. `AZURE-PARITY-INVENTORY.md` — the Azure portal's own AI gateway, Models and
   MCP surfaces (Learn-grounded) → Loom coverage, per `ui-parity.md`.
5. `LOOM-INTEGRATION.md` — exactly where this plugs into existing Loom
   surfaces, routes, containers, bicep and bootstrap.
6. `SECURITY-AND-COMPLIANCE.md`, `TEST-STRATEGY.md`.
7. `RISKS-AND-OPEN-DECISIONS.md` — D-items with defaults, Q-items with the
   operator's 2026-10-29 answers beside them.
8. `PRP.md` (master) then `apigw-W00-*.md` .. `apigw-W09-*.md`.

## Evidence convention

Repo claims carry `file:line` measured on `origin/main` at **`b9decb4a8`**
(2026-10-28). External claims carry a URL in `research/` with the retrieval
date (2026-10-28). Anything not read in full is marked **UNVERIFIED**. Mosaic
behaviour is quoted from its ADRs and guides as retrieved; Mosaic's own "live
verification still required" lists are carried forward, not assumed settled.

## Relationship to `PRPs/backlog/apim-ai-gateway/` (#4442)

That PRP is the **runtime gateway** epic: the multi-endpoint pool for Loom's
own AI traffic, default-ON routing, SKU and capacity, LLM policies in
sovereign boundaries, content safety per boundary, a Gov-capable semantic
cache. This set is the **control plane** over any number of gateways,
including that one. The two touch different files except `apim.bicep`, which
is sequenced (see `PRP.md` § 5). W7 (model pools) is the only wave with a hard
dependency on #4442 (Waves A and B1).
