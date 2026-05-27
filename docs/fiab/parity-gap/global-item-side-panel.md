# Global parity gap: Item side panel (Comments / Version history / Share / Learn)

**Validated**: 2026-05-26  
**Surface**: Right-side icon strip on item editors (4 buttons)  
**Component**: rendered inside editor pages; consumed via `lib/components/app-shell.tsx` ribbon area  
**Fabric reference**: Fabric item editors all show a right-edge action strip — Comments / Activity / Version history / Share / Send link / Learn — all wired  
**Backend probed**: Comments, version history, share are all DISABLED (per DOM probe)

## What renders

Tested live on `/items/notebook/new`. Right-side panel button state:

| Button | aria-label | disabled | Notes |
|---|---|---|---|
| Comments | "Comments" | **TRUE** | Button present but greyed out — no comments backend |
| Version history | "Version history" | **TRUE** | Button present but greyed out |
| Share | "Share" | **TRUE** | Button present but greyed out |
| Learn about this item | "Learn about this item" | FALSE | Opens Learn drawer (works) |

## What's broken

3 of 4 right-side buttons are silently disabled with no MessageBar explaining what's missing. Per `no-vaporware.md`:

> ## What's explicitly forbidden
> 
> - Buttons with no click handler

Disabled buttons are not click-handler-less, but the user sees a Fabric-like button strip and 3 of 4 are inert with no signposting to "why". This is per-spec a **BROKEN** finding for Phase 4 of the parity validator.

## Row-by-row matrix

| Fabric element | Loom: present | Severity | Notes |
|---|---|---|---|
| 4-button strip on right edge | YES | — | Visual parity |
| Comments works | **NO** (disabled) | **MAJOR** | Backend not implemented; no MessageBar gate |
| Version history works | **NO** (disabled) | **MAJOR** | Same |
| Share works | **NO** (disabled) | **MAJOR** | Same |
| Learn works | YES | — | Opens drawer with item-type quick-start |
| Activity feed button | NO | MINOR | Fabric has 5-6 buttons; Loom has 4 |
| Send link | NO | MINOR | |

## Grade: **D**

Three of four primary actions are silently disabled with no signpost. This pattern needs the no-vaporware MessageBar treatment immediately: either wire to a real backend (a Cosmos `comments` container partitioned by itemId would unblock Comments; version-history needs `manifest-versions` container; Share needs Entra group-grant via Graph API) OR show a MessageBar that says "Comments not yet enabled — see roadmap item X." Disabled-without-explanation is the worst-case UX.
