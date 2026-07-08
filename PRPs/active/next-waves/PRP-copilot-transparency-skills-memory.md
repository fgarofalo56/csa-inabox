# PRP — Copilot transparency, skills library & long-term memory (ATLAS-class chat UX)

> **Title:** Copilot transparency, skills library & long-term memory — ATLAS-class chat UX for CSA Loom
> **Date:** 2026-07-08
> **Status:** proposed
> **Owner:** CSA Loom — next-waves backlog
> **Cross-cutting rules honored (die-hard, non-negotiable):** `no-vaporware` (real backend + receipt per merge),
> `no-fabric-dependency` (Azure-native is the DEFAULT; Fabric/Power BI opt-in only, never a gate),
> `loom_no_freeform_config` (wizards/dropdowns/toggles — never a raw JSON textarea),
> `loom_design_standards` (Fluent v9 + Loom tokens; cards, icons, alignment), bicep-sync, dual-cloud
> (Commercial + Government/GCC/GCC-High) mandatory per item.
> **Posture (die-hard for this PRP):** every capability ships **default-ON, opt-out** — a tenant admin can
> disable, and a user can opt out — but there is **no enablement gate, no "turn this on first" wall**. The
> transparency bar, the context meter, the curated skills, and memory recall are live the moment the feature
> lands, not behind a setup step.
> **Sources consulted:**
> - Reference implementation (read-only research, 2026-07-08): the ATLAS chat stack at
>   `E:/Repos/HouseGarofalo/atlas-hub/atlas` — six subsystems documented with concrete file paths (chat
>   metadata UX, context-usage panel, memory brain, skills system, and portable extras). ATLAS is the
>   feature target; **Loom re-implements each concept on Loom's own Azure-native stores** (Cosmos + Azure AI
>   Search vectors), **not** ATLAS's Mongo/Qdrant/Neo4j triple.
> - Loom current-state research (2026-07-08): code-grounded Grep/Read across `apps/fiab-console/lib` and
>   `apps/fiab-console/app` — `copilot-orchestrator.ts`, `help-copilot-orchestrator.ts`, `transcript.tsx`,
>   `mcp-shim.ts`, `catalog.ts`, `ms-skills.ts`, `powerbi-skills.ts`, `mcp-servers-panel.tsx`,
>   `loom-docs-index.ts`.
> - Reused Loom foundations: `rel-T85` AI-fn cost stats (Wave 6 Round-1, live-verified), the
>   `copilot-sessions` Cosmos container, and the `loom-docs-index.ts` Azure AI Search RAG pattern.

---

## Executive summary — the strategic "why"

CSA Loom is Fabric-class analytics and AI on **pure Azure + OSS** — Commercial and Government, day-one,
with zero hard dependency on real Microsoft Fabric or Power BI. Loom's Copilot is already real and
non-vaporware: a tool-calling agent (`copilot-orchestrator.ts::orchestrate()`) with genuine per-user
session persistence in Cosmos, real AOAI token accounting (`OrchestratorUsage`), a working right-rail tool
inventory (`tools-panel.tsx`), and a separate docs-grounded RAG assistant (`help-copilot-orchestrator.ts`)
that cites sources. That is a B-grade foundation.

What is **missing is the trust-and-memory axis** — the thing that turns "a chat box that calls tools" into
an **ATLAS-class assistant the operator can audit, teach, and rely on across sessions.** Today a user
cannot see *how much* a turn cost, *how fast* it was, *which* MCP server backed a tool call, *what* grounded
the answer, or *how full* the context window is. There is **no skills library** — Loom's ~30 curated agent
skills (`ms-skills.ts`) and the Power BI authoring skills (`powerbi-skills.ts`) are pane-keyed
system-prompt injections with **zero** user or admin control and **no UI listing them at all.** And there
is **no long-term memory** — a fact learned in one session is gone in the next; "memory" today is nothing
but an ephemeral per-user transcript log.

ATLAS has solved exactly these three problems, in a shape Loom can adopt one-for-one: a **three-tier
transparency split** (always-visible status bar → per-message collapsible badge → admin-only deep trace),
a **segmented context-window meter** backed by a pure, invariant-tested segment-sum function, a **skills
registry** with per-user-toggle-over-global-enabled, and a **layered memory brain** (cheap always-on
identity/preference layer + budgeted relevance search + a nightly consolidation pass) guarded by a
four-layer memory-write security decorator. This PRP ports each onto Loom's Azure-native stack: the
transparency data already partly exists server-side (`OrchestratorUsage` + per-tool `durationMs`) and needs
UI + instrumentation, not a new foundation; the context meter needs new message-build instrumentation; the
skills library and the memory brain are from-scratch builds on **Cosmos containers + Azure AI Search vector
recall** — never Mongo, Qdrant, or Neo4j. Every memory write is prompt-injection-scanned, secret-redacted,
and audited so the whole thing is **Gov-safe by construction.** MCP visibility ships immediately, paired
with the MCP default-ON flip. Nothing here reintroduces a Fabric requirement, and nothing hides behind an
enablement gate.

---

## Work items

| ID | Item | Scope area | Loom state | Priority | Effort |
|----|------|-----------|-----------|----------|--------|
| CTS-01 | Per-message transparency status bar (Tier 1 — always visible): model/deployment, tokens in/out + running total, cost (reuse rel-T85), latency, tool/MCP call count | Transparency | PARTIAL | P1 | M |
| CTS-02 | Per-message collapsible detail badge (Tier 2): per-tool call status, routing, delegation, parallelism telemetry | Transparency | PARTIAL | P1 | M |
| CTS-03 | Admin-only deep debug/trace panel (Tier 3): Flow / JSON / Routing / Tools / Knowledge / Timeline tabs | Transparency | MISSING | P2 | L |
| CTS-04 | Sources / grounding attribution on the cross-item orchestrator (RAG docs, schemas, memories → citations) | Transparency | PARTIAL | P1 | M |
| CTS-05 | Context-expander graphic — segmented context-window breakdown + pure invariant-tested segment-sum backend | Context meter | MISSING | P1 | L |
| CTS-06 | "Dump conversation to long-term memory" action (pre-compaction extraction; manual override of auto-flush) | Memory | MISSING | P1 | M |
| CTS-07 | Skills library + management UI: registry, curated Loom skill set, custom-skill builder, per-skill toggle (tenant default-ON / user opt-out), injected into personas + orchestrator | Skills | MISSING | P1 | XL |
| CTS-08 | Long-term memory / brain: Cosmos + AI Search vector recall, user + workspace scope, auto-capture + explicit save, L0–L3 layered recall into prompt with attribution, admin visibility/purge | Memory | MISSING | P1 | XL |
| CTS-09 | MCP visibility in chat: "MCP servers/tools live this conversation" panel + per-call "via &lt;server&gt;" badge (ships with the MCP default-ON flip) | MCP | PARTIAL | P1 | M |
| CTS-10 | Extend the transparency + context meter to **every** AI surface — per-pane scoped assists, not just the global launcher | Transparency | MISSING | P2 | M |
| CTS-11 | Skills self-evolution: auto-learn candidate skills from usage + guided synthesis (opt-in, admin-reviewed) | Skills | MISSING | P3 | L |
| CTS-12 | Memory-write security guard (4-layer): injection scan + LLM classifier + secret redaction + locked-field approval, fully audited | Memory | MISSING | P2 | L |
| CTS-13 | Nightly memory consolidation pass (REM-analog, Cosmos-native): dedupe, contradiction flag, topic promotion | Memory | MISSING | P3 | L |
| CTS-14 | Copilot replay → eval-suite harness (capture a turn, re-dispatch, promote to a YAML eval; PII-redacted) | AgentOps | MISSING | P2 | M |
| CTS-15 | Proactive / ambient context injection (recent activity + pending approvals folded in without being asked) | Transparency/AI | MISSING | P2 | M |
| CTS-16 | Per-provider circuit breaker + learned model routing (AOAI-deployment + MCP resilience) | Resilience | MISSING | P3 | M |
| CTS-17 | AI spend burn-rate projection + budget alert on the Copilot cost stream | FinOps | MISSING | P3 | S |

**Sequencing note.** CTS-09 (MCP visibility) ships **immediately**, coupled to the separately-tracked MCP
default-ON flip. The transparency spine (CTS-01/02/04) and the context meter (CTS-05) are additive to the
existing `transcript.tsx`/`OrchestratorUsage` plumbing and land together near the AIF multi-agent waves.
CTS-08 (memory brain) is the from-scratch foundation that CTS-06 (dump-to-memory), CTS-12 (write guard),
and CTS-13 (consolidation) all ride — they form a dedicated **Memory & Brain** wave. CTS-07 (skills
library) is independent and lands with the AIF skills work. CTS-11/13/15/16/17 are the P2/P3 tail folded
into existing depth/tail waves (dedupe notes below).

---

## CTS-01 — Per-message transparency status bar (Tier 1, always visible)

**Capability.** A compact, always-visible strip under (or on) every assistant message: model/deployment
name + provider badge, **tokens in / tokens out** with a running conversation total, a **cost estimate**
(reusing the rel-T85 cost-stats price table), **latency** (turn wall-clock), and a **tool/MCP call count**.
This is ATLAS's Tier-1 surface — "how fast, how cheap, on what model was this turn" — never buried in a
tooltip.

**Grounding (ATLAS reference implementation).**
- `E:/Repos/HouseGarofalo/atlas-hub/atlas/frontend/src/components/chat/ChatStatusBar.tsx` — live per-turn
  status bar: model + provider badge, streaming token count, client-side `estimateCost(provider,in,out)`
  from a `PROVIDER_COSTS` table mirroring the backend, and a 1s-tick elapsed-time counter; re-renders from
  `lastUsage` after the turn.
- `frontend/src/types/chat.ts` `Message` (L71-96): `model`, `provider`, `usage`, `duration_ms`, `metadata`.
- `backend/app/services/cost_tracker_pure.py` — `MODEL_PRICING` / `calculate_cost` / fallback pricing.

**Current Loom state — PARTIAL.** `lib/azure/copilot-orchestrator.ts` already assembles
`OrchestratorUsage {promptTokens, completionTokens, totalTokens, aoaiCalls, toolCalls}` (copilot-orchestrator.ts:1088)
from the real AOAI response, and each tool result carries `durationMs` (copilot-orchestrator.ts:1093).
`lib/components/copilot/transcript.tsx` renders a model badge (transcript.tsx:185) and a usage caption
"N tools · N tokens · N turns" (transcript.tsx:200-206). The delta: (a) tokens shown only as a single
`totalTokens`, never split in/out even though both are tracked; (b) **no cost** figure; (c) **no
turn-latency**; (d) the strip is a terminal caption, not a persistent per-message bar.

**Azure-first build.**
- **Backend:** compute `turnLatencyMs` in `orchestrate()` (first-token and total wall-clock) and attach it,
  plus the already-present `promptTokens`/`completionTokens`, to the emitted `final` step. Add a
  `costUsd` computed server-side from the **rel-T85 cost-stats price table** (reuse the existing AI-fn cost
  module — do not re-derive prices client-side) keyed by `target.deployment`.
- **Client/types:** extend `Turn`/`Step` in `lib/components/copilot/types.ts` with `promptTokens`,
  `completionTokens`, `turnLatencyMs`, `costUsd`, `model`, `provider`.
- **BFF:** no new route — the SSE stream already carries the `final` step; add fields to its payload.
- **UI:** a `lib/components/copilot/message-metadata-bar.tsx` (Fluent v9 + Loom tokens) — a slim
  always-visible bar: model+provider badge, `↑{in}/↓{out} · Σ{total}`, `${cost}`, `{latency}`, `{n} tools`.
  Color the cost/latency chips with Loom accent tokens (green/amber/red thresholds).
- **Catalog:** n/a (chat surface, not an item type).
- **Bicep:** none (pure UI + existing cost module). **Gov:** identical both clouds; price table is
  cloud-parameterized already for Gov meters.

**Acceptance (no-vaporware receipt).** Run a real cross-item Copilot turn with `LOOM_DEFAULT_FABRIC_WORKSPACE`
UNSET; receipt shows the bar rendering **real** promptTokens/completionTokens from the AOAI response, a
non-zero `costUsd` from the rel-T85 table, a measured `turnLatencyMs`, and a screenshot of the bar.

**Priority P1 · Effort M.**

---

## CTS-02 — Per-message collapsible detail badge (Tier 2)

**Capability.** A per-message collapsible chip that expands to the full turn detail: **per-tool-call status**
(name, duration, success/error, and — from CTS-09 — which MCP server backed it), routing/agent info when a
persona routed the turn, a delegation chain for multi-agent turns, and tool-parallelism telemetry
(batched / cache-hit / speculated) as a "how efficient was this turn" signal.

**Grounding (ATLAS).**
- `frontend/src/components/chat/MessageBubble.tsx` `AgentInfoBadge` (L628-720+) — collapsible,
  provider-colored chip: agent name, task type, routing confidence %, provider, duration, routing
  reasoning, delegation chain (per-agent provider+duration), from `message.metadata`.
- `frontend/src/types/chat.ts` `ToolParallelMeta` (L25-40): `batch_size`, `cache_hits`, `speculation_hits`.

**Current Loom state — PARTIAL.** `transcript.tsx` already streams each `tool_call` (name only,
transcript.tsx:88-93) and `tool_result` (name + `durationMs` + success/error icon, transcript.tsx:95-111)
inline. Missing: a **collapsed-by-default** per-message roll-up, routing/delegation fields (the cross-item
orchestrator is single-agent today, so these appear only when a persona-routed path exists), and the
parallelism telemetry.

**Azure-first build.**
- **Backend:** roll the per-step tool events into a `turnDetail` object on the `final` step
  (tool list with `{name, serverId?, durationMs, ok, error?}`); when a persona/route is involved, attach
  `{routedPersona, confidence, reasoning}`. Emit `toolParallelMeta` when the dispatcher batches/caches.
- **Client/types:** `turnDetail` on `Turn`.
- **UI:** extend `message-metadata-bar.tsx` with an expander (chevron) opening a `turn-detail-panel.tsx`:
  a tool table (name · via-server · duration · status), routing sub-section, delegation list, and a
  parallelism chip row. Fluent `Accordion`/`Table`, Loom tokens.
- **Bicep:** none. **Gov:** identical both clouds.

**Acceptance.** Run a turn that calls ≥2 tools (one an MCP tool); receipt shows the collapsed chip
expanding to the real per-tool table with durations and the correct "via &lt;server&gt;" label for the MCP
call and "built-in" for the native tool.

**Priority P1 · Effort M.**

---

## CTS-03 — Admin-only deep debug / trace panel (Tier 3)

**Capability.** An admin-gated, tabbed deep-trace panel for a selected turn: **Flow** (phase graph),
**JSON** (raw step payloads), **Routing**, **Tools**, **Knowledge** (grounding sources), and **Timeline**
(a horizontal phase bar chart — classification / prompt-build / llm-streaming / tool-execution / save with
per-phase ms). This is the third tier ATLAS keeps *out* of the normal chat surface — deep introspection for
operators debugging a bad turn, not everyday clutter.

**Grounding (ATLAS).**
- `frontend/src/components/chat/ChatDebugPanel.tsx` (6-tab panel) + `frontend/src/stores/chatDebugStore.ts`
  + `frontend/src/types/debugPanel.ts`. Timeline tab = per-phase ms bar chart; Routing tab = agent/provider/
  model/confidence + context flags (tools/knowledge/memory present); footer = running token/chunk/tool
  counts + total duration.

**Current Loom state — MISSING.** No per-turn phase timing is captured anywhere in `orchestrate()`; there
is no admin trace surface for a chat turn (distinct from the Foundry `tracing` item type, which traces
agent items, not the Console Copilot).

**Azure-first build.**
- **Backend:** instrument `orchestrate()` with a lightweight phase timer (wrap the classify → prompt-build →
  AOAI-stream → tool-exec → persist stages), accumulating `{phase, ms}[]` onto the persisted step
  (best-effort, never blocking the SSE stream — same swallow-errors posture as `persistStep`).
- **BFF:** `app/api/copilot/sessions/[id]/trace/route.ts` (admin-gated via `requireTenantAdmin`) returning
  the stored per-turn trace from the `copilot-sessions` container.
- **UI:** `lib/components/admin/copilot-debug-panel.tsx` — Fluent tabbed panel; the Timeline tab uses the
  existing Loom chart primitive (no new chart dep), Routing/Tools/Knowledge tabs read the CTS-02/CTS-04
  detail objects, JSON tab is a read-only viewer.
- **Bicep:** none (reuses the existing container). **Gov:** admin-gated both clouds; PII in raw JSON is
  redacted by default (reuse CTS-12's secret redactor) with a raw override for tenant admins.

**Acceptance.** As a tenant admin, open the debug panel on a real multi-tool turn; receipt shows the
Timeline bar chart with real per-phase ms and the JSON tab showing the actual step payloads (secrets
redacted).

**Priority P2 · Effort L.**

---

## CTS-04 — Sources / grounding attribution on the cross-item orchestrator

**Capability.** Every answer that used grounding shows **what** it was grounded on — RAG doc chunks,
schema/metadata reads, and (from CTS-08) recalled memories — as citation chips the user can click. Today
only the separate Help Copilot cites sources; the agentic cross-item Copilot never does.

**Grounding (ATLAS).**
- The `ContextUsagePanel` knowledge segment + the `AgentInfoBadge` "knowledge present" context flag both
  reflect grounding fed into the turn; ATLAS surfaces citations per answer.

**Current Loom state — PARTIAL.** Citations are **structurally supported** in the shared `Step`/`Turn`
types (types.ts:21,70) and **rendered** via `CitationChips` (transcript.tsx:196-198) — but
`copilot-orchestrator.ts` **never populates** `citations` on a `final` step (zero matches). The
RAG-grounded `help-copilot-orchestrator.ts` + `loom-docs-index.ts` (real Azure AI Search corpus) is the
only path that cites, and it is a separate assistant.

**Azure-first build.**
- **Backend:** when a tool result carries retrievable provenance (a `loom-docs-index` search, a schema/table
  read, a memory recall from CTS-08), map it into the `citations: Citation[]` shape the UI already renders,
  and set it on the `final` step. Optionally route more grounded questions through the existing
  `searchDocs`/`loom-docs-index.ts` path so the agent is genuinely RAG-grounded, not just tool-grounded.
- **Client/types:** reuse the existing `Citation` type + `CitationChips` — no new UI primitive.
- **UI:** citation chips already render; add a "Sources (N)" affordance in the CTS-02 detail panel that
  groups citations by kind (doc / schema / memory) with the memory ones badged distinctly (ties to CTS-08
  attribution).
- **Bicep:** none (reuses the deployed Azure AI Search docs index). **Gov:** AI Search GA both clouds.

**Acceptance.** Ask a question whose answer draws on a Loom doc chunk and a recalled memory; receipt shows
real citation chips on the answer (doc chunk + memory), each linking to its source — no `api.powerbi.com`
or Fabric call in the trace.

**Priority P1 · Effort M.**

---

## CTS-05 — Context-expander graphic (segmented context-window breakdown)

**Capability.** The single highest-value visual to clone 1:1: a collapsible bar docked under the chat.
Collapsed = `Context: {util}% ({used}/{window})` + a skill-count chip + live message count + a colored
utilization icon, above an always-visible thin multi-segment bar (one segment per context contributor).
Expanded = one **drillable** row per segment — **system prompt / persona**, **skills**, **tools**,
**memory**, **knowledge/RAG**, **conversation history**, **remaining** — each with token count and detail:
Skills drills to active skill names + per-skill token estimate; Tools drills to tool-name chips; System
Prompt opens a modal with a preview + Copy. Footer: **Copy Report** and **Dump to Memory** (CTS-06).

**Grounding (ATLAS).**
- `frontend/src/components/chat/ContextUsagePanel.tsx` (431 lines) — the exact graphic.
- `frontend/src/stores/chat/streamingStore.ts` (L25-37) `ContextUsageData` contract: `context_window`,
  `system_prompt_tokens`, `skills{count,tokens,names[]}`, `tools{count,tokens,names[]}`, `memory{tokens}`,
  `knowledge{tokens}`, `conversation_history{messages,tokens}`, `total_input_tokens`, `remaining_tokens`,
  `utilization_pct`.
- `backend/app/services/chat/context_usage.py::build_context_usage_payload()` (L61-154) — a **pure,
  unit-tested** function with a documented invariant `sys_base + memory + knowledge + skills + conversation
  + tools == total_input_tokens` (no double counting; `sys_base = system_prompt_tokens − memory − knowledge
  − skills`, `conversation = history − system_prompt`), emitting `segment_sum` / `segments_consistent`
  telemetry. Delivered to the UI as an SSE `context_usage` event once per turn.

**Current Loom state — MISSING.** Nothing in `copilot-orchestrator.ts` reports the token size of any prompt
segment: the system prompt, `opts.personaContext` (copilot-orchestrator.ts:1836-1841, truncated to 4000
chars with no size reported), the MS-skill guidance blocks (`msSkillSystemBlocksForPane`,
copilot-orchestrator.ts:1852), or the tool-schema payload. A context-expander has **zero backing data**
today.

**Azure-first build.**
- **Backend:** a new pure module `lib/azure/context-usage.ts` with `buildContextUsagePayload()` mirroring
  ATLAS's invariant (unit-tested with the same `segment_sum`/`segmentsConsistent` guard). Instrument
  `orchestrate()` at **message-build time** (before the AOAI call) to tokenize each segment — system base,
  persona context, skill blocks, tool schema, memory (CTS-08), knowledge (CTS-04), conversation history —
  using a tokenizer helper (`@dqbd/tiktoken` or the AOAI token-count estimate already used for usage).
- **BFF/stream:** emit a `context_usage` SSE event once per turn (new step kind `context_usage`), consumed
  into the copilot store.
- **UI:** `lib/components/copilot/context-usage-panel.tsx` — Fluent v9 + Loom tokens, the segmented bar +
  drill-in rows + a "View full system prompt" modal (preview + Copy) + **Copy Report** + **Dump to Memory**
  footer buttons. No freeform config — all read-only drill-downs.
- **Agent-readable:** persist the latest payload to the session doc so a future "how full is my context?"
  chat tool can read it (ATLAS's `context_usage_tool.py` analog) — Cosmos, not Redis.
- **Bicep:** none. **Gov:** identical both clouds.

**Acceptance.** Run a turn with an active skill + a persona context + ≥1 tool; receipt shows the segmented
bar with **real** per-segment token counts summing exactly to `total_input_tokens` (invariant test green),
the Skills row drilling to the active skill names, and the system-prompt modal showing the real prompt.

**Priority P1 · Effort L.**

---

## CTS-06 — "Dump conversation to long-term memory" action

**Capability.** A one-click action (in the CTS-05 footer and the message actions) that extracts durable
facts/preferences/decisions/context from the recent conversation into long-term memory — explicitly framed
as **pre-compaction extraction**, and also the manual override of an auto-flush that fires at a configurable
context-utilization threshold.

**Grounding (ATLAS).**
- Button → `frontend/src/services/memoryService.ts::flushConversationMemory()` → `POST /api/v1/memory/flush`
  → `backend/app/services/memory/memory_flush_service.py::flush_memories()`: takes the last N messages,
  prompts an LLM (`FLUSH_EXTRACTION_PROMPT`) to extract a JSON array (`content`, `category`, `confidence`,
  `tags`), persists each via `personal_memory_service.create_memory`, logs to `memory_flush_log`.
  `should_flush()` auto-triggers at `memory_flush_threshold_ratio`.

**Current Loom state — MISSING.** No memory system exists (see CTS-08) and no "save to memory" affordance
exists in `transcript.tsx` (only Copy / Regenerate / thumbs).

**Azure-first build (depends on CTS-08 for the store + CTS-12 for the write guard).**
- **Backend:** `lib/azure/memory-flush.ts::flushConversationMemory(sessionId, userOid, workspaceId)` — pull
  the last N steps from `copilot-sessions`, call AOAI (`aoai-chat-client`) with a Loom extraction prompt to
  produce a **typed** fact array, and persist each through CTS-08's `createMemory` (which runs the CTS-12
  guard). Log to a `copilot-memory-flush-log` container.
- **Auto path:** `shouldFlush(utilizationPct)` at a tenant-configurable threshold, invoked from the CTS-05
  instrumentation; the button is the manual override of the same code path.
- **BFF:** `app/api/copilot/memory/flush/route.ts` (session-scoped, tenant-admin-configurable threshold).
- **UI:** wire the CTS-05 "Dump to Memory" button + a per-message "Save to memory" action; toast on success
  with the count of memories written.
- **Bicep:** none new (Cosmos containers via `createIfNotExists`). **Gov:** AOAI + Cosmos both clouds.

**Acceptance.** Hold a short conversation stating a durable preference, click "Dump to Memory"; receipt
shows the extracted typed memories persisted in the memory container and the flush logged — and a **new
session** recalling that preference (proves CTS-08 recall).

**Priority P1 · Effort M.**

---

## CTS-07 — Skills library + management

**Capability.** A first-class **skills registry**: a curated CSA-Loom skill set (migrate the existing
`ms-skills.ts` + `powerbi-skills.ts` descriptors into data), a **custom-skill builder** (author name /
description / trigger / system-prompt / examples / config via forms — no hand-editing code), a **per-skill
toggle** (tenant default-ON, user-level opt-out — the die-hard posture), and injection into personas + the
orchestrator so an enabled skill's guidance reaches the model. Relation to MCP tools is made visible: a
skill that advertises an `mcpToolPrefix` shows whether that MCP server is genuinely connected.

**Grounding (ATLAS).**
- Skills are **DB documents** (not filesystem markdown): `frontend/src/types/skill.ts` `Skill` (L58-76) —
  `skill_id`, `name`, `version`, `description`, `category`, `tags`, `trigger{type,slash_command,patterns,
  confidence_threshold}`, `system_prompt`, `examples[]`, `config{max_context_tokens,priority,combinable,
  exclusive_group,compatible_providers,...}`, `access{visibility,owner_id,shared_with,requires_admin}`,
  `enabled`, `is_builtin`.
- Services `backend/app/services/skills/`: `skill_service.py` (CRUD + `get_skill_states`/`update_skill_states`
  — per-user toggle overrides distinct from global `enabled`), `skill_registry.py` (in-memory cache +
  precomputed embeddings), `skill_resolver.py::resolve_for_message()` (filter by trigger/lifecycle/override/
  compat, score by regex → name-substring → semantic cosine), `skill_injector.py::inject_skills()` (delimited
  `── Active Skills ──` system-prompt block + `estimate_injection_tokens()` — the CTS-05 skills-token
  segment).
- Frontend Skills Studio `frontend/src/pages/skills-studio/` (catalog / editor two-tab Prompt+Config /
  detail / sandbox) + `AdminSkillsPage.tsx`; `skillStore.ts::toggleSkill()`/`isSkillActive()` (checks global
  `enabled` **and** the user override).

**Current Loom state — MISSING.** `ms-skills.ts` (~30 skills, `msSkillsForPane` string-matches
`contextSlug`, ms-skills.ts:982) and `powerbi-skills.ts` are **pure code, pane-keyed, with zero on/off
control at any level** and **no UI listing them.** `mcp-servers-panel.tsx` toggles MCP **servers**, not
skills; no "skills" route/panel exists anywhere in `apps/fiab-console/app` or `lib/components/admin`.

**Azure-first build.**
- **Store:** a `copilot-skills` Cosmos container (built-in skills seeded from the migrated `ms-skills.ts`/
  `powerbi-skills.ts` descriptors; `is_builtin:true`) + a `copilot-skill-states` container keyed by
  `tenantId+userOid` for per-user toggle overrides, and a tenant-default set. Privacy/scoping enforced at
  the Cosmos-filter level.
- **Backend:** `lib/copilot/skill-registry.ts` (cache + optional precomputed embeddings via the
  AOAI embedding client), `skill-resolver.ts::resolveForMessage()` (trigger + lifecycle + **user-override**
  + provider/pane compat, scored by regex → name → semantic), `skill-injector.ts::injectSkills()` (the
  existing delimited block + `estimateInjectionTokens()` feeding CTS-05). `msSkillsForPane` is refactored to
  consult the store (default-ON) rather than only the hardcoded pane match.
- **BFF:** `app/api/copilot/skills/**` — list/get/create/update/duplicate, `PATCH .../state` (toggle),
  admin-wide management under `requireTenantAdmin`.
- **UI:** `lib/components/copilot/skills-studio/**` — a catalog grid (mirrors `mcp-servers-panel.tsx`
  structure) with per-skill Fluent `Switch`, a two-tab editor (Prompt / Config — **forms, no JSON
  textarea**), a detail view, and a sandbox to test-a-skill; plus an admin-wide page. Each skill card shows
  its `mcpToolPrefix` connectivity (reuses `msConnectedMcpPrefixes`) so the MCP↔skill relation is visible.
- **Catalog:** skills are a Copilot concept, surfaced in the Copilot settings + admin plane (not an item
  type).
- **Bicep:** Cosmos containers via `createIfNotExists`; no new resource. **Gov:** Cosmos + AOAI both clouds.

**Acceptance.** In the Skills Studio, disable a built-in skill as a user (tenant default stays ON for
others), author a new custom skill via the form builder, and confirm in a real turn that the disabled skill's
guidance is **absent** from the system prompt (CTS-05 skills segment reflects the change) while the new
skill fires on its trigger — receipt shows the injected `── Active Skills ──` block matching the enabled set.

**Priority P1 · Effort XL.**

---

## CTS-08 — Long-term memory / brain (Cosmos + AI Search vectors)

**Capability.** Durable, cross-session memory: **user-scoped** (private) and **workspace-scoped** (shared —
the enterprise analog of ATLAS's household scope) memories captured **automatically** from conversation and
**explicitly** saved (CTS-06); recalled into the prompt via a **layered L0–L3 budget** with **attribution**
in the grounding panel (CTS-04); with **admin visibility + purge** and Gov-safe writes (CTS-12). Loom uses
**Cosmos as system of record + Azure AI Search vectors for ANN recall** — **never** Mongo/Qdrant/Neo4j.

**Grounding (ATLAS — concepts, re-hosted on Loom's stack).**
- Stores (ATLAS's three-DB brain): Mongo `personal_memories` (system of record), Qdrant vector mirror
  (`vector_store.py` dual-write + brute-force cosine fallback), Neo4j `RELATES_TO` graph. **Loom maps:**
  Cosmos `copilot-memory` = system of record; **Azure AI Search vector index** = the ANN mirror (dual-write
  on create/update, graceful degrade to a Cosmos keyword/tag scan if Search is unconfigured); relationships
  as Cosmos edge docs (no Neo4j — see CTS-13).
- Scoping: `backend/app/services/memory/memory_scopes.py` `MemoryScope{USER, HOUSEHOLD, AGENT}` +
  `query_with_scopes()` (parallel scopes, dedupe by id, re-rank by composite score, filter enforced at the
  DB query). **Loom maps** `HOUSEHOLD → WORKSPACE`.
- Recall budget: `backend/app/services/chat/context_service.py::get_layered_context()` — L0 (~50-100 tok:
  identity/roster), L1 (~120 tok: top preferences/facts at confidence ≥ 0.7), L2 (~500 tok: top-10
  query-relevant via `query_with_scopes`), L3 (~2000 tok on-demand: top-20, sharing L2's single search call).
  Greedy packing under a token budget — exactly the CTS-05 `memory` segment.
- Write path: explicit CRUD (`personal_memory_service.py`) + auto extraction
  (`memory_extraction_service.py`) + the CTS-06 flush.

**Current Loom state — MISSING (from-scratch build).** "Memory" today = ephemeral per-`userOid` transcript
logs in `copilot-sessions`/`copilot-help-sessions`; nothing re-reads a past session into a new one. The
`loom-docs-index.ts` RAG corpus is static **product docs**, not per-user state. The catalog `memory` MCP
server (catalog.ts:274-299) is an undeployed stdio entry, not a first-class memory concept.

**Azure-first build.**
- **Store:** `copilot-memory` Cosmos container (PK `/scopeKey` = `user:{oid}` or `workspace:{id}`), doc =
  `{id, scope, scopeKey, content, category, confidence, tags[], embeddingId?, createdAt, source}`. An
  **Azure AI Search vector index** `copilot-memory-vec` mirrors each doc (dual-write via the existing
  `loom-docs-index.ts` embedding + index pattern); `memorySearch()` does vector ANN with a **Cosmos
  keyword/tag fallback** when Search is unconfigured (fails open, never breaks the turn).
- **Recall:** `lib/azure/memory-recall.ts::getLayeredContext(userOid, workspaceId, query, tokenBudget)` —
  L0 identity/prefs (always), L1 high-confidence facts, L2 top-K vector-relevant (USER + WORKSPACE scopes,
  parallel + dedupe), L3 on-demand deep — greedy-packed to the budget. Injected as an extra system message
  alongside personaContext/skill blocks in `orchestrate()`, and its token size feeds CTS-05's `memory`
  segment; recalled items surface as memory citations (CTS-04).
- **Auto-capture:** a lightweight post-turn extractor (reuse CTS-06's extraction) writes durable facts; the
  explicit path is CTS-06.
- **Admin visibility/purge:** `app/api/admin/copilot/memory/**` + a `lib/components/admin/copilot-memory-panel.tsx`
  (browse by scope/user/workspace, view/edit/delete, bulk purge) — mirrors `session-list.tsx` structure.
- **Bicep:** Cosmos containers via `createIfNotExists`; the AI Search vector index provisioned by the same
  bootstrap as `loom-docs-index`. **Gov:** Cosmos + Azure AI Search vector search GA both clouds;
  honest-gate to the Cosmos keyword fallback if the vector index is absent.

**Acceptance.** In session A state a durable fact ("our fiscal year starts in April"); in a **fresh session
B** ask a question that needs it; receipt shows `getLayeredContext` recalling the memory (vector hit),
the memory appearing as a citation on B's answer, and the admin panel listing + purging it. Prove the
Cosmos fallback by unsetting the vector index and re-running.

**Priority P1 · Effort XL.**

---

## CTS-09 — MCP visibility in chat (ships with the MCP default-ON flip)

**Capability.** The chat surface shows **which MCP servers/tools are live for this conversation** — a
per-conversation panel listing connected MCP servers (name, tool count, connected/gated status) and a
per-tool-call **"via &lt;server&gt;"** badge distinguishing an MCP tool from an always-on Azure-native Loom
tool. This ships **immediately**, coupled to the separately-tracked flip that makes the ready MS MCP servers
default-ON.

**Grounding (ATLAS).** ATLAS's `AgentInfoBadge` context flags surface tools/knowledge/memory presence per
turn; the same "what's live this turn" transparency, applied to MCP.

**Current Loom state — PARTIAL.** `mcp-shim.ts::buildMcpShim(registry, tenantId)` (mcp-shim.ts:58-136)
registers each MCP tool as `mcp_<slug>_<tool>` and **threads `serverId`/`name`** (mcp-shim.ts:106) — but
the registered `ToolDef` (mcp-shim.ts:122-132) **drops that context** before it reaches the registry, so the
`tool_call`/`tool_result` step shows only the raw slugged tool name. `transcript.tsx` shows the tool name
but never which server. The right-rail `tools-panel.tsx` lists all tools but does not distinguish
"connected MCP" from "always-on native." `buildMcpShim` is wired **only** on the global launcher path
(guarded at copilot-orchestrator.ts:1787).

**Azure-first build.**
- **Backend:** carry `serverId`/`serverName` through the registered `ToolDef` so each `tool_call`/`tool_result`
  step knows its origin; expose a per-turn `connectedMcp[]` summary (server name, tool count, connected vs
  honest-gate) from `listMcpServers(tenantId)` (already policy-decorated) on the session.
- **UI:** (a) a "MCP this conversation" section in `tools-panel.tsx` (or a chat header chip) listing
  connected servers with status; (b) a **"via &lt;server&gt;"** badge on MCP tool calls in the CTS-02 detail
  panel, "built-in" for native tools.
- **Coupling:** ships with the MCP default-ON flip PR so that when the ready MS servers flip on, the chat
  immediately reflects them.
- **Bicep:** none. **Gov:** honest-gate reflects `govSafe` catalog flags (Fabric-family/opt-in servers stay
  off by default in Gov).

**Acceptance.** With an MCP server connected, run a turn that calls one of its tools; receipt shows the
"MCP this conversation" panel listing the server and the tool call badged "via &lt;server&gt;", distinct
from a native tool call labeled "built-in".

**Priority P1 · Effort M.**

---

## CTS-10 — Extend transparency + context meter to every AI surface

**Capability.** The CTS-01/02/04/05 surfaces exist on **every** Loom AI surface — not only the global
cross-item Copilot launcher, but every per-pane scoped assist (Report Copilot, semantic-model Copilot,
KQL/notebook builders, etc.). Same metadata bar, same context meter, same grounding chips, themed per pane.

**Grounding (ATLAS).** ATLAS applies the status bar + context panel uniformly across chat surfaces
(incl. `WorkspaceContextUsagePanel.tsx` for workspace-scoped variants).

**Current Loom state — MISSING for scoped panes.** Per-pane assist routes pass `registryOverride`/`registry`
and therefore **skip** `buildMcpShim` and take a fixed built-in tool set; they render bespoke transcripts
without the CTS-01/05 instrumentation. Transparency currently exists (partially) only on the global path.

**Azure-first build.**
- **Backend:** factor the CTS-01/02/04/05 instrumentation into a shared orchestrator helper so both
  `orchestrate()` and the scoped assist routes emit the same `final`-step metadata + `context_usage` event.
- **UI:** make `message-metadata-bar.tsx` + `context-usage-panel.tsx` reusable, drop them into each pane's
  assist transcript with the pane's Loom theme tokens.
- **Bicep:** none. **Gov:** identical both clouds.

**Acceptance.** Open the Report Copilot (a scoped pane) and run a turn; receipt shows the same metadata bar
(model/tokens/cost/latency) and context meter as the global launcher.

**Priority P2 · Effort M.**

---

## CTS-11 — Skills self-evolution (auto-learn + guided synthesis)

**Capability.** The system detects recurring usage patterns and **proposes** new skills, and offers a guided
synthesis flow to draft a skill from an observed pattern — always **admin-reviewed**, opt-in, never
auto-published.

**Grounding (ATLAS — KEEP as backlog).** `skill_curator.py` / `skill_learner.py` /
`self_enhance/skill_synthesizer.py` — lifecycle auto-archiving + auto-learning new skills from usage;
`capability_gap_tracker.py` + `dynamic_tool_generator.py` detect gaps and synthesize skills/tools.

**Current Loom state — MISSING.** `ms-skills.ts` has a "skill-creator" meta-skill (guidance text telling the
model how to draft a skill by hand) but no authoring/learning pipeline.

**Azure-first build.** A `skill-learner.ts` job over the CTS-07 usage logs proposing candidate skills into a
"Suggested" bucket in the Skills Studio; an admin reviews, edits (via the CTS-07 form builder), and
publishes. **Bicep:** none. **Gov:** AOAI both clouds. **Priority P3 · Effort L.** *(Rides CTS-07.)*

---

## CTS-12 — Memory-write security guard (4-layer)

**Capability.** Every memory write passes a four-layer defense before persisting: (1) deterministic
prompt-injection pattern scan, (2) an LLM guardrail classifier, (3) secret redaction on every string field,
(4) a hard block on mutating locked identity/policy fields without explicit operator approval — and **every**
attempt, pass or fail, is audited. This is what makes CTS-08 Gov-safe.

**Grounding (ATLAS — KEEP, Gov-critical).** `backend/app/agents/middleware/memory_write_guard.py` +
`app/security/{memory_guardrail.py, sanitize.py, secret_redactor.py}` + `audit_service.py`
(`memory_write_audit`), surfaced at `frontend/src/pages/admin/security/MemoryWriteAuditPage.tsx`.

**Current Loom state — MISSING.** No memory, so no guard. Must land **with** CTS-08 — memory that writes
un-scanned, un-redacted content is a Gov violation.

**Azure-first build.** A `memory-write-guard.ts` decorator wrapping CTS-08's `createMemory`/`updateMemory`:
regex injection scan → optional AOAI classifier → secret-redactor (reuse the existing Loom secret redactor)
→ locked-field approval gate; append every attempt to a `copilot-memory-write-audit` Cosmos container.
Admin surface `lib/components/admin/memory-write-audit-panel.tsx`. **Bicep:** Cosmos container via
`createIfNotExists`. **Gov:** mandatory both clouds. **Priority P2 · Effort L.** *(Hard dependency of CTS-08;
folded into the Memory & Brain wave.)*

---

## CTS-13 — Nightly memory consolidation pass (REM-analog, Cosmos-native)

**Capability.** A nightly reflector that scans recent memories, merges near-duplicates (drops the
lower-salience side), flags conflicting facts into a contradictions queue, and promotes recurring topics
into topic pages — producing a consolidation report. ATLAS's standout "sleep cycle."

**Grounding (ATLAS — KEEP as P3).** `backend/app/services/brain/rem_consolidation.py` +
`synaptic_dynamics.py` (Hebbian `RELATES_TO` reinforcement). **Loom drops the Neo4j graph** and models
relationships as Cosmos edge docs / AI Search similarity clusters — no new graph DB.

**Current Loom state — MISSING.** From-scratch, rides CTS-08.

**Azure-first build.** A scheduled job (ACA Job / Function timer) `memory-consolidate.ts`: pull the last
24h of memories from `copilot-memory`, cluster by vector similarity (reuse the AI Search vector index),
merge duplicates, write contradictions to a `copilot-memory-contradictions` container, promote topics to a
`copilot-topic-pages` container, emit a `ConsolidationReport`. Relationship reinforcement = a usage-weighted
edge doc updated on recall, not a graph traversal. **Bicep:** ACA Job / Function timer + Cosmos containers.
**Gov:** ACA/Functions + Cosmos both clouds. **Priority P3 · Effort L.**

---

## CTS-14 — Copilot replay → eval-suite harness

**Capability.** Capture a real chat turn, let an admin **re-dispatch** it (to compare model/prompt changes),
and **promote** a captured turn into a YAML eval suite — PII-redacted by default with a raw admin override.
An AgentOps building block for regression-testing the Copilot itself.

**Grounding (ATLAS — KEEP as P2).** `backend/app/api/v1/endpoints/admin_replay.py` — capture, `POST
/admin/replay`, `POST /admin/eval/save-from-turn`, PII-redacted with a `raw=1` override.

**Current Loom state — MISSING.** No capture/replay/eval surface for the Console Copilot.

**Azure-first build.** Reuse the CTS-03 per-turn trace as the capture; `app/api/admin/copilot/replay/route.ts`
re-runs a stored turn through `orchestrate()`; `.../eval/save-from-turn` writes a YAML case to an eval
container/blob; secret redaction from CTS-12. **Dedupe note:** aligns with **AIF-13** (AgentOps eval-linked
tracing) — build as the Console-Copilot instance of that pattern, sharing the redactor + trace store.
**Bicep:** none new. **Gov:** both clouds. **Priority P2 · Effort M.**

---

## CTS-15 — Proactive / ambient context injection

**Capability.** The assistant volunteers relevant context without being asked — recent activity in the
current item/workspace, pending approvals, and a capability self-awareness digest folded into the turn
context so the agent proactively surfaces what matters.

**Grounding (ATLAS — KEEP as P2).** `backend/app/services/proactive_context.py` + `proactive_scheduler.py`.

**Current Loom state — MISSING.** Context is purely reactive (persona + skills + tools).

**Azure-first build.** A `proactive-context.ts` provider folding recent Cosmos activity + pending
approval/deploy state into the L0/L1 memory layer (CTS-08) so it enters the prompt within budget; surfaced
as a distinct "proactive" grounding chip. **Dedupe note:** overlaps **BR-AMBIENT-FEED** (Wave 18 ambient
insight feed) — build as the chat-side injection that feeds the same signal. **Bicep:** none. **Gov:** both
clouds. **Priority P2 · Effort M.**

---

## CTS-16 — Per-provider circuit breaker + learned model routing

**Capability.** A CLOSED→OPEN→HALF_OPEN circuit breaker per AI provider / AOAI deployment / MCP server (a
failing backend is auto-isolated and probed, not hammered), plus learned per-task-type model routing (hard
tasks → smarter deployment, easy → cheaper) with a feedback loop.

**Grounding (ATLAS — KEEP as P3).** `backend/app/agents/circuit_breaker.py`;
`backend/app/services/learning/model_router.py` (Thompson-sampling over `model_routing_stats`) +
`routing_feedback.py`.

**Current Loom state — MISSING.** `aoai-chat-client` is unified but has no breaker; no learned routing.

**Azure-first build.** A `circuit-breaker.ts` wrapper around `aoai-chat-client` + `callMcpTool`; a
`model-router.ts` tracking per-task success/latency/cost in a `copilot-routing-stats` Cosmos container.
**Dedupe note:** the routing half is the learned-router deepening of **AIF-12** (Model Router) — build
jointly. **Bicep:** Cosmos container. **Gov:** both clouds. **Priority P3 · Effort M.**

---

## CTS-17 — AI spend burn-rate projection + budget alert

**Capability.** On top of the per-turn cost (CTS-01), a burn-rate/budget-projection view and a budget
alert on the aggregate Copilot spend stream — "at this rate you'll hit $X by month-end."

**Grounding (ATLAS — KEEP as P3, slimmed).** `backend/app/api/v1/endpoints/spend.py` — burn-rate/budget
projection (`GET /spend/projections`). **Loom drops** ATLAS's cross-repo (atlas-core/media/vox) rollup —
not Loom-relevant.

**Current Loom state — MISSING.** rel-T85 tracks per-call cost; no projection/alert.

**Azure-first build.** A `copilot-spend-projection.ts` aggregating the rel-T85 cost stream into a burn-rate
+ month-end projection; a budget threshold alert (Azure Monitor / in-app). **Dedupe note:** overlaps **W14**
(FinOps what-if simulator) and **FGC-28** (chargeback) — build as the Copilot-spend slice feeding those.
**Bicep:** none new. **Gov:** both clouds. **Priority P3 · Effort S.**

---

## ATLAS `portableExtras` triage (scope item 6)

Every ATLAS portable extra, triaged **KEEP** (→ a backlog item above) or **DROP** (not Loom-relevant), with
the mapping and a one-line reason.

| # | ATLAS extra | Verdict | Maps to / reason |
|---|-------------|---------|------------------|
| 1 | Self-evolution (skill synthesizer / dynamic tool gen / capability gap tracker) | **KEEP P3** | → **CTS-11**. Auto-learn + guided skill synthesis, admin-reviewed; rides the CTS-07 registry. |
| 2 | Provider routing via Thompson sampling (`model_router.py`) | **KEEP P3** | → **CTS-16** (routing half); dedupe with **AIF-12** Model Router — build as the learned deepening. |
| 3 | Per-provider circuit breaker | **KEEP P3** | → **CTS-16** (breaker half). Resilience for AOAI deployments + MCP servers. |
| 4 | Spend backstop / cross-repo cost rollup + burn-rate projection | **KEEP P3 (slimmed)** | → **CTS-17**. Keep burn-rate/budget projection on Loom's own spend; **drop** the cross-repo (atlas-core/media/vox) rollup — not Loom-relevant. |
| 5 | Admin replay / eval harness (capture → re-dispatch → YAML eval) | **KEEP P2** | → **CTS-14**; dedupe with **AIF-13** AgentOps. Strong Copilot-regression tool. |
| 6 | Talking-head avatar + real-time voice (Simli/XTTS/MuseTalk WebSocket) | **DROP** | Loom is an enterprise analytics/AI console; a lip-synced avatar has no place in the product surface. |
| 7 | 4-layer memory-write security guard | **KEEP P2 (Gov-critical)** | → **CTS-12**. Hard dependency of CTS-08; injection scan + redaction + locked-field gate + audit = Gov-safe memory. |
| 8 | Nightly REM memory consolidation + Hebbian graph | **KEEP P3** | → **CTS-13**. Port the dedupe/contradiction/topic-promotion pass on Cosmos + AI Search; **drop** Neo4j (Cosmos edge docs instead). |
| 9 | Household-scoped memory | **KEEP (folded)** | Folded into **CTS-08** as the **WORKSPACE** scope (the enterprise analog of household). No separate item. |
| 10 | Proactive context injection | **KEEP P2** | → **CTS-15**; dedupe with **BR-AMBIENT-FEED** (Wave 18). |
| 11 | Chat idempotency + tool-call parallelism telemetry (`ToolParallelMeta`) | **KEEP (folded)** | Folded into **CTS-02** as the parallelism chip row (batch/cache/speculation). No separate item. |

**Net:** 1 DROP (avatar/voice), 2 folded (household scope → CTS-08; parallelism telemetry → CTS-02), 8 KEEP
as backlog items (CTS-11..17, with #9 and #11 folded and #2/#3 both in CTS-16).

---

## Cross-cutting acceptance & rules recap

- **Default-ON, opt-out:** the metadata bar, context meter, curated skills, and memory recall are live on
  first render — a tenant admin can disable and a user can opt out, but there is **no enablement gate**.
- **No vaporware:** every item's receipt shows a real AOAI/Cosmos/AI Search response with
  `LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET — real tokens, real cost from the rel-T85 table, real recalled
  memories, real MCP-server attribution.
- **No Fabric dependency:** memory recall, skills injection, and grounding all run on Cosmos + Azure AI
  Search + AOAI; **zero** default-path `api.fabric.microsoft.com` / `api.powerbi.com` calls.
- **No freeform config:** the skills builder and every drill-down are forms/toggles/read-only views — no raw
  JSON textarea.
- **Fluent v9 + Loom tokens** on every new surface; **bicep-synced** — all new Cosmos containers via
  `createIfNotExists`, the AI Search vector index via the existing `loom-docs-index` bootstrap, and the
  consolidation job as an ACA Job / Function timer, all documented for Commercial + Gov.
- **Gov-safe by construction:** every memory write is injection-scanned, secret-redacted, and audited
  (CTS-12); vector recall honest-gates to a Cosmos keyword fallback where the vector index is absent.
