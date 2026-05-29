# Parity gap — `/governance` + 8 sub-pages

!!! info "Comparative positioning note"
    This document is written from the
    perspective of Microsoft Azure, Cloud Scale Analytics, and CSA Loom. Any
    description of third-party or competing products, services, pricing, or
    capabilities is derived from **publicly available documentation and sources**
    believed accurate at the time of writing, and is provided for **general
    comparison only**. We do not claim expertise in, or authority over, any
    non-Microsoft product or service; the respective vendor's official
    documentation is the authoritative source for their offerings, which may
    change over time. Nothing here is intended to disparage any vendor — where a
    competing product has genuine advantages, we aim to note them honestly.
    Verify all third-party details against the vendor's current official
    documentation before making decisions.


**Loom routes:** `/governance`, `/governance/catalog`, `/governance/classifications`, `/governance/insights`, `/governance/lineage`, `/governance/policies`, `/governance/purview`, `/governance/scans`, `/governance/sensitivity`
**Fabric reference:** Microsoft Purview Unified Catalog — https://learn.microsoft.com/purview/governance-solutions-overview + Purview portal at web.purview.azure.com
**Loom screenshots:**
- `temp/parity/page-governance-loom.png` — main `/governance` (real activity feed)
- `temp/parity/page-governance-catalog-loom.png` — fake-data catalog
- `temp/parity/page-governance-insights-loom.png` — fake-data insights cards
**Captured:** 2026-05-26

## Phase 3 — Per-sub-page assessment

### 7a. `/governance` (main)

**Real.** Renders `<ActivityFeedPane>` which fetches from `/api/activity` (joins audit-log + comments + shares from Cosmos). Verified live: shows 3 real events (uat-sqldb activity by fgarofalo@limitlessdata.ai on 5/25/2026 14:54). Stats are computed client-side from the live feed. Empty state is honest.

### 7b. `/governance/catalog`

**VAPORWARE — VIOLATES `no-vaporware.md`.**

Source `apps/fiab-console/app/governance/catalog/page.tsx` defines a hardcoded `ASSETS` array:
```typescript
const ASSETS = [
  { name: 'fact_sales', source: 'OneLake · fin-prod', owner: 'alice', classifications: ['PII', 'Financial'], label: 'Confidential' },
  { name: 'dim_customer', ..., owner: 'alice', ... },
  { name: 'SecurityEvents', ..., owner: 'eve', ... },
  // ... 8 fake rows total
];
```

The rendered table looks like a real data catalog but is 100% sample data. No `useQuery`, no `fetch('/api/...')`, no Cosmos backend. This is **exactly what `no-vaporware.md` line forbids**: "Pre-configured / hard-coded UI values that look like real data but aren't."

### 7c. `/governance/classifications`

**VAPORWARE.** Hardcoded `BUILT_IN` array (8 fake classifications with fake hit counts: "Email Address: 4,120 hits", "IP Address (v4): 65,002 hits") + hardcoded `CUSTOM` array. No backend call.

### 7d. `/governance/insights`

**VAPORWARE.** Hardcoded card values: "Items with owner 88%", "Endorsement coverage 23%", "PII items unlabeled 17", "Sources scanned 30 d 38/38". These look like dashboard metrics. They are constants.

### 7e. `/governance/lineage`

**VAPORWARE.** Hardcoded `NODES` array (sql, sap, cdc, mirror, bronze, silver, fact) and `EDGES`. The lineage graph is a static SVG of fake nodes — there's no real lineage data being fetched. (Per `csa-loom-parity-reality.md` baseline, this matches the prior pipeline-DAG "renders boxes but no real data" pattern.)

### 7f. `/governance/policies`

**VAPORWARE.** Hardcoded `DLP` array ("Block external sharing of Highly Confidential" — Enabled — 4 triggers), `MASKING` array, `RLS` array. All fake.

### 7g. `/governance/purview`

**Honest stub.** Source clearly labels the embed as a preview placeholder: "Purview portal preview — Will load https://web.purview.azure.com/resource/{account} once connected" and when the user clicks Embed: "Purview portal would render here. The real iframe needs Purview's X-Frame-Options to allow loom-console-* origin." This is an acceptable honest gate per `no-vaporware.md` (clearly preview / not real). **Honest grade: C** (works as a config form, doesn't claim to be a working embed).

### 7h. `/governance/scans`

**VAPORWARE.** Hardcoded `SOURCES` array (7 fake sources including "ldn-gold-lakehouse", "sap-s4", "archive-bucket"), `RECENT_SCANS` array.

### 7i. `/governance/sensitivity`

**VAPORWARE.** Hardcoded `LABELS` array (5 labels: Public, General, Confidential, Highly Confidential, Top Secret with coverage % and item counts), `POLICIES` array (4 fake auto-apply policies).

## Phase 4 — Functional verification

| Route | Render | Backend | Verdict |
|---|---|---|---|
| `/governance` | ✅ Real | `/api/activity` Cosmos query | OK |
| `/governance/catalog` | ✅ Static array | None | **VAPORWARE** |
| `/governance/classifications` | ✅ Static array | None | **VAPORWARE** |
| `/governance/insights` | ✅ Static array | None | **VAPORWARE** |
| `/governance/lineage` | ✅ Static array | None | **VAPORWARE** |
| `/governance/policies` | ✅ Static array | None | **VAPORWARE** |
| `/governance/purview` | ✅ Honest stub | Configure-then-embed (preview placeholder) | OK — honest gate |
| `/governance/scans` | ✅ Static array | None | **VAPORWARE** |
| `/governance/sensitivity` | ✅ Static array | None | **VAPORWARE** |

## Fabric / Purview comparison

| Fabric/Purview surface | Loom surface | Reality |
|---|---|---|
| Purview Unified Catalog | `/governance/catalog` | UI is a styled table but data is fake |
| Purview Classifications | `/governance/classifications` | UI present, data fake |
| Purview Insights | `/governance/insights` | UI present, metrics fake |
| Purview Data Map / Lineage | `/governance/lineage` | UI is a static SVG of fake graph |
| Purview Policies | `/governance/policies` | UI present, policies fake |
| Purview portal embed | `/governance/purview` | Config form + honest preview placeholder |
| Purview Scans | `/governance/scans` | UI present, sources fake |
| Microsoft Information Protection / Sensitivity labels | `/governance/sensitivity` | UI present, labels fake |

## Honest grade

**Grade: D — VAPORWARE**

Per `no-vaporware.md`, the grading rubric:
- D: renders, mostly stubbed, looks nothing like Fabric. — **This applies to 7 of 9 governance routes.**

Reasoning:
- ONE sub-page (`/governance` main) is real (uses live activity feed from Cosmos).
- ONE sub-page (`/governance/purview`) is an honest config-form-with-preview-placeholder.
- SEVEN sub-pages render hardcoded sample arrays that *look* like real Purview data (fake users alice/bob/eve/carl/devops, fake metric percentages, fake lineage nodes) — directly violating `no-vaporware.md`.

These are precisely the pattern banned by line: "Pre-configured / hard-coded UI values that look like real data but aren't" and "Tabs that show static content".

**This is the worst-performing surface area of the 15 top-level pages.**

## Recommended next actions (URGENT per no-vaporware)

1. **DELETE** the hardcoded `ASSETS`, `BUILT_IN`, `CUSTOM`, `DLP`, `MASKING`, `RLS`, `SOURCES`, `RECENT_SCANS`, `LABELS`, `POLICIES`, `NODES`, `EDGES` arrays from the 7 vaporware sub-pages.
2. Replace with one of:
   - **Real Purview API call** (if a Purview account is configured for the tenant — wrap with same gate as `/governance/purview`).
   - **Honest MessageBar** explaining what needs to be deployed/configured to populate the page (e.g., "Connect a Purview account at `/governance/purview` to populate this catalog. Loom does not synthesize fake data.").
   - **Empty state** ("No classifications defined yet. Click + New classification.") with a real CRUD form that persists to Cosmos.
3. Update `docs/fiab/parity-progress.md` to reflect that these surfaces are scaffold-grade, not parity-complete.
4. Update `apps[]` env list in `admin-plane/main.bicep` with `LOOM_PURVIEW_ACCOUNT` env var for the real Purview integration.
5. Add `scripts/csa-loom/seed-governance.sh` to populate Cosmos governance containers with empty schemas (vs. injecting fake data).
