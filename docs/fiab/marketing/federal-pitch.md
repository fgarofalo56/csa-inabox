# Federal Account-Team Pitch Track

> **Comparative positioning note.** This document is written from the
> perspective of Microsoft Azure, Cloud Scale Analytics, and CSA Loom. Any
> description of third-party or competing products, services, pricing, or
> capabilities is derived from **publicly available documentation and sources**
> believed accurate at the time of writing, and is provided for **general
> comparison only**. We do not claim expertise in, or authority over, any
> non-Microsoft product or service; the respective vendor's official
> documentation is the authoritative source for their offerings, which may
> change over time. Nothing here is intended to disparage any vendor — where a
> competing product has genuine advantages, we aim to note them honestly.
> Verify all third-party details against the vendor's current official
> documentation before making decisions.


Tailored variant of the [pitch deck](pitch-deck.md) for Microsoft
federal account teams (account exec + technical specialist).

## What differs from the standard pitch

The standard pitch is audience-agnostic. The federal variant
emphasizes:
- FedRAMP High inheritance
- ITAR considerations
- CMMC L2 / L3 readiness
- CNSSI 1253 control mapping at IL5
- HIPAA BAA scope in Gov
- StateRAMP applicability for state customers
- Federal procurement timeline + Azure consumption commit options

## Federal-specific slides (replace standard slides 6, 14, 15, 19)

### Replacement slide 6 — Federal deployment paths

| Path | Federal fit |
|---|---|
| `azd up` CLI | Most federal platform teams have CLI workflows + custom CI/CD |
| Deploy-to-Azure button | Federal architects evaluating in customer-controlled subs |
| Marketplace Managed App | **Deferred to backlog** — federal customers prefer customer-managed deploy anyway |
| Microsoft federal CSU engagement | Recommended for IL5 v1.1 promotion + 5-day workshop |

### Replacement slide 14 — Federal customer value

1. **Audit-boundary alignment** — per-boundary `.bicepparam` matches
   FedRAMP High / IL4 / IL5 cleanly
2. **No publisher persistent access** — customer-managed deploy
   default; no Microsoft access to federal subs post-install
3. **Sovereignty controls** — all controls in customer's tenant; HSM
   keys customer-managed at IL5
4. **Forward to Fabric Gov** — when Fabric GAs, OneLake shortcut +
   1:1 artifact port; zero rewrite
5. **Free in v1** — no procurement friction; no pricing model lock-in

### Replacement slide 15 — Federal cost framing

- CSA Loom IP free in v1
- Customer pays only for Azure consumption underneath (~$3-5K/mo
  Commercial baseline; +10-25% in Gov-H)
- Eligible for MACC (Microsoft Azure Consumption Commit) where
  applicable
- No annual Loom subscription; no per-user licensing; no per-data-
  volume fees

### Replacement slide 19 — Federal Q&A (top 5 likely questions)

#### "How does this work with our ATO?"

Per-boundary documentation in `docs/fiab/compliance/` is structured
for audit teams. NIST 800-53 r5 control mapping, CMMC L2 / L3
extension, HIPAA BAA scope, ITAR considerations — all per-boundary.

Customer's SSP (System Security Plan) can incorporate Loom components
by reference. We provide:
- Per-component compliance attestation
- Per-boundary `.bicepparam` showing what's deployed where
- Sentinel rules that satisfy NIST 800-53 SI-7 / AU-6 controls

#### "What about IL6 / Top Secret?"

Out of scope. CSA Loom is not authorized in Azure Government Secret.
Customers with IL6 / TS requirements should engage their sponsor
for separate ATO; potentially deploy a sister Loom-Secret project
(not on the v1/v1.1/v2 roadmap).

#### "How does Defender for Cloud AI Threat Protection work in Gov?"

It doesn't — Defender AI TP is Commercial-only. Loom ships a manual
SOC pipeline (Microsoft Sentinel + Content Safety log wiring + self-
hosted Presidio for PII) that gives equivalent visibility. See
[Defender AI workaround](../compliance/defender-ai-workaround.md).

#### "Can we use Loom in our existing GCC-High tenant?"

Yes. `gcc-high.bicepparam` deploys against your existing Azure
Government subscription, using your existing M365 GCC-High tenant
identity. Multi-sub mode supports your existing per-agency
subscription pattern.

#### "What about CMMC L2 / L3 attestation?"

Loom contributes to multiple CMMC practice families (AC, AU, CM, IA,
IR, MA, MP, RA, SC, SI). Customer is responsible for full L2 / L3
attestation including workforce + personnel security practices. See
[CMMC 2.0 L2 extension](../compliance/cmmc-2.0-l2-fiab.md).

## Federal-specific use cases to reference

| Use case | Audience |
|---|---|
| [Federal Data Mesh](../use-cases/federal-data-mesh.md) | Multi-agency federal departments |
| [Multi-Agency Onboarding](../use-cases/multi-agency-onboarding.md) | Federal CIO / shared services |
| [Direct-Lake Replacement](../use-cases/direct-lake-replacement.md) | Customers migrating from competing BI / analytics tools or Power BI Report Server |
| [Sovereign AI Agents](../use-cases/sovereign-ai-agents.md) | Federal AI workloads under sovereignty constraints |
| [Hybrid Fabric Commercial + Loom Gov](../use-cases/hybrid-topology.md) | Federal customers with both Commercial + Gov estates |

## Pre-engagement homework (account team)

Before the federal account meeting:
1. Verify customer's current Azure Gov boundary (GCC / GCC-H / IL5)
2. Confirm Fabric availability in their boundary (currently
   `Forecasted` everywhere in Gov)
3. Inventory existing Synapse / ADF / Databricks / Power BI footprint
4. Identify primary compliance constraint (FedRAMP H / IL4 / IL5 /
   ITAR / CMMC L2/L3 / HIPAA / IRS 1075)
5. Pre-load slides + demo environment

## Engagement timeline (federal sales cycle)

| Phase | Timeline | Action |
|---|---|---|
| Discovery | Weeks 1-2 | 30-min pitch + qualifying questions |
| Architecture | Weeks 3-4 | 60-min deep-dive + live demo |
| POV | Weeks 5-8 | `azd up` to customer staging sub; walk tutorials |
| Production planning | Weeks 9-12 | 5-day Cloud CoE workshop; architecture review |
| Production deploy | Month 4 | Customer-led deploy; CSU support |
| Operations | Ongoing | Quarterly check-ins; Fabric Gov GA tracking |

## Federal stakeholders to engage

| Role | Why |
|---|---|
| Federal CIO | Strategic alignment with Fabric direction + sovereignty |
| Federal CDO | Data mesh / governance + analytics modernization |
| ATO authorizing official | Compliance posture per boundary |
| Mission owner / domain lead | Per-domain Workspace planning |
| Federal procurement | Free in v1 + Azure consumption commit |
| Microsoft federal CSU | Workshop delivery + IL5 v1.1 promotion |

## Related

- [Pitch deck](pitch-deck.md) — base deck this variant extends
- [Seller playbook](seller-playbook.md) — qualifying + objection
  handling
- [Battlecard vs Fabric](battlecard-fabric.md)
- Compliance: [Compliance index](../compliance/index.md)
