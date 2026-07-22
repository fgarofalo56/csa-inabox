# loom-app-runtime — parity with Databricks Apps

Source docs: https://docs.databricks.com/aws/en/dev-tools/databricks-apps/
Audited: 2026-07-17 (APPS-W0, code-level with file:line evidence; paths relative to `apps/fiab-console/`).
Loom baseline: **Loom App Runtime** (`loom-app-runtime` item) — ACR quick-build → ACA deploy.
Program: `PRPs/completed/loom-apps-parity/PRP.md`. Sibling doc `loom-apps.md` covers the
*Fabric/Power-BI org-app* shape (`loom-app` visual item) — a different comparison.
Grades: ✅ built (real backend) · η partial · ❌ missing.

## Databricks Apps feature inventory → Loom coverage

### Frameworks / runtimes
| Capability | Grade | Evidence / gap |
|---|---|---|
| Streamlit | ✅ | `lib/azure/loom-apps-runtime-templates.ts:75-109` real scaffold + Dockerfile CMD |
| Dash | ✅ | `:111-151` gunicorn `app:server` |
| Gradio | ✅ | `:153-186` |
| Flask | ✅ | `:188-221` |
| Node (Express) | ✅ | `:223-265` |
| Agent (FastAPI + AOAI tool loop) | ✅ | `:275-411` (Loom-only bonus) |
| Shiny (py), Panel | ❌ | not in registry `:413-415` |
| React / Angular / Svelte / Next.js / Vite | ❌ | only bare Express for Node |
| R / Shiny | ❌ | `LoomAppRuntimeKind` is `'python'\|'node'` only (`:46`) |
| Bring-any-Dockerfile | ❌ | generated Dockerfile always wins; user `Dockerfile` dropped (`:496,499`) |

### App config & lifecycle
| Capability | Grade | Evidence / gap |
|---|---|---|
| app.yaml-equivalent manifest | η | port/env/entry exist as scattered fields; **no** unified manifest, no command/args/entrypoint editing (CMD fixed per-runtime `:431-475`), **no health path** (ACA TCP probe only) |
| Deploy from template | ✅ | `lib/azure/loom-apps-client.ts:289-315` (ACR SAS upload → DockerBuildRequest) |
| Deploy from public git | ✅ | `:267-288` |
| Private git (PAT/OBO) | ❌ | credentials hard-rejected `:282-283` |
| Workspace-file sync | ❌ | no mechanism |
| Redeploy-on-push | ❌ | manual POST only |
| Deploy / stop / start / delete | ✅ | `:415-457,479-487,468-476,490-499` real ARM/ACA |
| Restart | ❌ | stop→start only |
| Rollback-to-revision | ❌ | `activeRevisionsMode:'Single'` (`loom-apps-runtime-templates.ts:623`) forecloses it |
| Scale-to-zero | ✅ | `minReplicas:0` + http scale rule `:605,642-648` |
| CI/CD template / app bundle | ❌ | none app-specific |
| Local-dev harness / CLI | ❌ | none |

### Compute & auth
| Capability | Grade | Evidence / gap |
|---|---|---|
| Min/max replicas | ✅ | editor `lib/editors/loom-app-runtime-editor.tsx:457-458` → real ACA scale block |
| CPU / memory sizing | η | client accepts (`deploy/route.ts:76-77`) but **not exposed in the editor** — defaults 0.5 CPU / 1Gi |
| Concurrency | ❌ (UI) | hardcoded `concurrentRequests:'20'` (`:646`) |
| Always-on toggle | η | implicit via minReplicas>0; no labeled toggle |
| Dedicated app identity | η | a UAMI is assigned (`:616-619`) **but it is the single shared `uami-loom-mcp` for every app**, not per-app least-privilege; identity + grants not surfaced in the editor |
| Credential auto-injection | ❌ | only `PORT` is injected (`:610-611`); no `LOOM_APP_CLIENT_ID` / workspace URL / resource endpoints |
| Runs-as: service identity vs user OBO | ❌ | always service UAMI; Easy-Auth gates sign-in (`:662-693`) but outbound calls never OBO |

### Resources (Databricks' 13 attachable types)
| Capability | Grade | Evidence / gap |
|---|---|---|
| ANY one-click resource attach (grant + env inject) | ❌ | no Resources tab (tabs: Overview/Source/Deploy/Bindings/Logs/History `:342-347`); manual env Bindings only |
| Key Vault secret | η | `secretRef` accepted in env (`:608`, editor `:498`) **but `buildAcaAppBody` never emits `configuration.secrets[]` — a raw secretRef fails at ARM** (latent bug) |
| All other 12 types (app-to-app, Genie→Weave agent, Postgres, pipeline, MLflow, model endpoint, SQL warehouse, UC connection/table/volume, UDF, AI Search) | ❌ | no attach flow; app-to-app blocked further by `external:true`-only ingress (`:625`) |

### Monitoring & sharing
| Capability | Grade | Evidence / gap |
|---|---|---|
| Per-app console logs (LAW) | ✅ | `tailAppLogs` `loom-apps-client.ts:517-541` + Logs tab; honest gate on LAW env |
| App Insights / traces / metrics | ❌ | not provisioned or surfaced |
| Per-app cost | ❌ | tagged (`:615`) but no per-app cost view |
| Embed / allowed-origins (CSP) | ❌ | no frame/CSP config |
| Publish / share / marketplace | ❌ | item ACL only (the visual `loom-app` item has publish; the runtime does not) |
| Entra sign-in gating | ✅ | `buildAuthConfigBody` `:662-693` |

### Cross-cutting (positives)
- All 6 API routes owner-guarded (`resolveItemAccessByOid`) before any mutate.
- Honest infra gates (`LoomAppsNotConfiguredError` names env vars + bicep module).
- Default-on kill switch (env + tenant toggle) on build/deploy/start.
- Build+deploy chain is real ARM end-to-end (no mocks).

## Top-10 gaps (ordered by user impact → drives APP-W1..W5)
1. **No Resources tab / attachment** (0 of 13 types) + latent `secretRef`-without-`secrets[]` ARM bug → APP-W2.
2. **No auto env injection** (only PORT) → APP-W2.
3. **Shared (not per-app) UAMI + identity not surfaced** → APP-W2.
4. **No rollback-to-revision, no restart** (`Single` revision mode) → APP-W1.
5. **Missing frameworks** (React/Next/Vite/Svelte/Angular, Shiny/Panel/R, any-Dockerfile) → APP-W1.
6. **CPU/mem/concurrency not exposed** → APP-W1.
7. **No unified manifest + no health path** → APP-W1.
8. **No private git / workspace sync / redeploy-on-push** → APP-W4.
9. **No embed / allowed-origins / marketplace publish** → APP-W5.
10. **No local-dev CLI, no CI template/bundle; no App Insights/metrics/per-app cost in editor** → APP-W4/W5.

Re-run this audit at APP-W6; "on par or better than Databricks Apps" requires every row ✅ (or an explicitly-superior Loom equivalent).
