# Global parity gap: Topbar — logo + brand

**Validated**: 2026-05-26  
**Surface**: Top-left logo + wordmark on every page (`<Link href="/">CSA Loom</Link>`)  
**Fabric reference**: Microsoft Fabric top-bar — Fabric icon + "Microsoft Fabric" wordmark, dark `#0A2540`-ish background  
**Loom URL**: `https://<your-console-hostname>/` (all routes)

## What renders

- Loom rope/braid icon (16px) + "CSA Loom" wordmark (white, 14px-ish), padded at `x=16, y=8, h=40, w=224`
- Header background: dark purple `#2c1d59`-range (per `--loom-topbar-bg`)
- Icon + wordmark are wrapped in `<Link href="/">` with `aria-label="CSA Loom (Cloud Scale Analytics) — home"` and Tooltip
- Avatar appears on the right as "FG" Persona; pre-auth shows "Sign in" text link

## Row-by-row matrix

| Fabric element | Loom: present | Severity | Notes |
|---|---|---|---|
| Product icon | YES (Loom rope) | — | Branded for Loom — by design, not Fabric. Looks polished. |
| Wordmark | YES ("CSA Loom") | — | White text on dark purple |
| Click logo → home | YES | — | Real `<Link href="/">` |
| Tenant name display | NO | MINOR | Fabric shows tenant subdomain in some skins; Loom doesn't |
| Visual contrast | OK | — | White on dark purple passes WCAG AA |

## Functional probes

- Click logo → routes to `/` (Home) — PASS
- Hover → Tooltip "CSA Loom — home" appears — PASS
- Brand wordmark visible at all viewports >= 768px — visible at 1600/1920px tested

## Grade: **A-**

Topbar branding is clean, on-brand, and accessible. Down 1 notch only because there's no tenant indicator (a minor Fabric parity miss). Not a blocker.
