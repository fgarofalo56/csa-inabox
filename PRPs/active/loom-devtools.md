# PRP — CSA Loom developer toolkit (`loom-devtools`)

> **Title:** The Loom developer toolkit — agent Skills, MCP servers, purpose-built agents, CLI/SDK,
> and templates. One authored source per artifact, two emitters, five MCP servers split by blast
> radius, and a machine-checked API contract behind all of it.
> **Date:** 2026-08-03
> **Status:** proposed
> **Owner:** Loom Platform / Developer Experience
> **Base commit:** `0be26002` (branch `main`)
> **Sources consulted — every claim below was read out of the tree at this commit, not recalled:**
> `packages/loom-skills/**` (11 `SKILL.md`, 4 plugin bundles, `.claude-plugin/marketplace.json`,
> `.mcp.json`); `apps/fiab-console/lib/copilot/skill-registry-core.ts` (the `SkillDescriptor`
> interface), `lib/azure/skill-store.ts` (Cosmos-backed custom skills + `listSkills` union),
> `lib/copilot/ms-skills.ts`, `lib/copilot/powerbi-skills.ts`;
> `app/api/iq/mcp/route.ts` + `lib/azure/iq-mcp-tools.ts` (9 tools);
> `lib/mcp/catalog.ts` (browse `MCP_CATALOG` = 33, `MCP_DEPLOY_CATALOG` = 4, `REMOTE_BUILTIN_MCP_CATALOG` = 12),
> `lib/azure/mcp-catalog.ts` (a *separate* 29-entry `MCP_CATALOG` consumed by `lib/copilot/agent-registry.ts`);
> `apps/fiab-mcp-bridge/**` + `config/loom-mcp-bridge.json`; `apps/fiab-mcp-config/config/loom-mcp.json`;
> `azure-functions/mcp-server/**`; `app/api/items/{data-agent,agent-flow,loom-app-runtime}/[id]/{mcp,publish-mcp}`;
> `apps/loom-cli/**` (7 command groups in `src/index.ts:135-159`) + `apps/loom-cli/README.md`;
> `apps/loom-sdk/src/resources/` (5 resources); `sdk/python/csa-loom/**` (incl. `src/csa_loom/testing.py`);
> `sdk/terraform-provider-loom/**` (2 resources + 1 data source); `sdk/openapi.json` (14 paths);
> `apps/fiab-console/lib/auth/pat.ts` (3 scopes); `lib/azure/mcp-egress-guard.ts` → `lib/azure/egress-ssrf.ts`;
> `lib/azure/copilot-orchestrator.ts:493` (`buildDefaultRegistry`); `docs/fiab/local-golden-path.md:15`;
> `.github/workflows/publish-loom-cli.yml`, `publish-loom-sdk.yml`, `sdk-contract.yml`;
> `docs/fiab/parity/{loom-cli,mcp-catalog,admin-mcp-servers,iq-mcp-surface,mcp-stdio-bridge,ms-mcp-servers,powerbi-agentic-mcp,ontology-sdk}.md`.
> **Microsoft reference bar (Learn-cited, fetched 2026-08-03):**
> [What are Fabric MCP Servers?](https://learn.microsoft.com/rest/api/fabric/articles/mcp-servers/what-is-fabric-mcp-server) ·
> [Fabric Core MCP Server overview](https://learn.microsoft.com/rest/api/fabric/articles/mcp-servers/core-remote/overview-core-mcp-server) ·
> [Core MCP tools reference](https://learn.microsoft.com/rest/api/fabric/articles/mcp-servers/core-remote/tools-core-mcp-server) ·
> [Fabric CLI (`fab`)](https://learn.microsoft.com/rest/api/fabric/articles/fabric-command-line-interface) ·
> [Fabric CI/CD overview](https://learn.microsoft.com/fabric/cicd/cicd-overview) ·
> [Remote MCP for eventhouses](https://learn.microsoft.com/fabric/real-time-intelligence/mcp-remote-eventhouse) ·
> [Remote MCP for Activator](https://learn.microsoft.com/fabric/real-time-intelligence/mcp-remote-activator) ·
> [Fabric IQ Ontology MCP](https://learn.microsoft.com/microsoft-copilot-studio/mcp-fabric-iq-ontology-work-iq)
> **Governing rules (die-hard, non-negotiable):** `.claude/rules/no-fabric-dependency.md` — every
> artifact in this toolkit works with **`LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET** and never calls
> `api.fabric.microsoft.com` / `api.powerbi.com` / `onelake.dfs.fabric.microsoft.com` on a default
> path; `.claude/rules/no-vaporware.md` — every phase ships functional end-to-end with a real-data
> receipt; `.claude/rules/ui-parity.md`, `.claude/rules/ux-baseline.md` (G1/G2/G3) for the surfaces
> this program adds to the Console; `loom_no_freeform_config`, `loom_design_standards`.
> Dual-cloud (Commercial + Government) mandatory; per-cloud deltas stated in §6, not assumed.

---

## 1. Executive summary — what is actually wrong

Loom's developer surface is **not thin**. It has a real CLI (7 command groups, device-code auth), a
TypeScript SDK, a typed Python SDK that ships a `StubTransport` as a product artifact, a Terraform
provider, three MCP catalog families, a working stdio→HTTP bridge deployed as a Container App, an
in-product Copilot skill system with per-user toggles and token metering, and an 11-skill agent-skills
bundle. Most vendors ship less.

The problem is **four structural defects**, each verified in the tree:

1. **The two skill systems cannot see each other.** `packages/loom-skills/` (11 `SKILL.md`) and
   `lib/azure/skill-store.ts` (`SkillDescriptor`, Cosmos-backed, Studio-toggleable) are entirely
   disjoint code. A grep for `loom-skills` across `apps/ scripts/ .github/ platform/ sdk/` returns
   **exactly one hit** — `scripts/csa-loom/gov-verify-evidence.sh:49`, and that consumes a *shell
   script* from the bundle (`scripts/loom-endpoint-probe.sh`), not a single skill. **Zero of the 11
   skills reach a customer.** A skill authored in-repo is invisible to the product; a skill authored
   in the product is invisible to a coding agent.

2. **The bundle's own MCP wiring is inert.** `packages/loom-skills/.mcp.json` declares two servers
   keyed on `${LOOM_MCP_BRIDGE_URL}` / `${LOOM_MCP_BRIDGE_TOKEN}` / `${LOOM_IQ_MCP_URL}` /
   `${LOOM_IQ_TOKEN}`. Of those four, `LOOM_MCP_BRIDGE_URL` is bicep-wired; the other **three appear
   nowhere in the repo outside `packages/loom-skills/README.md`** (grep across `*.bicep *.ts *.md *.yml`).
   Point a coding agent at the bundle today and both servers fail to start.

3. **The API contract covers 1% of the API.** `sdk/openapi.json` has **14 paths**, five of which are
   SCIM — so **9 product paths**. The Console has **1,666 `route.ts` files across 120 top-level API
   groups**. Every SDK, every MCP tool, every Terraform resource, and every agent that wants to reach
   Loom programmatically is either hand-written against an undocumented surface or does not exist.
   This is the load-bearing gap: it is upstream of the SDK gap, the MCP gap, and the Terraform gap.

4. **Nothing is published.** `git tag -l` contains no `loom-cli-v*` and no `loom-sdk-v*` tag; both
   `publish-loom-cli.yml` and `publish-loom-sdk.yml` publish **only** on such a tag push. The
   `npm install -g @csa-loom/cli` line in `apps/loom-cli/README.md` does not work today. The Python
   SDK is not on PyPI. The Terraform provider is not in the registry.

Against Microsoft's bar this is the whole story. Fabric Core MCP exposes ~29 typed tools over a
documented REST surface with per-user OAuth 2.0 and audit logging
([tools reference](https://learn.microsoft.com/rest/api/fabric/articles/mcp-servers/core-remote/tools-core-mcp-server));
`fab` is `pip install ms-fabric-cli` away with four auth modes; `fabric-cicd` and the Fabric Terraform
provider are published artifacts ([CI/CD overview](https://learn.microsoft.com/fabric/cicd/cicd-overview)).
Loom's *capability* is comparable. Its **reachability** is not.

This PRP does not propose a new developer platform. It proposes: **one authored source per artifact
with two emitters, five MCP servers split by blast radius, the OpenAPI contract raised from 9 product
paths to the real surface, and a publish pipeline that actually fires.**

---

## 2. Current state — grounded inventory

### 2.1 EXISTS and is real

| Piece | Path | Evidence |
|---|---|---|
| Agent-skills bundle | `packages/loom-skills/` | 11 `SKILL.md`; 4 plugin bundles (`loom-skills`, `loom-authoring`, `loom-consumption`, `loom-operations`); `marketplace.json`; `.cursorrules`; `.windsurfrules`; `AGENTS.md` |
| In-product Copilot skills | `lib/copilot/skill-registry-core.ts:44` (`SkillDescriptor`), `lib/azure/skill-store.ts:140-141,261,300` | Unions `MS_AGENT_SKILLS` + `POWERBI_AUTHORING_SKILLS` + Cosmos custom skills; per-user override via `resolveActiveSkills`; token meter via `estimateSkillTokens` |
| Read-only MCP in-product | `app/api/iq/mcp/route.ts` (207 LOC) + `lib/azure/iq-mcp-tools.ts` (203 LOC) | 9 tools: `catalog_search`, `iq_overview`, `iq_search`, `iq_list_ontologies`, `iq_get_ontology`, `iq_list_semantic_models`, `iq_get_semantic_model`, `iq_list_signal_tables`, `iq_query_signals` |
| stdio→HTTP MCP bridge | `apps/fiab-mcp-bridge/` + `config/loom-mcp-bridge.json` | 4 entries; per-entry `envAllowlist`; launcher restricted to `npx`/`uvx`; `AZURE_CLOUD` boundary filter; deployed as Container App, `LOOM_MCP_BRIDGE_URL` bicep-wired |
| Self-hosted Azure MCP config | `apps/fiab-mcp-config/config/loom-mcp.json` | allow/deny tool catalog, PIM-for-Groups JIT elevation, App Insights audit, rate limits — **the strongest prior art in the repo for §5** |
| Deployable MCP catalog | `lib/mcp/catalog.ts` | Browse `MCP_CATALOG` = 33 entries with `govSafe`/`airGapSafe`/`license`/`externalHosts`/`fabricFamily`; `MCP_DEPLOY_CATALOG` = **4** (`github`, `grafana`, `fetch`, `time`); `REMOTE_BUILTIN_MCP_CATALOG` = 12; `serversForCloud()` filters `commercial\|gcc\|gcc-high\|il5`; `requiresHosting()` honestly gates every stdio entry |
| Per-item MCP publish | `app/api/items/{data-agent,agent-flow,loom-app-runtime}/[id]/{mcp,publish-mcp}` | Items already publish themselves as MCP servers — the same shape as Fabric's [per-eventhouse](https://learn.microsoft.com/fabric/real-time-intelligence/mcp-remote-eventhouse) / [per-Activator](https://learn.microsoft.com/fabric/real-time-intelligence/mcp-remote-activator) remote MCP endpoints |
| Built-in Functions MCP server | `azure-functions/mcp-server/` | `function_app.py`, `mcp_tools.py` (`search_catalog`, `list_resources`, `list_deployments`), `mcp_tools_data_movement.py`, tests, `DEPLOYMENT.md` |
| CLI | `apps/loom-cli/` | 7 groups wired at `src/index.ts:135-159`: `auth`, `workspace\|ws`, `item`, `apps`, `policy`, `report`, `find`. Device-code (RFC 8628) via `POST /api/auth/cli-session`, or `--service-principal`. Creds at `~/.loom/credentials.json` mode 0600, keyed by API URL. Zero runtime deps. Token acquisition is **server-side**, so one binary serves every sovereign cloud — only `--api-url` differs |
| TS SDK | `apps/loom-sdk/src/resources/` | 5 resources: `workspaces`, `items`, `catalog`, `thread`, `tokens` |
| Python SDK | `sdk/python/csa-loom/` | Typed, generated client (`scripts/generate_client.py` → `_generated/`), contract test, and **`src/csa_loom/testing.py` ships `StubTransport` as a product artifact** |
| Terraform provider | `sdk/terraform-provider-loom/` | `workspace_resource`, `item_resource`, `workspace_data_source` + a `contract_test.go` |
| PAT auth | `lib/auth/pat.ts:64,208-210,310,322` | 3 typed scopes `read-only\|read-write\|admin`; read-only enforced at the HTTP verb; `patCannotMint`; admin re-checked against live tenant-admin status at *resolve* time so a demoted creator's admin token loses admin power |
| Egress guard | `lib/azure/mcp-egress-guard.ts` → `lib/azure/egress-ssrf.ts` | Real SSRF guard: https-only, private-IP rejection, allow-suffix list `LOOM_MCP_EGRESS_ALLOW`, built-in-host exemption. Shared byte-for-byte with the A2A outbound client |
| Parity docs | `docs/fiab/parity/` | 8 relevant docs already exist (`loom-cli`, `mcp-catalog`, `admin-mcp-servers`, `iq-mcp-surface`, `mcp-stdio-bridge`, `ms-mcp-servers`, `powerbi-agentic-mcp`, `ontology-sdk`) |

### 2.2 PARTIAL — real, but does not do what its name implies

| Piece | What is partial | Evidence |
|---|---|---|
| **The 11 skills** | All are **Tier-0 grounding cards** ("for a lakehouse call `adls-client.ts` + `synapse-sql-client.ts` via `/api/lakehouse`, not OneLake"). `loom-cloud-endpoints` as the MUST-READ root is the right foundation. **Not one procedural skill exists** — nothing tells an agent how to ship an item type or triage a failed run | `packages/loom-skills/skills/*/SKILL.md` |
| **`marketplace.json` bundle lists** | Hand-maintained. Four bundles each restate a skill list by path; nothing verifies they match the folder or each other | `.claude-plugin/marketplace.json` |
| **OpenAPI contract** | 14 paths (9 product + 5 SCIM) against 1,666 `route.ts` / 120 groups. `sdk-contract.yml` gates the SDKs against it — so the gate is real, but it is gating 1% of the API | `sdk/openapi.json`; `find app/api -name route.ts \| wc -l` = 1666 |
| **CLI README** | Documents only `auth` / `workspace` / `item`. `apps`, `find`, `policy`, `report` are live in `index.ts` and **absent from the README** — including `apps ci-template`, which emits a GitHub Actions workflow | `apps/loom-cli/README.md:59-105` vs `src/index.ts:145-158` |
| **CLI parity claim** | `docs/fiab/parity/loom-cli.md` claims zero ❌ vs `fab` for the workspace+item surface with two ⚠️ (SP-certificate, managed-identity login). Those two are genuinely absent; `fab` offers both ([Fabric CLI docs](https://learn.microsoft.com/rest/api/fabric/articles/fabric-command-line-interface)). There is also no `loom config`, no shell completions, and no workspace-scope `import`/`export` verb | — |
| **Terraform provider** | 2 resources + 1 data source. Loom has ~60 item types. Not registry-published | `sdk/terraform-provider-loom/internal/provider/` |
| **`/api/iq/mcp` auth** | Cookie session **or** a **shared service token** (`LOOM_IQ_MCP_TOKEN`, else `LOOM_INTERNAL_TOKEN`) plus a **caller-asserted `x-user-oid`** that becomes the tenant partition. Constant-time compare, oid format-validated, optional `LOOM_INTERNAL_ALLOWED_OIDS` allowlist, bearer path off unless `LOOM_IQ_MCP_ENABLED=true` — but any holder of the token can act as any allowed oid. This is **not** the per-user OAuth + RBAC model Fabric Core MCP uses | `app/api/iq/mcp/route.ts:60-88` |
| **MCP catalog metadata** | Two independent gov-metadata arrays: `lib/mcp/catalog.ts` browse `MCP_CATALOG` (33, the authoritative one per its own comment) and `lib/azure/mcp-catalog.ts` `MCP_CATALOG` (29, consumed by `lib/copilot/agent-registry.ts` for the agent-mesh egress policy). Both carry `govSafe`/`airGapSafe`/`license`/`externalHosts`. Nothing enforces they agree | `lib/mcp/catalog.ts:1524-1534`; `lib/azure/mcp-catalog.ts:120` |
| **`--dry-run`** | Exists only as `loom policy diff` / `loom policy apply --yes`. No global `--dry-run` on any mutating verb | `src/commands/policy.ts` |

### 2.3 ABSENT — state it plainly

| Piece | Status |
|---|---|
| Any bridge between `packages/loom-skills` and `skill-store.ts` | **Does not exist** (one shell-script hit, zero skill hits) |
| Any procedural / workflow skill | **Does not exist** — all 11 are grounding cards |
| Any guardrail skill (no-Fabric check, honest-gate, parity-doc) | **Does not exist** — the die-hard rules are enforced by reviewer memory |
| Purpose-built subagents | **Do not exist.** No `.claude/agents/` anywhere in the tree. The `agents` directories found are all API routes (`app/api/agents`, `app/api/foundry/agents`, `app/api/mesh/agents`) — the in-product agent mesh, not developer subagents |
| A write-capable MCP server (author / deploy / query) | **Does not exist.** `/api/iq/mcp` is read-only metadata; the per-item MCP routes expose a single item, not the platform |
| `LOOM_IQ_MCP_URL`, `LOOM_IQ_TOKEN`, `LOOM_MCP_BRIDGE_TOKEN` | **Not emitted anywhere.** Present only in `packages/loom-skills/README.md` |
| Published `@csa-loom/cli`, `@csa-loom/sdk`, PyPI `csa-loom`, registry `terraform-provider-loom` | **Not published.** No `loom-cli-v*` / `loom-sdk-v*` tag exists |
| Local emulator | **Does not exist — and the docs say so.** `docs/fiab/local-golden-path.md:15`: "there is **no local emulator**". The local profile is real session crypto + honest gates. This is the honest answer and this PRP does **not** propose changing it |
| Item / project scaffolding templates for developers | **Do not exist** as a developer artifact. `deploy-templates/`, `app-templates`, `data-product-template`, `copilot-template-library` are all *product* templates for end users, not a `loom init` for a developer adding an item type |

---

## 3. The reference bar (Learn-grounded)

| Microsoft artifact | What it does | Loom's honest position |
|---|---|---|
| [Fabric Core MCP Server](https://learn.microsoft.com/rest/api/fabric/articles/mcp-servers/core-remote/overview-core-mcp-server) (remote, preview) — `https://api.fabric.microsoft.com/v1/mcp/core` | ~29 typed tools (`search_catalog`, workspace CRUD, workspace-role grant/revoke, item CRUD + `get/update_item_definition`, folders, `list_capacities`, `get_operation_state/result`, `get_knowledge`); **OAuth 2.0 via Entra**; **RBAC enforced**; **audit logged**; explicitly "no privilege escalation" | Loom has 9 read-only tools with a shared-token auth mode. §4.2 closes the tool gap; §5 closes the auth gap |
| [Fabric MCP Server (local)](https://learn.microsoft.com/rest/api/fabric/articles/mcp-servers/what-is-fabric-mcp-server) | `docs_*` (offline API specs, schemas, best practices), `onelake_*` file+table ops, `core_create-item`; open source; **offline-capable** | Loom's equivalent of `docs_*` is exactly what §4.1 Tier-0 skills already are — but they are unreachable. The offline-capable framing is the argument for skills-as-context over a network tool |
| [Fabric CLI `fab`](https://learn.microsoft.com/rest/api/fabric/articles/fabric-command-line-interface) | `pip install ms-fabric-cli`; filesystem metaphor (`fab ls`, `fab create ws.Workspace/db.SQLDatabase`); `fab api` escape hatch; **four auth modes** incl. certificate + managed identity | `loom` matches the surface for workspace+item, is missing cert + MI auth, and **is not installable** |
| [fabric-cicd + Terraform provider](https://learn.microsoft.com/fabric/cicd/cicd-overview) | Published Python deploy library; registry-published Terraform provider for workspaces/capacities | Loom has `loom apps ci-template` (undocumented) and a 2-resource unpublished provider |
| Per-item remote MCP ([eventhouse](https://learn.microsoft.com/fabric/real-time-intelligence/mcp-remote-eventhouse), [Activator](https://learn.microsoft.com/fabric/real-time-intelligence/mcp-remote-activator), [IQ ontology](https://learn.microsoft.com/microsoft-copilot-studio/mcp-fabric-iq-ontology-work-iq)) | A single item exposes itself at a per-item MCP URL | **Loom already does this** for `data-agent` / `agent-flow` / `loom-app-runtime`. This is the one place Loom is at or ahead of the bar |

**No part of this toolkit may require a Fabric tenant.** Every row above is a *design reference*, not a
dependency. The Fabric/Power BI MCP entries stay `govSafe:false, fabricFamily:true, defaultRecommended:false`
exactly as `lib/mcp/catalog.ts` already has them.

---

## 4. The toolkit inventory

Costs are **dev-days for one engineer**, and include the vitest + CI gate + parity-doc + receipt that
`no-vaporware.md` requires. They do **not** include the roll or the live dual-cloud verification, which
is budgeted per-phase in §7.

### 4.1 Agent Skills — 6 workflow + 3 guardrail, and one source with two emitters

#### Tier 1 — workflow skills (all absent today)

Each ships with a **verification step**. A procedure with no "how do I know it worked" is the exact
vaporware failure mode this repo has been burned by.

| Skill | Why it earns its place | Cost |
|---|---|---|
| `loom-debug-run` | **Build this first.** Highest-frequency loop and purely procedural: run id → which backend (Synapse / ADF / Livy / ADX) → which log store → the exact KQL. Read-only, so zero blast radius; it is the cheapest possible proof that the emitter pipeline works | 3 d |
| `loom-scaffold-item` | Adding an item type today touches the catalog registry, the item-type visual registry, the provisioner, BFF routes, the editor, the parity doc, vitest, and bicep. Nobody holds that in their head. Mine it from a recent real item-type diff, not from a description | 5 d |
| `loom-wire-pipeline` | Must encode the two-canvas gotcha — a pipeline fix has to land in **both** the editor and the designer — or the identical bug ships twice, which it has | 4 d |
| `loom-query-grounded` | Enforces resolve-table → fetch **real** schema → compose → `EXPLAIN` → execute-with-cap. The anti-hallucination procedure. Useless without M2, so it phases with it | 3 d |
| `loom-semantic-model-from-catalog` | Generating a tabular layer is mechanical *given real columns* and pure fiction without them. Pairs with M1's `schema_get` | 4 d |
| `loom-migration` | Produces a **reversible plan artifact**, never an in-place mutation | 4 d |

#### Tier 2 — guardrail skills

| Skill | Why it earns its place | Cost |
|---|---|---|
| `loom-no-fabric-check` | Runs the greps from `.claude/rules/no-fabric-dependency.md` §"How to spot a violation" and **explains each hit** (opt-in branch vs default path). Turns a rule enforced by reviewer memory into a runnable procedure | 2 d |
| `loom-honest-gate` | The G2 pattern: inline **Fix-it** + registration in the gate registry + the Admin gate page. A bare remediation MessageBar is no longer compliant, and this is how a contributor finds that out before review | 2 d |
| `loom-parity-doc` | Emits `docs/fiab/parity/<slug>.md` with a real, Learn-grounded inventory — not a table of aspirations | 2 d |

#### The packaging answer — one source, two emitters (the architecturally load-bearing item)

Author every skill **once** as `SKILL.md`, carrying the product-only fields in an extra frontmatter block:

```yaml
---
name: loom-debug-run
description: Triage a failed Loom run...      # → SkillDescriptor.whenToUse
allowed-tools: Read, Grep, Glob, Bash          # Claude Code / Cursor / Windsurf
loom:
  panes: [monitor, pipeline, notebook]         # → SkillDescriptor.panes
  toolNames: [item_get, run_get, adx_query]    # → MUST resolve in buildDefaultRegistry()
  category: Ops
  clouds: [AzureCloud, AzureUSGovernment]
---
```

- **Emitter A** (exists, needs a generator) — `packages/loom-skills/.claude-plugin/marketplace.json`.
  Generate the four bundle skill-lists from the folder so they cannot drift. **2 d.**
- **Emitter B** (new) — `scripts/skills/build-skill-descriptors.mjs` compiles the same folder into a
  `BUILTIN_LOOM_SKILLS: SkillDescriptor[]` module that `lib/azure/skill-store.ts:listSkills()` unions
  alongside `MS_AGENT_SKILLS` / `POWERBI_AUTHORING_SKILLS` (`skill-store.ts:140-141`). **No new store,
  no new UI**: the Skills Studio toggle, the per-user override (`resolveActiveSkills`) and the
  context-window meter (`estimateSkillTokens`) all work unchanged. **6 d.**
- **CI gate** — fail the build if any `toolNames` entry does not resolve in a live
  `buildDefaultRegistry()` (`lib/azure/copilot-orchestrator.ts:493`). The gate must **construct the
  registry and look the name up**, never regex the source. This repo has a documented history of gates
  that pass while measuring nothing, and a regex over `registerTool(` would be exactly that. **2 d.**

**Why it earns its place:** a skill a developer writes in the repo becomes available in a customer's
in-product Copilot with no code change, and the entire drift class disappears permanently.

**Also in scope (2 d):** emit `LOOM_IQ_MCP_URL` / `LOOM_IQ_TOKEN` / `LOOM_MCP_BRIDGE_TOKEN` from bicep,
or delete them from `.mcp.json` and the README. Today the bundle documents four env vars and the
platform emits one. Either fix is acceptable; leaving it as-is is not.

**Tier-1/2 subtotal: 24 d. Packaging subtotal: 12 d.**

### 4.2 MCP servers — five, split by blast radius

One mega-server is the wrong answer for a governed platform: a single leaked token then grants
everything. Split by **what a compromised token can do**. Each server is a distinct MCP endpoint with
its own scope requirement, its own tool allow-list, and its own audit stream.

| # | Server | Blast radius | Tools | Auth floor | Cost |
|---|---|---|---|---|---|
| **M1** | `loom-catalog` | Read metadata | `catalog_search`, `workspace_list`, `item_list`, `item_get`, `schema_get`, `lineage_get`, `gate_status` | PAT `read-only` **or** Entra OBO | 8 d |
| **M2** | `loom-query` | **Read data rows** — the data-exfil surface | `sql_explain`, `sql_query`, `kql_query`, `preview_table`, `query_status`, `query_cancel` | Entra OBO **only** (no PAT), per-query row + byte + timeout cap | 12 d |
| **M3** | `loom-author` | Create/modify item definitions | `item_create`, `item_update`, `item_definition_get`, `item_definition_update`, `item_delete`, `workspace_create`, `folder_*` | PAT `read-write` or OBO; **`--dry-run` default-on** | 10 d |
| **M4** | `loom-ops` | Read runs/logs, trigger reruns | `run_list`, `run_get`, `run_logs`, `run_start`, `run_cancel`, `schedule_get` | PAT `read-write` or OBO; `run_start` scoped to items the caller can already run | 8 d |
| **M5** | `loom-admin` | **Provision infra, grant access** — the privilege-escalation surface | `gate_list`, `gate_fix`, `mcp_server_deploy`, `role_grant`, `role_revoke`, `pat_list`, `pat_revoke` | Entra OBO + **live tenant-admin re-check** + step-up (PIM) + default-OFF | 14 d |

**M1 · `loom-catalog` — 8 d.** Every downstream workflow starts with "what exists and what shape is
it", and today an agent guesses. Extends `/api/iq/mcp` rather than adding an app — the JSON-RPC
dispatcher, batch handling, and error codes already exist in `route.ts`. `lineage_get` wraps the
existing `/api/lineage/openlineage`. `schema_get` is the one genuinely new piece: a per-backend
resolver over Synapse / ADX / Databricks UC / Loom Unity. **Must not expose:** data rows, connection
strings, secrets, or `/api/developer/tokens`.

**M2 · `loom-query` — 12 d — the most security-sensitive component in the toolkit.** This is what makes
`loom-query-grounded` and `loom-semantic-model-from-catalog` possible: an agent that can `EXPLAIN`
before it executes stops inventing columns. It is also, unavoidably, a bulk-read primitive. Its
controls are in §5.3 and they are not optional.

**M3 · `loom-author` — 10 d.** The Fabric Core parity item (`create_item`, `update_item_definition`,
folders). Earns its place because "scaffold me a medallion lakehouse + pipeline" is the single most
requested agent workflow and today it requires a human clicking through editors. **`--dry-run` is the
default**: every mutating tool returns a plan first and requires an explicit `confirm` argument to
apply, mirroring `loom policy apply --yes`.

**M4 · `loom-ops` — 8 d.** Pairs with the `loom-debug-run` skill; the skill is the procedure, M4 is the
data. Split from M1 because "read a log" and "start a run" have different blast radii from "list items",
and split from M3 because an on-call engineer needs rerun without needing item-definition write.

**M5 · `loom-admin` — 14 d — default-OFF.** Earns its place only because §G2 demands every gate carry
an inline Fix-it and a registry entry; `gate_fix` is that same remediation reachable from an agent.
`apps/fiab-mcp-config/config/loom-mcp.json` already models the pattern — allow/deny tool catalog,
PIM-for-Groups JIT elevation, App Insights audit, rate limits — and M5 adopts it rather than inventing
a second one. **A PAT may never reach M5**: `patCannotMint` (`lib/auth/pat.ts:310`) already establishes
this principle for token minting and M5 extends it to the whole server.

**MCP subtotal: 52 d.** Add **4 d** for a `deployCatalogWithGovMeta`-style consistency gate that fails
CI when `lib/mcp/catalog.ts` `MCP_CATALOG` and `lib/azure/mcp-catalog.ts` `MCP_CATALOG` disagree on
`govSafe` / `airGapSafe` / `license` for a shared id — today nothing enforces that and the agent-mesh
egress policy reads the *other* array.

### 4.3 Purpose-built agents — 4, as `.claude/agents/*.md`

There is no `.claude/agents/` directory in the tree. These are the four the repo's own history argues
for; each is a thin composition over the skills and MCP servers above, not new machinery.

| Agent | Composition | Why it earns its place | Cost |
|---|---|---|---|
| `loom-item-builder` | `loom-scaffold-item` + `loom-parity-doc` + M1 + M3 | The 8-touchpoint item-type checklist is the single highest-friction contribution path | 3 d |
| `loom-triage` | `loom-debug-run` + M4 + M1 | Read-only. The on-call loop, and the safest agent to ship first | 2 d |
| `loom-rule-auditor` | `loom-no-fabric-check` + `loom-honest-gate` + repo greps | Runs the die-hard-rule greps as a **PR check**, not a memory exercise. This is the one that pays for the whole set | 3 d |
| `loom-parity-analyst` | `microsoft_docs_search`/`_fetch` + `loom-parity-doc` + M1 | `ui-parity.md` requires a Learn-grounded feature inventory per surface; today that is done by hand and inconsistently | 3 d |

**Explicitly not proposed:** an agent with write access to Azure, an agent that can merge, and an agent
that can reach M5. **Subtotal: 11 d.**

### 4.4 CLI capabilities

| Capability | Why it earns its place | Cost |
|---|---|---|
| **Publish** — cut `loom-cli-v0.2.0`, verify `npm i -g @csa-loom/cli` end-to-end | The README's install line is false today. Nothing else in this section matters until this is true | 1 d |
| **README truth pass** — document `apps`, `find`, `policy`, `report`, and every REST mapping | Four live command groups are undocumented, including `apps ci-template` which emits a CI workflow nobody knows exists | 1 d |
| `loom config get/set/list` | Claimed by the parity doc against `fab config set`; not implemented | 2 d |
| SP-**certificate** + **managed-identity** login | The two genuine ⚠️ in `docs/fiab/parity/loom-cli.md`. MI login is what makes `loom` usable from an ACA job or a self-hosted runner without a secret — the same four-mode bar `fab` sets | 4 d |
| Global `--dry-run` on every mutating verb | Today only `loom policy`. An agent driving the CLI needs a universal plan-then-apply | 3 d |
| `loom ws export <id> / import <file>` (`.loomws` bundle at workspace scope) | The bundle format exists; there is no CLI verb for it, so workspace-level CI promotion has no entry point | 4 d |
| `loom run <item> --wait`, `loom logs <run>` | The CLI can `apps logs` but cannot run or tail an arbitrary item — the exact loop `loom-triage` and M4 need from a terminal | 3 d |
| Shell completions (bash/zsh/pwsh) | Table stakes; ~1 d given the zero-dep arg parser | 1 d |

**Subtotal: 19 d.**

### 4.5 SDK + the API contract (the load-bearing item)

| Capability | Why it earns its place | Cost |
|---|---|---|
| **OpenAPI expansion, tranche 1 → ~60 paths** | 9 product paths today against 120 API groups. Cover workspaces, items (all types), catalog, lineage, runs, gates, policy, reports. Generate from the route tree where possible; hand-author where the route is polymorphic | 12 d |
| **OpenAPI expansion, tranche 2 → the rest of the public surface** | Explicitly mark internal-only routes `x-loom-internal: true` and **exclude them from every generated client**. An undocumented route is not the same as a private one, and conflating them is how internal routes leak into SDKs | 10 d |
| **Contract gate hardening** | `sdk-contract.yml` already gates the SDKs against `openapi.json`. Extend it to fail when a **non-internal** `route.ts` has no OpenAPI path — a ratchet, starting at the current count and only ever decreasing | 4 d |
| **Regenerate TS + Python SDKs** from the expanded contract | 5 TS resources today; the Python client is already generated so tranche 1 is mostly free there | 6 d |
| **Publish** — `@csa-loom/sdk` to npm, `csa-loom` to PyPI | Neither is published. `StubTransport` is genuinely good and nobody can `pip install` it | 2 d |
| **Terraform provider expansion** — item types beyond the generic `item_resource`, plus registry publish | 2 resources vs ~60 item types. Fabric's provider is registry-published; ours is not | 8 d |

**Subtotal: 42 d.** This is the largest line item in the PRP and it is deliberately first in dependency
order: M1–M5, both SDKs, the Terraform provider, and every generated client all sit on it.

### 4.6 Templates

| Template | Why it earns its place | Cost |
|---|---|---|
| `loom init item <type>` — item-type scaffold | Emits the 8 touchpoints `loom-scaffold-item` describes: catalog registry entry, item-type visual, provisioner stub with an **Azure-native default branch**, BFF route, editor shell at UX baseline, parity doc skeleton, vitest, bicep hook | 5 d |
| `loom init mcp-server` | Emits an MCP server conforming to §5's authz model (scope check, tool allow-list, audit emit, egress guard) — so the *next* MCP server cannot be built without the controls | 3 d |
| `loom init skill` | Emits a `SKILL.md` with the dual frontmatter of §4.1 and a verification section, so a new skill is emitter-compatible by construction | 1 d |
| CI templates — extend `loom apps ci-template` to workspace + policy + report scope | The verb exists and works; it covers apps only | 3 d |

**Subtotal: 12 d.**

**Programme total: 24 + 12 + 52 + 4 + 11 + 19 + 42 + 12 = 176 dev-days**, before the per-phase
verification budget in §7.

---

## 5. Security

This is a governed, federal-capable platform. **A query MCP is a data-exfiltration surface. A deploy
MCP is a privilege-escalation surface.** The controls below are acceptance criteria, not guidance.

### 5.1 Authorization model per server

| Server | Accepted principals | Authorization decision | Never accepted |
|---|---|---|---|
| M1 `loom-catalog` | PAT `read-only`, PAT `read-write`, Entra OBO | Same workspace/item ACL check the BFF route performs. No new authz path — the MCP tool **calls the BFF handler**, it does not reimplement it | Anonymous; the shared-service-token + `x-user-oid` pattern |
| M2 `loom-query` | **Entra OBO only** | PDP decision + engine-side identity. The query executes as the **user**, not as the Console UAMI | Any PAT; any service token; any client-asserted identity |
| M3 `loom-author` | PAT `read-write`, Entra OBO | Workspace-role check at write time; `confirm` argument required to leave dry-run | PAT `read-only`; anonymous |
| M4 `loom-ops` | PAT `read-write`, Entra OBO | `run_start` allowed only for items the caller can already run interactively | PAT `read-only` for `run_start`/`run_cancel` |
| M5 `loom-admin` | Entra OBO **only**, with a **live** tenant-admin re-check at resolve time and a PIM step-up claim | Per-tool allow-list from `apps/fiab-mcp-config/config/loom-mcp.json`; default-OFF via env | **Any PAT, unconditionally** — extending the `patCannotMint` principle at `lib/auth/pat.ts:310` |

**The `x-user-oid` pattern is deprecated by this PRP.** `/api/iq/mcp:72-88` resolves the acting tenant
from a caller-supplied header once a shared token validates. It is defensible for the internal MAF
callback it was built for, and it is not defensible as the general developer-facing auth model —
Fabric Core MCP is explicit that it enforces per-user RBAC and grants "no privilege escalation"
([Learn](https://learn.microsoft.com/rest/api/fabric/articles/mcp-servers/what-is-fabric-mcp-server)).
M1 replaces it with PAT/OBO; the existing internal path stays, narrowed to the internal callback and
kept behind `LOOM_IQ_MCP_ENABLED`.

### 5.2 What must never be exposed by any MCP tool

Enforced by a **deny-list unit test that runs against every registered tool's actual output**, not by
review:

- Secrets, connection strings, SAS tokens, Key Vault references, account keys.
- Full ARM resource IDs and subscription ids (this repo is public; the same rule that governs commits
  governs tool output).
- `/api/developer/tokens` in any form — no MCP tool lists, reads, or mints a PAT except M5 `pat_list`
  (metadata only, never the secret) and `pat_revoke`.
- Another tenant's data. Every tool asserts the resolved tenant matches the item's tenant partition
  before returning, per the cross-tenant `tid` boundary already established in the codebase.
- Raw stack traces or upstream Azure error bodies — normalized to `{ok:false, error, hint}`.

### 5.3 M2-specific controls (the exfiltration surface)

1. **OBO only.** The query runs under the user's own Synapse / ADX / UC identity, so engine-side RLS,
   CLS, and the PDP obligations apply automatically. A service-identity query path is not built.
2. **Hard caps, server-side.** Max rows, max bytes, max wall-clock per query — enforced in the tool,
   not requested by the caller. A caller may lower them; a caller may not raise them.
3. **`sql_explain` before `sql_query` is the documented procedure** (`loom-query-grounded`), and
   `sql_query` emits the plan alongside the result so the audit record shows what was scanned.
4. **Read-only by construction.** DDL/DML rejected at parse, not at the engine. An error naming the
   rejected statement class, never a silent no-op.
5. **Per-principal rate + volume budget**, reusing the rate-limit model already in
   `apps/fiab-mcp-config/config/loom-mcp.json`. Exceeding it is a 429 with a retry hint, and it fires
   an audit event.
6. **Every query audited** — principal oid, tenant, item, statement hash, rows returned, bytes scanned,
   duration, allow/deny — to the existing audit stream (`lib/admin/audit-stream`, already imported by
   `lib/auth/pat.ts:49`) and thence to `LoomAudit_CL`.

### 5.4 M5-specific controls (the escalation surface)

1. **Default-OFF.** `LOOM_MCP_ADMIN_ENABLED` unset ⇒ the endpoint 404s. Enabling is an explicit,
   audited tenant-admin action surfaced on the Admin gate-registry page.
2. **Live admin re-check**, not a claim snapshot — the same design as `patCanAdmin`
   (`lib/auth/pat.ts:320-322`), which ANDs `scope === 'admin'` with a live `isTenantAdmin(session)`, so
   an admin-scoped token minted by a since-demoted user gets no admin power.
3. **PIM step-up.** `role_grant` / `role_revoke` / `mcp_server_deploy` require an active JIT elevation,
   per the PIM-for-Groups model already in `apps/fiab-mcp-config/config/loom-mcp.json`.
4. **Two-step confirm.** Every mutating tool returns a plan with a nonce; applying requires the nonce.
   No single tool call changes the estate.
5. **`gate_fix` is allow-listed, not general.** It may set only the specific values registered in the
   gate registry for that gate id. It is not an arbitrary env/secret writer.

### 5.5 Prompt-injection surface — the custom-skill path

`lib/azure/skill-store.ts:314-334` `createCustomSkill()` lets a tenant author `guidance` text that is
**injected as an extra system message** when the skill is active. That is a first-class prompt-injection
surface and it exists today. This PRP must not widen it:

- Compiled built-ins are emitted with `isBuiltin: true` and are **non-editable** and non-deletable
  through the custom-skill CRUD path.
- A custom skill's `toolNames` are **intersected** with the caller's already-resolved authorization.
  They may narrow what the model reaches for; they may never widen it. A custom skill naming an M5 tool
  gets an empty intersection, not an M5 tool.
- `duplicateSkill` (`skill-store.ts:417-435`) copies `guidance` **and `toolNames`** verbatim into a new
  custom skill. It already forces `isBuiltin: false` (via `createCustomSkill`, `skill-store.ts:325-326`),
  which is correct — but the copied `toolNames` must be run through the same intersection, or
  duplicating a compiled built-in becomes a way to obtain its tool list under a tenant-editable
  `guidance`.
- Skill `guidance` is rendered in the Studio as **text**, never as markdown with active links.

### 5.6 Egress

Every outbound MCP call continues through `assertEgressAllowed` (`lib/azure/egress-ssrf.ts`) via
`mcp-egress-guard.ts` — https-only, private-IP rejection, `LOOM_MCP_EGRESS_ALLOW` suffix allow-list,
built-in-host exemption. M1–M5 are **internal ingress** Container App / BFF routes and do not make
caller-supplied outbound requests at all; the guard remains for the admin probe and the A2A client that
already share it.

### 5.7 Audit

One audit shape for the whole toolkit: `{ts, principal_oid, tenant, server, tool, args_hash, decision,
rows|bytes|targets, duration_ms, outcome}`. Emitted through `lib/admin/audit-stream` to
`LoomAudit_CL`. **Acceptance is a KQL query that returns the events**, not the presence of an
`emitAuditEvent` call — a logging call whose sink is unverified is the same defect class as a gate that
measures nothing.

---

## 6. Per-cloud deltas — Commercial vs Government

Nothing here is assumed symmetric. Each row states the Gov behaviour explicitly.

| Component | Commercial | Government (GCC / GCC-High / DoD) | Mechanism |
|---|---|---|---|
| **CLI** | Works | **Works unchanged** — token acquisition is server-side in `/api/auth/cli-session`, so one binary serves every cloud; only `--api-url` differs | Existing |
| **CLI publish** | npm public | **Same package.** No Gov-specific build. Air-gapped installs consume the tarball artifact from the release | Release artifact |
| **M1 `loom-catalog`** | Full | Full | Azure-native backends only |
| **M2 `loom-query`** | Synapse + ADX + **Databricks UC** + Loom Unity | **No Databricks Unity Catalog in Gov.** `schema_get` and the query path resolve through **Loom Unity** (the OSS-UC-compatible overlay) instead. The tool surface is identical; the resolver branch differs | Backend resolver per cloud |
| **M3 `loom-author`** | Full | Full — item creation is Azure-native by rule | `no-fabric-dependency.md` |
| **M4 `loom-ops`** | Full | Full | Azure Monitor / ADX present in Gov |
| **M5 `loom-admin`** | Full, default-OFF | Full, default-OFF. PIM-for-Groups is available in Gov | Existing config |
| **Fabric / Power BI MCP entries** | Present, opt-in, `defaultRecommended:false` | **Filtered out.** `serversForCloud('gcc'\|'gcc-high'\|'il5')` already excludes `govSafe:false`, and every Fabric-family entry is `govSafe:false, fabricFamily:true` | `lib/mcp/catalog.ts:1511-1518` |
| **`MCP_DEPLOY_CATALOG`** (4: github, grafana, fetch, time) | All 4 deployable | `fetch` reaches arbitrary external hosts — already disabled for Gov in the bridge config (`fetch` is `AzureCloud`-only). `github` requires an approved egress path in GCC-High/IL5; `grafana` and `time` are self-contained | Existing `boundaries` + `externalHosts` |
| **`REMOTE_BUILTIN_MCP_CATALOG`** (12) | `ms-learn` and `ms-release-comms` are default-ON, no auth | Both reach public `learn.microsoft.com`. In GCC-High/IL5 these must be **off by default or proxied**; the entra-obo entries resolve against the Gov Entra authority | Per-cloud default in the remote-config store |
| **`fetch` MCP server** | Available | Already excluded from Gov in `apps/fiab-mcp-bridge/config/loom-mcp-bridge.json` (`AzureCloud` only, and `enabled:false`) | Existing |
| **Skills** | Full | Full. `loom-cloud-endpoints` is already the MUST-READ root and is already sovereign-cloud aware; the `loom.clouds` frontmatter field lets a skill declare `[AzureCloud]` only, and the emitter filters | New frontmatter field |
| **Templates** | Full | Full — `loom init item` emits an Azure-native provisioner branch by default, so a Gov-only estate is the *default* target, not a variant | By construction |
| **PyPI / npm / Terraform registry** | Public install | **Air-gapped estates cannot reach them.** Every artifact must also ship as a release tarball and be mirrorable into the Loom ACR / an internal index — the same pattern `resolveCatalogImage()` + `LOOM_MCP_CATALOG_REGISTRY` already use for images | New, in D5 |
| **Local development** | No emulator (`docs/fiab/local-golden-path.md:15`) | No emulator. **Unchanged and not in scope** — the honest local profile is real session crypto + honest gates | Existing, documented |

**Gov verification rule (from prior incidents):** there is no local Gov `az`. Every Gov claim in this
programme is proven via a GitHub Actions job against the Gov estate, and no full ARM resource id is
ever printed into a log or a PR body.

---

## 7. Phased delivery

Every phase ships **functional end-to-end** per `no-vaporware.md`, with a real-data receipt, on **both**
clouds. No phase leaves a half-wired artifact behind. Phase order is dependency order, and D0 is first
because everything else sits on it.

### D0 — Contract + publish (the foundation) · ~19 d
- OpenAPI tranche 1 → ~60 paths, `x-loom-internal` marking, ratchet gate in `sdk-contract.yml`.
- Cut `loom-cli-v0.2.0` and `loom-sdk-v0.1.0`; publish `@csa-loom/cli`, `@csa-loom/sdk`, PyPI `csa-loom`.
- CLI README truth pass (`apps`, `find`, `policy`, `report`).
- **Functional at end of phase:** a developer on a clean machine runs `npm i -g @csa-loom/cli`,
  `loom auth login`, `loom ws list` against both estates. Receipt = terminal transcript, both clouds.

### D1 — Skills: one source, two emitters · ~15 d
- Dual-frontmatter schema; Emitter A (marketplace generator); Emitter B (`BUILTIN_LOOM_SKILLS` →
  `listSkills()` union); registry-resolving CI gate; fix or delete the three unemitted env vars.
- Ship `loom-debug-run` and `loom-no-fabric-check` through both emitters as the proof.
- **Functional at end of phase:** the same `SKILL.md` appears in a coding agent's skill list **and** in
  the in-product Skills Studio with a working toggle and a token estimate. Receipt = G1 browser walk of
  the Studio + a Claude Code session transcript using the skill.

### D2 — M1 `loom-catalog` + `loom-triage` agent · ~15 d
- M1 (7 tools) with PAT/OBO authz, the deny-list test, and audit; `schema_get` per-backend resolver
  (Databricks UC on Commercial, Loom Unity on Gov); `.claude/agents/loom-triage.md`.
- Deprecate the `x-user-oid` general path; narrow it to the internal callback.
- **Functional at end of phase:** an external MCP client with a `read-only` PAT lists workspaces,
  fetches a real table schema, and the call appears in a `LoomAudit_CL` KQL result. Receipt = the KQL
  output, both clouds.

### D3 — Workflow skills + M4 `loom-ops` + CLI run/logs · ~24 d
- `loom-scaffold-item`, `loom-wire-pipeline`, `loom-migration`; `loom-honest-gate`, `loom-parity-doc`;
  M4; `loom run --wait` / `loom logs`; `loom-item-builder` + `loom-rule-auditor` agents;
  `loom init item` / `loom init skill` templates.
- **Functional at end of phase:** an agent scaffolds a new item type end-to-end, its editor renders at
  UX baseline, `loom-rule-auditor` runs as a PR check on a real PR. Receipt = the merged scaffold PR +
  the auditor's check output.

### D4 — M2 `loom-query` + M3 `loom-author` + grounded-query skills · ~32 d
- M2 with the full §5.3 control set — **no phase of M2 ships without the caps, the audit, and the
  DDL/DML rejection; a "read-only by convention" M2 does not ship.**
- M3 with dry-run-by-default; `loom-query-grounded`, `loom-semantic-model-from-catalog`; global CLI
  `--dry-run`; SP-cert + MI login.
- **Functional at end of phase:** an OBO-authenticated agent explains then executes a real Synapse
  query, is capped at the row limit, is denied a `DROP`, and every attempt is in the audit. Receipt =
  the four KQL rows, both clouds (Gov via Loom Unity).

### D5 — M5 `loom-admin` + SDK/Terraform breadth + air-gap distribution · ~34 d
- M5 default-OFF with PIM step-up + two-step confirm; OpenAPI tranche 2; regenerated TS/Python SDKs;
  Terraform provider item-type expansion + registry publish; mirrorable release tarballs and an
  internal-index path for air-gapped estates; `loom ws export/import`; shell completions;
  `loom init mcp-server`; `loom-parity-analyst`.
- **Functional at end of phase:** a Terraform apply creates a workspace and three item types on both
  estates from the registry-published provider; an air-gapped install path is proven from a mirrored
  artifact. Receipt = `terraform apply` output + the mirrored-install transcript.

**Cumulative: ~139 d of the 176 d inventory lands in D0–D5**; the residual (`loom config`,
`ci-template` breadth, the catalog-consistency gate, and Tier-2 polish) is opportunistic and rides the
phase it is nearest to.

---

## 8. Acceptance criteria

Each is a command or an artifact. None is a judgement call.

**Contract & publish**
1. `sdk/openapi.json` path count ≥ 60 after D0 and ≥ the agreed tranche-2 target after D5.
2. `sdk-contract.yml` fails a PR that adds a `route.ts` without either an OpenAPI path or an explicit
   `x-loom-internal: true` marking. **Proven by a deliberate red run**, not by the gate being green.
3. `npm view @csa-loom/cli version` and `npm view @csa-loom/sdk version` return a version;
   `pip download csa-loom` succeeds; `terraform init` resolves `terraform-provider-loom` from the registry.
4. `git tag -l 'loom-cli-v*'` is non-empty.

**Skills**
5. `grep -rn "loom-skills" apps/ scripts/ .github/` returns at least one hit that is a **skill emitter**,
   not only `gov-verify-evidence.sh`.
6. Every `SKILL.md` in `packages/loom-skills/skills/` appears in `listSkills()` output with
   `isBuiltin: true`, verified by a vitest that calls `listSkills()`.
7. The `toolNames` CI gate **constructs `buildDefaultRegistry()` and resolves each name**. Proven by a
   deliberate red run with a bogus tool name.
8. `marketplace.json` bundle lists are byte-identical to generator output (`git diff --exit-code` after
   regeneration).
9. `LOOM_IQ_MCP_URL`, `LOOM_IQ_TOKEN`, `LOOM_MCP_BRIDGE_TOKEN` either appear in bicep **or** appear
   nowhere — `grep` count in `packages/loom-skills/` matches the count in `platform/`.

**MCP**
10. Each of M1–M5 responds to MCP `tools/list` with exactly its declared tool set, and to a `tools/call`
    with a real backend response — captured against both estates.
11. A PAT-authenticated call to M2 or M5 returns 403. A `read-only` PAT call to an M3 mutating tool
    returns 403. Both are vitest cases **and** live probes.
12. The deny-list test runs every registered tool against a fixture estate and asserts no secret,
    connection string, subscription id, full ARM id, or PAT value appears in any output.
13. M2 hard caps: a query requesting more than the row cap returns a capped result with an explicit
    `truncated: true`; a `DROP TABLE` returns a parse-stage rejection naming the statement class.
14. M5 with `LOOM_MCP_ADMIN_ENABLED` unset returns 404. With it set, a non-admin OBO principal returns
    403 even holding a valid token.
15. A KQL query over `LoomAudit_CL` returns one row per tool call made during the acceptance run, with
    principal, tool, and outcome populated.
16. A catalog-consistency test fails when `lib/mcp/catalog.ts` and `lib/azure/mcp-catalog.ts` disagree on
    `govSafe`/`airGapSafe`/`license` for a shared id.

**CLI**
17. `loom --help` lists all 7 groups; `apps/loom-cli/README.md` documents all 7 with REST mappings.
18. `loom auth login --managed-identity` succeeds from an ACA job with no secret.
19. Every mutating verb accepts `--dry-run` and prints a plan without mutating — asserted by a vitest
    that runs each verb with `--dry-run` against a stub transport and asserts zero non-GET requests.

**Per-cloud**
20. Every acceptance item above is executed against **both** Commercial and Gov, Gov exclusively via a
    GitHub Actions job, with no full ARM resource id in any log.
21. `serversForCloud('gcc-high')` returns zero entries with `fabricFamily: true` — asserted by vitest.
22. The whole D0–D5 acceptance run is repeated with `LOOM_DEFAULT_FABRIC_WORKSPACE` **unset**; every
    item still passes. Per `no-fabric-dependency.md` this is the definition of done, not a variant run.

**Vaporware floor**
23. Every phase PR carries a real-data receipt: endpoint hit, first 300 chars of the real response, and
    for any Console surface a G1 in-browser E2E walk.
24. `grep -rE "(return \[\]|return \{\})" ` over every new MCP tool handler and CLI command returns zero
    placeholder returns.

---

## 9. Honest limits — what this PRP does NOT deliver

- **No local emulator.** `docs/fiab/local-golden-path.md:15` states there is none; that stays true. The
  local developer profile remains real session crypto + honest gates. Building an emulator is a
  separate, much larger programme and pretending otherwise would be the exact defect this repo keeps
  catching.
- **No Fabric interop.** Nothing here reads or writes a Fabric workspace on a default path. The Fabric
  MCP servers and `fab` are cited as a design bar only.
- **M2 is a governed query proxy, not a new engine.** It routes to Synapse / ADX / UC / Loom Unity and
  enforces caps and audit. It does not optimize, cache, or federate — that is the `loom-sql-gateway`
  work in `PRPs/active/bridge-services/`, and M2 should ride it once it lands rather than fork it.
- **The Terraform provider will not cover all ~60 item types in D5.** It covers the generic item
  resource plus the highest-value typed resources. The rest is a documented backlog, not a claim.
- **`loom-scaffold-item` is mined from a real recent item-type diff.** If that diff is not
  representative, the skill will be wrong in ways only a real scaffold attempt reveals — which is why
  D3's receipt is a **merged** scaffold PR, not a generated file.
- **Skill token cost is real.** `estimateSkillTokens` exists because skills consume context. Nine new
  built-ins default-ON would be a regression; the emitter must set sensible per-pane defaults and the
  Studio meter is the acceptance surface for that.

---

## 10. Risks

| Risk | Why it is live here | Mitigation |
|---|---|---|
| **A gate that measures nothing** | This repo has shipped several. The `toolNames` gate is the highest-risk one — a regex over `registerTool(` would pass forever | Every new gate ships with a **deliberate red run** in its PR (acceptance #2, #7) |
| **M2 becomes the exfil path** | An OBO bypass, a missing cap, or a service-identity fallback turns it into bulk read | OBO-only with no service-identity code path at all; caps server-side; DDL/DML rejected at parse; audit verified by KQL |
| **Custom-skill prompt injection widens** | `createCustomSkill` guidance is already system-injected | Built-ins non-editable; `toolNames` intersected never unioned; `duplicateSkill` re-runs the intersection |
| **OpenAPI expansion leaks internal routes into SDKs** | 120 groups, most internal | `x-loom-internal: true` excluded from every generator; the ratchet counts non-internal routes only |
| **Gov drift** | Gov has no Databricks UC and GCC-High egress constraints | Per-cloud resolver branch in `schema_get`/M2; every acceptance item runs on both estates via Actions |
| **Three catalog arrays drift** | Two independent gov-metadata lists, one feeding the agent-mesh egress policy | Consistency gate (acceptance #16) |
| **Publish unblocks a supply-chain surface** | Public npm/PyPI packages carry the Loom name | Provenance/attestation on publish; the tag-triggered workflows already isolate release from the release-please train |

---

## 11. Relationship to other PRPs

- `PRPs/active/bridge-services/PRP-bridge-services.md` — **loom-sql-gateway** is the eventual backend
  for M2. Build M2 against the per-engine clients now; re-point it at the gateway when that lands.
  Do not fork.
- `PRPs/active/loom-apex/PRP.md` — **B-N19b** ("`csa-loom` PyPI SDK + terraform-provider-loom,
  contract-tested vs `openapi.json`") is the same work as this PRP's D0/D5 SDK lines. This PRP
  supersedes B-N19b and B-N19b should be marked as folded here.
- `docs/fiab/parity/loom-cli.md`, `iq-mcp-surface.md`, `mcp-catalog.md`, `admin-mcp-servers.md`,
  `mcp-stdio-bridge.md`, `ms-mcp-servers.md`, `ontology-sdk.md` — each gets a parity-doc refresh in the
  phase that touches it, per `ui-parity.md`.
- A sibling PRP for the **CSA Loom VS Code extension** is in flight; M1/M2/M4 and the published SDK are
  its dependencies, and the two must not build parallel API clients.
