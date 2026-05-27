# Global parity gap: Theme toggle (light/dark)

**Validated**: 2026-05-26  
**Surface**: Moon/sun icon in top-bar actions  
**Component**: `apps/fiab-console/lib/components/theme-toggle.tsx`  
**Fabric reference**: Fabric exposes Settings → Theme → Light/Dark/High-contrast in account flyout  
**Backend probed**: Likely persisted to `/api/user-prefs?key=theme` (not verified live)

## What renders

- Theme button, `aria-label="Switch to dark theme"` (toggles to "Switch to light theme")
- `title="Dark theme"` / `title="Light theme"`
- Icon switches between moon/sun

## Functional probes (auth'd)

- Initial state: `data-theme="light"`, body bg ~ white
- Click → `data-theme="dark"`, body bg `rgb(21, 19, 28)` — PASS
- Button label flips from "Switch to dark theme" to "Switch to light theme" — PASS
- Fluent token system swaps (verified visually)

## Row-by-row matrix

| Fabric element | Loom: present | Severity | Notes |
|---|---|---|---|
| Toggle button | YES | — | One-click toggle (Fabric is 2-click via Settings flyout) |
| Light theme | YES | — | |
| Dark theme | YES | — | |
| High-contrast theme | NO | MINOR | Fabric supports; accessibility-mode recommendation |
| Persist across sessions | LIKELY (need probe) | MINOR | Code suggests `/api/user-prefs` |
| Respects OS prefers-color-scheme | UNKNOWN | MINOR | |

## Grade: **B+**

One-click theme toggle is actually CLEANER than Fabric's nested-menu flow. Missing high-contrast, but core light/dark works.
