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
- [ ] **APP-W0 — audit + gap doc:** deep-read the live Loom App Runtime; grade every
      matrix row (built ✅ / partial η / ❌); `docs/fiab/parity/loom-apps.md`. (~1 session)
- [ ] **APP-W1 — framework + config parity:** add missing frameworks (Shiny/Panel/React/
      Angular/Svelte/Next/Vite/any-Dockerfile) + full app.yaml-equiv manifest + lifecycle
      (stop/start/restart/rollback/scale). (~2)
- [ ] **APP-W2 — Resources tab (the core):** the 13+ attachable resource types, one-click
      grant + env injection, app-identity panel, runs-as (SP vs OBO). (~2)
- [ ] **APP-W3 — Weave-native + Copilot authoring:** ontology-as-resource SDK, Copilot
      "describe your app" scaffolder, visual↔code merge. (~2)
- [ ] **APP-W4 — dev loop + CI/CD:** local-dev harness/CLI, private-git deploy,
      redeploy-on-push, app-bundle + CI template. (~1.5)
- [ ] **APP-W5 — monitoring, embed, marketplace, publish-as-API/MCP, golden templates. (~2)
- [ ] **APP-W6 — docs/walkthroughs/demo apps + final A-grade parity doc (zero ❌), Gov pass. (~1)

## Verification
Per `no-vaporware`/`ui-parity`/`ux-baseline`: real ACA deploy per app, browser E2E
(deploy a Streamlit app that queries a lakehouse + invokes a Weave action, Commercial +
Gov), parity doc zero-❌, §7 checklist, demo apps seeded. "On par or better than
Databricks Apps" requires the W0 audit re-run at W6 showing every matrix row ✅.
