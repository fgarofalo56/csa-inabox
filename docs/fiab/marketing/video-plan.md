# Video Walkthrough Plan

11 videos, ~56 minutes total content. Produced internally via OBS
Studio + DaVinci Resolve. Hosted on Microsoft Stream (Commercial) or
YouTube (public).

## Video catalog

| # | Title | Length | Audience | Production status |
|---|---|---|---|---|
| 1 | CSA Loom Overview | 3 min | Executive (CIO / CDO) | Script ready; not recorded |
| 2 | What's the install like | 4 min | Federal procurement | Script ready |
| 3 | Loom Console tour | 8 min | Architects | Script ready |
| 4 | Loom Setup Wizard conversation | 5 min | DevOps / Platform | Script ready |
| 5 | Direct Lake parity explained | 6 min | BI architects | Script ready |
| 6 | Activator rules deep-dive | 7 min | Real-time / IoT teams | Script ready |
| 7 | Data Agents tutorial | 6 min | Data scientists | Script ready |
| 8 | Mirroring zero-ETL demo | 5 min | Data engineers | Script ready |
| 9 | Forward migration to Fabric | 4 min | Strategy / CIO | Script ready |
| 10 | Hybrid Fabric + Loom topology | 5 min | Architects | Script ready |
| 11 | 5-day workshop preview | 3 min | All | Script ready |

## Production pipeline

Per existing `learn/multimedia/video-tutorials/` patterns:

| Stage | Owner | Deliverable |
|---|---|---|
| Script | This file (per-video sections below) | Markdown |
| Storyboard | Multimedia team | Per-video frame-by-frame outline |
| Recording | Multimedia team via OBS Studio | Raw .mov/.mp4 |
| Post-production | Multimedia team via DaVinci Resolve | Edited .mp4 |
| Closed captions | Auto-generated then human-reviewed | .srt |
| Hosting | Microsoft Stream + YouTube fallback | URL |
| WCAG 2.1 AA compliance | Multimedia team | Verified |

## Per-video scripts

### Video 1 — CSA Loom Overview (3 min)

```
[0:00] Title card: "CSA Loom — The Microsoft Fabric Experience in
       Your Azure Government Tenant"

[0:05] B-roll: federal agency datacenter

[0:10] Voice-over: "Microsoft Fabric is the strategic unified
       analytics SaaS platform. But Fabric isn't yet available in
       any US Government cloud — and Microsoft has not published a
       Gov GA date."

[0:30] Cut to: Console screenshot

[0:35] VO: "CSA Loom is the bridge. A productized, Azure-native
       parity layer that gives you the Fabric workspace experience
       inside your existing Azure tenant — federal, DoD, IC, state +
       local, defense industrial base."

[1:00] Quick cuts of: Console panes, Setup Wizard chat, parity
       service icons

[1:30] VO: "Three things matter: deploy fast, feel like Fabric,
       migrate cleanly. Loom delivers all three."

[2:00] Show forward-migration diagram

[2:15] VO: "When Fabric reaches your boundary, your Delta data
       becomes OneLake shortcuts. Zero data movement. Your dbt + KQL
       + Purview port 1:1. You're not trapped in Loom; you're
       bridged into Fabric."

[2:45] Closer: "Learn more at docs.csa-loom.example.com"

[3:00] End card
```

### Video 2 — What's the install like (4 min)

Screen recording of actual `azd up` install (sped 4x). Voice-over
narrates each phase + cost expectations.

### Video 3 — Loom Console tour (8 min)

Screen recording walking each of the 12 v1 panes. Workspace creation,
lakehouse browse, warehouse query, notebook tour, KQL editor,
catalog, activator, data agents, monitoring, admin.

### Video 4 — Loom Setup Wizard conversation (5 min)

Screen recording of the conversational deploy of a new DLZ. Shows
live `.bicepparam` preview pane.

### Video 5 — Direct Lake parity explained (6 min)

Whiteboard-style explainer + benchmark live demo:
- Why Direct Lake is unique (VertiPaq transcoder)
- Why Loom can't fully match (no OSS DAX engine on columnar)
- What we ship instead (Premium Import + warm-cache materializer)
- Benchmark: Delta commit → 15 s refresh vs Fabric's sub-second

### Video 6 — Activator rules deep-dive (7 min)

Tutorial-style. Walks through authoring a rule, the NRules
evaluation, the Redis state machine for `andStays`, action dispatch.

### Video 7 — Data Agents tutorial (6 min)

NL Q&A demo. Configure agent → test queries → show NL2SQL +
identity passthrough.

### Video 8 — Mirroring zero-ETL demo (5 min)

Source Cosmos DB → Mirroring Engine → Bronze Delta. Real-time CDC
visible.

### Video 9 — Forward migration to Fabric (4 min)

Screen recording + diagram. Show `fiab-migrate snapshot → plan →
execute` against a test Fabric workspace. OneLake shortcut creation
+ same data accessible from Fabric.

### Video 10 — Hybrid Fabric + Loom topology (5 min)

Whiteboard explainer of cross-cloud B2B + APIM bridges + data
residency. Most common federal customer pattern.

### Video 11 — 5-day workshop preview (3 min)

Highlight reel from each day of the Federal CoE workshop.

## Distribution

| Channel | Use |
|---|---|
| Microsoft Stream (internal) | Field enablement; tagged `csa-loom` |
| YouTube (public CSA channel) | Customer-facing; gated by viewer if customer is federal |
| Docs site embed | Embedded in `docs/fiab/marketing/video-plan.md` once published |
| Microsoft Learn (federal modules) | Embedded in customer training paths |

## Cadence

- Initial recordings: ship with v1 GA
- Refresh: annually OR on major Loom version change
- New videos: per major feature add (Fabric IQ family in v2 → new
  video)

## Accessibility

- Closed captions: human-reviewed
- Audio descriptions: included for visual-heavy segments
- Pacing: 130-160 wpm
- Color contrast: meet WCAG AA in slides

## Related

- [Pitch deck](pitch-deck.md) — slides referenced in some videos
- [Demo script](demo-script.md) — live demo cousin of videos 3-8
- Production guides: existing `learn/multimedia/video-tutorials/guides/`
