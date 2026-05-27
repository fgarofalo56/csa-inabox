# Parity gap — `/api-marketplace`

**Loom route:** `/api-marketplace` (rendered by `apps/fiab-console/app/api-marketplace/page.tsx` → `ItemsByTypePane` filtered to `apim-api`, `apim-product`, `apim-policy`)
**Fabric reference:** No direct equivalent — Loom-native surface for Azure API Management items
**Loom screenshot:** `temp/parity/page-api-marketplace-loom.png` (empty state — no APIM items in tenant)
**Captured:** 2026-05-26

## Phase 3 — UI structure assessment

This is a **Loom-native page** with no Fabric equivalent. The user's brief asks me to confirm it's "polished."

| # | Element | Status | Notes |
|---|---|---|---|
| 1 | Page header "API marketplace" | present | Clear title |
| 2 | Subtitle explaining what's listed | present | "Every API your tenant exposes via APIM — apis, products, and policies" |
| 3 | Filter input | present | Search filter |
| 4 | + New item button | present | NewItemDialog opens 2-pane Fabric-style picker |
| 5 | Empty state | present + honest | "No APIM items in this tenant yet. Click + New item above to create your first one — it persists to Cosmos and (when the underlying Azure resource is configured) executes against the real service." |
| 6 | Marketplace-y features: featured APIs, popular APIs, recently added | missing | Would expect a marketplace to have visual hero / featured / categories |
| 7 | Category filter chips (e.g., "Public APIs", "Internal", "Partner") | missing | MAJOR for a marketplace UX |
| 8 | Quick action: Subscribe / Get API key per API | not present in list view | MAJOR — APIM marketplace UX includes subscription |
| 9 | API operation count / version indicator on each card | not present | MINOR |
| 10 | Search by tag | not present | MINOR |
| 11 | Provider / publisher per API | not present | MINOR |
| 12 | Quota / pricing info | not present | MAJOR — marketplace implies tiered access |

## Phase 4 — Functional verification

| Control | Source | Result |
|---|---|---|
| Filter input | Real client-side filter on `displayName + description` | OK |
| + New item dialog | Real `NewItemDialog` | OK |
| Empty state | Honest "no items yet" with hint | OK |
| Backend | `/api/items/by-type?type=apim-api&type=apim-product&type=apim-policy` — real Cosmos query | OK |

When APIM items DO exist, they would render via the same card grid as OneLake catalog. The detail editors (`apim-api-parity-spec.md`, `apim-policy-parity-spec.md`, `apim-product-parity-spec.md`) per the project's parity specs cover the item-level editors.

## Honest grade

**Grade: C+**

Reasoning:
- This is a Loom-native page so there's no Fabric reference to compare against.
- It reuses the generic `ItemsByTypePane` component — so it inherits the same strengths (real backend, honest empty state, real filter) and weaknesses (no endorsement, no sensitivity, no overflow menu) as OneLake catalog.
- For something branded "Marketplace", the lack of marketplace-style UX (featured / categories / pricing tiers / subscription per API) makes it feel like a thin re-skin of `/onelake` rather than a distinct marketplace surface.
- Empty state is honest; no vaporware.

Not D because the underlying machinery is real. Not B because for a "marketplace" brand, the surface needs marketplace-specific UX (featured row, category chips, subscription flow).

## Recommended next actions

1. Add a "Featured APIs" hero row above the grid (showcases tenant's flagship APIs).
2. Add category chips: Public / Partner / Internal / Preview.
3. Per-card surface: API version, operation count, pricing tier, "Subscribe" quick action.
4. If tied to APIM real backend, add per-card "Get API key" + "Try in console" actions.
5. Add a separate "Products" tab (Fabric/APIM products group APIs into subscription bundles).
