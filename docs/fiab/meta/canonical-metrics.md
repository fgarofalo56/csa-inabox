<!-- parity-doc-meta
Reviewed-on: 2026-07-20
Validated-against:
  - apps/fiab-console/lib/catalog/fabric-item-types.ts
  - apps/fiab-console/lib/catalog/item-types/*.ts
  - apps/fiab-console/lib/editors/registry.ts
  - apps/fiab-console/lib/admin/env-checks.ts
  - apps/fiab-console/lib/admin/self-audit.ts
  - apps/fiab-console/lib/admin/health-probes.ts
  - apps/fiab-console/lib/admin/health-coverage.ts
  - apps/fiab-console/lib/admin/health-coverage-map.json
  - pyproject.toml
  - .github/workflows/test.yml
-->

# CSA Loom — Canonical Metrics

**This file is the single source of truth for the headline counts and thresholds
quoted across the repo** (item-type count, editor mappings, health-check counts,
coverage thresholds). When any doc, README, or slide states one of these numbers,
it must match this file, and this file must match the **code** — not the other way
round. Every number below is derived from a named source file at a named revision,
with the exact command that reproduces it.

> **Verified at:** repo rev `9ad350d3` · **Reviewed-on:** 2026-07-20.
> Re-derive before quoting in a release: run the commands in
> [§ How these are generated / verified](#how-these-are-generatedverified). If a
> number here disagrees with a source file, **the source file wins** — update this
> doc (and whatever quoted the stale number) in the same PR.

---

## Headline numbers

| Metric | Value | Source of truth |
|---|---|---|
| **Item types** (catalog) | **132** | `FABRIC_ITEM_TYPES` in `apps/fiab-console/lib/catalog/fabric-item-types.ts` (barrel of 22 category arrays under `lib/catalog/item-types/`) |
| **Workload categories / families** | **22** | distinct `category` field across `lib/catalog/item-types/*.ts` (= 22 category files = 22 `family-*` health checks) |
| **Item-type editors** | **132** | `EDITOR_REGISTRY` slug→component map in `apps/fiab-console/lib/editors/registry.ts` |
| **Editor ↔ item-type coverage** | **1:1** (0 orphans either way at this rev) | set comparison of registry slugs vs catalog slugs — every item type has a dedicated editor; no editor slug lacks an item type |
| **/admin/health checks (total)** | **≈134** | sum of the four check families below |
| — env-presence gates (`ENV_CHECKS`) | **89** | `apps/fiab-console/lib/admin/env-checks.ts` |
| — live probes (real Azure calls) | **20** | 8 in `lib/admin/self-audit.ts` + 12 in `lib/admin/health-probes.ts` |
| — workload-family aggregate checks | **22** | `lib/admin/health-coverage.ts` (one `family-*` per catalog category) |
| — security-posture checks | **3** | `securityChecks()` in `lib/admin/self-audit.ts` |
| **Azure clients under health coverage** | **117** | `clients` map in `lib/admin/health-coverage-map.json` (109 checks-mapped + 8 allowlisted) |
| **Gate registry** | derived from the 89 `ENV_CHECKS`; **wired** | `lib/gates/registry.ts` + `GATES_REGISTRY_WIRED = true` in `lib/admin/gate-registry.ts` |
| **Python coverage gate — enforced in CI** | **60%** | `pytest --cov-fail-under=60` in `.github/workflows/test.yml` |
| **Python coverage gate — declared** | **65%** | `fail_under = 65` in `pyproject.toml` `[tool.coverage.report]` |

### ENV_CHECKS by category (89 total)

| Category | Count |
|---|---|
| azure-services | 42 |
| builders | 17 |
| data-plane | 8 |
| security | 7 |
| ai-copilot | 4 |
| catalog-governance | 3 |
| enrichment | 3 |
| identity | 3 |
| permissions | 2 |

---

## Coverage threshold — the full truth (three numbers, reconciled)

There are **three** coverage numbers in the repo; they do **not** agree, and this
is the canonical reconciliation. Quote **60%** as the enforced gate.

1. **Enforced (what actually fails CI): 60%.** `.github/workflows/test.yml` runs
   `pytest … --cov-fail-under=60`. The pytest-cov **CLI flag overrides** the
   `pyproject.toml` value, so 60 is the number that blocks a merge today.
2. **Declared: 65%.** `pyproject.toml` `[tool.coverage.report] fail_under = 65`
   (ratcheted 60→65 on 2026-05-17 per the in-file history). This is the *intended*
   floor, but it is dormant because the CI CLI flag overrides it.
3. **Previously documented: 80%** — **stale/incorrect**. The READMEs claimed an
   `80%` gate (CSA-0088 note). No `fail_under = 80` exists anywhere in the repo.
   Corrected in this batch.

> **Known drift (tracked as WS-F3, task #26):** the CI flag (`60`) and the declared
> `pyproject` floor (`65`) should be reconciled — either raise the CI flag to 65 to
> match intent, or lower the declared floor to 65-with-CLI-60 documented. Do this
> through the coverage-ratchet wave (gated on sustained margin), **not** as a
> silent doc edit. Until then, **60% is the honest enforced number.**

**Scope (what the gate measures).** Only the packages in `pyproject.toml`
`[tool.coverage.run] source` are gated:
`csa_platform/governance/{common,dataquality,contracts,compliance}`,
`csa_platform/functions/{aiEnrichment,eventProcessing,secretRotation,validation}`,
`csa_platform/ai_integration/{rag,enrichment}`. Broad `csa_platform/**` and
`portal/shared/api/` are **measured (visible in the report) but not gated** — their
suites are still growing.

**Ignored suites** (`pytest --ignore`, `pyproject.toml` `addopts`):
`csa_platform/streaming/tests`, `csa_platform/multi_synapse/tests`. Re-enabling
these is WS-F2 (task #26).

**Ratchet roadmap** (from the `pyproject.toml` `[tool.coverage.report]` comment):
60/65 → **70** once `streaming` / `data_activator` / `metadata_framework` suites
are consolidated into the root runner → **75** after the portal backend reaches
parity with the platform packages. Raise one notch only after CI sits 5+ points
above the current floor for a full release cycle.

---

## How these are generated / verified

Run from the repo root. Each command re-derives the number in the table so this
doc can be audited against code at any time.

```bash
# Item types (132) — count item literals across the 22 category arrays
grep -cE "^[[:space:]]*\{[[:space:]]*slug:" apps/fiab-console/lib/catalog/item-types/*.ts \
  | awk -F: '{s+=$2} END{print s}'

# Workload categories (22)
grep -rhoE "category: '[^']+'" apps/fiab-console/lib/catalog/item-types/*.ts | sort -u | wc -l

# Item-type editors (132) — entries in EDITOR_REGISTRY
grep -cE "^[[:space:]]*'[^']+':[[:space:]]*reg\(" apps/fiab-console/lib/editors/registry.ts

# ENV_CHECKS env-presence gates (89)
grep -oE "id: '[^']+'" apps/fiab-console/lib/admin/env-checks.ts | sort -u | wc -l

# Live probes (20)
grep -oE "id: 'probe-[^']+'" apps/fiab-console/lib/admin/self-audit.ts \
  apps/fiab-console/lib/admin/health-probes.ts | sort -u | wc -l

# Azure clients under coverage (117)
python -c "import json;print(len(json.load(open('apps/fiab-console/lib/admin/health-coverage-map.json'))['clients']))"

# Coverage — enforced (60) vs declared (65)
grep -oE "cov-fail-under=[0-9]+" .github/workflows/test.yml     # -> 60
grep -E "^fail_under" pyproject.toml                            # -> 65
```

The `/admin/health` self-audit narrative (what each check probes, the coverage-map
allowlist justifications, and the remaining-probe backlog) lives in
[`docs/fiab/health-coverage-audit.md`](../health-coverage-audit.md); its component
counts should track the numbers above. If they drift, this file is authoritative for
the counts and the health-coverage doc is authoritative for the per-check detail.

---

## Consumers of this file (keep in sync)

These docs quote one or more numbers above and must link here rather than restate a
literal that can drift:

- `README.md` — coverage gate note + repo-tree comment.
- `apps/fiab-console/README.md` — item-type / editor counts.
- `docs/fiab/health-coverage-audit.md` — health-check component counts.

A CI guard (`scripts/ci/check-parity-doc-freshness.mjs`, wired into
`.github/workflows/loom-guardrails.yml`) warns when a parity / parity-gap doc's
`Validated-against` source files change after its `Reviewed-on` date, so drift is
caught at PR time rather than in production.
