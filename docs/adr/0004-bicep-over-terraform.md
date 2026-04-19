---
status: accepted
date: 2026-04-19
deciders: csa-inabox platform team
consulted: security, governance, dev-loop
informed: all
---

# ADR 0004 — Bicep over Terraform as primary IaC (for now; Terraform path planned)

## Context and Problem Statement

CSA-in-a-Box provisions Azure landing zones (DMLZ + DLZ), data services,
networking, and governance policies. We need a single primary IaC language
for the core modules (`deploy/bicep/DMLZ/`, `deploy/bicep/DLZ/`,
`deploy/bicep/gov/`). Federal and CCoE teams tend to standardize on either
Bicep or Terraform, and the choice affects contributor velocity, API
coverage, and multi-cloud readiness.

## Decision Drivers

- **First-party Azure API coverage** — new Azure resource types and API
  versions are available in Bicep on day one via ARM; Terraform's AzureRM
  provider lags by weeks to months.
- **Azure Government parity** — Bicep uses the ARM control plane that is
  identical across Commercial, Gov, and sovereign clouds.
- **Microsoft CAE/CCoE alignment** — the Enterprise-Scale Landing Zone
  reference (see `deploy/bicep/landing-zone-alz/`) is authored in Bicep;
  adopting Terraform would require maintaining a fork.
- **Contributor skill pool** — our primary contributors are Azure-native
  platform engineers; Bicep authoring is lower friction than HCL for this
  audience.
- **Escape hatch** — we must not paint ourselves into a corner; a Terraform
  path should remain viable for customers with a Terraform-primary CCoE.

## Considered Options

1. **Bicep (chosen)** — ARM-native, day-one API coverage, CAE-aligned, no
   state file to manage.
2. **Terraform (AzureRM + AzAPI providers)** — Multi-cloud, large community,
   mature module registry, but state-file management and provider lag.
3. **Pulumi** — General-purpose languages, multi-cloud, but small Azure
   community and another binary in the toolchain.
4. **Azure CLI scripts** — No IaC benefits; rejected on day one.

## Decision Outcome

Chosen: **Option 1 — Bicep** for all core modules. A Terraform path is
planned (not implemented) and will be opened once the module surface is
stable, via either a Bicep-to-Terraform generator or a parallel
Terraform-authored module set that consumes the same parameter contracts.

## Consequences

- Positive: Day-one Azure API coverage, including preview features needed
  for Purview, Unity Catalog, and Fabric.
- Positive: No state-file custody problem — ARM is the state store; reduces
  ATO surface area.
- Positive: Aligns with the Enterprise-Scale Landing Zone canonical pattern
  (`deploy/bicep/landing-zone-alz/`).
- Positive: Low contributor friction for Azure-native engineers; `what-if`
  is built in.
- Negative: Not multi-cloud; explicitly locks core IaC to Azure.
- Negative: Ecosystem is smaller than Terraform's — fewer public modules to
  borrow from.
- Negative: Linting/testing tooling (Bicep linter, PSRule) is less mature
  than Terraform's (tflint, checkov, terratest).
- Neutral: A Terraform path remains open; customers with a Terraform-primary
  CCoE are not blocked from contributing a parallel module tree.

## Pros and Cons of the Options

### Option 1 — Bicep
- Pros: ARM-native; day-one API coverage; no state file; Gov parity; CAE
  aligned; low authoring friction for Azure engineers; `what-if` built in.
- Cons: Azure-only; smaller ecosystem; less mature test tooling.

### Option 2 — Terraform
- Pros: Multi-cloud; huge module registry; mature testing (terratest);
  mature policy-as-code (Sentinel / OPA).
- Cons: Provider lag behind ARM; state-file custody (storage, locking,
  encryption) is a compliance burden; AzAPI required for preview features
  adds complexity.

### Option 3 — Pulumi
- Pros: Real programming languages; multi-cloud; strong type system.
- Cons: Small Azure user base; extra runtime in the toolchain; state-file
  issues similar to Terraform.

### Option 4 — Azure CLI scripts
- Pros: Zero tooling overhead.
- Cons: No idempotency; no drift detection; not IaC in any meaningful sense.

## Validation

We will know this decision is right if:
- New vertical examples can stand up a landing zone in <90 minutes using
  only Bicep modules.
- Azure preview features required for Purview / Unity Catalog / Fabric
  land in our modules within one release cycle of GA.
- If more than one enterprise customer blocks adoption on Terraform-only
  CCoE policy, accelerate the Terraform path to parity.

## References

- Decision tree: n/a (no dedicated decision tree; see architecture matrix)
- Related code: `deploy/bicep/DMLZ/main.bicep`, `deploy/bicep/DLZ/main.bicep`,
  `deploy/bicep/gov/main.bicep`, `deploy/bicep/bicepconfig.json`,
  `deploy/bicep/landing-zone-alz/`
- Framework controls: NIST 800-53 **CM-2** (baseline configuration via
  versioned IaC), **CM-3** (change control through PR review), **CM-6**
  (configuration settings enforced in code), **SA-10** (developer
  configuration management). See `governance/compliance/nist-800-53-rev5.yaml`.
- Discussion: CSA-0087
