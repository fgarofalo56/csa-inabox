# TTI budget & route code-splitting (PSR-9)

**Status:** active · **Owner:** Platform / Front-end.

Two levers keep the console's time-to-interactive fast: **route-level
code-splitting** (ship less JS up front) and a **TTI budget** (gate the
server-render latency of every top surface in CI).

## Route-level code-splitting

Every editor in `lib/editors/registry.ts` is loaded with
`next/dynamic(..., { ssr: false })` — the heavy editor bundles (Monaco, the
React-Flow canvas, the report designer, the pipeline/eventstream designers) are
**never** in the initial route payload; they download only when the user opens
that item type.

Since PSR-9 each dynamic import also has a **`loading:` skeleton**
(`editor-loading-skeleton.tsx`) — a ribbon + left-rail + content placeholder —
so the pane reads as "loading this editor" during the chunk download instead of
flashing blank. This is a perceived-TTI win with no change to the editor itself.

## TTI budget (enforced in CI)

The benchmark runner (PSR-1) measures **page TTI** — TTFB + HTML transfer — for
each top surface and emits a `page-tti:<slug>` metric per surface
(`home`, `catalog`, `workspaces`, `marketplace`, `governance`, `monitor`,
`lineage`, `learn`, `admin`, `copilot`).

The budget lives in `perf-budgets.json`:

| Metric | p95 ceiling | Applies to |
|--------|------------:|------------|
| `page-tti` | 4,000 ms | every surface without a specific override (the shared TTI budget) |
| `page-tti:copilot` | 5,000 ms | the Copilot page (heavier initial payload) |
| `page-tti:governance` | 5,000 ms | the Governance hub (heavier initial payload) |

**Gating fix (PSR-9):** `lib/perf/compare-budgets.ts` now resolves a
`page-tti:<slug>` row to its specific override **or** the generic `page-tti`
budget (`resolveMetricBudget`). Before this, the per-surface rows had no exact
budget entry and were silently ungated — the shared `page-tti` ceiling never
matched anything. Now **every** measured surface's TTI is gated against a
ceiling + the trailing-baseline regression budget, and the `perf-gate.yml` CI
job fails a roll that regresses any surface's TTI.

## Verification

- Unit: `lib/perf/__tests__/compare-budgets.test.ts` — `resolveMetricBudget`
  page-TTI fallback + per-surface override precedence, and an end-to-end
  `evaluateBudgets` case gating a `page-tti:<slug>` row.
- CI: `perf-gate.yml` runs the suite and compares against `perf-budgets.json`.
