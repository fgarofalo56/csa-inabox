# loom-app-runtime — parity with Databricks Apps

Source: Databricks Apps docs — https://docs.databricks.com/dev-tools/databricks-apps
(get-started, app-development, resources, key concepts, monitoring, deployment).

The **Loom App Runtime** (`loom-app-runtime`) is CSA Loom's Databricks-Apps-class
hosted-app service, built entirely on **Azure Container Apps + the Loom Azure
Container Registry** — no Databricks, no Fabric, no Power BI dependency
(`.claude/rules/no-fabric-dependency.md`). It runs identically in Commercial and
Gov (ACA is Gov-GA). Deploys are default-ON for any user with workspace access —
no spend gate, no approval gate; cost is bounded structurally by `minReplicas:0`.

Legend: built ✅ · honest-gate ⚠️ (renders fully; names the exact env/role/
resource to provision) · MISSING ❌.

---

## Frameworks / runtimes

| Databricks Apps | Loom coverage | Where |
|---|---|---|
| Python: Streamlit / Dash / Gradio / Flask | built ✅ | `lib/azure/loom-apps-runtime-templates.ts` — `streamlit`, `dash`, `gradio`, `flask` |
| FastAPI agent harness | built ✅ | `agent-fastapi` (pre-wired `/invoke` over Azure OpenAI) |
| Node: Express | built ✅ | `node-express` |
| "Bring any Dockerfile" (git repo) | built ✅ | Source tab → git repository URL; ACR builds the repo's Dockerfile |
| Golden templates (RAG chat, ops console, geospatial, ML scoring, approval, ontology explorer) | built ✅ | `rag-chat`, `ops-console`, `geospatial`, `ml-scoring`, `approval-app`, `ontology-explorer` |

Frameworks are a fixed dropdown (`loom_no_freeform_config`); each starter is real,
runnable code (`no-vaporware`). The git path is the "any framework" escape hatch.

## App config & lifecycle

| Databricks | Loom coverage | Where |
|---|---|---|
| `app.yaml` (command/args/env/entrypoint/port) | built ✅ | Template declares entry + manifest + port; env via the Bindings tab; the generated Dockerfile is the command/entrypoint |
| Deploy from template or git | built ✅ | Build → Deploy; ACR quick-build → ACA |
| **Private git (PAT)** | built ✅ | Source tab token field → Key Vault (`loom-app-git-<id8>`); `buildApp` composes the provider tokenized clone URL server-side |
| Local dev harness | built ✅ | `loom apps run-local <id>` — fetches the REAL assembled build context (`GET /context`) + `docker run` |
| Lifecycle: deploy / stop / start | built ✅ | Overview Start/Stop/Delete (real ACA action APIs) |
| Scale-to-zero (rest at ~$0) | built ✅ | `minReplicas: 0` floor enforced in `buildAcaAppBody` |
| CI/CD (GitHub Actions) | built ✅ | `loom apps ci-template` → workflow (build→deploy→gate) on the in-VNet `loom-aca` runner |
| **Redeploy-on-push** | built ✅ | `/reconcile` (poll `ls-remote` SHA vs `lastBuiltSha`) + `loom apps reconcile --build` |
| App-bundle format | built ✅ | `loom apps export` / `GET /export` → secret-safe `.loomapp` |

## Compute & auth

| Databricks | Loom coverage | Where |
|---|---|---|
| Serverless, configurable CPU/mem, always-on | built ✅ | Deploy tab replica min/max; CPU/mem in `buildAcaAppBody` |
| Dedicated app service principal, least-privilege | built ✅ | Shared apps UAMI (`LOOM_APPS_UAMI_ID`) — the identity every app runs as |
| Credential injection (client id, host, resource endpoints) | built ✅ | `AZURE_CLIENT_ID` + `LOOM_APP_CLIENT_ID` auto-injected; Resource attaches inject `APP_*`/`LOOM_*` endpoints |
| OAuth wrapper (Entra Easy-Auth) | built ✅ | `buildAuthConfigBody`; retries once + surfaces `authDetail` on failure |

## Resources an app can attach

The Resources tab (`lib/apps/app-resources.ts`) — one-click grant + env injection,
the Databricks resource model made one-click. Each Databricks resource maps to an
Azure-native backend:

| Databricks resource | Loom kind | Status |
|---|---|---|
| SQL warehouse | `warehouse` (Synapse SQL) | built ✅ |
| Unity Catalog table / volume | `lakehouse` (ADLS Gen2 + Delta), per-item picker | built ✅ |
| Secret | `keyvault` (KV secretRef) | built ✅ |
| Model serving endpoint | `aoai` (Azure OpenAI) | built ✅ |
| AI Search index | `ai-search` | built ✅ |
| Lakebase (Postgres) | `cosmos` + `weave-ontology` (AGE on PG) | built ✅ |
| Eventstream / Event Hub | `eventhubs` | built ✅ |
| Eventhouse / KQL | `adx`, per-item KQL-database picker (DB-scoped Viewer) | built ✅ |
| **Genie Agent (NL analytics)** | **`weave-ontology`** (query objects / invoke actions / traverse links via the `loom_ontology` SDK) | built ✅ — Loom's moat |

Grants use the correct plane per kind (ARM roleAssignments / ADX principalAssignments
/ Cosmos sqlRoleAssignments / PG principal); cross-sub scopes resolve by name via
Azure Resource Graph; data-plane grants ARM can't apply return an honest
pending-grants script pre-filled with real values.

## Monitoring & sharing

| Databricks | Loom coverage | Where |
|---|---|---|
| Logs | built ✅ | Logs tab → Log Analytics `ContainerAppConsoleLogs_CL` |
| Cost + metrics + App Insights | built ✅ | Monitoring tab → Azure Monitor metrics (Requests/Replicas/CPU/Memory) + month-to-date cost (Cost Management, filtered to the app's ACA resource) |
| **Embed in external websites** | built ✅ | The deployed app is its own ACA origin (separately embeddable); the console's own `frame-ancestors 'none'` is by design |
| Permissions / sharing | built ✅ | workspace-guard + access-requests; **publish-as-API** (APIM) surfaces the app in Marketplace → APIs |

## Beyond Databricks (the "better")

| Capability | Status | Where |
|---|---|---|
| Weave-native apps (ontology as a first-class resource + zero-boilerplate SDK) | built ✅ | `weave-ontology` kind + `loom_ontology.py` |
| Copilot-authored apps ("describe your app") | built ✅ | Copilot tab → `/assist` (two-phase propose→apply) |
| Visual↔code merge (Workshop "Open as code") | built ✅ | `workshop-app` eject → linked `loom-app-runtime` |
| Publish app as API (APIM) | built ✅ | Overview "Publish as API" → `/publish-api` |
| Publish app as MCP tool | honest-gate ⚠️ | agent-fastapi apps; scoped follow-on (generic OpenAPI→MCP shim) |
| Marketplace-publish an app | built ✅ (export) / follow-on (install) | `.loomapp` export shipped; install-from-bundle is the scoped follow-on |
| Multi-cloud day one (Commercial + Gov) | built ✅ | ACA is Gov-GA; identical deploy path |

## Honest infra gate

When `LOOM_APPS_CAE_ID` / `LOOM_APPS_ACR_LOGIN_SERVER` / the app UAMI are unset,
the editor renders fully and a MessageBar names the exact env vars +
`platform/fiab/bicep/modules/admin-plane/main.bicep` (`deployAppsEnabled`). On
AKS boundaries the runtime honest-gates to the GitOps-manifest path.

## Verification (from-scratch, per no-vaporware)

E2E receipts captured live (rev 0000327–0000333, minted-session + in-VNet probes):
- Attach every resource kind → real grant + injected env (APPS-W2).
- Ontology attach → object write-back returns a real AGE vertex.
- Copilot scaffold → real AOAI plan applied → Source shows generated files.
- Ontology Explorer + ejected Workshop app: build → deploy → in-VNet
  `APPHEALTH 200` / container logs "listening on :3000".
- `loom apps run-local` fetches a byte-identical build context; `.loomapp`
  export is secret-safe.

Unit: `lib/azure/__tests__/loom-apps-runtime.test.ts` (templates, Dockerfile,
build-context, ustar tar, ACA body, authConfig); `loom-apps-git-token.test.ts`
(tokenizer + ls-remote parse); route tests.

## Remaining (explicit, scoped)

- Publish-as-**MCP** for non-agent apps (generic OpenAPI→MCP shim).
- Marketplace **install-from-`.loomapp`** (the export half is shipped).

Every other matrix row is built ✅ or honest-gate ⚠️ — zero ❌.
