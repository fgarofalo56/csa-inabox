# powerbi-agentic-mcp — parity with Power BI Agentic (preview): agent skills + remote MCP

**Source UI / capability:** Power BI **Agentic (preview)** = the open-source Power BI **agent skills**
(`github.com/microsoft/skills-for-fabric`, plugin `powerbi-authoring`) + the **remote, web-hostable
Power BI Model Context Protocol (MCP) server** (`https://api.fabric.microsoft.com/v1/mcp/powerbi`).
This is NOT a portal page — it is an agent surface. The parity target is: (1) the five authoring
skills as best-practice guidance that grounds an authoring Copilot, and (2) the remote MCP's
schema-aware **query** of semantic models + Copilot-powered **DAX generation** tools (read-only,
run under the signed-in user's RBAC).

Grounded in (not memory):
- Power BI MCP server (preview): <https://learn.microsoft.com/power-bi/create-reports/copilot-power-bi-mcp> · <https://learn.microsoft.com/rest/api/power-bi/>
- Open-source agent skills: <https://github.com/microsoft/skills-for-fabric> (plugin `powerbi-authoring`)
- Microsoft Entra OAuth On-Behalf-Of: <https://learn.microsoft.com/entra/identity-platform/v2-oauth2-on-behalf-of-flow>
- Entra app registration: <https://learn.microsoft.com/entra/identity-platform/quickstart-register-app>
- Power BI admin tenant settings: <https://learn.microsoft.com/power-bi/admin/service-admin-portal-about-tenant-settings>

> **Design verdict (no-fabric-dependency + no-vaporware): B+ / honest opt-in.** Loom's OWN
> Azure-native semantic-model + report authoring is the **day-one DEFAULT** and is fully wired (the
> `dax_*` / `tabular_*` / `report_*` / `item_*` tools over Synapse SQL + Cosmos — see
> `dax-copilot.md`, `semantic-model-copilot-structure.md`, `powerbi-workspace.md`). The remote Power
> BI MCP (the SOLE Power BI / Fabric host this surface touches) and any Power BI REST are **strictly
> OPT-IN**, config-gated on `LOOM_POWERBI_MCP_CLIENT_ID` + the PBI-admin tenant setting, and never
> reached on a default code path. The five skills' *guidance* needs no Fabric/Power BI tenant — it
> grounds the Azure-native tools just as well, so it works with `LOOM_DEFAULT_FABRIC_WORKSPACE`
> unset. When the remote MCP is unconfigured the surface renders an **honest Fluent MessageBar gate**
> naming the exact env var + tenant setting + Entra app reg; when configured the MCP client makes a
> **real** Streamable-HTTP JSON-RPC call under the user's OBO bearer (no mock).

## Principle — reuse, do not fork

This integration adds **no parallel system**. It reuses Loom's existing **MCP catalog** + **Copilot
orchestrator** infra and adds only: a per-user OBO token path, ONE new "remote built-in" catalog
entry, a third `authMethod`, and the 5 skill descriptors. The remote PBI MCP server is just another
enabled `McpServerConfig` row that `buildMcpShim` already turns into `mcp_<server>_<tool>` tools — the
only delta is threading a per-USER token (not a tenant-static secret) into the MCP client.

## Loom surfaces (file map)

| Loom file | Role |
| --- | --- |
| `apps/fiab-console/lib/mcp/catalog.ts` → `RemoteBuiltinMcp` / `REMOTE_BUILTIN_MCP` / `isPbiMcpConfigured()` / `pbiMcpScopeUris()` / `POWERBI_MCP_DEFAULT_ENDPOINT` | The new **"remote built-in"** catalog family (a 3rd source distinct from `MCP_CATALOG` and `MCP_DEPLOY_CATALOG`). An already-hosted remote HTTPS endpoint with per-user Entra OBO auth — NOT a deployable image. |
| `apps/fiab-console/lib/types/mcp-config.ts` → `McpServerConfig.authMethod` `'entra-obo'` + `oboResource` / `oboScopes` + `source: 'remote-builtin'` | Runtime knows to mint a per-user OBO bearer instead of a static header / KV secret. No secret stored on the doc. |
| `apps/fiab-console/lib/azure/pbi-user-token-store.ts` → `savePbiUserToken` / `getPbiUserToken` | Per-user Power BI token cache (mirrors `sql-user-token-store.ts` EXACTLY): Cosmos `tenant-settings`, id `pbiusertoken:<oid>`, AES-256-GCM at rest, 60s expiry safety margin, best-effort write. |
| `apps/fiab-console/app/auth/callback/route.ts` → `captureUserPbiToken` | At login, `acquireTokenSilent` against the 3 delegated PBI scopes → `savePbiUserToken`. **Opt-in guarded** (`if (!LOOM_POWERBI_MCP_CLIENT_ID) return`) + swallow-all so login never breaks. |
| `apps/fiab-console/lib/azure/mcp-client.ts` → `resolveAuthHeader` / `listMcpTools` / `callMcpTool` (trailing optional `userToken`) | `authMethod === 'entra-obo'` short-circuits to `Bearer <userToken>`; the per-user token is threaded per request, never persisted. Backward compatible — existing 2-arg callers unchanged. |
| `apps/fiab-console/lib/azure/mcp-shim.ts` → `buildMcpShim(registry, tenantId)` | Resolves `getPbiUserToken(tenantId)` for every `entra-obo` server and passes it as the `userToken` arg to `listMcpTools` / `callMcpTool`. No cached token → silently skips the opt-in server (the gate is shown in the admin panel, never injected into chat). |
| `apps/fiab-console/lib/copilot/powerbi-skills.ts` → `POWERBI_AUTHORING_SKILLS` + `skillsForPane` / `skillSystemBlock` / `skillSystemBlocksForPane` | The 5 skill descriptors (`LoomCopilotSkill`) + pane selectors + the honest-gate-emitting system-block renderer. Pure data + selectors, no SDK/network/React. |
| `apps/fiab-console/lib/azure/copilot-personas.ts` → `POWERBI_AUTHORING_SKILLS` / `SEMANTIC_MODEL_SKILLS` / `REPORT_SKILLS` / `skillSystemBlock` | The persona module that **consumes** the descriptors — injects the guidance into the semantic-model + report pane personas' system prompt (the orchestrator's `getPanePersona` path, not a forked loop). |
| `apps/fiab-console/lib/azure/copilot-orchestrator.ts` → `powerbi_mcp_status` meta-tool | Read-only connection-state reporter: reads `isPbiMcpConfigured()` + `getPbiUserToken(userOid)` and answers "connect Power BI / why isn't it available" honestly on ANY cloud, without ever contacting a Fabric host. |
| `apps/fiab-console/app/api/admin/mcp-servers/powerbi/route.ts` | BFF: `GET` (configured → details + `tokenReady`; unconfigured → `configured:false` + honest `gate`; `?probe=1` → real initialize→tools/list under the OBO token), `POST` (register as an `McpServerConfig` row, `admin.deploy-mcp` gated, idempotent, never stores a secret). |

---

## A. Agent skills inventory → Loom coverage

The `powerbi-authoring` plugin ships **5** skills. Loom adapts each as a `LoomCopilotSkill` whose
`defaultTarget` is `'azure-native'` (guidance grounds the Loom-native tools day-one) with an optional
`pbiMcpToolPrefix` so the SAME skill additionally uses the remote MCP's query/DAX tools once connected.

Legend: ✅ built (guidance + real Azure-native tools, day-one) · ⚠️ opt-in augmentation (remote MCP tools, honest-gated) · ❌ MISSING

| # | Power BI agent skill (upstream) | Loom skill id | Day-one Azure-native coverage | Remote-MCP augmentation | Default Loom tools |
| --- | --- | --- | --- | --- | --- |
| S1 | **semantic-model-authoring** (star schema, DAX, PBIP/TMDL, Import/DirectQuery/Direct Lake, AI-readiness) | `semantic-model-authoring` | ✅ guidance grounds the tabular layer over the Synapse Dedicated SQL pool | ⚠️ `pbiMcpToolPrefix` set — adds schema-aware query + Copilot-DAX when connected | `dax_describe_model`, `dax_model_context`, `dax_nl2measure`, `dax_explain`, `dax_optimize`, `dax_save_descriptions`, `dax_eval_probe`, `tabular_list_models`, `tabular_list_tables`, `tabular_list_measures`, `tabular_eval_dax`, `item_create`, `item_configure` |
| S2 | **power-bi-report-authoring** (PBIR create/edit/validate) | `power-bi-report-authoring` | ✅ guidance grounds the Loom-native report renderer over the bound model | ⚠️ when connected | `report_query_model`, `report_suggest_visual`, `item_create`, `item_configure` |
| S3 | **power-bi-report-design** (design brief) | `power-bi-report-design` | ✅ pure-guidance (audience → layout → theme → visual plan) | — (no `pbiMcpToolPrefix`) | `report_suggest_visual` (+ `report_query_model` in the powerbi-skills variant) |
| S4 | **power-bi-report-planner** (guided plan a report from a semantic model) | `power-bi-report-planner` | ✅ inspects the REAL Loom model first (`tabular_list_*`) then plans pages/visuals | ⚠️ when connected | `tabular_list_models`, `tabular_list_tables`, `tabular_list_measures`, `report_query_model`, `report_suggest_visual`, `item_create` |
| S5 | **power-bi-report-management** (get/publish/manage reports in Fabric) | `power-bi-report-management` | ✅ list/organize Loom report items (`item_list`/`item_configure`/`workspace_list`) | ⚠️ **publish to a real Power BI/Fabric workspace is the opt-in step** — gated, never faked | `item_list`, `item_configure`, `workspace_list` |

How the guidance is injected (no forked loop): the active pane/persona selects the relevant skills
(`SEMANTIC_MODEL_SKILLS` for the semantic-model / DAX pane; `REPORT_SKILLS` for the report Copilot;
`skillsForPane(slug)` for a generic pane), `skillSystemBlock(...)` renders them as an extra
**system-message block** appended to the persona's system prompt via the orchestrator's
`getPanePersona` path. The guidance attributes the upstream open-source skills
(`github.com/microsoft/skills-for-fabric`, plugin `powerbi-authoring`).

> **Descriptor home note (honest):** the canonical descriptor module is
> `lib/copilot/powerbi-skills.ts` (named by the shared contract; it also exports the pane selectors
> and the `pbiMcpConnected` honest-gate emitter). A second, intentionally co-located copy lives in
> `lib/azure/copilot-personas.ts` — that is the one the orchestrator actually injects today (the
> change there was scoped to a single file). The two are kept in lock-step (same 5 ids, same default
> tool names, same `mcp_powerbiremote_` prefix constant). Consolidating to a single import is a
> follow-up; it does not affect behavior because both render identical guidance.

## B. Remote MCP server inventory → Loom coverage

The remote, web-hostable Power BI MCP server is the one Loom can connect to server-side (the local
one cannot — see §E). Its tools are schema-aware **query** of semantic models + Copilot-powered
**DAX generation**, read-only, executed under the signed-in user's Power BI RBAC.

| # | Remote MCP capability | Loom status | Where / backend |
| --- | --- | --- | --- |
| M1 | Endpoint `https://api.fabric.microsoft.com/v1/mcp/powerbi`, transport Streamable HTTP | ⚠️ honest-gate (opt-in) | `REMOTE_BUILTIN_MCP.endpoint` (override `LOOM_POWERBI_MCP_ENDPOINT`, default `POWERBI_MCP_DEFAULT_ENDPOINT`). The MCP client speaks the real Streamable-HTTP handshake (`initialize` → `tools/list` → `tools/call`, `Mcp-Session-Id` echo, JSON or SSE body). |
| M2 | Auth = Microsoft Entra OAuth **On-Behalf-Of** the signed-in user (delegated) | ✅ built | `authMethod: 'entra-obo'` → `resolveAuthHeader` returns `Bearer <userToken>`; token minted at login + cached per-user (`pbi-user-token-store`), refreshed on demand. The token NEVER lands on `McpServerConfig`. |
| M3 | Delegated scopes `Dataset.Read.All`, `MLModel.Execute.All`, `Workspace.Read.All` on resource `https://analysis.windows.net/powerbi/api` | ✅ built | `REMOTE_BUILTIN_MCP.resource` + `delegatedScopes`; `pbiMcpScopeUris()` = `${resource}/<scope>`. Login mints them via `acquireTokenSilent` (sovereign-aware host from `getPbiScope()`). |
| M4 | Schema-aware **query** of semantic models | ⚠️ opt-in | Auto-registered by `buildMcpShim` from the live `tools/list` (real names from the server). Surfaced to the model only when the server is connected + the user has a cached token. |
| M5 | Copilot-powered **DAX generation** (read-only) | ⚠️ opt-in | Same — advertised to the relevant skills via `pbiMcpToolPrefix`; runs under the user's RBAC. |
| M6 | Requires an Entra app (client id) + the PBI-admin tenant setting | ⚠️ honest-gate | `isPbiMcpConfigured()` (client-id presence) gates registration/calls; the tenant setting is a runtime grant surfaced as gate copy (the first real call 403s if still off). |
| M7 | Real connectivity probe (no fabricated "connected") | ✅ built | `GET …/powerbi?probe=1` + `POST` run the actual `initialize`→`tools/list` under the OBO bearer, persist `lastTestResult`, and return live `toolCount` / `error`. |

---

## Setup — Entra app registration, tenant setting, env vars

The remote MCP is OPT-IN. To enable it (per the honest gate copy in
`app/api/admin/mcp-servers/powerbi/route.ts → pbiGate()`):

1. **Entra app registration** (<https://learn.microsoft.com/entra/identity-platform/quickstart-register-app>):
   register an app whose API permissions request the **three delegated** Power BI scopes —
   `Dataset.Read.All`, `MLModel.Execute.All`, `Workspace.Read.All` on resource
   `https://analysis.windows.net/powerbi/api` (a.k.a. the Power BI Service API) — and **grant admin
   consent**. The signed-in user's token is acquired On-Behalf-Of against these.
2. **Power BI tenant setting** (PBI admin, in the Power BI admin portal →
   <https://learn.microsoft.com/power-bi/admin/service-admin-portal-about-tenant-settings>): enable
   **"Users can use the Power BI Model Context Protocol server endpoint (preview)"**. This is a
   runtime grant Loom cannot probe; if it is off the first Streamable-HTTP call returns 403, surfaced
   honestly on the server row.
3. **Console env vars:**
   - `LOOM_POWERBI_MCP_CLIENT_ID` — the Entra app (client) id. **Presence = opted-in** (drives
     `isPbiMcpConfigured()`). Client ids are public (non-secret) so they are echoed back in the GET
     for confirmation; there is **no client secret** on this path (delegated OBO carries a per-user
     token, not an app secret).
   - `LOOM_POWERBI_MCP_ENDPOINT` (optional) — overrides the endpoint; defaults to
     `https://api.fabric.microsoft.com/v1/mcp/powerbi`.
4. **Register** via `POST /api/admin/mcp-servers/powerbi` (tenant-admin `admin.deploy-mcp`). This
   writes an `McpServerConfig` row (`authMethod 'entra-obo'`, `source 'remote-builtin'`,
   `oboResource` + `oboScopes` from the catalog descriptor) so it flows through `buildMcpShim`
   untouched. Idempotent.
5. **Per-user consent:** each user signs in once with the PBI scopes consented; the callback caches
   their delegated token. Until then `tokenReady:false` and the panel shows an honest "sign in again /
   consent Power BI scopes" note — never a fake OK.

Secrets: the `entra-obo` path has **no static secret to store** (the per-user token is minted at
login + cached encrypted-at-rest, resolved at call time). This keeps the secrets-via-Key-Vault /
no-literal-credential invariant intact — there is simply no secret here to put in Key Vault.

## OBO token-exchange recipe (the concrete bit)

At chat time the orchestrator has the user's `oid` (`toolCtx.userOid`) but NOT a raw user assertion
(the session cookie holds claims only). So the PBI token is minted the SAME way the SQL/ARM tokens
are (mirroring `sql-user-token-store` / `user-token-store`):

- **At login** (`auth/callback` → `captureUserPbiToken`): `acquireTokenSilent({ account, scopes: [
  `${resource}/Dataset.Read.All`, `${resource}/MLModel.Execute.All`, `${resource}/Workspace.Read.All` ]})`
  → `savePbiUserToken(oid, token, exp)`. Runs ONLY when `LOOM_POWERBI_MCP_CLIENT_ID` is set; swallows
  all errors so login is unaffected.
- **At call time** (`buildMcpShim`): `getPbiUserToken(oid)`; if `null`/expired → skip the opt-in
  server (chat unaffected) and surface the honest "sign in again / consent Power BI scopes" gate in
  the admin panel.
- `acquireTokenOnBehalfOf` (in `msal.ts`) is the fallback when a raw assertion IS available (e.g. the
  internal-token MAF callback path); the default Console path uses the cached-silent-token store —
  identical to SQL.

---

## C. Backend per control (summary)

Every built/opt-in row above calls a **real** backend, no mock arrays:

- **Azure-native skills (day-one):** the advertised `dax_*` / `tabular_*` / `report_*` / `item_*`
  tools already exist in the `LoomToolRegistry` and execute against the Synapse Dedicated SQL pool +
  Cosmos (see `dax-copilot.md`, `semantic-model-copilot-structure.md`). The skills only inject
  guidance + advertise these existing tools — **no new tool is minted**.
- **Remote PBI MCP (opt-in):** the MCP client makes a genuine Streamable-HTTP JSON-RPC call to the
  PBI endpoint with `Authorization: Bearer <user OBO token>` + the three real delegated scopes. The
  `?probe=1` GET and the register POST run the actual `initialize` → `tools/list` handshake and
  persist a real `toolCount` / `error`. When unconfigured, the response is the honest `gate`; when
  configured but un-consented, `tokenReady:false` + `tokenNote` — never a fabricated success.

## D. no-fabric-dependency posture (verification)

- The remote PBI MCP is the **SOLE** `api.fabric.microsoft.com` host in this feature and it is
  reached **only** when `isPbiMcpConfigured()` is true AND the user has a cached delegated token. With
  `LOOM_POWERBI_MCP_CLIENT_ID` unset: `captureUserPbiToken` is a no-op, `buildMcpShim` registers
  nothing for it, the orchestrator's `powerbi_mcp_status` reports `ready:false` with the remediation,
  and the GET returns `configured:false` + the gate. Zero default-path Fabric/Power BI calls.
- The **default day-one path is Loom's Azure-native authoring** (`powerbi-workspace.md`,
  `semantic-model-copilot-structure.md`) — it works with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset.
- Acceptance greps (expect ZERO default-path hits):
  ```bash
  # The PBI MCP host must only appear behind the opt-in gate / catalog descriptor:
  grep -rn "api.fabric.microsoft.com/v1/mcp/powerbi" apps/fiab-console/lib apps/fiab-console/app
  # Every reach is wrapped by isPbiMcpConfigured() / authMethod==='entra-obo' / the catalog entry.
  ```

## Per-cloud notes

The login mint uses `getPbiScope()` for the **sovereign-correct** Power BI audience host
(Commercial `analysis.windows.net`; GCC `analysis.usgovcloudapi.net`; GCC-High
`high.analysis.usgovcloudapi.net`; DoD `mil.analysis.usgovcloudapi.net`), so the OBO token is minted
against the right host per cloud. Note `REMOTE_BUILTIN_MCP.resource` / `pbiMcpScopeUris()` carry the
**Commercial** literal (used for admin-panel display); the actual token acquisition at login is
sovereign-aware. The remote Power BI MCP server endpoint itself (`api.fabric.microsoft.com`) is a
**Commercial-only / preview** Fabric host — the feature is opt-in everywhere and simply stays gated
where the endpoint is unavailable; the Azure-native authoring path remains the default in every cloud.

---

## E. Local MCP server + Desktop Bridge — "connect your local agent" (documented only)

Microsoft also ships a **local** Power BI MCP server + a **Power BI Desktop bridge** that run as a
process on the **user's machine** (Power BI Desktop, or a local Node process). These connect a local
agent to a `.pbix` open in Power BI Desktop / a local tabular model.

**Loom does NOT host these server-side, and must not try to.** They run on the user's workstation
(stdio / localhost transport, no public HTTPS endpoint, and they read a locally-open model under the
user's desktop session) — there is nothing for a Container App to reach. This is the same reason the
`MCP_CATALOG` stdio entries must be hosted before Loom can connect (see `mcp-catalog.ts` header):
a local-only server has no endpoint Loom's server-side MCP client can POST to.

This section is therefore a **connect-your-own-local-agent guide**, not a Loom-hosted feature:

1. Install the local Power BI MCP server per Microsoft's instructions (Power BI Desktop's
   MCP/bridge feature, or the `powerbi-authoring` local server) on your workstation.
2. Point a **local agent** at it — Claude Desktop, VS Code (GitHub Copilot/agent mode), or
   **Claude Code** (Microsoft ships Claude Code compatibility for the `powerbi-authoring` skills).
   Add the local server to that agent's MCP config (stdio command / localhost URL).
3. Open your model in Power BI Desktop; the local agent now has the local MCP tools + the 5
   open-source authoring skills — entirely on your machine, under your identity.
4. To author against Loom's Azure-native model instead (no local Desktop, no Fabric), use the
   in-Console Copilot panes — they already carry the same skill guidance and the real
   `dax_*` / `tabular_*` / `report_*` tools.

Loom's contribution to this local path is **guidance only**: the same `powerbi-authoring`
best-practice text is what grounds the in-Console Copilot, so users get a consistent authoring
experience whether they drive the local agent or the Loom-native one.

---

## Known wrinkles / follow-ups (honest)

1. **Registered tool-name prefix vs. advertised constant — load-bearing on scoped personas.**
   `buildMcpShim` derives the tool prefix from the **server name**
   (`mcp_${srv.name.replace(/[^a-z0-9_]/gi,'_')}_…`). With
   `REMOTE_BUILTIN_MCP.name = "Power BI (remote)"` the live tools register as
   `mcp_Power_BI__remote__<tool>`, whereas the skill descriptors advertise the constant
   `mcp_powerbiremote_` (in both `powerbi-skills.ts` and `copilot-personas.ts`). On the **default
   all-tools pane** this is merely advisory — that pane has an empty `toolCatalog`, so
   `toAoaiToolsByName(undefined)` advertises *every* registered tool and the model sees the actual
   `mcp_Power_BI__remote__*` names regardless of the hint. But on **any `toolPrefixes`-scoped persona
   — which is the intended editor-pane wiring** (the DAX Copilot's
   `toolPrefixes: ['dax_','loom_', ...pbiMcpToolPrefixes()]` in `copilot-personas-dax.ts`, plus the
   exact-name pane catalogs that `mergePbiRemoteToolsIntoCatalog` folds the same prefix into) the gap
   is **load-bearing, not cosmetic**: `filterByPrefixes` matches by `t.name.startsWith(p)`, and the
   only Power BI prefix any persona carries is `mcp_powerbiremote_`, which **never** matches a
   registered `mcp_Power_BI__remote__*` name. So even with the remote server connected and a consented
   user, the remote query/DAX tools are filtered OUT and **never surfaced to the model** on those
   scoped panes — the opt-in augmentation silently no-ops exactly where the editor-pane personas are
   supposed to use it. Reconcile by deriving `buildMcpShim`'s prefix from a stable server **id**
   (`powerbi-remote` → `powerbiremote`) rather than the display name, or by updating the advertised
   constant — and because that constant is duplicated across both descriptor copies, do it **together
   with the descriptor de-dup in (2)** so the registered prefix and the advertised one are single-
   sourced and can never drift again. Not done here (this change is the parity doc only).
2. **Descriptor duplication** — see the descriptor-home note in §A: consolidate
   `copilot-personas.ts`'s copy to import from `lib/copilot/powerbi-skills.ts`.
3. **Tenant-setting probe** — the PBI-admin tenant setting cannot be read programmatically; it is
   surfaced as gate copy and confirmed only by the first real call's 403/200. This is the honest
   no-vaporware behavior, not a gap to "fix."

## Parity verdict

- **Grade: B+ (honest opt-in).** The default Azure-native authoring surface is fully wired day-one;
  the 5 agent skills ground it with real best-practice guidance + real tools; the remote PBI MCP is
  genuinely connectable (real OBO + real Streamable-HTTP, real probe) when opted into, and honestly
  gated otherwise. No mock data, no default-path Fabric call, no stored secret.
- **A-grade blockers:** wrinkles (1)+(2) above (the load-bearing scoped-persona prefix gap — which
  today keeps the opt-in remote tools from surfacing on the editor-pane personas — fixed alongside the
  descriptor de-dup it shares a constant with), and a
  side-by-side live walk of the remote MCP query/DAX tools under a consented user (per `no-scaffold`)
  once an Entra app + the tenant setting are provisioned in a test tenant.
