# palantir-migration-surfaces — parity with Palantir Foundry (audit-T29 / deep T50-T57)

Source: `docs/migrations/palantir-foundry/feature-mapping-complete.md`,
`app-migration.md`, `ai-migration.md`; audit rows `AUDIT-2026-06-10.md` (T29) and
`AUDIT-2026-06-10-deep.md` (T50-T57). Acceptance: real Azure-native
implementations of each surface, not doc-only mappings.

All six default Azure-native; nothing requires Microsoft Fabric or a Power BI
workspace (`.claude/rules/no-fabric-dependency.md`). Each shows an honest
infra-gate MessageBar (env var / RBAC) when the backing Azure resource is unset
(`.claude/rules/no-vaporware.md`).

## 1. Workshop → `workshop-app` (Atelier)
Palantir Workshop = low-code operational app builder over the ontology.

| Capability | Loom coverage | Backend per control |
| --- | --- | --- |
| Bind app to ontology objects | ✅ | `POST /api/items/workshop-app/[id]/bind-ontology` (Cosmos read of ontology + parse object types; persists binding; records Thread edge) |
| Object views (pages per object type) | ✅ | persisted on `state.objectViews`; rendered from the bound ontology's parsed classes |
| Write-back actions (create / update) | ✅ | persisted on `state.actions` (dropdown-built); runs through the ontology's bound Lakehouse/Warehouse |
| Hosting | ⚠️ honest-gate | Azure Container Apps (`modules/admin-plane/container-platform.bicep`) |

## 2. Slate → `slate-app`
Palantir Slate = custom HTML/JS app framework.

| Capability | Loom coverage | Backend per control |
| --- | --- | --- |
| Widget composition (table / chart / metric) | ✅ | persisted on `state.widgets` (dropdown + query path) |
| Bind to a data API | ✅ | `state.apiBaseUrl` → DAB / Ontology-SDK REST |
| Generate deployable app | ✅ | `POST /api/items/slate-app/[id]/generate` → real `index.html` + `app.js` + `staticwebapp.config.json` (Azure Static Web Apps) |

## 3. OSDK → `ontology-sdk`
Palantir OSDK = typed SDK over object / link / action types.

| Capability | Loom coverage | Backend per control |
| --- | --- | --- |
| Bind to an ontology | ✅ | `POST /api/items/ontology-sdk/[id]/bind-ontology` (Thread edge recorded) |
| Generate typed TS client | ✅ | `POST .../generate` → `generateTypeScriptSdk` (`lib/editors/_palantir-codegen.ts`) |
| Generate typed Python client | ✅ | `.../generate` → `generatePythonSdk` |
| REST/GraphQL Data API config | ✅ | `.../generate` → `generateDabConfig` (real `dab-config.json`) |
| Publish | ⚠️ honest-gate | DAB runtime (`modules/admin-plane/dab-runtime.bicep`) + APIM |

## 4. Apollo → `release-environment` (Shuttle)
Palantir Apollo = promotion / release orchestration across environments.

| Capability | Loom coverage | Backend per control |
| --- | --- | --- |
| Define promotion stages | ✅ | persisted on `state.stages` (mapped to Loom workspaces) |
| ARM deployment history | ✅ | `GET /api/items/release-environment/[id]/arm` → `listArmDeployments` (real Azure REST) or honest gate |
| Record promotions | ✅ | `POST .../promote` (real Cosmos persistence) |
| Catalog-driven environments | ⚠️ honest-gate | Azure Deployment Environments — `LOOM_DEVCENTER_PROJECT` + `modules/admin-plane/devcenter.bicep` |

## 5. Health Checks → `health-check`
Palantir Foundry Health Checks = monitoring views with alerts.

| Capability | Loom coverage | Backend per control |
| --- | --- | --- |
| Freshness check | ✅ | `POST /api/items/health-check/[id]/rule` (checkType=freshness) → real `scheduledQueryRule` |
| Row-count check | ✅ | `.../rule` (checkType=rowcount) |
| Custom KQL check | ✅ | `.../rule` (checkType=custom) |
| Email notification | ✅ | real Azure Monitor action group (`createMonitorActivatorRule`) |
| Rule list / state | ✅ | `GET .../rule` |
| Monitor not configured | ⚠️ honest-gate | names `LOOM_LOG_ANALYTICS_RESOURCE_ID` / `LOOM_ALERT_RG` / Monitoring Contributor |

## 6. AIP Logic / AIP → `aip-logic` (Spindle Studio)
Palantir AIP Logic = no-code typed LLM function (typed input → steps → output);
Palantir AIP = agents + logic that run over the ontology. Spindle Studio covers
both: typed logic functions AND a multi-step tool-calling agent runtime, both
grounded on the Weave ontology and runnable against real Azure OpenAI / Foundry.

| Capability | Loom coverage | Backend per control |
| --- | --- | --- |
| Typed input schema | ✅ | persisted on `state.inputs` (name + type dropdown) |
| Ordered steps (LLM / extract / branch) | ✅ | persisted on `state.steps` (dropdown — no freeform JSON) |
| Typed output | ✅ | `state.outputType` + description |
| Ground on Weave ontology | ✅ | `GET/POST /api/items/aip-logic/[id]/bind-ontology` → persists `state.boundOntologyId` + entity types + Thread edge `aip-logic-grounded-on` |
| Invoke as a function (grounded) | ✅ | `POST .../invoke` (`mode:'logic'`) → `chatGrounded` with the ontology's Lakehouse/Warehouse bindings attached as typed sources; queries run read-only on Synapse, answer cites real rows |
| Invoke as a tool-calling agent | ✅ | `POST .../invoke` (`mode:'agent'`) → `copilot-orchestrator` `orchestrate()` with `buildDefaultRegistry()` (Loom data tools) + ontology context; returns per-step run trace |
| Publish as Azure AI Foundry agent | ✅ | `POST .../deploy` → `createOrUpdateAgent()` (model = live AOAI deployment, tools = ontology data bindings); persists `state.foundryAgentId` |
| Run deployed agent + inspect steps | ✅ | `POST .../run-agent` → `runAgentAndInspect()` (thread→message→run→poll→steps) |
| No AOAI deployment | ⚠️ honest-gate | `.../invoke` + `.../deploy` 503 naming `LOOM_AOAI_ENDPOINT` + `LOOM_AOAI_DEPLOYMENT` |
| Foundry Agent Service unconfigured / Azure Gov | ⚠️ honest-gate | `.../deploy` + `.../run-agent` 501 naming `LOOM_FOUNDRY_PROJECT_ENDPOINT` + `LOOM_FOUNDRY_PROJECT_ID`; directs to the Azure-native Invoke path (Agent Service is unsupported in Azure Government) |

## Verification
- `npx tsc --noEmit` clean for all touched files (`palantir-editors.tsx`,
  `_palantir-codegen.ts`, `palantir-crud.ts`, the 6 route trees,
  `fabric-item-types.ts`, `registry.ts`).
- Unit tests: `lib/editors/__tests__/palantir-codegen.test.ts` (codegen is pure).
- Runtime E2E (minted-session walk per `no-vaporware.md`) is the integration
  gate — each editor renders, the primary action hits its real route, and the
  Azure-native backend responds or shows the documented MessageBar with
  `LOOM_DEFAULT_FABRIC_WORKSPACE` unset.
