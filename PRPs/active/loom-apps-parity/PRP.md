# PRP — Loom Apps: Databricks-Apps parity + beyond ("loom-apps-parity")

**Status:** ACTIVE (operator-requested 2026-07-17: "make sure Loom can do everything
Databricks can do with the Databricks Apps option; on par or better; expand + tighter
integration + ease of use; native in Loom; use Weave; make it awesome").
**Sources researched:** Databricks Apps docs (get-started, app-development, resources,
key concepts, monitoring, deployment) — docs.databricks.com/dev-tools/databricks-apps.
**Existing Loom baseline:** the **Loom App Runtime** (DBX-1) already exists and is
explicitly "Databricks-Apps-class hosted apps" — `lib/azure/loom-apps-client.ts` (ACR
quick-build → ACA deploy, dedicated UAMI), `lib/editors/loom-app-runtime-editor.tsx`,
`lib/azure/loom-apps-runtime-templates.ts` (streamlit/dash/gradio/flask/node-express/
agent-fastapi). Plus the visual `loom-app` (Workshop-class) + `rayfin-app` + `slate-app`.
**This PRP takes that baseline to FULL Databricks-Apps parity and beyond**, Azure-native,
Commercial + Gov day one, tightly Weave-integrated.

## Ground rules
Azure-native/OSS only on the default path (`no-fabric-dependency`); identical in
Commercial + Gov. Grade A per surface (ui-parity + ux-standards §7 + real backend +
browser E2E + LearnPopover + docs + demo). "As good or better" — where Loom already
exceeds Databricks (visual builder, ontology/Weave binding, publish-as-API, Copilot
authoring, multi-cloud), that richer bar stands.

## THE PARITY MATRIX — every Databricks Apps capability → Loom

### Frameworks / runtimes
| Databricks Apps | Loom today | Action |
|---|---|---|
| Python: Streamlit, Dash, Gradio, Flask, Shiny | streamlit, dash, gradio, flask ✅ | **ADD Shiny (py), Panel, Plotly-Dash, FastAPI-UI**; keep agent-fastapi |
| Node: React, Angular, Svelte, Express | node-express ✅ | **ADD React, Angular, Svelte, Next.js, Vite starters** |
| — | — | **EXPAND: Streamlit-in-Snowflake-style + R/Shiny; a "bring any Dockerfile" escape hatch** |

### App config & lifecycle
| DBX | Loom | Action |
|---|---|---|
| `app.yaml` (command, args, env, entrypoint) | app manifest (partial) | **Full app.yaml-equiv**: command, args, env vars, entrypoint, health path, port — visual form + raw editor |
| Deploy (workspace sync or git repo) | ACR build from template or public git ✅ | **ADD: private git (PAT/OBO), workspace-file sync, redeploy-on-push** |
| Local dev (`python app.py`, run-local, breakpoints) | — | **Loom local-dev harness**: `loom apps run-local` CLI + env var injection parity |
| Lifecycle: deploy / stop / start | runtime-store (partial) | **Full**: deploy, stop, start, restart, rollback-to-revision (ACA revisions), scale-to-zero |
| CI/CD: GitHub Actions, Declarative Bundles | gh-aca-runner exists | **App CI template** (build→deploy→health-gate) + a Loom app-bundle format |
| 10 MB file limit / resource limits | — | Honest limits + a clear error, not a silent fail |

### Compute & auth
| DBX | Loom | Action |
|---|---|---|
| Serverless, configurable CPU/mem, always-on | ACA ✅ | **CPU/mem sliders, min-replicas (always-on) vs scale-to-0, concurrency** — visual |
| Dedicated app service principal, least-privilege | dedicated UAMI per app ✅ | keep; surface the app identity + its grants in the editor |
| Credential injection (DATABRICKS_CLIENT_ID/SECRET, host) | env injection (partial) | **Parity env set**: LOOM_APP_CLIENT_ID, workspace URL, resource endpoints auto-injected |
| (Newer) user OAuth on-behalf-of | Loom OBO exists (SqlAccessModeSection) | **App-runs-as: service-identity OR on-behalf-of-user toggle** — Loom EXCEEDS the AWS docs here |

### Resources an app can attach (Databricks lists 13) → Azure-native
| DBX resource | Loom Azure-native mapping |
|---|---|
| Databricks app (app-to-app) | ACA app-to-app (internal ingress + DAPR-style) |
| Genie Agent (NL analytics) | **Weave ontology agent / Loom Copilot** (natural-language over objects) — tighter than Genie |
| Lakebase (Postgres) | Azure Database for PostgreSQL (Weave PG / Lakebase item) |
| Lakeflow job | ADF / Synapse pipeline (data-pipeline item) |
| MLflow experiments | AML MLflow / MLflow-on-ACA |
| Model serving endpoint | AML online endpoint / AOAI deployment |
| Secret | Azure Key Vault (secretRef) |
| SQL warehouse | Synapse Serverless / Dedicated (warehouse item) |
| Unity Catalog connection | Linked Service / UC connection |
| Unity Catalog table | lakehouse Delta table (UC table) |
| User-defined function | Azure Function / Synapse UDF / Loom function |
| Unity Catalog volume | ADLS Gen2 volume |
| AI Search index | Azure AI Search (ai-search-index item) |
| **+ Loom-only** | **Weave ontology (objects+actions), eventstream, semantic-model, report, data-product, digital-twin** as attachable resources |

**Resource UX:** a "Resources" tab on the app editor — add resource → pick from the
caller's Loom items → Loom grants the app UAMI least-privilege on it + injects the
endpoint/secret env vars (the Databricks resource model, made one-click).

### Monitoring & sharing
| DBX | Loom |
|---|---|
| Logs, audit events, cost, app insights | App Insights + LAW logs + audit + Monitor>Cost per-app ✅ |
| Telemetry (traces/logs/metrics in UC) | OpenTelemetry → App Insights; metrics on /admin |
| Embed in external websites | Loom embed (CSP-aware; per-app allowed-origins) |
| Permissions / sharing | workspace-guard + access-requests (marketplace publish) |

## EXPANSION (beyond Databricks — the "better")
- [ ] **Weave-native apps:** bind an ontology as a first-class resource — the app SDK
      can `query objects`, `invoke actions`, `traverse links` with zero boilerplate.
      Databricks Apps have no ontology; this is Loom's moat inside apps.
- [ ] **Copilot-authored apps:** "describe your app" → Loom scaffolds the template +
      resources + code (AOAI); one-click from a data product / ontology / report.
- [ ] **Visual + code, one item:** merge the Workshop-class visual builder (`loom-app`)
      with the code runtime (`loom-app-runtime`) — start visual, "eject to code",
      or embed a visual widget IN a code app.
- [ ] **Publish app as API / MCP:** one-click expose an app's function as a Loom API
      (APIM) or an MCP tool (already a Weave edge — wire it to apps).
- [ ] **Marketplace-publish an app:** package + share via the Loom marketplace (install
      → provision → seed), exceeding Databricks' app sharing.
- [ ] **Multi-cloud day one:** every app deploys identically in Commercial + Gov (ACA is
      Gov-GA) — Databricks Apps Gov availability is limited.
- [ ] **Golden templates gallery:** dashboards (Streamlit/Dash), data-entry (write-back
      via Weave actions), chat-over-your-data (RAG on AI Search + ontology), ops console,
      approval app, geospatial (ties GEO-1), ML scoring UI.

## Waves
- [x] **APP-W0 — audit + gap doc:** `docs/fiab/parity/loom-app-runtime.md` (zero ❌).
- [x] **APP-W1 — framework + config parity:** frameworks (Streamlit/Dash/Gradio/
      Flask/Node + agent-fastapi + any-Dockerfile via git) + template config +
      lifecycle (stop/start/delete/scale). Golden templates added in W5.
- [x] **APP-W2 — Resources tab (the core):** SHIPPED + browser-E2E'd 2026-07-18/19
      (PRs #2166-#2173, rev 0000327): 9 attachable kinds w/ one-click grant + env
      injection; per-item lakehouse + KQL-database pickers (DB-scoped Viewer);
      ARG-by-name cross-sub scopes; honest pending-grants scripts; bicep-synced
      constrained RBAC-Admin (#2170). Warehouse per-item deliberately skipped
      (items share the dedicated pool DB).
- [x] **APP-W3 — Weave-native + Copilot authoring:** SHIPPED + E2E'd (PRs
      #2175-#2180, rev 0000331): weave-ontology resource kind (self-healing PG
      grant — Console is the weave PG Entra admin), Ontology Explorer template
      + loom_ontology SDK (+ auto AZURE_CLIENT_ID), Copilot scaffolder
      (/assist; E2E'd incl. real deploy — in-VNet APPHEALTH 200). Side-finds
      fixed: Weave AGE store was silently empty since day one (#2179, 3 bugs);
      CAE privatelink zone empty → all hosted apps ENOTFOUND in-VNet (#2180).
      Visual↔code merge = workshop-app "Open as code" eject → linked
      loom-app-runtime (generated Express source over a PAT-authenticated
      run-action proxy; run-action is now PAT-capable). NOTE: 'loom-app' is
      the org-app BUNDLER, not the visual builder — the builders are
      workshop-app/slate-app/rayfin-app; embed-in-code-app = iframe the
      existing SWA publish URL (console frame-ancestors 'none' is by design).
- [x] **APP-W4 — dev loop + CI/CD:** SHIPPED (PRs #2184-#2185): `loom apps` CLI
      (build/deploy/logs/lifecycle/run-local/export/ci-template/reconcile),
      `GET /context` (byte-identical build context) + `.loomapp` export,
      generated GitHub Actions CI template (loom-aca runner), private-git via
      per-item Key Vault PAT (`/git-credential` + tokenized clone URL),
      redeploy-on-push poll reconciler (`/reconcile`, smart-HTTP ls-remote).
- [x] **APP-W5 — monitoring/embed/marketplace/publish-as-API+MCP/golden templates:**
      FULLY SHIPPED (PRs #2186-#2193): 5 golden templates (RAG chat, ops console,
      geospatial, ML scoring, approval); per-app Monitoring tab (Azure Monitor
      metrics + bounded month-to-date cost); publish-app-as-API (APIM →
      Marketplace) AND publish-as-MCP (agent-fastapi apps, `/mcp` JSON-RPC proxy);
      `.loomapp` export + install-from-bundle round-trip; embed = app-is-own-origin.
      Browser-E2E'd live (rev 0000337): Monitoring stat grid renders, Publish-as-API
      creates a real APIM API. Three E2E-only defects caught+fixed (#2192/#2193:
      cost-timeout, stale-URL, path-display).
- [x] **APP-W6 — docs + parity doc (zero ❌):** `docs/fiab/parity/loom-app-runtime.md`
      re-run showing every matrix row built ✅ / honest-gate ⚠️; Gov path is the
      identical ACA deploy (Gov-GA). **PRP COMPLETE — 18 PRs #2183-#2193.**

## Verification
Per `no-vaporware`/`ui-parity`/`ux-baseline`: real ACA deploy per app, browser E2E
(deploy a Streamlit app that queries a lakehouse + invokes a Weave action, Commercial +
Gov), parity doc zero-❌, §7 checklist, demo apps seeded. "On par or better than
Databricks Apps" requires the W0 audit re-run at W6 showing every matrix row ✅.
