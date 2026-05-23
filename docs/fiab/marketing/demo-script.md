# Demo Script

Three variants for live + recorded CSA Loom demos.

## 5-minute lightning demo

Trade-show booth / executive briefing center context.

| Time | Action | Talk track |
|---|---|---|
| 0:00-0:30 | Open Loom Console; show Workspaces pane | "This is CSA Loom. Looks and feels like Microsoft Fabric, runs in your Azure Government tenant." |
| 0:30-1:30 | Open a Lakehouse, show tables, sample a query in Warehouse pane | "Same medallion pattern Fabric uses. UC / Purview governance underneath." |
| 1:30-3:00 | Open Notebook, run a Spark cell, show Copilot `/explain` magic | "Notebooks with Copilot — same Databricks engine, same notebook experience." |
| 3:00-4:30 | Open Semantic Model designer; trigger a Delta commit; show 15s refresh latency | "Direct Lake parity in 5-30 seconds via warm-cache materializer. Honest about the gap vs Fabric's sub-second." |
| 4:30-5:00 | Show architecture diagram + "deployed via azd in 60 min" | "All this — `azd up`, your tenant, full Bicep, free in v1." |

**Closer**: "Want a deeper look? Let's schedule 30 minutes."

## 30-minute technical demo

Full walkthrough for a federal architecture team.

### Setup (pre-demo)

- Loom deployed to demo sub (Commercial for fastest path)
- Sample dataset loaded into a test workspace
- Power BI Premium F-SKU active
- AOAI deployment in same region as Loom

### Script

1. **Marketplace install (recorded clip)** — 30 s
   - "We're starting from a recording because the actual install
     takes 60-100 min. Here's what the user sees: portal click → form
     → deploy."

2. **Live: Loom Setup Wizard** — 5 min
   - Walk through the conversational deploy of adding a new DLZ
   - Show the live `.bicepparam` preview
   - Confirm gate + deploy

3. **Live: Create a workspace via Console** — 3 min
   - Workspaces pane → + New Workspace
   - Watch deploy progress (5 min)
   - Open workspace home

4. **Live: Ingest via Mirroring Engine** — 3 min
   - Mirroring pane → + New Mirror
   - Configure Cosmos DB source
   - Watch CDC populate Bronze table

5. **Live: Transform Bronze → Silver → Gold** — 5 min
   - Open Notebook pane (Databricks)
   - Run a transform cell
   - Verify in Lakehouse pane

6. **Live: Catalog the Gold tables** — 2 min
   - Catalog pane → add sensitivity label
   - Show UC tags (Commercial) or Purview classifications (Gov)
   - Show lineage view

7. **Live: Semantic Model designer + Direct-Lake-Shim** — 4 min
   - Author TMDL model
   - Deploy
   - Trigger refresh — show 15s latency

8. **Live: Power BI report against the model** — 1 min
   - Open report in Power BI service
   - Show real-time data

9. **Live: Activator rule** — 3 min
   - Activator pane → + New Rule
   - Visual rule designer
   - Test fire — show Teams notification

10. **Live: Data Agent + test chat** — 3 min
    - Data Agents pane → + New Agent
    - Configure with example queries
    - Test chat: ask a natural-language question
    - Show NL → SQL generation + result + citation

11. **Tour Monitoring Hub** — 1 min
    - CU-equivalent dashboard
    - Per-engine query history
    - Cost dashboard

12. **Discuss per-boundary deltas** — 30 s
    - "Same Console, same UX, in Gov: Container Apps becomes AKS;
      UC becomes Purview-primary; Foundry Agent Service becomes MAF
      + AOAI direct. Customer-transparent."

**Closer**: Open Q&A.

## 60-minute deep-dive

Adds to the 30-min demo:
- Per-boundary Bicep walkthrough (10 min)
  - Show `commercial.bicepparam` vs `gcc-high.bicepparam`
  - Highlight dispatch differences (Container Apps → AKS, etc.)
- MCP-driven deploy from the wizard (5 min)
  - Show PIM-for-Groups JIT elevation
  - Show MCP tool call in Activity Log
- Forward migration tooling demo (10 min)
  - `fiab-migrate snapshot`
  - `fiab-migrate plan`
  - `fiab-migrate execute` against test Fabric workspace
  - Show OneLake shortcut + zero data movement
- Hybrid topology architecture (5 min)
  - Cross-cloud B2B + cross-cloud APIM
  - Loom Gov + Fabric Commercial side-by-side

## Demo environment requirements

- Loom deployed in a dedicated demo sub (or shared CSU demo sub)
- Pre-loaded sample data: NOAA daily weather (Tutorial 02 dataset)
- Cosmos DB test container (Tutorial 06)
- Test ADX cluster with synthetic IoT data (Tutorial 04)
- Test Power BI Premium workspace
- Pre-configured AOAI deployment

## Recorded video versions

Each variant has a recorded video version under [`video-plan.md`](video-plan.md):
- 5-min lightning → "CSA Loom Overview" video
- 30-min technical → "Loom Console Tour" + "Loom Setup Wizard" +
  "Direct Lake parity explained" videos
- 60-min deep-dive → "Per-boundary deploy walkthrough" + "Forward
  migration to Fabric" + "Hybrid topology" videos

## Troubleshooting during live demo

| Issue | Fallback |
|---|---|
| Deploy fails mid-demo | Switch to pre-deployed demo environment |
| Network slow in venue | Use recorded video for slow segments |
| Live Activator firing delayed | Use pre-fired rule log to show outcomes |
| Direct-Lake-Shim latency > 60s | Show Monitoring Hub historical data instead |

## Related

- [Pitch deck](pitch-deck.md) — the 20-slide deck this demo complements
- [Seller playbook](seller-playbook.md) — qualifying + objection handling
- [Video walkthrough plan](video-plan.md) — recorded versions
