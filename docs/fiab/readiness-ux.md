# Readiness UX — capability graph + workload scorecard + tenant profile (WS-H)

Admin surface: **`/admin/readiness`** (nav: Admin → Readiness).
BFF: `GET /api/admin/readiness`, `GET /api/admin/readiness/export`.
Compute: `apps/fiab-console/lib/admin/readiness.ts` (pure, unit-tested).

A live **go/no-go** view of the deployment. Everything is computed from real
gate + probe state — no fabricated status (`no-vaporware.md`).

## Data sources (real, no mocks)

| Surface | Source | What it provides |
| --- | --- | --- |
| H1 capability graph | `lib/gates/registry.ts` — `GATES` + `allGateStatuses()` | Per-capability env vars (present/missing), backend surfaces, RBAC role, bicep module, configured/blocked status — the exact env-presence checks the per-client `*ConfigGate()` helpers gate on. |
| H1 live status | `lib/admin/health-probes.ts` via `runSelfAudit()` | A read-only call against the actual Azure backend as the Console UAMI, mapped to its gate by `GATE_PROBE_MAP`. |
| H2 workload scorecard | the same gate + probe state, grouped by `WORKLOADS` | Ready / Partial / Blocked go/no-go per named workload. |
| H3 tenant profile | `buildTenantProfile` + `renderProfileMarkdown` | JSON + readable markdown export with timestamp, environment, and every gated dependency's remediation. |

## Readiness state semantics

- **ready** — configured and, where a live probe exists, probe-verified
  (`verified: 'live-probe'`). A configured capability with no probe is `ready`
  but honestly marked `verified: 'config-only'` (env-presence verified, not
  exercised end-to-end) — never a fabricated live green.
- **partial** — configured but the live probe warns (e.g. RBAC/network issue).
- **blocked** — required config missing, or the live probe fails
  (configured-but-broken). An auto-resolving optional-default gate
  (`canAutoResolve`) is `ready` even when unset — that is the intended default.

## Workload go/no-go

`WORKLOADS` groups capabilities into named workloads (Core platform, Data
Integration, Data Engineering, Real-Time Intelligence, Governance & Security,
AI & Copilot, Business Intelligence, Machine Learning, App Development,
Eventing & Messaging). A workload is:

- **blocked** — any **critical** capability is blocked (hard no-go), or every
  capability is blocked;
- **ready** — every capability is ready;
- **partial** — otherwise.

The workload registry references real gate ids; `readiness.test.ts` asserts every
id exists in `GATES`, so the map can never drift from the registry.

## Fix path

A blocked/partial capability's inspector shows the exact unmet prerequisites and
a one-click **Fix it** — the shared `GateFixitDialog` the gate registry uses,
which discovers real Azure resources and applies through the audited env-config
write path (G2).

## Export (H3)

- `GET /api/admin/readiness/export` → JSON `TenantProfile` (download).
- `GET /api/admin/readiness/export?format=md` → markdown report (download).

Both carry a timestamp, the non-secret environment (subscription / resource
groups / cloud), the ready capabilities, and every gated dependency with its
exact remediation.

## Tests

- `lib/admin/__tests__/readiness.test.ts` — pure compute (H1/H2/H3), 18 cases.
- `app/api/admin/readiness/__tests__/readiness-routes.test.ts` — BFF contract
  (capability gate, report shape, JSON + markdown export), 6 cases.

## Owed

Live in-browser E2E screenshot (dark + light) per G1 — not captured this session
(no browser). The compute is unit-tested and the routes are contract-tested with
the self-audit run mocked.
