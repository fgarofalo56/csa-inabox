# copilot-console — parity with a best-in-class AI chat console (audit-T121)

Source UI: pre-launch Loom Copilot landing (`app/copilot/page.tsx` hero) ·
ChatGPT / Copilot Studio / Azure AI Foundry playground chat patterns ·
Microsoft Fabric Copilot chat pane.

The console is the full-screen orchestrator chat rendered by `/copilot`
(launched) and embedded at `/items/cross-item-copilot/<id>`. It keeps the real
`copilot-orchestrator` SSE engine intact — this overhaul is UI + session
management only.

## Feature inventory (best-in-class chat console)

| Capability | Loom coverage | Backend |
|---|---|---|
| Hero / product identity header | built ✅ gradient hero w/ Loom tokens (`CopilotConsoleView` non-embedded) | — |
| Sessions left rail | built ✅ `SessionList` | `GET /api/copilot/sessions` |
| — search / filter | built ✅ `SearchBox` | client filter |
| — recency grouping (Pinned/Today/Yesterday/This week/Older) | built ✅ `bucketFor()` | `updatedAt` |
| — active-session state | built ✅ `aria-current` + brand styling | — |
| — rename | built ✅ inline `Input` → PATCH | `PATCH /api/copilot/sessions/[id] {title}` |
| — pin / favorite | built ✅ hover menu → PATCH | `PATCH … {pinned}` |
| — duplicate | built ✅ new chat pre-filled w/ source prompt | client (new session on send) |
| — delete (confirm dialog) | built ✅ | `DELETE /api/copilot/sessions/[id]` |
| — hover "…" menu | built ✅ `Menu`/`MenuPopover` | — |
| — real empty state + New chat CTA | built ✅ | — |
| Transcript: user vs assistant bubbles | built ✅ `Transcript` avatars + role chips | — |
| — markdown rendering | built ✅ `CopilotMarkdown` (headings/lists/tables/links) | — |
| — syntax-highlighted code + copy | built ✅ fenced blocks → `MonacoTextarea` read-only + Copy | — |
| — streaming indicator | built ✅ "Thinking…" spinner on the in-flight turn | SSE `step` |
| — tool-call + run-receipt rendering | built ✅ `StepStream` + `CopilotResult` (grid/chart/Monaco) | tool invoke results |
| — citations | built ✅ `CitationChips` when a turn carries sources | tool result `citations` |
| — copy answer | built ✅ | — |
| — regenerate | built ✅ re-POST the originating prompt | `POST /api/copilot/orchestrate` |
| — thumbs up/down feedback | built ✅ | `PATCH … {rating, messageIndex}` (Cosmos `copilot-feedback`) |
| Composer pinned at bottom; messages scroll | built ✅ `flex-shrink:0` composer, single scroll region (T118) | — |
| — Enter to send / Shift+Enter newline | built ✅ | — |
| Right rail: active persona | built ✅ `ToolsPanel` `getPanePersona(contextSlug)` | persona registry |
| — persona suggested prompts (fill composer) | built ✅ | persona `suggestedPrompts` |
| — tool catalog: name + what-it-does + when-to-use | built ✅ `whenToUse` falls back to `description` | `GET /api/copilot/tools` |
| — "reads active context" badge | built ✅ `readsContext` | tool metadata |
| — live status badge | built ✅ Ready/AOAI deployment + tool count | `GET /api/copilot/status` |
| — guided tool Run (no raw JSON) | built ✅ `SchemaArgForm` (enum→Dropdown, bool→Switch, …) | `POST /api/copilot/tools/[name]/invoke` |
| Honest AOAI gate (no deployment) | built ✅ MessageBar + cloud-correct AI Foundry deep link | `status.aoai.portalDeepLink` |
| Loading / error states | built ✅ Spinner + MessageBar across panels | — |

Zero ❌ rows, zero stub banners.

## Backend (unchanged engine; additive only)

- SSE chat: `POST /api/copilot/orchestrate` — untouched.
- Sessions: `GET /api/copilot/sessions`, `GET/DELETE/PATCH …/[id]`. PATCH gained
  a rename/pin branch (`updateSessionMeta` in `copilot-orchestrator.ts`, real
  Cosmos read-modify-write with ownership check) alongside the existing
  feedback branch. `SessionSummary` + `listSessions` now also select
  `c.title, c.pinned`.
- Tools: `GET /api/copilot/tools` now surfaces optional `whenToUse` /
  `readsContext` from `ToolDef` (undefined → UI falls back to `description`).

## Per-cloud

UI-only; no new env vars or bicep. The single cloud-aware seam (AI Foundry
portal deep link) already resolves `ai.azure.com` (Commercial/GCC) vs
`ai.azure.us` (GCC-High/IL5/DoD) server-side via `/api/copilot/status` and is
consumed unchanged — never hardcoded.

## No-Fabric / no-vaporware compliance

- Works with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset — Cosmos via
  `LOOM_COSMOS_ENDPOINT`, AOAI via the Foundry hub; no Fabric/Power BI host on
  the default path. Persona copy says "CSA Loom", never "Microsoft Fabric".
- Every control wires to a real route; tool runner uses guided controls, not
  raw JSON (loom_no_freeform_config).

## Verification

`npx tsc --noEmit` clean on the touched files. Live: launch `/copilot`, send a
prompt (real SSE stream), rename/pin/delete a session and confirm it persists
across reload (Cosmos), confirm the composer stays pinned while only the
transcript scrolls.
