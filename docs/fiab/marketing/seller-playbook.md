# Seller Playbook

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


For Microsoft field sellers + federal account teams. How to qualify,
pitch, handle objections, and close on CSA Loom.

## Who CSA Loom is for

| Segment | Why Loom fits |
|---|---|
| Federal civilian agencies (FedRAMP High / IL4) | Fabric `Forecasted` in their boundary; Loom is available today |
| DoD components (IL4 / IL5) | Same — plus IL5 in v1.1 |
| Intelligence community (where on Azure Gov) | IL5 fit; IL6 out of scope |
| State + local government (StateRAMP / CJIS) | Standards-aligned |
| Federal contractors (CMMC L2/L3, ITAR) | GCC-High deploys |
| Regulated commercial (healthcare, regional banks) | HIPAA BAA covers Gov; pharma FDA Part 11 |

## Qualifying questions (5)

Ask these in the first conversation:

1. **"Are you blocked from Fabric by audit boundary?"**
   - Yes → strong Loom fit
   - No (Commercial) → suggest Microsoft Fabric directly; Loom is
     primarily for blocked customers

2. **"What's your timeline for analytics modernization?"**
   - Now / 6 mo → Loom delivers in 60-100 min deploy + 6 mo to
     production maturity
   - 18+ mo → maybe wait for Fabric Gov GA if it lines up

3. **"Are you on Azure Gov today?"**
   - Yes (GCC-H / IL4) → Loom v1 ready
   - Yes (GCC) → Loom v1 works but Direct Lake parity unavailable
   - Yes (IL5) → Loom v1.1 (+3 mo); deploy in GCC-H first if can't wait
   - No → Migrate to Azure Gov first; then Loom

4. **"Do you have a Power BI Premium investment to extend?"**
   - Yes → Loom integrates natively; Direct-Lake-Shim refreshes
     existing semantic models
   - No → Loom requires Power BI Premium; factor into cost

5. **"What's your data sovereignty position?"**
   - Strict (ITAR, IL5, sovereign-only) → Loom in GCC-H / IL5 is
     the answer
   - Flexible (hybrid Commercial / Gov) → Loom + Fabric Commercial
     hybrid topology

## Discovery framework

After qualifying, dig deeper:
- Data volume per DLZ (sizes capacity SKU)
- Workload mix (Spark-heavy / SQL-heavy / streaming / BI / ML)
- Existing Synapse / Databricks investment
- Existing Power BI semantic models + report estate
- Real-time / Activator-style alerting needs
- AI / NL-Q&A appetite
- Compliance attestation timeline

## Three pitch variants

Each variant is a *fully written, run-on-rails* doc — minute-by-minute
agenda, narration script, Q&A bank. Don't wing these.

### 30-min CIO pitch — [open the script →](pitches/30-min-cio-pitch.md)

Slides 1-8, 11, 13, 14 from the [pitch deck](pitch-deck.md). Focus on
"why now" + "how we fit your boundary" + "forward migration." Goal:
get a *yes* to the 60-min deep-dive with their architects.

### 60-min architecture deep-dive — [open the script →](pitches/60-min-architecture-deep-dive.md)

Full pitch deck + per-workload parity matrix + custom parity services
+ live Console demo + architect Q&A bank (15 most-likely questions
written out). Goal: earn the technical buy-in and book the 2-hour
evaluation.

### 2-hour technical evaluation — [open the script →](pitches/2-hour-technical-evaluation.md)

Hands-on `azd up` against the customer's test subscription, live.
Pre-flight checklist + workshop preview + 35-55 minute live deploy +
post-deploy bootstrap + Console walkthrough + decision-matrix
worksheet + commitment ask. Goal: leave with a signed-off "we'll
deploy production in [N weeks]."

## Objection handling — top 10

### 1. "Why not just wait for Fabric Gov GA?"

"Microsoft hasn't published a Gov GA date. Based on the normal
pattern, IL5 is 2027+ at earliest. Loom gives you the Fabric
experience today, with a clean forward-migration path. You're not
betting against Fabric — you're investing in a head-start that
becomes Fabric when Fabric arrives."

### 2. "What if we already use Databricks?"

"Loom is built on Databricks (primary Spark compute). If you have
existing Databricks workspaces, Loom extends them with the Console
+ parity services + Setup Wizard. Zero rewrite of your existing
Databricks notebooks."

### 3. "What's the lock-in?"

"Bicep + open-source + Microsoft 1P services. Every byte of data
is in storage accounts you own. Every secret is in your Key Vault.
When Fabric reaches your boundary, OneLake shortcut + 1:1 artifact
port. No proprietary format Loom-specific that you can't migrate
out of."

### 4. "How much does it cost?"

"Loom IP is free in v1. You pay only for Azure consumption
underneath — Databricks DBU, ADX vCore-seconds, Power BI Premium
F-SKU, ADLS storage, AOAI tokens. Sample F8 deployment ~$3-5K/month
in Commercial; +10-25% in Gov."

### 5. "Who supports it?"

"Microsoft federal field + customer success. GitHub Issues for
public; Microsoft internal Teams channel for federal accounts.
Loom is built and maintained by the CSA-in-a-Box team."

### 6. "What if our audit team rejects it?"

"Per-boundary `.bicepparam` files map exactly to FedRAMP High + IL4 /
IL5 audit boundaries. Every Azure service in scope is documented
with its audit posture. Manual SOC pipeline replaces Defender for
Cloud AI Threat Protection in Gov. See `docs/fiab/compliance/` for
the audit-team-ready documentation."

### 7. "Can we deploy it ourselves?"

"Yes — `azd up` works in your own environment. Loom is open-source
under the csa-inabox repo. You don't need to engage Microsoft for
the platform deploy. Microsoft engagement makes sense for the 5-day
workshop + initial CoE establishment."

### 8. "What about the Direct Lake gap?"

"We're honest about this. Fabric's Direct Lake gives sub-second
freshness via a proprietary VertiPaq transcoder. Loom gives 5-30
second freshness via a warm-cache materializer on Power BI Premium
Import. For most analytical workloads, 5-30 s is acceptable. For
workloads that require sub-second, wait for Fabric Gov GA."

### 9. "How does this work with our existing Synapse / ADF investment?"

"Loom embeds Synapse Serverless as the Gov SQL surface (since
Databricks SQL Warehouse isn't in Gov yet). Your existing ADF
pipelines work unchanged. Loom doesn't replace your Synapse Dedicated
SQL Pool today — that's a separate decision."

### 10. "Can it run in our existing tenant?"

"Yes — Loom deploys into your existing Entra tenant + Azure
subscriptions. Multi-sub mode supports adding new DLZs over time
as you onboard agencies / domains. Single Entra tenant + N Azure
subs is the canonical pattern."

## Competitive positioning

When a customer is weighing a non-Microsoft offering, lead with Loom's own
strengths rather than attacking the alternative. Where the competitor has a
genuine advantage, say so honestly and verify against the vendor's current
documentation.

| Alternative being considered | How Loom is positioned |
|---|---|
| Independent cloud data warehouse (Gov) | Loom is Fabric-aligned, giving a forward-migration story into Microsoft Fabric as it reaches the boundary. A standalone competitor's offering is operated independently of Fabric, so that path isn't native to it. |
| Independent operational-analytics platform (IL5) | Loom typically has lower TCO and is open-source under the covers, with a forward-migrate-to-Fabric path. Where a competitor's offering brings mature, opinionated mission tooling, note that honestly. |
| Databricks Gov standalone | Loom is built on Databricks and adds the SaaS feel, parity services, and Setup Wizard. A customer already running Databricks gains the Console, Direct-Lake-Shim, Activator, and Data Agents on top. |
| Competitor analytics on another government cloud | Loom keeps you on Azure (existing Microsoft EA, Entra ID, Power BI investment). Cross-cloud reads remain possible via Loom Shortcuts where the data lives elsewhere. |

## Pricing guidance

Loom is free in v1; underlying Azure consumption only.

When customer asks about future pricing:
- "Pricing model is currently deferred to backlog. When we resurface,
  it'll likely be a flat fee per capacity SKU + metered overage per
  DLZ — mirroring Fabric's F-SKU billing intuition."
- "v1 + v1.1 are free in your tenant; you pay only for Azure
  consumption. You're not making a long-term Loom-pricing
  commitment by deploying today."

## Account-team motion

| Stakeholder | Engage |
|---|---|
| Customer CIO / CDO | 30-min pitch deck |
| Customer Architects | 60-min deep-dive + live demo |
| Customer Audit / Security | `docs/fiab/compliance/` walk-through |
| Customer Platform team | `azd up` walk-through |
| Customer Procurement | Discuss Azure consumption + free Loom IP |
| Microsoft CSU (federal) | Engage for IL5 v1.1 promotion |

## Hand-off to delivery

After contract close:
- Engage CSA-in-a-Box CSU for 5-day Cloud CoE workshop
- Microsoft federal architect for initial deployment review
- Support escalation: GitHub Issues + internal Microsoft Teams
  channel
- Quarterly check-in: capacity utilization + Fabric Gov GA tracking

## Trial / POV

F2 capacity supports trial deploys. v1 is free anyway. Suggest:
- Week 1: Deploy `azd up` to customer staging sub
- Week 2: Walk through tutorials 01-05 with customer team
- Week 3: Customer designs first production workload
- Week 4: Workshop kickoff for full Cloud CoE engagement

## Customer success stories template

Per [[writing-voice-no-customer-framing]], success stories use
generic federal-mission framing:

> "A federal civilian agency processing CUI under FedRAMP High
> deployed CSA Loom into their existing Azure Government tenant in
> [N hours]. By [month M], they had [N workloads] migrated from
> their legacy on-prem analytics stack. Their projected Fabric
> migration window is [Q/Y] — Loom is their bridge."

## Internal Microsoft enablement

- 90-day field activation plan: [federal pitch deck](federal-pitch.md)
- Technical specialist certification: pending v1 GA
- Engagement tracking: GitHub Issues with `csa-loom` label
- Pricing approval matrix (post-v1.1): TBD per CSU process

## Related

- [Pitch deck](pitch-deck.md)
- [Demo script](demo-script.md)
- [Battlecard vs Fabric Commercial](battlecard-fabric.md)
- [Federal pitch variant](federal-pitch.md)
