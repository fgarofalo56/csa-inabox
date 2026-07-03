# Global non-editor chrome parity — validation summary

**Validated**: 2026-05-26 (Platform Admin, fabric-parity-loop validator pass)  
**Live URL**: `https://<your-console-hostname>/`  
**Method**: Playwright MCP live-browser probes — DOM inspection + network observation + click handlers + functional tests on signed-in session
**Rule reference**: `.claude/rules/no-vaporware.md` + `.claude/workflows/fabric-parity-loop.md`

## Verdict matrix

| # | Surface | Grade | Real backend? | Vaporware? | Severity of gap |
|---|---|---|---|---|---|
| 1 | Topbar logo + brand | A- | n/a (static) | No | MINOR (no tenant indicator) |
| 2 | App launcher (waffle) | B | YES — /api/apps-catalog | No | MINOR (no icons, no unauth gate) |
| 3 | Tab strip | C | YES — /api/tabs Cosmos | No | **BLOCKER** (overflow hides global actions) |
| 4 | Topbar search + Ctrl+K palette | D | NO — static catalog only | **YES** | **BLOCKER** (can't find real items) |
| 5 | Copilot pane | **F** | NO — hardcoded template | **YES (admitted in code)** | **BLOCKER** (no LLM call) |
| 6 | Notifications | B | YES — /api/notifications | No | MINOR (no severity icons) |
| 7 | Send feedback | B+ | YES (code-level wired) | No | MINOR (no screenshot attach) |
| 8 | Theme toggle | B+ | local + likely /api/user-prefs | No | MINOR (no high-contrast) |
| 9 | Learn link | B+ | static authored content | No | MINOR (no in-page search) |
| 10 | Admin link | N/A | covered by admin validator | — | see admin docs |
| 11 | Workspace settings drawer | C+ / INCONCLUSIVE | partial (2 of 6 tabs real) | No (honest gates) | MAJOR (live page unstable) |
| 12 | Item-side-panel (Comments/Version/Share/Learn) | **D** | NO for 3 of 4 | partial | **BLOCKER** (3 buttons silently disabled) |
| 13 | New-item dialog | A | static catalog (correct) | No | MINOR (no in-dialog search) |
| 14 | Sign-in flow | B- | MSAL real | No | MAJOR (session instability observed) |
| 15 | Activity feed (Recent / Pinned / Recommended apps) | A- | YES — multiple BFF endpoints | No | MINOR (no activity timeline) |

## Aggregate

- **A or A+**: 1 (New-item dialog)
- **A-**: 2 (Topbar branding, Activity feed)
- **B+**: 3 (Send feedback, Theme toggle, Learn link)
- **B**: 2 (App launcher, Notifications)
- **B-**: 1 (Sign-in flow)
- **C+**: 1 (Workspace settings drawer)
- **C**: 1 (Tab strip)
- **D**: 2 (Topbar search, Item-side-panel)
- **F**: 1 (Copilot pane — VAPORWARE)
- N/A: 1 (Admin link — separate validator)

## Top-3 most urgent fixes (by user pain × frequency)

### 1. Copilot pane — REMOVE OR WIRE (F → A)
The chat sends, replies, but **never calls /api/copilot/orchestrate**. Code admits "Wire me to a real LLM by setting AZURE_OPENAI_ENDPOINT" in the templated mock response. Either wire to the orchestrate route (which exists and is fully built per the codebase) OR remove the Sparkle button from chrome and replace with a MessageBar gate.

**Fix scope**: `lib/components/copilot-pane.tsx` lines 99-111 — replace `setTimeout` mock with `await fetch('/api/copilot/orchestrate', {…})` + streaming.

### 2. Tab strip overflow — BLOCKER (C → A)
Once a user opens 5+ tabs (which happens within minutes of starting work), the tab strip overflows horizontally past the viewport and visibly overlaps the right-side global actions toolbar. There's no chevron / no overflow menu / no scroll affordance (scrollbar is hidden via CSS).

**Fix scope**: `lib/components/tab-strip.tsx` — add an overflow chevron with `MoreHorizontal24Regular` icon that opens a Popover listing hidden tabs; ensure flex layout caps tab strip width at `calc(100vw - actions-width - logo-width - launcher-width - search-max-width)`.

### 3. Topbar search — wire to real items (D → A)
The Command Palette claims to "Search items, settings, item types" but only searches the static catalog. Real items (lakehouses, notebooks, reports the user has actually created) are invisible. Users will give up on it.

**Fix scope**: `lib/components/command-palette.tsx` — add an `Items` group, debounced fetch to `/api/search/items?q={q}`, render results inline. The BFF route already exists.

## Tab-strip overflow root cause (debug breadcrumb)

In a session with 11 tabs and viewport=1600px:
- Tabs strip extends from x=296 to x=2792 (1500px past viewport edge)
- Right-side icons at x=1420 (Learn) and x=1456 (Admin) are physically rendered ON TOP OF where tabs are
- localStorage cache + Cosmos persistence keep tab list alive across sessions, so even closing browser doesn't help
- POSTing `{tabs:[]}` to `/api/tabs` clears server-side but localStorage repopulates instantly

## Auth instability breadcrumb

During this validation, `/api/me` flapped between authed/401 unpredictably:
- Page navigation sometimes caused token to drop
- Refresh sometimes restored auth, sometimes routed to MSAL
- This made several live probes (workspace detail, item editor first-load) inconclusive
- Suspected cookie SameSite / Front Door routing race; needs follow-up

## Honest scoring summary

Of 14 surfaces with grades (excluding N/A admin):
- **3 are at or above B+ and feel production-grade** (new-item dialog, send feedback, learn link, activity feed)
- **6 are functional but rough** (topbar, app launcher, theme toggle, notifications, sign-in, workspace settings)
- **5 are stubbed, broken, or vaporware** (tab strip overflow, topbar search, item-side-panel, copilot pane)

Target per parity rubric: every surface A or A+. We have **1 A, 2 A-, and 12 below A**. There is significant chrome work between "today" and "A everywhere."
