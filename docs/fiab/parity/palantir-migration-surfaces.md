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

## 6. AIP Logic → `aip-logic` (Spindle)
Palantir AIP Logic = no-code typed LLM function (typed input → steps → output).

| Capability | Loom coverage | Backend per control |
| --- | --- | --- |
| Typed input schema | ✅ | persisted on `state.inputs` (name + type dropdown) |
| Ordered steps (LLM / extract / branch) | ✅ | persisted on `state.steps` (dropdown — no freeform JSON) |
| Typed output | ✅ | `state.outputType` + description |
| Invoke as a function | ✅ | `POST /api/items/aip-logic/[id]/invoke` → `chatGrounded` against live Azure OpenAI |
| No AOAI deployment | ⚠️ honest-gate | names AOAI env vars / Foundry deploy step |

## Verification
- `npx tsc --noEmit` clean for all touched files (`palantir-editors.tsx`,
  `_palantir-codegen.ts`, `palantir-crud.ts`, the 6 route trees,
  `fabric-item-types.ts`, `registry.ts`).
- Unit tests: `lib/editors/__tests__/palantir-codegen.test.ts` (codegen is pure).
- Runtime E2E (minted-session walk per `no-vaporware.md`) is the integration
  gate — each editor renders, the primary action hits its real route, and the
  Azure-native backend responds or shows the documented MessageBar with
  `LOOM_DEFAULT_FABRIC_WORKSPACE` unset.
