# onelake-catalog-govern-owner — parity with Fabric OneLake Catalog → Govern (data-owner view)

Source UI: https://learn.microsoft.com/fabric/governance/onelake-catalog-govern
Loom surface: `/governance/govern?view=owner` → `lib/panes/govern-owner.tsx`
Feature flag: F3 (data-owner Govern view)

## Fabric/Azure feature inventory (grounded in Learn)

The OneLake catalog **Govern** tab has two scopes. This doc covers the
**data-owner** scope ("My items"). Capabilities the real Fabric UI exposes:

1. **My-items scope** — the Govern tab shows governance posture for items the
   signed-in user **owns** (data owners default to "My items"; admins default to
   "All data" and can switch).
2. **On-open refresh** — for data owners the insights **refresh each time the tab
   is opened** (the admin/all-data scope refreshes ~daily). A manual **Refresh**
   button is also present.
3. **Insight cards (smaller than admin)** — sensitivity-**label coverage**,
   **curation state** (description + endorsement), and **inventory** count for the
   owner's items.
4. **Recommended action cards** — scoped to the owner's items (e.g. items missing
   a sensitivity label, description, or endorsement), each linking to the item to
   fix it.
5. **Copilot** — available to ask about the owner's governance posture
   (capacity-gated in Fabric; AOAI-backed in Loom).

## Loom coverage

| # | Capability | Status | Notes |
|---|------------|--------|-------|
| 1 | My-items scope | ✅ built | BFF derives `ownerId/ownerUpn` from the session cookie; items filtered server-side on `state.ownerUpn`/`contact`/`steward`/`createdBy = upn`. No `?owner=` param. |
| 2 | On-open refresh + manual Refresh | ✅ built (⚠️ Function honest-gate) | `useEffect` POSTs `/api/governance/govern/refresh` on mount + a Refresh button. When `LOOM_POSTURE_FUNCTION_URL` is unset, a Fluent MessageBar names the env var + bicep module; posture still computes live. |
| 3 | Insight cards (inventory / label coverage / curation) | ✅ built | Three compact KPI cards: My inventory, Label coverage %, Curation state % (mean of description + endorsement coverage) with progress bars. |
| 4 | Owner-scoped recommended actions | ✅ built | Three action cards — Add sensitivity labels / Add descriptions / Request endorsement — each lists up to 8 owned items with a deep link to `/items/<type>/<id>`. |
| 5 | Copilot | ✅ built | "Ask Copilot about my governance" opens the shared AOAI-backed Copilot rail (`openCopilot()`). |

Zero ❌. The only ⚠️ is the honest infra gate on the optional refresh Function —
the full surface renders and is functional without it.

## Backend per control

| Control | Backend |
|---------|---------|
| KPI cards + action lists | `GET /api/governance/govern/owner` → Cosmos `posture-aggregates` (point-read, PK `ownerId`) with live `items`/`workspaces` query fallback. Real Cosmos, no mocks. |
| On-open / Refresh | `POST /api/governance/govern/refresh` → posture-refresh Azure Function (`/api/posture-refresh`) → recompute + UPSERT `posture-aggregates` + `recommended-actions`. Fire-and-forget; honest gate when unconfigured. |
| Recommended-action deep links | `<a href="/items/<itemType>/<id>">` → existing item editor. |
| Copilot CTA | `openCopilot()` → `/api/copilot/orchestrate` SSE (AOAI). |

## Cross-owner isolation (no leakage)

| Layer | Control |
|-------|---------|
| Session cookie | AES-256-GCM + HKDF; caller cannot forge `oid`/`upn`. |
| BFF | `ownerId = s.claims.oid`, `ownerUpn = s.claims.upn` — no request-supplied owner. |
| Cosmos cache | Point-read `item(ownerId, ownerId)` — single partition. |
| Cosmos live | `WHERE … AND (state.ownerUpn=@upn OR createdBy=@upn …)` — server-side predicate. |
| Function | Accepts `{ownerId, ownerUpn}` from the BFF (session-derived), not the browser. |
| Function key | Key Vault → `LOOM_POSTURE_FUNCTION_KEY` secretRef; never sent to the browser. |

## No-Fabric-dependency

The owner view has **no embedded Power BI report** and reaches **no
`api.fabric.microsoft.com` / `api.powerbi.com`** host on any path. All posture is
computed from the Loom Cosmos catalog and Azure Functions, so Commercial, GCC,
GCC-High, and IL5 behave identically with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset.
