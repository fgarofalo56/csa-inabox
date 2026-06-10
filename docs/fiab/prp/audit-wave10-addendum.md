# CSA Loom — Wave 10 addendum (operator UI asks)

Net-new UI items added after the deep audit, from direct operator feedback.
Built in Wave 10 (UI redesign) via loom-unleash-fast {auditWave:10} alongside
audit-T106..T120. Honor: no-vaporware (keep the REAL live chat backend wired —
copilot-chat Azure Function / copilot-orchestrator; no mocks), ui-parity
(improve, don't strip), loom-design-standards (Fluent v9 + Loom tokens, Web 3.0).

## Tasks

### audit-T121 — Loom Copilot CHAT interface overhaul (HIGH PRIORITY) | Wave 10
- **area:** ui-redesign
- **askSource (operator, 2026-06-10):** "The Loom Copilot, the actual chat interface — sessions on the left, tools on the right — looks like garbage / rudimentary. Can't edit chat sessions. The tools panel doesn't make sense (unclear what you're supposed to do). Compare to the pre-launch Copilot landing screen (banner + 'what Copilot can orchestrate') which looks nice — make the live chat that good or better. Modernize to Web 3.0, best-in-class. Leverage frontend-design skill + front-end agents."
- **status:** stub / ui-only (functional chat exists but the UI is rudimentary)
- **goal — take the live Copilot chat surface to best-in-class, keeping the real backend intact:**
  1. **Design north star:** match + exceed the pre-launch Copilot landing aesthetic (hero banner, "what Copilot can orchestrate" visual language, gradient/Loom tokens). The chat view should feel like the same product, not a downgrade.
  2. **Sessions list (left rail):** fully manageable — **rename, delete, pin/favorite, duplicate, search/filter**, grouped by recency (Today / Yesterday / This week / Older), clear active-session state, hover "…" action menu, real empty state, "New chat" CTA. Persist to the real store (Cosmos/session store the chat already uses). No dead controls.
  3. **Tools / persona panel (right rail):** make it self-explanatory — show the **active pane persona** (from the per-pane registry, getPanePersona), each available **tool with a name + one-line "what it does" + when-to-use**, enable/disable where meaningful, and live status (e.g. "reads your active query/schema"). Replace the raw/unclear list with a structured, captioned panel. Surface suggested prompts.
  4. **Transcript / center:** modern message design (clear user vs assistant, avatars/role chips, markdown + syntax-highlighted code blocks with copy, streaming indicator, **tool-call + run-receipt rendering** that's readable, citations, regenerate/copy/feedback actions). Composer **pinned** (flex-shrink:0; messages scroll) — coordinate with audit-T118.
  5. **Polish bar:** Fluent v9 + Loom tokens throughout, no raw inline styles, responsive, keyboard-navigable, real empty/loading/error states (Spinner + MessageBar). No overlaps. A-grade.
  6. **Backend:** the real live chat path stays fully functional (no-vaporware) — this is a UI/UX overhaul over the existing copilot-chat function / orchestrator, NOT a rewrite of the chat engine.
- **files (build agent to confirm in research):** `apps/fiab-console/lib/components/copilot/**` (copilot-pane.tsx, chat view, session list, tools panel), the Copilot landing/launch component (the nice pre-launch screen to mirror), `apps/fiab-console/lib/copilot/**`, the copilot session store + `/api/copilot/**` routes, `azure-functions/copilot-chat`.
- **verify:** tsc clean on touched files; the live chat still sends/streams against the real backend; sessions rename/delete/pin persist; side-by-side the chat view now matches the landing-screen quality. Screenshot before/after.

### audit-T122 — Data Agent page overhaul + full lifecycle management (HIGH PRIORITY) | Wave 10
- **area:** ui-redesign
- **askSource (operator, 2026-06-10):** "The data agent page still needs a lot of work. You can't edit the data agents — you click on them and I don't even know if they exist anymore. I want to click a data agent on the left, go to where it's at, and configure / delete / remove / enhance it. The data-agent UI needs work — enhance it, add more features and capabilities. Free reign to make it the best possible data-agent UI. Wire up everything under the covers to make it usable (not just visually) — real backend."
- **status:** stub / partial (list renders but no real open/edit/delete; may not reflect real existing agents)
- **goal — make the data-agent surface a best-in-class, fully-wired management experience:**
  1. **List (left):** show the operator's REAL existing data agents from the backing store (Cosmos/items) — confirm they actually exist and render live. Each row: name, status, backing sources count, last-updated; hover/"…" menu + click.
  2. **Click-through to detail/config:** clicking an agent on the left **opens its real editor/detail** (route to the data-agent item editor / a detail pane), where you can **configure, rename, delete/remove, duplicate, and enhance** it — all wired to real BFF routes + the real backend (no dead buttons, no mocks).
  3. **Configure/enhance capabilities:** manage the agent's **data sources** (lakehouse/warehouse/KQL/Azure SQL/semantic-model bindings — incl. the T58 DAX dataset binding), system prompt/persona, grounding/index settings, tool catalog, test/preview chat against the real agent, publish/share (and the T85 publish-to-M365 path where relevant). Add genuinely useful capabilities a Fabric "data agent" exposes.
  4. **Delete/remove:** real delete (with confirm) that removes the agent from the store + any provisioned backing; reflect immediately in the list.
  5. **Polish bar:** Fluent v9 + Loom tokens, modern Web 3.0 look, no inline-style debt, real empty/loading/error states, keyboard-nav, A-grade. Composer pinned (coordinate w/ audit-T118).
  6. **Backend (no-vaporware):** wire create/read/update/delete/configure/test to real routes + clients (the data-agent item provisioner/editor + copilot-orchestrator data-agent persona). Azure-native default.
- **files (build agent to confirm in research):** `apps/fiab-console/lib/panes/data-agent.tsx`, `apps/fiab-console/lib/editors/**` data-agent editor, `apps/fiab-console/app/api/items/data-agent/**` + any `/api/data-agent*` routes, the data-agent provisioner, copilot-orchestrator data-agent persona + tabular-read tooling.
- **verify:** real existing agents list; click → real config surface; create/edit/delete persist to the real backend and reflect in the list; a test query runs against the real agent; tsc clean on touched files; screenshots before/after.

### audit-T123 — Workload Hub: make workload → item-type hierarchy a real "create-by-workload" launcher (HIGH PRIORITY) | Wave 10
- **area:** ui-redesign
- **askSource (operator, 2026-06-10):** "On the Workload Hub 'My workloads' it shows types — Databases 7 item types, Industry solutions, Power BI 5 items, Power Platform 5 item types, Data Engineering 8 item types. What do the item types underneath represent — capabilities? When I click one it just takes me to the service (click Copilot Studio → Copilot Studio; click Data Engineering → opens a Synapse serverless pool). Where are the 7/8 item types? I'm confused how the integration is supposed to work. The main workloads + sub item-types should translate to actual usable wizards/workflows/options. Dive deep, enhance, take it to the next level."
- **status:** ui-only / confusing (counts shown but the sub-item-types aren't surfaced as usable create flows; clicking deep-links to a service instead of exposing the item types)
- **goal — turn the Workload Hub into a real, self-explanatory "create / manage by workload" navigator backed by the item-type registry:**
  1. **Source of truth:** the per-workload "N item types" counts must come from the REAL item-type catalog/registry (the ~75 registered item types), grouped by Fabric workload (Data Engineering, Data Warehouse, Databases, RTI, Data Science, Power BI, Power Platform, Industry solutions, Governance, etc.). The number = the count of creatable item types in that workload — make that meaning explicit in the UI (label/tooltip: "8 item types you can create").
  2. **Expand, don't dead-end:** clicking a workload shows ITS item types (tiles with icon + name + one-line description + "what it does"), not a deep-link to a single service. Each item-type tile is the entry point.
  3. **Each item type → real create wizard / open:** clicking an item type launches the REAL provisioning wizard / create flow for that item (e.g. Data Engineering → lakehouse / notebook / Spark job def / pipeline …; Databases → the 7 DB item types; Power BI → semantic model / report / paginated report / dashboard …) OR opens the workspace filtered to existing items of that type with a "+ New" CTA. Wire to the real install/provision path + item editor (no-vaporware).
  4. **Clarify the model:** make it obvious that a "workload" is a category and its "item types" are the things you create/manage in it — consistent with how Fabric presents the workload → item-type model. Resolve the current confusion where clicking just navigates to a service.
  5. **Polish:** Fluent v9 + Loom tokens, TileGrid + ItemTile + icons from item-type-visual, real empty/loading states, Web 3.0, A-grade.
  6. **Backend (no-vaporware):** counts + tiles from the real registry; create actions hit the real provisioner/editor routes; existing-items views query the real store.
- **files (build agent to confirm in research):** for Workload Hub look at `apps/fiab-console/app/workload-hub|workloads/**`, `lib/components/**workload**`, the item-type catalog/registry (`lib/items/**` / item-type-visual), and the install/provision routes `app/api/items/**`. (`lib/components/realtime-hub/realtime-hub-view.tsx` is the RTI hub — different surface.)
- **verify:** counts match the registry; clicking a workload reveals its item types; clicking an item type opens a real create wizard or filtered workspace that actually provisions/opens the item; tsc clean; screenshots before/after.
