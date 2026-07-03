# Parity gap — `apim-product`

> v2 fabric-parity-loop validator, run 2026-05-26.
> Reference target: Azure portal → API Management service → Products → Product → Settings.
> Loom route: `https://<your-console-hostname>/items/apim-product/new`.
> Editor source: `apps/fiab-console/lib/editors/apim-editors.tsx` (lines 316-416).

## Phase 3 — gap matrix vs Azure portal APIM Product blade

| # | Azure portal APIM Product element | Loom present? | Severity |
|---|---|---|---|
| 1 | Settings form (display name / state / description / subscription required / approval required) | Present (lines 387-411) — all key fields | OK |
| 2 | Description textarea | Present (Fluent `<Textarea>` lines 401-405) — multiline | OK |
| 3 | Lifecycle state dropdown (published / not published) | Present (lines 391-400) | OK |
| 4 | APIs tab (which APIs are bundled in this product) | MISSING — Azure portal has Product → APIs to add / remove APIs to the product | MAJOR |
| 5 | Policies tab (per-product policy XML) | MISSING — should link to `apim-policy?scope=product` | MAJOR |
| 6 | Subscriptions list (users subscribed to this product, approve / reject) | MISSING | MAJOR |
| 7 | Access control (groups that can view / subscribe) | MISSING | MAJOR |
| 8 | Save / Reload | Present (lines 377-380) | OK |
| 9 | Publish / Unpublish ribbon actions | Ribbon vapor — toggling state via dropdown achieves the same thing | MINOR (acceptable substitute) |
| 10 | Status bar | MISSING | MINOR |

## Phase 4 — functional click probe (source-trace)

| Control | Source impl | Live behavior |
|---|---|---|
| **Save** | `save()` (line 348-364) — real `PUT /api/items/apim-product/{id}` with all fields | Real |
| **Reload** | `load()` (line 328-344) | Real |
| Display name input | local state | Real |
| Lifecycle state dropdown | `setState` | Real |
| Description textarea | local state | Real |
| Subscription required switch | local state | Real |
| Approval required switch (disabled when subscriptionRequired = false) | Present (line 410) — disable interlock is correct | Real |
| Ribbon "Save" / "Reload" / "Publish" / "Unpublish" | Top-bar Save / Reload are real buttons; ribbon ones have no handlers | DEAD ribbon (4) |

## Grade

**B** — Settings form is fully real-REST against APIM. All visible form fields persist. The approval-required switch correctly interlocks with subscription-required (a nice UX detail). 4 dead ribbon entries, no APIs / Subscriptions / Access tabs.

This is the strongest of the APIM trio. Honest about its scope (just the settings blade) and the scope it covers is genuinely Fabric-parity-quality. The MAJOR rows are scope-expansions (APIs / Subscriptions / Access), not lies.

