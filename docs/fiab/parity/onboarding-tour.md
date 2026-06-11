# onboarding-tour — parity with Microsoft Fabric Home onboarding

Source UI: Microsoft Fabric Home "Navigate the Fabric home page" — key areas + the
feature-aware Help (?) pane.
- https://learn.microsoft.com/fabric/fundamentals/fabric-home
- https://learn.microsoft.com/fabric/fundamentals/copilot-fabric-overview (in-context help)

Fabric does not ship a blocking onboarding wizard; it teaches the Home surface
with numbered "key areas" and a persistent Help pane ("Keep Help open while you
learn a new workload"). CSA Loom mirrors that model with a dismissable,
resumable teaching-bubble tour over the equivalent shell anchors — built on
Fluent's purpose-built `TeachingPopover` (no new dependency, no modal blocker).

## Fabric/Azure feature inventory (Fabric Home key areas)

| # | Fabric Home key area | What it is |
|---|----------------------|------------|
| 1 | Navigation pane | Left rail to move between workspaces, OneLake, monitoring, admin |
| 2 | Fabric / experience switcher | Switch between workloads/experiences |
| 3 | Create | Entry point to make new items |
| 4 | Top bar | Search, Help (?), Feedback, Notifications, Settings, Account |
| 5 | Learning & getting-started resources | Tutorials, sample data, docs |
| 6 | Your content / recents | Recently opened items |
| — | Help (?) pane | Feature-aware help kept open while learning |
| — | Resume / replay | Help is always reachable; onboarding is non-blocking |

## Loom coverage

| Fabric area | Loom anchor (`data-tour`) | Tour step | Status |
|-------------|---------------------------|-----------|--------|
| Navigation pane (1) | `nav` (left rail) | "Navigate your platform" | built ✅ |
| Switcher / Create (2,3) | reached from `nav` → Workspaces → + New | covered by nav step + docHref `/workspaces` | built ✅ |
| Top-bar Search (4) | `search` (TopbarSearch, Ctrl+K) | "Find anything fast" | built ✅ |
| Top-bar Help / Copilot (4) | `copilot` (Help Copilot, Ctrl+/) | "Ask the Help Copilot" | built ✅ |
| Learning resources (5) | `help` (Help menu → Learn library) | "Learn library & guided tutorials" | built ✅ |
| Getting started / deploy | `setup-intro` (`/setup` hero) | "Provision a Data Landing Zone" | built ✅ |
| Welcome / orientation | `brand` (CSA Loom wordmark) | "Welcome to CSA Loom" | built ✅ |
| Non-blocking + Help-resumable | Help menu → "Take the guided tour" → `openTour()` | replay/resume | built ✅ |
| Your content / recents (6) | already shipped (PinnedSection / recents) — not a tour step by design | — | n/a |

Zero ❌, zero stub banners.

## Backend per control

The tour is pure client-side Fluent v9 + Next.js — it touches **no** Fabric or
Power BI host on any path, so it renders identically in Commercial, GCC,
GCC-High, and IL5. Persistence rides the existing Cosmos `user-prefs` container
(no new infra):

| Control | Backend |
|---------|---------|
| First-run auto-open gate | `GET /api/me` (authenticated?) + `GET /api/user-prefs?key=tour:v1:completed` (Cosmos `user-prefs`) |
| Anti-flash first-paint guard | `localStorage["loom.tourSeen.v1"]` |
| Next / Back step persistence | `POST /api/user-prefs {key:"tour:v1:lastStep", value:<i>}` (Cosmos) |
| Dismiss / Finish | `POST /api/user-prefs {key:"tour:v1:completed", value:true}` + localStorage flag |
| Resume / replay | Help menu item → `openTour()` window event → resumes from `tour:v1:lastStep` |

## Bicep / bootstrap sync

No new Azure resource, env var, or role. The `user-prefs` Cosmos container is
already created idempotently by `lib/azure/cosmos-client.ts`
(`createIfNotExists('user-prefs', '/userId')`, line ~344) and is in the ensure
list — so `az deployment sub create -f platform/fiab/bicep/main.bicep` already
provisions everything the tour needs. Zero bicep drift.

## Verification

- `npx tsc --noEmit` — new files clean (no new errors).
- `npx vitest run lib/onboarding` — registry invariants + `openTour` event
  contract pass.
- Manual walk (authenticated, `tour:v1:completed` unset): tour auto-opens on the
  welcome anchor → Next walks nav → search → copilot → help → routes to `/setup`
  → Finish persists completion. Esc / Skip / X dismiss and persist; Help →
  "Take the guided tour" resumes from the last step.
