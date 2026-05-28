# 30-minute CIO pitch — CSA Loom

Audience: customer CIO / CDO / VP Data. Goal: get a *yes* to a follow-up
60-minute architecture deep-dive with their architects in the room.

Use this script verbatim or trim. Slide refs are
[pitch-deck.md](../pitch-deck.md) slide numbers.

---

## Agenda (30 min)

| Min | What | Slide |
|---|---|---|
| 0-2 | Frame: "Here's where Fabric is for federal in 2026" | 1 |
| 2-7 | The problem you have today | 2 |
| 7-12 | What CSA Loom is | 3, 4 |
| 12-17 | How it fits your tenant (boundary + identity + audit) | 7 |
| 17-21 | Honest gaps (build trust by saying what we DON'T do) | 8 |
| 21-25 | Forward migration to Fabric | 13 |
| 25-28 | Five-point value summary | 14 |
| 28-30 | Ask: "Can we book the 60-min deep-dive with your architects?" | 11 |

Skip slides 5, 6, 9, 10, 12, 15, 16, 17, 18 in the CIO pitch — they're
the architecture detail for the deep-dive.

---

## Narration — what to actually say

### Min 0-2 — Frame

> "Before we start, the punch line: Microsoft Fabric isn't generally
> available in Gov today. There's no published GA date for GCC-H or
> IL5 — best estimates put IL5 at 2027. Most federal customers I talk
> to are stuck in the same place: their analytics roadmap is *Fabric
> when it arrives*, but they need to ship workloads in 2026."

> "CSA Loom is what we built so you don't have to wait. It's the
> Microsoft Fabric *experience* — the workspace, the lakehouse, the
> semantic models, the real-time intelligence, the AI agents — running
> inside your existing Azure Government tenant *today*, and migrating
> forward to Microsoft Fabric one-for-one when Fabric reaches your
> boundary."

Pause here for the CIO to react. If they push back ("just wait for
Fabric"), use objection-handler #1 from the [seller playbook](../seller-playbook.md).

### Min 2-7 — The problem (slide 2)

Talk through the three pain points:

1. *Audit boundary blocks Fabric.* Your audit team will reject any
   service not on the FedRAMP High / IL4 / IL5 attestation list.
   Fabric isn't on it.
2. *Your team has Synapse + Databricks investment.* You don't want to
   throw that out.
3. *Your stakeholders want Power BI + AI experiences NOW.* They've
   seen Fabric demos at conferences and they're asking why your
   tenant can't.

If the customer leans in on (1), they're audit-driven — you've found
the budget. If they lean on (3), they're stakeholder-driven and you
need to pull in their CISO too.

### Min 7-12 — What Loom is (slides 3, 4)

Slide 3 — vision. Loom = Fabric-experience + Azure-native + open-
source. Three sentences.

Slide 4 — what customers actually get. Walk the four bullets:
- Unified workspace experience (Fluent UI v9 Console)
- Push-button deploy (`azd up`, 60-100 min)
- Built for sovereignty (FedRAMP High day-one, IL4 day-one, IL5 v1.1)
- Forward migration is the goal (Delta tables become OneLake
  shortcuts; dbt models port 1:1; semantic models port via TMDL)

### Min 12-17 — Fit (slide 7)

Per-boundary support table. The CIO wants to hear "yes, this works
in OUR cloud" — Commercial, GCC, GCC-High, IL4, IL5 v1.1. Walk the
row that matches their boundary in detail; reference the others
quickly.

If they're FedCiv: Commercial+GCC variant.
If they're DoD / IC: GCC-High + IL5 v1.1.

### Min 17-21 — Honest gaps (slide 8)

This is the trust-builder. Open with:

> "I'm going to spend two minutes telling you what Loom *doesn't* do
> today, because if I oversell you here, your architects will reject
> the deep-dive."

Then walk the three honest gaps:
1. **Direct Lake parity** — Loom uses Power BI Premium *Import* with
   a warm-cache materializer. Sub-second queries are still seconds.
   When Fabric Gov arrives, Direct Lake ports in.
2. **Defender for Cloud AI Threat Protection** — Gov tenants don't
   have it yet. Loom replaces with Sentinel analytic rules + a Logic
   App playbook. Functional equivalent, manual SOC pipeline.
3. **Pricing model** — Loom is *free in v1* (you pay only Azure
   consumption). The future pricing model is deferred to backlog; no
   commitment today.

### Min 21-25 — Forward migration (slide 13)

This is the close. The CIO is hearing two things:
1. *Microsoft strategy alignment.* Loom is built BY the CSA-in-a-Box
   team using Microsoft 1P services. When Fabric Gov ships, it's the
   same team building both.
2. *Zero rewrite.* Delta → OneLake shortcut. dbt → 1:1. TMDL → 1:1.
   KQL → 1:1. Activator rules → 1:1.

> "You're not betting against Fabric. You're investing in a
> head-start that *becomes* Fabric when Fabric arrives."

### Min 25-28 — Five-point summary (slide 14)

Read all five. Don't editorialize:
1. Fabric-experience workspace in YOUR tenant
2. Push-button deploy
3. Built for sovereignty (per-boundary `.bicepparam`)
4. Forward migrates to Fabric 1:1
5. Free in v1 — you pay only Azure consumption

### Min 28-30 — The ask

> "If this is interesting, the next step is a 60-minute deep-dive
> with your architects. I'll bring the platform team; we'll walk
> through the per-workload parity matrix and live-demo the Console.
> Three weeks out — can your scheduler send invites?"

Get the deep-dive date on the calendar BEFORE you leave the meeting.

---

## Common questions (CIO-flavor — full bank in [seller playbook](../seller-playbook.md))

**"Why not just wait for Fabric Gov GA?"**
> "Microsoft hasn't published a Gov GA date. Best estimates put IL5
> at 2027+. Loom is the head-start that *becomes* Fabric when Fabric
> arrives."

**"How much does it cost?"**
> "Loom IP is free in v1. You pay only for Azure consumption
> underneath — Databricks DBU, ADX vCore-seconds, Power BI Premium,
> ADLS storage, AOAI tokens. Sample F8 deployment ~$3-5K/month in
> Commercial; +10-25% in Gov."

**"Who supports it?"**
> "Microsoft federal field + customer success. GitHub Issues for
> public; internal Microsoft Teams channel for federal accounts.
> Loom is built and maintained by the CSA-in-a-Box team."

**"What's the lock-in?"**
> "None. Bicep + open-source + Microsoft 1P services. Every byte of
> data is in storage accounts you own. Every secret is in your Key
> Vault. When Fabric arrives — clean migration."

---

## After the meeting

- Send a 1-page recap email within 24 hours (use [one-pager.md](../one-pager.md) as the basis)
- Book the 60-min deep-dive with their architect team
- Pre-share [parity matrix](../../parity-matrix.md) so architects come prepared
- Loop in CSU federal field rep for follow-up

## Related

- [60-min architecture deep-dive](60-min-architecture-deep-dive.md) — next-step doc
- [2-hour technical evaluation](2-hour-technical-evaluation.md) — for deeper-engaged accounts
- [Seller playbook](../seller-playbook.md) — full objection-handler bank + competitive positioning
- [Pitch deck](../pitch-deck.md) — slide source
- [One-pager](../one-pager.md) — leave-behind
- [Demo script](../demo-script.md) — used in the deep-dive
