# Global parity gap: Copilot pane (top-right Sparkle button)

**Validated**: 2026-05-26  
**Surface**: Sparkle icon in top-bar actions → opens Copilot side drawer (Ctrl+/ also opens)  
**Component**: `apps/fiab-console/lib/components/copilot-pane.tsx`  
**Fabric reference**: Microsoft Fabric Copilot side pane streams LLM responses (Azure OpenAI), grounded in workspace items  
**Backend probed**: `POST /api/copilot/orchestrate` exists (route file present); other routes too (`/api/copilot/sessions`, `/api/copilot/tools`)

## What renders

- Sparkle button at top-right of global actions toolbar, `aria-label="Open Copilot"`, tooltip "Copilot (Ctrl+/)"
- Click → `aside[aria-label="Copilot"]` slides in from right, 380px wide, top-anchored under topbar
- Pane has: header with Sparkle icon + "Copilot" title + "Ctrl + /" hint + close X
- Body: scrollable message list with seed message ("Hi! I can help you…")
- Composer: text input + send button

## Functional probes (auth'd)

- Click Sparkle → pane opens — PASS
- Typed "Test message: do you call the orchestrate API?" + Send → response received in ~400ms
- Response text:
  > For "Test message: do you call the orchestrate API?", here's what I'd try:
  > 
  > • Open the most relevant item editor.
  > • Draft the KQL / DAX / T-SQL.
  > • Wire an Activator rule if you want alerts.
  > 
  > (Wire me to a real LLM by setting AZURE_OPENAI_ENDPOINT.)

- **ZERO calls to /api/copilot/orchestrate** captured during the send (verified via browser_network_requests filter)
- Code (line 99-111 of copilot-pane.tsx) literally hardcodes the templated response with `setTimeout(400)`
- The code itself states in plain text: `(Wire me to a real LLM by setting AZURE_OPENAI_ENDPOINT.)`

## What's broken

This is **CLASSIC VAPORWARE per `.claude/rules/no-vaporware.md`**:
- The UI looks like real Copilot
- The send button works
- The response includes the user's text echoed back inside a templated reply
- But NO LLM is called, NO API is hit, the entire interaction is a `setTimeout` + string template

The orchestrate route exists in the codebase. The pane code chooses not to use it.

## Row-by-row matrix

| Fabric element | Loom: present | Severity | Notes |
|---|---|---|---|
| Sparkle button top-right | YES | — | |
| Ctrl+/ shortcut | YES | — | Works |
| Side pane slides in from right | YES | — | 380px wide, fixed |
| Seed greeting | YES | — | Hardcoded |
| Compose + send | YES UI | — | Button works |
| **LLM response** | **NO** | **BLOCKER** | Mock template response, never calls the orchestrate API |
| Grounding indicators | NO | MAJOR | Fabric shows "Grounded in: notebook-X" |
| Streaming | NO | MAJOR | All-at-once mock |
| New session / clear chat | NO | MINOR | |

## Grade: **F (Vaporware)**

Per no-vaporware.md this surface MUST either (a) wire to `/api/copilot/orchestrate` (which already exists) and stream real Azure OpenAI responses, or (b) be removed from chrome entirely and replaced with a button that says "Copilot — coming soon" + a MessageBar with the env var to set.

The code admits its own vaporware status in a literal sentence inside the templated response. This needs immediate attention.
