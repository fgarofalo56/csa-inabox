---
description: Run the multi-agent Fabric-parity build pipeline (catalog → build → validate → loop) on one or more UIs. Argument is one or more UI names from docs/fiab/fabric-parity-tasks.json (e.g. "notebook" or "lakehouse data-pipeline" for parallel).
argument-hint: <ui-name> [more-ui-names...]
---

# Run the Fabric-parity loop on $ARGUMENTS

You are running the **multi-agent build pipeline** defined in `.claude/workflows/fabric-parity-loop.md`. The user invoked it with one or more UI names: `$ARGUMENTS`.

## Steps

### 1. Read the task list

Read `docs/fiab/fabric-parity-tasks.json` and find the entry for each UI name passed in `$ARGUMENTS`. For each, extract:
- `fabricRefUrl` — the URL of the real Fabric item to inspect
- `loomEditorPath` — the path to the current Loom editor file
- `loomRoutes` — the BFF route prefixes Loom uses
- `azureBackend` — which Azure service is the target backend (Synapse Spark, Databricks, ADF, etc.)
- `requiredAzureResources` — bicep-codified resources needed (Spark pool, cluster, etc.)
- `requiredManualGrants` — interactive grants the operator must do once (e.g. Dataverse Application User)
- `currentVerdict` — last known grade from docs/fiab/wiring-audit.md

### 2. For each UI, spawn the 3-agent pipeline

You must run the three phases **sequentially per UI** (catalog must finish before build, build must finish before validate). For **parallel UIs**, kick off N independent pipelines by sending multiple `Agent` tool calls in a single message.

Per-UI loop (max 3 iterations):

#### Phase 1 — CATALOG (Explore agent)

Spawn:
```
Agent(
  subagent_type: "Explore",
  description: "Catalog Fabric <ui-name>",
  prompt: <the catalog brief — see below>
)
```

The catalog brief tells the agent:
- Use Playwright MCP to open the Fabric URL
- Take screenshots of every visible state (default, hover on each cell/button, dropdown open, panel expanded)
- Document every visible element: title bar, tab strip, ribbon contents, side panels, status bar, modals, hover toolbars
- Save artifacts to `docs/fiab/parity-specs/<ui>-spec.md` + `docs/fiab/parity-specs/<ui>-screens/`
- Return a one-paragraph summary

#### Phase 2 — BUILD (general-purpose agent)

Spawn:
```
Agent(
  subagent_type: "general-purpose",
  description: "Build Loom <ui-name> per spec",
  prompt: <the build brief — see below>
)
```

The build brief tells the agent:
- Read `docs/fiab/parity-specs/<ui>-spec.md` (which the catalog agent just produced)
- Read `docs/fiab/parity-specs/<ui>-needs-rework.md` if it exists (from a prior validate-fail iteration)
- Build/update the Loom editor in `apps/fiab-console/lib/editors/` matching the spec
- Wire to the real Azure backend per `azureBackend`
- Update bicep modules + post-deploy-bootstrap workflow so push-button deploy creates `requiredAzureResources`
- Build a new image tag (vN+1), deploy to the Container App, verify Healthy
- Commit with conventional commits + co-authored-by + push
- Return: image tag deployed + commit hash + list of files changed

#### Phase 3 — VALIDATE (verify-app agent)

Spawn:
```
Agent(
  subagent_type: "verify-app",
  description: "Validate <ui-name> parity",
  prompt: <the validate brief — see below>
)
```

The validate brief tells the agent:
- Open both Fabric (`fabricRefUrl`) and Loom (`https://loom-console-fvbbctd4eehqbkcs.b02.azurefd.net/items/<ui-name>/<id>`) in Playwright
- Mint a Loom session cookie via the env var `SESSION_SECRET` (it was given access)
- Side-by-side compare every element from `docs/fiab/parity-specs/<ui>-spec.md`
- Click every button in Loom; confirm it does what the same button in Fabric does
- Confirm the primary action hits real Azure (network panel shows real Azure URLs)
- Grade A/B/C/D/F using the criteria in `.claude/workflows/fabric-parity-loop.md`
- If grade is C/D/F: write `docs/fiab/parity-specs/<ui>-needs-rework.md` with the specific gap list
- Return: grade + summary + path to needs-rework.md (if any)

#### Approval gate

After Validate returns:
- **Grade A or B** → mark TodoWrite task complete, append to `docs/fiab/parity-progress.md`, move to next UI
- **Grade C/D/F** AND iteration count < 3 → loop back to Phase 2 (Build) with the needs-rework.md path as additional input
- **Grade C/D/F** AND iteration count >= 3 → stop, write `docs/fiab/parity-specs/<ui>-stuck.md`, mark needs-human-review

### 3. Brief format

For each agent spawn, the prompt must be **self-contained** — the subagent doesn't see this conversation. Include:
- The UI name + relevant URLs/paths from the task list
- What artifacts the previous phase produced (paths)
- What artifacts this phase should produce (paths)
- Acceptance criteria
- Any KV secret retrieval needed (refer to existing patterns in the bash scripts: temporarily Enable KV, get SESSION_SECRET, re-Disable)

### 4. Report

After all UIs complete, print a summary table:

| UI | Final grade | Iterations | Image tag | Files changed | Notes |
|---|---|---|---|---|---|

Mark TodoWrite tasks accordingly.

## Constraints

- Stay efficient — each Agent call is its own context window, so write tight self-contained prompts
- The Build agent has full Azure CLI + GitHub access; it can open ACR, build images, deploy. Other agents should not need that.
- The Catalog agent is read-only.
- The Validate agent has Playwright + KV-via-az access for minting cookies, but should not edit code.
- Do not loop more than 3 times per UI.
- If running multiple UIs in parallel, send ONE message with N Agent tool calls.

## Now: kick off

Begin by reading `docs/fiab/fabric-parity-tasks.json`. If the file doesn't exist or doesn't have entries for the requested UIs, surface that clearly and stop.
