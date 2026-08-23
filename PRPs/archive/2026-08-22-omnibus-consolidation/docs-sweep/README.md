# Docs / Help / Copilot comprehensive sweep — program tracker

**Goal (operator, 2026-07-07):** the docs site pages, the docs-site Copilot,
the in-product Help Center, and the tutorials all reflect **everything in
Loom** — every editor and admin page, with recent changes.

**Scope (measured):**
- **118** item-type editors (`apps/fiab-console/lib/catalog/item-types/*.ts`)
- **28** admin pages (`apps/fiab-console/app/admin/**/page.tsx`)
- **~30** top-level console pages

**Four output surfaces per feature:**
1. Public docs site page (MkDocs → GitHub Pages) — also the Copilot grounding corpus
2. Docs-site Copilot (`azure-functions/copilot-chat`) — prompt + grounding
3. In-product Help Center / Learn Hub (`apps/fiab-console/lib/learn/content.ts`)
4. In-product tutorials (`lib/components/learn/core-surface-tutorials.ts` + capture pipeline)

## Baseline (measured 2026-07-07)

| Surface | Baseline state |
|---|---|
| Docs-site Copilot prompt | **Was** CSA-in-a-Box-era (old `portal/shared/api` tree, no Loom). **Batch 0: rewritten Loom-aware.** |
| In-product Help (`content.ts`) | ~117/118 editor slugs already referenced; **only `loom-app` absent**. Needs a currency pass. |
| Public docs pages | ~2,092 built pages exist, but not Loom-coherent; needs a Loom entry structure + gap-fill. |
| Loom Apps discoverability | Category exists but is the **22nd / last** New-Item tab — easy to miss. |

## Batch plan

- **Batch 0 — foundation (this PR):** Copilot system prompt → Loom-aware (done);
  this tracker; Loom Apps discoverability fix; add `loom-app` to Help content.
- **Batch 1 — Loom-coherent docs entry:** a canonical "What is CSA Loom",
  architecture, Fabric→Azure mapping, and Loom Apps doc set at the top of the
  MkDocs nav (the Copilot's primary grounding).
- **Batch 2+ — per-category editor coverage** (Data Engineering, Data Factory,
  Warehouse, RTI, Data Science, Fabric IQ, Governance/Admin, Loom Apps, …):
  each editor gets/refreshes a docs page + Help entry, verified, PR'd, merged
  main-green. Parallel agents per category.
- **Final — Copilot grounding regen + live Q&A verification.**

Each batch: PR → `vitest`/`next build` green → merge `--admin` → main-head CI green.
