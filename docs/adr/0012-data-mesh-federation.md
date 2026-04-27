---
status: accepted
date: 2026-04-20
deciders: csa-inabox platform team
consulted: federal-architects, data-governance
informed: all
---

# ADR 0012 — Data-mesh federation model: contract-driven, Purview-governed, portal-surfaced

## Context and Problem Statement

README and PLATFORM_SERVICES claim data-mesh. The implementation had
identical dbt `profiles.yml` and `packages.yml` across domains, no
per-domain CODEOWNERS entries for most domains, no per-domain Bicep
scoping, and no CI enforcement of the `contract.yaml` files that
already exist in each domain's `data-products/`. The mesh was
centralized-pretending-federated — architect perspective AQ-0027.

We need an explicit, minimal federation model the current codebase
can reach incrementally without forcing a monorepo re-org.

## Decision Drivers

- **Honest scope** — claim what we ship, ship what we claim. This
  mirrors the posture already locked in by ADR-0011 (multi-cloud)
  and ADR-0010 (Fabric-parity).
- **Contract-first** — `contract.yaml` is the load-bearing artifact;
  every downstream stage (CI, catalog, marketplace) keys off it.
- **Purview-primary** — catalog, classification, and lineage are
  Purview's job (ADR-0006); the mesh leans into that, not around it.
- **Portal-surfaced** — the marketplace is the consumer UX; federation
  is visible to consumers there, not in domain Git trees.
- **CI-enforceable** — domains that want to merge must pass the
  contract-validation CI gate; enforcement is automatic, not tribal.
- **No re-org churn pre-1.0** — adopt mesh *semantics* without moving
  code.

## Considered Options

1. **Full re-org (per-domain subrepos, per-domain release cadence)** —
   the most faithful mesh. Requires standing up N subrepos, N release
   pipelines, cross-repo dependency wiring, and a private package
   index for shared dbt macros. Too much churn for pre-1.0; defer.
2. **Contract-first in-monorepo (CHOSEN)** — adopt mesh semantics via
   `contract.yaml` + CI validation + Purview registration + portal
   marketplace without moving code. Per-domain CODEOWNERS and path-
   scoped CI provide the boundary enforcement.
3. **Keep centralized** — honest with the current implementation but
   contradicts the stated vision. Reject; misaligns with §3 of the
   vision document.

## Decision Outcome

Chosen: **Option 2 — Contract-first in-monorepo**.

Adopt a four-stage pipeline as the canonical mesh federation model:

1. **Domain publishes `contract.yaml`** — schema, SLA, classification,
   owner, and data-product lineage declarations live in each
   `domains/<domain>/data-products/<product>/contract.yaml`. The
   contract is the unit of publication; nothing else ships without it.
2. **CI validates** — `.github/workflows/validate-contracts.yml`
   runs on every PR touching `domains/<domain>/` and fails merge if
   contracts are malformed, schemas drift, required metadata
   (`apiVersion`, `kind`, `metadata`, `schema`, `sla`, `quality_rules`)
   is missing, or classifications are absent. Validation is backed by
   `csa_platform/governance/contracts/contract_validator.py`.
3. **Purview registers** — on merge to `main`, the platform's Purview
   bootstrap job reads every `contract.yaml` and registers
   business-glossary terms, sensitivity labels, and lineage edges per
   `csa_platform/governance/purview/`. Purview is the system of record
   for catalog state; the contract is the source of truth.
4. **Portal marketplace surfaces** — the FastAPI marketplace router
   lists published data products from Purview, joined with
   `contract.yaml` metadata. Access requests flow through
   `portal/shared/api/routers/access.py`, gated by the CSA-0002
   domain-scoping middleware and classification caps.

## Boundary enforcement (minimum viable mesh)

The code does not need to move, but the *responsibility* for each
domain must be legible. Three enforcement points:

- **CODEOWNERS (per-domain)** — `.github/CODEOWNERS` lists a distinct
  owner set for every domain under `domains/`. Central platform team
  owns `csa_platform/`, `deploy/`, `portal/shared/api/`, and `.github/`.
  Domain PRs require domain-owner approval; platform PRs require
  platform-team approval.
- **CI scoping (path-triggered)** — the existing
  `.github/workflows/test.yml` and `validate-contracts.yml` are
  path-filtered. Domain-specific tests live under
  `domains/<domain>/tests/` and are triggered only when that domain's
  paths change. This prevents a breakage in `finance` from blocking a
  merge in `sales`.
- **Bicep scoping (optional, roadmap)** — each domain **MAY** have
  its own `domains/<domain>/deploy/` Bicep for DLZ-spoke resources,
  rooted at the shared DMLZ governance layer. Not mandatory for v1;
  tracked as roadmap. Central DMLZ-layer Bicep remains under
  `deploy/bicep/DMLZ/`.

## Consequences

- Positive: **Honest mesh** — the vision §3 claim becomes defensible
  against a code walkthrough. The `contract.yaml` files in the tree
  finally have semantic weight.
- Positive: **Low-churn path** — no subrepo split, no release-cadence
  fork; existing monorepo tooling (uv, make, pytest) keeps working.
- Positive: **Composable forward** — if we later promote a domain to
  a subrepo, the `contract.yaml` + Purview + marketplace pipeline is
  unchanged; only the Git layout moves.
- Positive: **Purview-native** — does not reinvent the catalog; leans
  on ADR-0006 choices.
- Positive: **Portal-native** — consumers discover data products in
  one place (the marketplace), not by spelunking the Git tree.
- Negative: **Per-domain release cadence not yet real** — merges
  still go through one `main`; a true mesh has independent domain
  releases. Tracked for future work.
- Negative: **CODEOWNERS alone is advisory** — GitHub branch
  protection must be configured to *require* code-owner review for
  the boundary to be enforced. Operational, not architectural.
- Negative: **Bicep per-domain is deferred** — today domain infra
  still lives under central `deploy/bicep/`. Fine for v1; revisit
  when a domain needs resource-group isolation.

## Pros and Cons of the Options

### Option 1 — Full re-org (per-domain subrepos)

- Pros: Maximum mesh fidelity; per-domain release cadence; independent
  blast radius; classic Zhamak-Dehghani-shaped org/tech alignment.
- Cons: 3–6 months of pipeline work; cross-repo dependency resolution
  for shared dbt macros; duplicated CI boilerplate; large
  onboarding cost for new contributors; blocks on v1 delivery.

### Option 2 — Contract-first in-monorepo (CHOSEN)

- Pros: Ships today on existing tooling; `contract.yaml` is already in
  the tree; Purview + marketplace pipeline already scaffolded; path-
  triggered CI already in place; CODEOWNERS alone enforces ownership.
- Cons: No true per-domain release cadence; single `main` branch
  remains the choke point; Bicep per-domain deferred.

### Option 3 — Keep centralized

- Pros: Zero net-new work; already how the code is laid out.
- Cons: Contradicts vision §3; `contract.yaml` files become
  decorative; federal customers evaluating mesh claims will find
  them indefensible under a walkthrough.

## Validation

We will know this decision is right if:

- Two independent domains can publish a data product end-to-end
  (`contract.yaml` → CI green → Purview registered → portal
  marketplace listing) without touching shared `csa_platform/` code.
- Every new data product merges with domain-owner approval only,
  not platform-team approval; platform-team approval remains required
  only for `csa_platform/`, `deploy/`, `portal/shared/api/`, and
  `.github/` paths.
- Classification drift between the `contract.yaml` and Purview is
  zero after one full reconciliation cycle post-merge.
- More than half of new data-product PRs pass `validate-contracts`
  on the first run within one quarter of adoption.

If every new data product still requires platform-team edits beyond
CODEOWNERS review, revisit the model — likely option 1 becomes
necessary.

## References

- Vision §3 — governance-first data mesh — [`docs/VISION.md`](../../README.md)
- ADR-0006 Purview-primary catalog —
  [`./0006-purview-over-atlas.md`](./0006-purview-over-atlas.md)
- ADR-0008 dbt Core —
  [`./0008-dbt-core-over-dbt-cloud.md`](./0008-dbt-core-over-dbt-cloud.md)
- Marketplace router —
  [`portal/shared/api/routers/marketplace.py`](../../portal/shared/api/routers/marketplace.py)
- Access router (classification caps) —
  [`portal/shared/api/routers/access.py`](../../portal/shared/api/routers/access.py)
- Contract files —
  [`domains/`](../../domains/)` <domain>/data-products/<product>/contract.yaml`
- Contract validator —
  [`csa_platform/governance/contracts/contract_validator.py`](../../csa_platform/governance/contracts/contract_validator.py)
- Purview automation —
  [`csa_platform/governance/purview/`](../../csa_platform/governance/purview/)
- CI enforcement —
  [`.github/workflows/validate-contracts.yml`](../../.github/workflows/validate-contracts.yml)
- CODEOWNERS — [`.github/CODEOWNERS`](../../.github/CODEOWNERS)
- Framework controls: NIST 800-53 **AC-3** (access enforcement via
  domain CODEOWNERS + classification caps), **CA-2** (assessments via
  `validate-contracts` CI gate), **CM-3** (change control via
  contract-gated merges). Mapped in
  [`governance/compliance/nist-800-53-rev5.yaml`](../../csa_platform/governance/compliance/nist-800-53-rev5.yaml).
- Finding: **CSA-0128** / approved ballot item **E3** / **AQ-0027**.
