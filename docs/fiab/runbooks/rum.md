# Runbook — Client-side real-user monitoring (RUM1)

**Surface:** `/admin/rum` · **Ingest:** `POST /api/telemetry/rum` (session-gated BFF)
**Owner item:** loom-next-level `ws-verification-dr.md` RUM1 · **Kill-switch:** runtime flag `rum1-client-telemetry`

## What it is

The console's telemetry was server-side only (PRP ground truth #14) — a
GuidedPickerRail-class client freeze on a path outside the synthetic-journey
set was invisible. RUM1 adds **first-party** browser capture on every console
page:

| Signal | Capture | App Insights table (LAW) |
|---|---|---|
| Hard page loads | real Navigation Timing (total/network/send/receive/processing) | `browserTimings` / `AppBrowserTimings` |
| Soft route changes | App Router pathname transitions (view counts only — no fabricated durations) | `pageViews` / `AppPageViews` |
| Web Vitals | LCP, FCP, TTFB, CLS, INP-approx (worst event duration) via `PerformanceObserver` | `customEvents` / `AppEvents` (`loom-rum-vitals`) |
| Unhandled errors | `window.onerror` + `unhandledrejection`, deduped, ≤10/session | `exceptions` / `AppExceptions` |

Every row carries `AppRoleName == 'loom-console-browser'` and a
`csa-loom.surface` property (the scrubbed route shape) — filter on the role to
separate RUM from server telemetry.

## Architecture (IL5-safe by design)

```
browser (first-party capture, bundled in the console image — NO CDN)
  └─ POST /api/telemetry/rum   (session-gated, rate-limited 2/s burst 20,
      │                         64 KB / 30-item caps, PII re-scrub)
      └─ App Insights track API ({IngestionEndpoint}/v2.1/track from
                                  APPLICATIONINSIGHTS_CONNECTION_STRING)
          └─ Log Analytics workspace → /admin/rum (KQL via monitor-client)
```

- The browser talks **only to the console BFF** — no external telemetry
  beacon, satisfying X-IL5 checklist item 4.
- Per-cloud by construction: the connection string embeds the ingestion
  endpoint (`.azure.com` Commercial, `.azure.us` Gov); the `/admin/rum` KQL
  path uses the cloud-aware `api.loganalytics` host from `cloud-endpoints.ts`.

## Privacy (no PII)

Scrubbing happens **client-side before anything leaves the page**, and again
server-side on ingest (`lib/telemetry/rum-shared.ts`, unit-tested):

- Surfaces are route **shapes**: GUID/hex/numeric/random id segments → `:id`;
  query strings + fragments dropped wholesale.
- Error text scrubbed of emails, GUIDs, JWTs, bearer tokens, URL queries;
  length-capped.
- **No user identifier is ever forwarded** — the session gates abuse; it never
  becomes a telemetry dimension.

## Config

| Setting | Default | Where |
|---|---|---|
| `LOOM_RUM_ENABLED` | `true` (opt-out with `false`) | `observabilityConfig.rumEnabled` bag → console env |
| `LOOM_RUM_SAMPLE_RATE` | `100` (0–100, per-session sampling) | `observabilityConfig.rumSampleRate` bag → console env |
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | derived (monitoring module) | withheld when `telemetryEnabled=false` → RUM silently no-ops |
| Runtime flag `rum1-client-telemetry` | ON | `/admin/runtime-flags` — instant kill, no roll |

ENV_CHECKS id: `svc-client-rum` (observability fragment, `optionalDefault` —
unset = silent no-op, never a health defect).

## Operations

- **Kill capture now:** `/admin/runtime-flags` → flip `rum1-client-telemetry`
  OFF. New page loads stop capturing on their config fetch; in-flight beacons
  are dropped at the ingest route. Seconds, no revision roll.
- **Reduce volume:** set `LOOM_RUM_SAMPLE_RATE` (e.g. `10`) via
  `/admin/env-config` or the bicep bag.
- **Verify live:** open a few console pages, then in Log Analytics:
  `AppBrowserTimings | where AppRoleName == 'loom-console-browser' | take 10`.
- **Admin view gated?** `/admin/rum` needs `LOOM_LOG_ANALYTICS_WORKSPACE_ID`
  (auto-derived) + **Log Analytics Reader** for the Console UAMI — capture
  itself keeps working while the view is gated.

## Cost

LAW ingestion delta only: beacons are ≤4 small envelopes per page view,
sampled. At 100% sampling on a busy tenant expect low single-digit **MB/day**
— well under $1/mo/cloud at PAYG LAW rates; bound further via
`LOOM_RUM_SAMPLE_RATE`. No new Azure resources.

## Rollback

Flip the `rum1-client-telemetry` flag OFF (instant), set
`LOOM_RUM_ENABLED=false` (revision roll), or git-revert the RUM1 PR at
leisure — all three leave server telemetry and synthetic journeys untouched.
