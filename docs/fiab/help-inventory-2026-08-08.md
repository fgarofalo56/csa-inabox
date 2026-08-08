# Help coverage — corrected inventory, 2026-08-08

> **Why this page exists.** A help-centre audit dated **2026-07-24** recorded a
> backlog of **18 item guides + 15 app tutorials = 33 outstanding**. That figure
> was carried forward as live work. It is stale. This page re-measures it
> against the code and records what is actually outstanding, so no future lane
> re-derives it or builds something that already exists.
>
> **Estate context:** measured at `e73d976c`, which is `origin/main` with zero
> drift — so `main` reflects what a user actually sees.

## Headline

**33 of 33 were already done.** Both halves of the 07-24 baseline were closed by
the intervening `loom-apex` D1/D2/D4 waves. The genuine outstanding count against
that baseline is **zero**.

Re-measuring turned up **one** undocumented surface the baseline never counted,
which this wave wrote, and **one functional defect** found while verifying a
guide's claims.

## What was measured

### Item guides — 142 / 142, no gaps and no dead links

`EDITOR_DOC_SLUGS` in `apps/fiab-console/lib/learn/content.ts` is the registry
that decides whether an item type's Learn card links to a real Loom guide or
shows "Loom guide coming". Cross-checking it against the catalog and the files on
disk:

| Set | Count |
|---|---|
| Catalog item types (`lib/catalog/item-types/*.ts`) | 142 |
| Editor guides on disk (`docs/fiab/tutorials/editor-*.md`) | 142 |
| Registered in `EDITOR_DOC_SLUGS` | 142 |

All four cross-checks come back empty:

- registered but **no file on disk** (would be a dead link) — none
- file on disk but **not registered** (card would falsely say "coming") — none
- catalog slug with **no guide** — none
- guide with **no catalog slug** (orphan) — none

The 18 the baseline named are the D2 wave, listed in `content.ts` as "the 18
recent-wave item types that shipped with NO editor guide at all". All 18 are on
disk and registered.

### App tutorials — 29 / 29 apps covered

| Set | Count |
|---|---|
| Apps in `CATALOG_META` | 29 |
| Apps with a Learning Hub card (`USE_CASES.appId`) | 29 |
| Apps in the content-bundle `REGISTRY` | 29 |

No app lacks a card, and no card names an app that isn't installable — so no
"Install live example" button silently drops.

The 15 the baseline named are the D4 wave: 8 **App deep dives** plus 7
**Supercharge notebook pack** cards.

!!! note "One disclosed thinness, not a gap"
    The 7 Supercharge cards share a single deep dive
    (`fiab/tutorials/apps/supercharge-medallion.md`) — by design, and disclosed
    in the code: one representative bronze→silver→gold chain walked end to end
    plus an index of the rest. 15 cards, 9 documents. Called out here so it is a
    known decision rather than a rediscovery.

### Reachability — nothing orphaned

Every one of the 142 editor guides, all 9 app tutorial pages, and all 9 numbered
tutorials is referenced in `mkdocs.yml`. A guide nothing links to is the
inert-feature class in documentation form; none of these are in it.

All 49 `docPath` values in the Learning Hub's `USE_CASES` table resolve to a real
file. Five resolve via a directory `README.md` rather than `index.md` — that is
valid MkDocs and the published pages render, verified against the live docs site.

!!! note "The parity tree is orphaned from nav — pre-existing, systemic"
    `mkdocs.yml` contains **zero** references to `fiab/parity/`. The whole
    per-surface parity corpus is reachable only by direct URL. That is a
    reviewer-artifact corpus rather than user guidance, so it may be deliberate,
    but it is recorded here because it was not previously written down. The
    access-requests parity doc is now reachable from its nav-linked user guide.

### Truth audit — 15 user-facing numeric claims, all TRUE

Learning Hub card summaries make specific, checkable assertions. Every one was
verified against the actual content bundles:

| Claim | Verified |
|---|---|
| Supercharge: 28 bronze / 28 silver / 34 gold / 8 ML / 9 streaming / 3 utils / 7 guide = **117 notebooks** | all 7 exact; total 117 |
| FedRAMP tracker: **13-family** NIST 800-53 scorecard | 13 (AC AT AU CM CP IA IR MP RA SA SC SI SR) |
| Data steward: **4** Purview data products, **17-term** glossary | 4 datasets, 17 terms |
| FinOps: **5-page** executive report | 5 pages |
| Lakehouse inspector: **10** seeded tables | 10 |
| Workspace monitoring: **six-tile** dashboard | 6 tiles |
| RAG builder: **7-metric** evaluation suite | 7 metrics |

This is the reassuring half of the audit: the guides that shipped are honest.

## What is actually outstanding

### 1. One surface had no user guide — now written

`/governance/access-requests` (the F16 multi-tier approval inbox) was the **only**
user-facing console surface whose route path appeared in no document. Written
this wave: [Access requests — the multi-tier approval inbox](governance/access-requests.md).

Be precise about what was missing. The surface was **not** undocumented in the
absolute sense — `docs/fiab/parity/access-requests.md` inventories its
capabilities against Purview / Fabric / Entra. What did not exist was a **user
guide**: a page explaining how the approval chain works, what the final tier
actually provisions, and what happens when a grant comes back `pending` or
`error`. A parity scorecard is a completeness artifact for reviewers, not
guidance for the person staring at the inbox.

Measured across all static console routes:

| Group | Routes | Route path in no doc |
|---|---|---|
| User-facing | 73 | 1 (now 0) |
| Admin | 53 | 3 — all false positives (see below) |

The three admin "gaps" — `/admin/access-packages`, `/admin/access-report`,
`/admin/parity-autopilot` — are **redirect stubs**, kept as stable deep links
(IA-04 / IA-06). Each forwards to a tab of a hub surface that is documented.
They correctly have no guide of their own. Recorded here so the next audit does
not re-flag them.

### 2. Documented-but-false: three wrong claims in the access-requests parity doc

Verifying the new guide against the code falsified three claims in
`docs/fiab/parity/access-requests.md`, all corrected this wave:

| Claim as written | Measured truth |
|---|---|
| Rows 4 and 5 — approver inbox per tier and decision advance — **built ✅** | Both are broken cross-user (see below). Now marked **❌** with the root cause. |
| Tiers defined in `lib/types/access-request.ts` | That file contains zero occurrences of the tier constants. They live in `lib/types/**access-request-workflow**.ts`. |
| Submit request → Cosmos **`access-requests`** (PK `/tenantId`) | The F16 workflow container is **`access-request-workflow`** (PK `/tenantId`). `access-requests` is the *marketplace* container, partitioned by `/dataProductId` — a different system. The cosmos-client even carries a comment warning the two are distinct. |

### 3. A functional defect, found while verifying the new guide

Writing the guide surfaced a real bug rather than a documentation gap:
**cross-user approval cannot work today.** Requests are written under the
requester's Entra object id; the inbox and decision routes read under the
signed-in approver's object id. Different people, different partition key — the
approver's inbox returns empty and a decision call 404s.

The correct helper (`tenantScopeId`, adopted by 84 other route files) exists and
was simply not adopted here. Full detail, exact lines, and why the unit test
cannot catch it are in the guide's
[What is broken today](governance/access-requests.md#what-is-broken-today)
section.

**Status: INFERRED from code, not reproduced live.** No estate access was used
for this finding.

### 4. A stale count in the Help source of truth — fixed

The header comment of `lib/learn/content.ts` claimed Learn content covers "the
117 catalog item types", with an explicit instruction to keep the number in sync
with `FABRIC_ITEM_TYPES.length`. The actual length is **142**. Corrected in the
same change as this page.

### 5. Operator-gated, still outstanding

Screenshot capture (`help-D6`) is **operator-gated** and was not attempted.
Measured state, so the gate is precise:

- **121** of 142 editor guides have a captured landing screenshot
  (`EDITOR_THUMB_SLUGS`); the other **21** fall back to a generated placeholder
  tile, which is the intended honest behaviour, not a broken image.
- `EDITOR_STEP_IMAGE_COUNTS` is **empty** — no slug has a published multi-step
  capture, so every walkthrough past step 1 renders the "screenshot coming"
  placeholder alongside its authored caption.

Neither blocks the written guides.

## How to re-run this measurement

The checks above are mechanical. To reproduce:

- **Editor-guide coverage** — compare the slugs in
  `lib/catalog/item-types/*.ts`, the `editor-*.md` files under
  `docs/fiab/tutorials/`, and `EDITOR_DOC_SLUGS` in `lib/learn/content.ts`. All
  three sets must be identical.
- **App coverage** — compare `CATALOG_META` keys, `USE_CASES[].appId`, and the
  content-bundle registry. All three must be identical.
- **Reachability** — every `editor-*.md`, every `tutorials/apps/*.md`, and every
  `USE_CASES[].docPath` must appear in `mkdocs.yml` and resolve to a file
  (`<path>.md`, `<path>/index.md`, or `<path>/README.md`).
- **Surface coverage** — every non-dynamic `page.tsx` under
  `apps/fiab-console/app` that is not a `redirect()` stub should be mentioned in
  at least one document.

## Lesson for the next audit

Three separate premises in this program were falsified on 2026-08-08 alone, and
this was a fourth: a 33-item backlog that was entirely closed.

The re-inventory then produced **three false findings of its own**, all caught
before they shipped:

- Five Learning Hub doc paths flagged as dead links actually resolve via a
  directory `README.md` — the check had only tried `.md` and `index.md`.
- Three admin routes flagged as undocumented are `redirect()` stubs with no
  surface of their own.
- The access-requests surface was first called "mentioned in no document". A
  parity doc existed; the initial grep had been truncated with `head -5`, so an
  **unknown was reported as a negative** — the same failure class this program
  has hit before.

Grep-verify every premise, including your own, and never let a truncated command
stand in for a complete measurement.
