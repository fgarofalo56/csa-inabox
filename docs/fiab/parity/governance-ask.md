<!-- parity-doc-meta
Reviewed-on: 2026-07-28
Validated-against:
  - apps/fiab-console/app/governance/ask/page.tsx
  - apps/fiab-console/app/api/governance/copilot/ask/route.ts
  - apps/fiab-console/lib/governance/nl-governance-copilot.ts
  - apps/fiab-console/lib/governance/policy-graph.ts
  - apps/fiab-console/lib/governance/policy-graph-load.ts
  - apps/fiab-console/lib/governance/policy-graphrag.ts
  - apps/fiab-console/lib/azure/ontology-graphrag.ts
-->

# governance-ask — parity with **Microsoft Purview access/insight reporting** + **Unity Catalog governance search**

**Loom item / surface:** `/governance/ask` — the natural-language governance
copilot (loom-apex **B-N14b**).

**Source UIs inventoried**

| Source | What it gives an operator |
|---|---|
| [Microsoft Purview Data Estate Insights](https://learn.microsoft.com/purview/data-estate-insights-about) | Curated dashboards over classification / sensitivity / ownership coverage — **fixed reports, no free-form question** |
| [Purview data-map classifications](https://learn.microsoft.com/purview/data-map-classification-supported-list) | The built-in sensitive-information-type catalog Loom mirrors in `purview-system-classifications.ts` |
| [Purview access policies](https://learn.microsoft.com/purview/concept-data-owner-policies) | Who is granted what, per policy — again, browse-only |
| Databricks Unity Catalog "search + effective permissions" | Per-object grant inspection; no cross-object NL question |

**The parity gap this closes.** In every source UI, "who can read PII in EU?"
is a *research task*: open the classification report, cross-reference the access
report, then check residency by hand. None of them answer it as ONE question,
and none of them hand back a citable evidence chain. Loom does both.

## Feature inventory ↔ Loom coverage

| Capability (source UI) | Loom coverage | Backend |
|---|---|---|
| Browse built-in sensitive-information types | ✅ `/admin/classifications` (pre-existing) + used as policy-graph nodes here | `purview-system-classifications.ts` (reference catalog) |
| Per-object "who has access" report | ✅ `/admin/access-reviews` (access-governance W1) + traversed here | `loom-access-assignments` (Cosmos), `workspace-roles` |
| Per-policy scope inspection | ✅ `/governance/policies` + traversed here | tenant policy doc (`policy-store.ts`) |
| Column-grain classification | ✅ ODCS `properties[].classification` | `loom-data-contracts` (Cosmos) |
| **Free-form NL question across all of the above** | ✅ **Loom-only — exceeds every source UI** | `retrievePolicyContext` + in-VNet Azure OpenAI |
| **Citable evidence chain per answer** | ✅ **Loom-only** — typed `GraphPathCitation`s rendered under the answer and carried into the N10 Answer Receipt | `pathCitationsFromVisits` (shared with N11) |
| **Refuse-not-guess** | ✅ **Loom-only** — no path ⇒ refusal + the missing-evidence sentence; the model is not called at all | `askGovernance` |
| Residency / region question | ⚠️ **Honest partial**: regions are derived from region terms an operator actually wrote on a policy scope, a contract domain/purpose, or an item region. An asset with no declared region contributes no `LOCATED_IN` edge, so a residency claim about it is REFUSED rather than assumed from the Azure region of the backing resource. |
| Model-less operation | ⚠️ Honest gate: with no AOAI deployment the retrieval still runs and the cited paths are returned uninterpreted (`gate.code = 'no_aoai'`) |

Zero ❌.

## Backend per control

| Control | Real backend |
|---|---|
| Ask / example chips | `POST /api/governance/copilot/ask` (`withSession`, caller-partition scoped) |
| Policy-graph assembly | Cosmos: `loom-access-assignments`, `workspace-roles`, tenant policy doc, `loom-data-contracts`, `items` |
| Classification vocabulary | Static Purview built-in catalog (documented reference data, not a live call — see the module header for why) |
| Retrieval | Pure, in-process; reuses the N11 GraphRAG primitives |
| Narration | In-VNet Azure OpenAI (`aoaiChat`, `temperature: 0`) |
| Kill switch | Runtime flag `n14b-nl-governance-copilot` (default ON) |

## No-Fabric / sovereignty

No Fabric or Power BI host is contacted on any path, and
`LOOM_DEFAULT_FABRIC_WORKSPACE` is never read. Every read is in-boundary Cosmos
and the model call is in-VNet AOAI, so the whole capability runs DISCONNECTED in
a GCC-High / IL5 enclave with no code-path change.

## Known limits (stated, not hidden)

- The graph is bounded (500 assignments / 500 workspace roles / 400 items / 600
  contract fields per question). A tenant beyond those bounds gets an answer
  over a truncated graph; the node count is shown on the answer.
- A silo that fails to read is listed in `unavailable` and disclosed both to the
  model and in the UI — the answer is explicitly labelled incomplete.
- Group-membership expansion is not walked: a grant held by a group is cited as
  the group, not as its members.
