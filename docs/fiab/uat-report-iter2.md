---
title: CSA Loom — UAT Report (Iteration 2 — GREEN)
date: 2026-05-23
status: passed
---

# UAT Report — Iteration 2 (GREEN ✅)

End-to-end Playwright UAT against the live CSA Loom Console — **all 8 panes pass**.

## Root cause of iter-1 ingress 404

From Microsoft Learn's [Communicate between container apps](https://learn.microsoft.com/azure/container-apps/connect-apps#external-and-internal-fqdns):

> "When you set ingress to **internal**, the FQDN includes an `.internal.` segment. Other container apps in the same environment can still reach the app using this address, but requests from outside the environment receive a `404` response from the environment's proxy. The DNS name resolves to the environment's shared IP, but the proxy rejects the request because the app is internal-only."

The UAT jumpbox lives in the **DLZ VNet** (peered to the env's hub VNet) — i.e., it's **outside** the Container Apps environment. With Console set to `ingress: internal`, the env's Envoy proxy refuses external requests by design. Iter-1's 404s were correct ACA behaviour, not a bug.

## Fix

`az containerapp ingress update -g rg-csa-loom-admin-eastus2 -n loom-console --type external`. The env itself is still `vnetConfiguration.internal: true`, so traffic stays inside the VNet — but the app's ingress proxy now accepts requests from the broader VNet, not just from sibling container apps.

This is the right default for any user-facing pane (Console). Backend services (MCP, Activator, Mirroring, Direct-Lake-Shim) stay on `internal` ingress — only sibling apps need to reach them.

## Smoke test result (2026-05-24 03:25 UTC)

```json
{
  "url": "https://loom-console.delightfulmoss-96202bfd.eastus2.azurecontainerapps.io",
  "rootStatus": 200,
  "panes": [
    { "name": "workspaces",     "status": 200, "navActive": 1, "ok": true },
    { "name": "lakehouse",      "status": 200, "navActive": 1, "ok": true },
    { "name": "warehouse",      "status": 200, "navActive": 1, "ok": true },
    { "name": "notebook",       "status": 200, "navActive": 1, "ok": true },
    { "name": "semantic-model", "status": 200, "navActive": 1, "ok": true },
    { "name": "activator",      "status": 200, "navActive": 1, "ok": true },
    { "name": "data-agent",     "status": 200, "navActive": 1, "ok": true },
    { "name": "setup-wizard",   "status": 200, "navActive": 1, "ok": true }
  ]
}
```

All 8 panes load. `navActive: 1` on every pane = the left-nav active highlight binds correctly to the route. Sub-resource 401s seen in browser console are expected: BFF API endpoints (`/api/workspaces`, `/api/users/me`, etc.) require an authenticated session, and the smoke test runs unauthenticated. The shell renders; the data fetches expect the user to sign in.

## Screenshots

Captured on the jumpbox at `/tmp/loom-uat/`:

```
00-root.png            workspaces.png      lakehouse.png
warehouse.png          notebook.png        semantic-model.png
activator.png          data-agent.png      setup-wizard.png
uat-result.json
```

To pull them off the jumpbox (RG `rg-csa-loom-dlz-single-eastus2`):

```bash
az vm run-command invoke -g rg-csa-loom-dlz-single-eastus2 -n loom-uat-jumpbox \
  --command-id RunShellScript \
  --scripts "cd /tmp/loom-uat && base64 -w0 loom-uat-screens.tgz"
# decode the base64 blob locally → tar xzf
```

## Backend app state (separate from UAT pass)

The 4 worker apps still have application-level issues being fixed in PR #327 (queued for auto-merge). The Console UAT passes regardless because those apps back data sources that aren't required to render the shell:

| App | State (pre-#327) | Fix in #327 |
|---|---|---|
| `loom-console` | ✅ Healthy | n/a |
| `loom-setup-orchestrator` | ✅ Healthy | n/a |
| `loom-mcp` | ❌ "no SDKs" runtime error | ENTRYPOINT now globs for actual dll |
| `loom-activator` | ❌ DI registration crash | Singleton factories use placeholder URIs + lazy connect |
| `loom-direct-lake-shim` | ❌ Same as MCP | AssemblyName added to csproj |
| `loom-mirroring` | ❌ Missing Debezium config | Default env vars baked in |

Once #327 merges and `full-app-deploy-commercial` re-runs to push the fixed images, all 6 should land Healthy.

## What this iteration proves

- ✅ The full CSA Loom Console front-end is built, deployed, and reachable in Azure Commercial via an internal Container Apps env
- ✅ All 8 panes (workspaces / lakehouse / warehouse / notebook / semantic-model / activator / data-agent / setup-wizard) render and route correctly
- ✅ Left-nav active-item highlighting works on every pane
- ✅ Private DNS + VNet peering pattern documented and validated end-to-end from a jumpbox

## Open follow-ups

- Authenticated UAT: re-run the smoke test with an MSAL token to validate BFF data fetches (`/api/workspaces`, etc.) return 200, not 401
- Capture annotated screenshots once Bastion access lets a human visually walk the panes
- Lock ingress decisions in Bicep: Console = `external` (still in-VNet because env is internal); MCP/Activator/Mirroring/DLS = `internal`
- v1.1 backlog: provision real Cosmos / Redis / Service Bus / Event Hubs Kafka and wire up the four worker apps end-to-end
