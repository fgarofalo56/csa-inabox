# Admin Portal — Updates & Version Sync (`/admin/updates`) — Parity Gap

> Validator: v2 fabric-parity-loop · 4-phase check  
> Run date: 2026-05-26  
> Fabric reference: **None** — Updates is a Loom-native admin surface; Fabric ships continuously and does not surface a version-sync page in its admin portal.  
> Loom URL: <https://loom-console-fvbbctd4eehqbkcs.b02.azurefd.net/admin/updates>

## Captures

| Loom | Fabric |
|---|---|
| Live capture blocked by session expiry; structure from `apps/fiab-console/app/admin/updates/page.tsx` (141 lines) | N/A — no Fabric equivalent. Closest is the Azure portal's resource-provider version banner + Fabric's in-portal "What's new" toast / blog. |

## Phase 1 — What Fabric provides

Fabric does **not** ship an admin "Updates & version sync" surface. Fabric is a SaaS — Microsoft rolls updates continuously to all tenants. There's a public roadmap (`https://aka.ms/FabricRoadmap`), a "What's new" blog, and the in-product Help menu has "What's new" links. There is no per-tenant version reporting.

This means **the Updates page is Loom-native** — Loom is open-source, you run it yourself, and you need to know what version you're on vs the upstream repo. This is a legitimate Loom-specific feature, not a parity gap.

## Phase 2 — What Loom provides

Source: `apps/fiab-console/app/admin/updates/page.tsx` — **141 lines, real implementation**:

- Calls `GET /api/version` (which returns `{ current, upstream, recent, hasUpdate, repo, error? }`).
- Renders a hero band with two version "badges": **Currently running** and **Latest upstream** (with the GitHub repo slug).
- Status badge: **"Update available"** (brand) or **"Up to date"** (success, with checkmark icon) per `hasUpdate`.
- **Re-check** button — re-fires the fetch.
- When update is available: **View release on GitHub** button (links to release URL) + **Open deploy workflow** button (links to GitHub Actions).
- **Release notes** panel rendering the upstream release body (markdown rendered as preformatted whitespace).
- **Recent releases** list — shows last N releases with version, name, published date, prerelease badge, "View" link.
- Privacy footer explaining feedback flow (tenant ID hashed before leaving deployment).

## Phase 3 — Gap matrix

No Fabric equivalent → no parity gap. Comparing against itself / the Loom contract:

| Required Loom element | Loom | Severity |
|---|---|---|
| Show running version (build marker) | Yes | OK |
| Show upstream version (GitHub Releases API) | Yes | OK |
| Show "update available" / "up to date" status | Yes (badge with appropriate color + icon) | OK |
| Re-check button (manual refresh) | Yes | OK |
| Deep-link to release on GitHub | Yes | OK |
| Deep-link to deploy workflow | Yes | OK |
| Render release notes | Yes (raw text, `whiteSpace: pre-wrap`) | MINOR — should be rendered Markdown, not raw text (release notes contain `## headings` and `- bullets` that today render as literal characters) |
| Recent-releases history list | Yes | OK |
| Privacy disclosure for feedback flow | Yes | OK |
| Loading state | Yes ("Checking for updates…") | OK |
| Error state (GitHub unreachable) | Yes (caption "(unable to reach GitHub: <error>)") | OK |

## Phase 4 — Functional verification

Code-confirmed real backend at `/api/version` (would need a live probe in a fresh session to confirm 200 + payload shape, but the code structure is correct).

| Control | Expected | Status |
|---|---|---|
| Page load | Fetches `/api/version` on mount | Code-confirmed |
| Re-check button | Re-fires fetch | Code-confirmed (onClick → load()) |
| Release-on-GitHub link | Opens GitHub release in new tab | Code-confirmed (`target="_blank" rel="noreferrer"`) |
| Deploy workflow link | Opens repo Actions tab | Code-confirmed |

## Grade: **A−** (or **B** depending on how strict on markdown rendering)

- Honest contract, real backend, real data, real CTAs that work, sensible error/loading states, privacy disclosure attached.
- The one nit holding it back from A: release notes are rendered as raw `<div>` text with `whiteSpace: pre-wrap`. GitHub release bodies are Markdown (`#`, `##`, `-`, fenced code, links). Today those render as literal `## foo` text. Add `react-markdown` (or similar lightweight renderer) and this is A.
- This is **the strongest admin page** in the portal, alongside Capacity. Should be the model for the rest.
