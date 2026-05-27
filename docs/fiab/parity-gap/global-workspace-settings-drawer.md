# Global parity gap: Workspace settings drawer

**Validated**: 2026-05-26  
**Surface**: Settings button on a workspace page → opens right-side drawer  
**Component**: `apps/fiab-console/lib/components/workspace-settings-drawer.tsx`  
**Fabric reference**: Fabric workspace settings — General, Permissions, Git integration, OneLake, Sensitivity, Premium capacity, License, Workspace deletion  
**Backend probed**: PATCH `/api/workspaces/[id]` (real); DELETE `/api/workspaces/[id]` (real); permissions/git/onelake stubs return MessageBars

## What renders (per code inspection)

Drawer with 6 vertical tabs:

1. **General** — name, description, capacity, domain (PATCH wired)
2. **Permissions** — MessageBar gate "Not wired — see issue #N" (per code comment)
3. **Git integration** — MessageBar gate
4. **OneLake** — MessageBar gate
5. **Sensitivity** — MessageBar gate
6. **Danger zone** — Delete workspace (DELETE wired)

Spec ask was 5 tabs (Permissions / Git / OneLake / Capacity / Domain). Actual implementation has 6 tabs but Capacity + Domain are inside General (acceptable consolidation).

## Functional probes (LIVE — UNREACHABLE in this session)

Could not validate live because:
- The `/workspaces/[id]` page was **stuck on "Loading workspace…" indefinitely** in two attempted runs
- Auth state in MCP browser kept dropping during navigation (`/api/me` flapped between authed/401)
- API direct probe (`fetch('/api/workspaces/6128cd84-...')`) returned 200 with real data, but the React page never finished rendering
- Suspected hydration / SWR race on this Front Door deployment

This is itself a **MAJOR finding** — the workspace detail page is unstable in our chrome-MCP test session. Real users may not see this if their cookies are persistent, but session-recovery edge cases break the page.

## Row-by-row matrix (per code inspection only)

| Fabric element | Loom: present | Severity | Notes |
|---|---|---|---|
| Settings button on workspace | YES | — | Tooltip "Workspace settings" |
| Drawer slides from right | YES | — | `position="end"`, `size="medium"` |
| Tab: General | FUNCTIONAL | — | PATCH real |
| Tab: Permissions | GATED w/ MessageBar | C+ | Honest no-vaporware gate |
| Tab: Git integration | GATED | C+ | |
| Tab: OneLake | GATED | C+ | |
| Tab: Sensitivity | GATED | C+ | |
| Tab: Danger zone | FUNCTIONAL | — | DELETE real |

## Grade: **C+ (code-level)** / **INCONCLUSIVE (live)**

Code shows 2 of 6 sections are real, 4 are honestly gated with MessageBars (per no-vaporware). Could not validate live because workspace detail page was stuck loading throughout this session. Re-validate manually after fixing the page hydration issue.
