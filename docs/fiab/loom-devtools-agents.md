# Loom developer toolkit — purpose-built agents

> Companion to `PRPs/active/loom-devtools.md` §4.3. Four Claude Code subagents
> that compose the toolkit's Agent Skills and MCP servers into repeatable
> developer workflows. Each is a thin composition over existing machinery, not
> new machinery, and each is least-privilege by construction.

## The four agents

| Agent | File | One-line role | Composition (PRP §4.3) |
|---|---|---|---|
| `loom-triage` | `.claude/agents/loom-triage.md` | Read-only root-cause triage of a failed/degraded Loom run | `loom-debug-run` + M4-read + M1 |
| `loom-item-builder` | `.claude/agents/loom-item-builder.md` | Scaffold a new item type across its 8 touchpoints + parity doc | `loom-scaffold-item` + `loom-parity-doc` + M1 + M3 |
| `loom-rule-auditor` | `.claude/agents/loom-rule-auditor.md` | Run the die-hard-rule greps as a PR check (report only) | `loom-no-fabric-check` + `loom-honest-gate` + repo greps |
| `loom-parity-analyst` | `.claude/agents/loom-parity-analyst.md` | Learn-grounded feature inventory → `docs/fiab/parity/<slug>.md` | `microsoft_docs_search`/`_fetch` + `loom-parity-doc` + M1 |

## Tool allowlist and why it is least-privilege

Tools use Claude Code's MCP naming `mcp__<server>__<tool>`. The `loom-*` servers
are the five MCP servers defined in PRP §4.2 (M1 `loom-catalog`, M2 `loom-query`,
M3 `loom-author`, M4 `loom-ops`, M5 `loom-admin`); the `microsoft_docs_mcp`
server is the Microsoft Learn MCP already available to the toolkit.

| Agent | MCP tools granted | Server / blast radius | Deliberately excluded |
|---|---|---|---|
| `loom-triage` | 7 × `mcp__loom-catalog__*` (read metadata) + `run_list`/`run_get`/`run_logs`/`schedule_get` on `mcp__loom-ops__*` | M1 (read) + M4 read-only subset | `run_start`/`run_cancel` (mutating) and ALL of M2/M3/M5 — the agent is read-only |
| `loom-item-builder` | 7 × `mcp__loom-catalog__*` + `item_create`/`item_update`/`item_definition_get`/`item_definition_update` on `mcp__loom-author__*` (dry-run default) | M1 (read) + M3 authoring subset | `item_delete`/`workspace_create`/`folder_*` (not needed to scaffold), all M4/M5, no infra/role/gate tools |
| `loom-rule-auditor` | none (repo-only: Read/Grep/Glob/Bash) | static analysis over the tree | every MCP write; a PostToolUse hook holds Bash to read-only (no push/merge/approve/az-mutate) |
| `loom-parity-analyst` | `microsoft_docs_search`/`_fetch` + 7 × `mcp__loom-catalog__*` | Learn MCP + M1 (read) | all M2/M3/M4/M5; no Bash, no arbitrary web fetch; Write/Edit constrained to `docs/fiab/parity/` |

**No agent can reach M5 `loom-admin`, provision infra, grant access, push, or
merge** — the three capabilities PRP §4.3 explicitly does not propose. The two
write-capable agents are scoped tightly: `loom-item-builder` gets a 4-tool M3
authoring subset with dry-run default (never `item_delete`/`workspace_create`);
`loom-parity-analyst` can only write parity docs. `loom-triage` and
`loom-rule-auditor` cannot mutate anything.

## Guardrails encoded in every agent

- **Secret-scrub reliance (PRP §5.2):** no agent prints connection strings, SAS
  tokens, KV refs, account keys, PAT values, subscription ids, or full ARM
  resource ids; log lines carrying them are redacted. The M-server deny-list
  test is the backstop.
- **Escalation limits (PRP §4.3, §5.4):** no agent reaches M5; `loom-triage`
  recommends a rerun rather than performing it; `loom-item-builder` dry-runs
  every M3 write and never pushes/merges; `loom-rule-auditor` reports and can
  comment on a PR but never approves/merges (enforced by a Bash guard hook).
- **Per-cloud (PRP §6):** every agent works on Commercial and Government with
  the API URL as the only difference; each knows Gov has no Databricks Unity
  Catalog (schema resolves via Loom Unity), filters Fabric/Power BI, and forbids
  printing full ARM ids in logs.
- **No Fabric dependency (`no-fabric-dependency.md`):** every agent treats the
  Azure-native path as the default and never names "bind a Fabric workspace" as
  a remediation.

## Install / distribute

These are standard Claude Code project subagents. They are usable as soon as
they exist on disk — no build step.

- **Repo-local (default):** the four files live in `.claude/agents/` at the repo
  root and are picked up automatically by Claude Code, Cursor, and any tool that
  reads `.claude/agents/*.md`. Invoke with the Agent tool / `@loom-triage` etc.,
  or let them auto-trigger on a matching `description`.
- **User-level:** copy any of them into `~/.claude/agents/` to make the agent
  available across all repos on the machine.
- **The `loom-*` MCP servers ship in PRP phases D2–D5.** Until a given server is
  configured in the workspace `.mcp.json`, that agent's `mcp__loom-*` tools are
  simply unavailable and the agent runs with its native tools (Read/Grep/Glob/
  Bash and, for the analyst, the Learn MCP). The allowlist is forward-declared
  so no change is needed when the servers land. `loom-rule-auditor` needs no
  loom MCP server at all and is fully functional today.

## Verification

Frontmatter YAML parses (pyyaml), every `tools` entry is a real Claude Code tool
or a declared `mcp__loom-*` / `mcp__microsoft_docs_mcp__*` tool, and no agent
holds a mutating capability it does not need (least-privilege table above). See
the PRP §4.3 / §5 for the authoritative scope and guardrail definitions.
