# PRP — APIM AI Gateway as the day-one path for every Loom AI endpoint

**Status:** DRAFT (2026-09-10) — design unblocked; no wave started.
**Issue:** #4442 (`epic`, `sprint:active`, `sp:13`, `lane:bicep`, `lane:console`)
**Created:** 2026-09-10 · **Owner:** autonomous build program
**Related rules:** `auto-bind-by-default.md`, `cloud-parity.md`,
`deploy-integrity.md`, `no-vaporware.md`, `no-fabric-dependency.md`,
`ux-baseline.md` · **Memory:** `loom_default_on_opt_out`,
`csa_loom_region_availability_is_not_audit_scope`
**Predecessor:** `PRPs/completed/model-strategy/PRP.md` (Waves M1–M6 built the
gateway this epic turns on).

---

## 1. Goal (operator intent, 2026-09-10)

> "Have Loom integrate directly with APIM for its AI endpoints so it's not tied to
> one Foundry endpoint, but can leverage all AI services and endpoints through
> APIM via an AI Gateway. Make sure the deployment scripts and configuration
> settings cover all things day-one Loom deploy."

**This is not greenfield.** Model-strategy Wave M4 already authored a real GenAI
gateway and deliberately left it OFF "pending operator confirmation of the
APIM-vs-direct direction". #4442 IS that confirmation. The work is to widen the
pool, turn it on, extend it to the other three service families, and make it
deploy day-one in every boundary.

### What "done" means

1. A fresh `az deployment` in **any** supported boundary stands the AI gateway up
   and routes Loom's AI traffic through it, with **no operator action** — the
   platform provisions and binds it (`auto-bind-by-default.md`). "Set
   `LOOM_AOAI_APIM_URL`" as a terminal user-facing state is a defect.
2. The backend pool accepts **N endpoints**, priority-ordered, PTU-primary with
   pay-go spillover, including operator-supplied BYO — not one endpoint derived
   from a single Foundry account.
3. All four service families route through the gateway (§3, Q3).
4. **Every supported boundary gets the same capability**, or the gap is declared
   with an owner and a date (`cloud-parity.md`). Semantic cache in Gov is solved,
   not skipped (Q4).
5. Greenfield **and** brownfield, Commercial **and** sovereign, each with its own
   receipt (`deploy-integrity.md` R4/R5). A boundary with no receipt is named as
   unexercised, never implied working.

---

## 2. Decisions already recorded — DO NOT RE-ASK

From #4442's decision comments (2026-09-10). Each is the operator's, with the
measurement that produced it.

| # | Question | Decision |
|---|---|---|
| Q1 | APIM tier | **Premium (classic).** Standard v2 was chosen first and then **withdrawn**. |
| Q2 | Endpoint scope | **Multi-Azure endpoints** — N Foundry/AOAI accounts across regions/subscriptions in one priority-ordered pool, plus BYO. **Multi-vendor (Anthropic/Vertex) explicitly OUT of scope.** |
| Q3 | Service breadth | **All four** — LLM inference, AI Search, Document Intelligence / Speech / Vision, and `llm-content-safety` at the gateway. |
| Q4 | Semantic cache in Gov | **Find a Gov-capable equivalent.** Do not ship a Commercial-only cache. Path: build on the existing `redisOss` app. |

### Why Standard v2 was withdrawn — three independent grounds, all measured

1. **No Gov regions.** Learn's *Availability of v2 tiers and workspace gateways*
   enumerates every v2 region and contains no `USGov Virginia` / `USGov Arizona` /
   `USGov Texas` / `US DoD Central` / `US DoD East`; the page states the v2 tiers
   are available in a **subset** of classic regions. Disqualifying under
   `cloud-parity.md` on its own.
2. **It cannot reproduce Loom's private posture.** v2 VNet integration leaves the
   gateway, management plane and developer portal publicly reachable;
   `apim.bicep` today is `virtualNetworkType: 'Internal'`.
3. **No availability zones and no multi-region** — both of which matter once the
   gateway is the single path for all Loom AI traffic.

Premium classic keeps all three properties and needs **zero networking rework**.
`apimSku` / `apimSkuName` already exist (`main.bicep:64`, `:922` defaulting to
`Developer`), so this is a param + capacity/cost change, not a redesign. **Cost is
the accepted trade** and was accepted knowingly.

> One caveat carried forward from the issue, and it is the honest one: ground 1 is
> *absence from an authoritative table*, not a positive statement of
> unavailability. Per the Gov access rule, definitive confirmation comes from an
> in-boundary GitHub Actions run, never local `az`. We are not designing against a
> tier Microsoft's own table does not list in our boundaries — but the negative is
> not itself a receipt.

---

## 3. Measured current state (verified in-tree 2026-09-10, not carried)

### Already built — Wave M4

| Capability | Where | State |
|---|---|---|
| Per-endpoint backends + circuit breaker (429/5xx, honours `Retry-After`) | `apim.bicep:431-461` | built, authored in ALL clouds |
| Load-balanced backend **pool**, priority LB | `apim.bicep:462-480` | built |
| `llm-token-limit` (per-consumer TPM) | `apim.bicep:507` | built, opt-in |
| `llm-semantic-cache-lookup` / `-store` | `apim.bicep:510-513` | built, opt-in, needs external Redis + embeddings |
| Managed-identity auth to backends (keyless) | `apim.bicep:66-67` | built |
| Console routing switch + graceful fallback | `LOOM_AOAI_VIA_APIM`, `LOOM_AOAI_APIM_URL` | built |
| Brownfield adopt of an existing APIM | `main.bicep:624-626`, `adoptMode(adopt,'apim')` | built |

### The gap — verified at the line

```bicep
// admin-plane/main.bicep:2084
var aoaiApimBackendEndpoints =
  (apimEnabled && empty(existingApimName) && aoaiApimGatewayEnabled && !empty(loomAoaiEndpointValue))
    ? [ loomAoaiEndpointValue ] : []
```

The pool **supports N and is passed exactly one**, derived from a single account
(`loomAoaiEndpointValue`, `:2083`). This is literally "tied to one Foundry
endpoint".

Both switches are OFF (`main.bicep:2591-2592`, inside `loomBackends` to stay under
the ARM 256-param ceiling):

```bicep
aoaiGateway: ''      // 'apim' AUTHORS the gateway
aoaiViaApim: ''      // 'true' ROUTES console traffic through it
```

**They are deliberately separable** so the gateway can be deployed and
smoke-tested before live traffic is flipped. **Preserve that property** — do not
collapse them into one flag.

`redisOss: 'enabled'` is already in the same `loomBackends` object (`:2578`),
which is the foundation for Q4.

### The DNS constraint — measured on the live estate this session

The private DNS zone `azure-api.net` is linked to the hub VNet
(`link-apim-console`, registration disabled) and contains **exactly one A
record**:

```
apim-csa-loom-centralus   ->   10.0.4.4
```

Because a linked private zone is **authoritative for its whole namespace**, every
other `*.azure-api.net` name returns NXDOMAIN inside the VNet. That is not a
theory — it is the root cause of #4432: `LOOM_CONTENT_SAFETY_ENDPOINT`'s host did
not resolve from `loom-console` at all, every copilot turn threw, and the throw
surfaced as a causeless HTTP 500.

**Three consequences this design MUST honour:**

1. The APIM gateway hostname itself resolves — that A record exists. Routing to
   `apim-csa-loom-centralus.azure-api.net` is safe **today**.
2. **A workspace-gateway design is disqualified as-is.** The issue measured
   `hzd9c4bdb9e4fng6.ai-gateway.dm1-02.azure-api.net` → ENOTFOUND in-VNet. Any
   hostname of that shape needs its own record in the zone, or it is unreachable.
3. **A second APIM instance** (multi-region, or a migration standing one up
   alongside) is unreachable in-VNet until its A record is added. Any wave that
   creates one owns that record.

Pool *backends* are unaffected: they are `*.openai.azure.com` /
`*.cognitiveservices.azure.com`, resolved through their own privatelink zones,
which work today (measured: 10.0.5.19 / 10.0.5.20).

---

## 4. Waves

Partitioned **by file** so lanes do not intersect. A wave that needs a file
another wave owns is sequenced, not parallelised.

### Wave A — the multi-endpoint pool (the core of the issue)
**Owns:** `platform/fiab/bicep/modules/admin-plane/main.bicep` (the
`aoaiApimBackendEndpoints` derivation only), `apim.bicep` (pool params).

- Replace the single-element array with a derivation that collects **every**
  Loom-provisioned inference endpoint plus operator-supplied BYO, priority-ordered.
- Preserve `no-vaporware`: an empty pool is still never authored.
- Priority-1 = PTU primary where present; the rest priority-2 spillover.
- **Acceptance:** a param set naming three endpoints produces a three-member pool
  with the documented priorities, proven by `az bicep build-params` + an ARM
  what-if, not by reading the template.

### Wave B — default-ON with opt-out preserved
**Owns:** the `loomBackends` defaults in `main.bicep`, every `params/*.bicepparam`.

- `aoaiGateway` and `aoaiViaApim` default ON; explicit opt-out documented.
- **Keep them separable.** Author-then-cutover must survive.
- Set them in **every** boundary param file, with any boundary that must differ
  stating why at the line (the `il5.bicepparam` precedent).
- **Acceptance:** each `.bicepparam` builds and resolves the expected values.

### Wave C — Premium classic + capacity
**Owns:** `apimSku` / `apimSkuName` defaults and param files.

- Flip the default from `Developer`. `Developer` has **no SLA** and is
  single-node, so it is not a day-one production answer even though it does
  support `llm-token-limit`.
- **Acceptance:** state the cost delta explicitly in the PR. This was accepted
  knowingly and must not be smuggled in.

### Wave D — the other three service families (Q3)
**Owns:** `apim.bicep` API/policy definitions.

- AI Search, Document Intelligence / Speech / Vision, and `llm-content-safety` at
  the gateway.
- Note from the issue, carried: the LLM policies (`llm-token-limit`,
  `llm-semantic-cache-*`) only understand OpenAI-shaped traffic, so the other
  families get backends + circuit breaker + routing, **not** token limiting.
  Say so rather than implying uniform capability.

### Wave E — observability + gateway-side safety
**Owns:** `apim.bicep` policy fragments, App Insights wiring.

- `llm-emit-token-metric` → per-API/per-dimension token metrics: the cost
  attribution story nearly for free.
- `llm-content-safety` including `shield-prompt`.
- **Note the interaction with #4432's fix:** the console already screens prompts
  via Content Safety directly. Gateway-side screening must not double-charge or
  double-block; decide and record which layer owns the verdict.

### Wave F — Gov-capable semantic cache (Q4)
**Owns:** the `redisOss` app definition + the cache policy wiring.

- Azure Managed Redis is Azure Public only with no announced Gov date
  (`main.bicep:2573-2577`), so the Commercial answer cannot be the Gov answer.
- Build the RediSearch capability on the existing `redisOss` app.
- **Two properties are non-negotiable:** the cache is per-tenant (answers never
  cross tenants), and the UI states that semantic caching returns responses on
  **similarity, not exact match**, so it can surface answers that are incorrect,
  outdated or unsafe — Learn's own caveat.
- **Token counters are per gateway / region / workspace and are NOT aggregated**;
  any multi-region design must state what a "limit" actually means.

### Wave G — day-one deploy coverage + readiness
**Owns:** `.bicepparam` files (sequenced after B), the readiness gate registry,
`docs/`.

- A readiness gate for gateway health, registered so Copilot can discover and
  resolve it (`ux-baseline.md` G2) and visible on the Admin gate page.
- Greenfield **and** brownfield walkthroughs (`deploy-integrity.md` R8).
- Brownfield must honour R5: discover an existing APIM, **offer** it, never
  silently adopt or silently duplicate. `adoptMode(adopt,'apim')` already exists.

---

## 5. Verification

Per `deploy-integrity.md` and `ux-baseline.md` G1, and stated per boundary:

- **Commercial:** a real deploy receipt, then a live AI turn through the gateway.
  The bar the copilot work just set applies here too — a test that accepts "a
  real answer OR an honest gate" proves nothing. Require the real answer.
- **GCC-High / IL5:** each needs its own receipt. Until one exists the boundary is
  **supported-in-code, never exercised** and must be labelled that way in every
  table (`cloud-parity.md`). Confirm Premium classic availability in-boundary via
  a GitHub Actions run, never local `az`.
- **Brownfield:** prove the adopt path against an existing APIM.
- The `azure-api.net` record for any new instance is part of the acceptance, not
  a follow-up.

---

## 6. Risks

| Risk | Why it matters | Mitigation |
|---|---|---|
| Cutover breaks live AI | The gateway becomes the single path for all Loom AI traffic | Keep `aoaiGateway` / `aoaiViaApim` separable; author + smoke-test before routing |
| `azure-api.net` shadowing | Already caused #4432 at a smaller blast radius | §3 constraint 2/3; any new hostname owns its record |
| Premium cost | Materially the most expensive tier | Accepted knowingly; state the delta per PR |
| Gov tier availability | Ground 1 is table absence, not a positive negative | In-boundary Actions run before claiming parity |
| Double content-safety | Console already screens (post-#4432) | Wave E decides which layer owns the verdict |

---

## 7. Sequencing note

#4442 says to sequence after #4432's diagnosis "so we do not change endpoint
resolution underneath a live defect". **That diagnosis is complete**: root cause
was the authoritative `azure-api.net` zone, the private endpoint has landed, and
the copilot is verified answering end-to-end on the live estate. #4432 remains
open pending an operator-observed G1 walk, but it no longer blocks this design —
and its measurement is now an input to it (§3).
