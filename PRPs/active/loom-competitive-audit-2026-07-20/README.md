# CSA Loom Competitive Audit — 2026-07-20

A full competitive audit of **CSA Loom** (Next.js data/AI/analytics platform on Azure-native + OSS backends, unifying Microsoft Fabric, Power BI, Palantir Foundry, Databricks, and Azure AI Foundry under one sovereign-capable console with no hard Fabric dependency) against every major competitor, plus a burn-the-box vision and a buildable PRD.

## Deliverables

| File | What it is |
|---|---|
| `PARITY-MATRIX.md` | Unified graded parity matrix — overall scorecard (6 competitors) + 10 per-domain matrices (Data Eng, Warehouse, RTI, Semantic/BI, Ontology, ML/Serving, AI/Agents, Governance, Platform/Sovereignty, UX) + "where Loom already wins" (10 A+ structural advantages). |
| `FINDINGS-REPORT.md` | Executive findings — where Loom stands (B+/A− vs each competitor; IS the integration layer), consolidated P0/P1/P2 gap register (deduped across sections), UX debt to refactor, 12 burn-the-box flagship differentiators, 90-day + 6-month roadmap. |
| `PRD.md` | Buildable PRD "CSA Loom — Burn-the-Box: The #1 Data + AI + Agents Platform" — 11 workstreams (parity + net-new) with Problem/Deliverables/Acceptance per epic, 6-wave sequencing, die-hard-rule DoD, risks, PRP slicing. |

## Research inputs

| File | Cluster |
|---|---|
| `research/01-fabric-powerbi.md` | Microsoft Fabric (all 7 workloads) + Power BI — grade B+/A−; gaps = Direct Lake, OneLake shortcuts, report Format-pane. |
| `research/02-palantir-foundry.md` | Palantir Foundry + AIP (Weave epic) — grade B/B+; widest Foundry clone on Azure; gaps = object views, derived props, AIP-Logic studio, Workshop depth. |
| `research/03-databricks-aifoundry.md` | Databricks + Azure AI Foundry — grade B+/A−; gaps = Feature Store (D), Model Serving (C+), fine-tuning (F). |
| `research/04-frontier-ai-agents.md` | OpenAI / Anthropic / Google / xAI agentic platforms — grade B/B+; A+ on sovereignty + governed-data-plane action; gaps = tier-router, agent-builder polish, A2A. |
| `research/05-loom-baseline-ux-netnew.md` | Loom current-state inventory (by the numbers), cross-cutting UX audit, integration thesis, 10 burn-the-box net-new ideas. |

## The thesis in one line

Competitors make you the integration layer between their products; **Loom is the integration layer** — one console, one copilot, one compute currency (LCU), one governance plane, one sovereign push-button deploy — and that integration + sovereignty is the un-copyable moat.

## Top P0 gaps

1. Wire the model tier-router (no-op today — caps every AI surface).
2. Feature Store (D), Model Serving (C+), LLM fine-tuning (F).
3. OneLake zero-copy shortcuts engine; Direct Lake substitute; report Format-pane cards.
4. Ontology object views + instance viewer (the Foundry moat surface).

## Flagship burn-the-box bets

Ontology-Over-Everything · Closed-Loop Model Fabric · NL-to-Full-Estate · One-Canvas Cross-Workload Authoring · Sovereign Agent Mesh · Feature-Store-Over-Ontology · Governance-as-Code · MCP+A2A Sovereign Hub · Self-Driving Platform (LCU-Autopilot) · Time-Machine · Living Marketplace · Parity Autopilot.
