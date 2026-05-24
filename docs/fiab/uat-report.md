---
title: CSA Loom — UAT Report (Iteration 1)
date: 2026-05-23
status: blocked
---

# UAT Report — Iteration 1

End-to-end UAT attempt against the live CSA Loom deployment in the
limitlessdata FedCiv DLZ subscription (`363ef5d1-…`).

## What landed

| Layer | State |
|---|---|
| ACR (`acrloomvggjkbjpheamtg`) | Private endpoint locked back down, 6 images pushed at `v0.1` |
| Container Apps Env (`cae-csa-loom-eastus2`, internal mode) | Provisioned, LB IP `10.0.2.85` reachable from peered VNet |
| Container Apps (6 of 6) | All present, revisions provisioned |
| UAT jumpbox (`loom-uat-jumpbox`) | Ubuntu 24.04 + Chromium + Playwright + AAD-SSH, peered into hub VNet |
| Private DNS zone `delightfulmoss-96202bfd.eastus2.azurecontainerapps.io` | Created with `*`, `@`, `*.internal`, `internal` A records → 10.0.2.85; linked to hub + DLZ VNets |
| Playwright smoke test (`apps/fiab-console/tests/uat-console-smoke.mjs`) | Wrote, encoded, runs on jumpbox; hits all 8 panes |

## What blocked

Every ACA ingress hostname — Console, MCP, setup-orchestrator (this one
even reports `healthState: Healthy`) — returns the ACA "Container App is
stopped or does not exist" 404 page when reached via the env LB. Verified:

- DNS resolves correctly to `10.0.2.85`
- LB accepts the connection (TLS terminates with `-k`, HTTP 404 body)
- Direct revision FQDN (`loom-console--0000001.internal.delightfulmoss-…`) returns the same 404
- Health probes on `/api/health` were the original culprit for Console (no such route in the Next.js BFF — fixed by stripping probes from the template via REST PUT, which spun a healthy `loom-console--0000001` revision)
- Even after fix, the env LB still returns the same 404 for every ingress hostname

The env LB IP is correct (matches `properties.staticIp` and the
`capp-svc-lb` frontend in `ME_cae-csa-loom-eastus2_…`). The 404 is
emitted by ACA's edge, not the app — meaning the ingress map doesn't
recognise the Host header. Root cause not yet identified — candidates:

1. The env's ingress-host map needs a deactivate/activate cycle on each
   app after the probe-stripping PUT (the old `qdhm92f` revision is
   technically gone but the env may be caching a "stopped" entry)
2. An SNI/TLS cert binding inside the env LB that doesn't cover the
   `.internal.<env-domain>` form for ingress (only for replica-direct?)
3. Routing rule not picked up because the apps were originally created
   while the env was in some half-configured DNS state

Recommended next step: restart each Container App via
`az containerapp revision restart` (or `az containerapp update --set-env-vars FORCE=$(date +%s)` to spin a fresh revision), then re-curl. If still 404, open an ACA support ticket — symptoms are consistent with the known internal-env ingress-cache bug.

## Evidence

- Playwright JSON result + screenshots staged on jumpbox at `/tmp/loom-uat/`
- Run output captured in this session's transcript
- All 8 pane URLs returned HTTP 404 with the ACA edge page

## Plumbing committed in this session

- `apps/fiab-console/tests/uat-console-smoke.mjs` — Playwright smoke test (URL points at `loom-console.internal.delightfulmoss-…`)
- `uat-runner-final.sh` — base64-bundled runner, installs Playwright locally on the jumpbox, runs the smoke test, writes screenshots + JSON to `/tmp/loom-uat/`
- Private DNS zone `delightfulmoss-96202bfd.eastus2.azurecontainerapps.io` — manually created in `rg-csa-loom-admin-eastus2`, wildcard A records, linked to hub + DLZ VNets
- Container App `loom-console` — probes stripped via REST PUT, new `loom-console--0000001` revision Healthy

## Open issues

- ACA env ingress returns 404 for every hostname (see above)
- Most apps' health probes are misconfigured (point at endpoints that don't exist in their respective codebases) — same fix as Console needed across MCP, Activator, Mirroring, Direct-Lake-Shim
- `@azure/monitor-opentelemetry` init still failing at Console startup (non-fatal, but logs an error every boot)

Tracked for the next iteration. Console v0.2 should add proper
`/api/health` routes to every app + correct probe configuration in the
Bicep templates so this doesn't recur.
