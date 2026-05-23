# Copilot in CSA Loom

## What Fabric does

Per-workload Copilots are embedded in Fabric: Data Engineering / Data
Science (notebooks slash commands), Data Factory (pipelines +
dataflows), Warehouse (NL→SQL), SQL DB, Real-Time Dashboard (NL→KQL),
Power BI report authoring. Runs on Azure OpenAI. Per-user identity
scoping. F2+ paid capacity required (no Trial).

## CSA Loom parity design — Loom Copilot runtime

The Loom Copilot is the unified Copilot persona in the Loom Console.
Built on the extended `apps/copilot/` + `azure-functions/copilot-chat/`
scaffold (per [PRP-09 Data Agents](data-agents-parity.md) — same
runtime, different system prompts and tool catalogs per context).

### Personas

The same agent runtime serves multiple personas via system-prompt
selection:

| Context | Persona | Tool catalog |
|---|---|---|
| Setup Wizard (`/setup`) | "loom-deploy-agent" | render_bicepparam, submit_deployment, poll_deployment, activate_pim, MCP tools |
| Console sidebar (all panes) | "loom-copilot" | NL2SQL, NL2DAX, NL2KQL, doc-search, workspace-search, capacity-check |
| Notebook embed (slash commands) | "notebook-copilot" | `/explain`, `/fix`, `/comments`, `/optimize` |
| Warehouse pane | "warehouse-copilot" | NL2SQL, EXPLAIN, optimize-query |
| Semantic Model pane (v1.1) | "dax-copilot" | NL2DAX, DAX-explain, optimize-DAX |
| KQL pane | "kql-copilot" | NL2KQL, KQL-explain |
| Activator pane | "activator-copilot" | rule-author, threshold-suggest |
| Data Agents pane | "agent-config-copilot" | example-query-generate, field-description-generate |
| Admin pane (v1.1) | "ops-copilot" | capacity-scale, OAP-toggle, workspace-create |

### Capacity isolation

Per-organization dedicated AOAI deployment ("Loom Copilot Capacity")
in Commercial. In Gov where AOAI TPM quotas are tighter, per-DLZ
AOAI deployments for blast-radius isolation.

### Telemetry + feedback

Reuses the existing `azure-functions/copilot-chat/` feedback + backlog
mechanism (per `temp/fiab-research/07-existing-repo-scope.md` — the
existing 400+ line function_app.py has all the security + telemetry
+ feedback already).

### Identity (per AMENDMENTS A15)

OBO throughout — every tool call carries the calling user's Entra
token. Per-user audit trail.

## Per-boundary behavior

| Boundary | AOAI | Orchestration | Foundry portal |
|---|---|---|---|
| Commercial | ✅ Full catalog | Foundry Agent Service | ✅ |
| GCC | ✅ Full catalog | Foundry Agent Service | ✅ |
| GCC-High / IL4 | ✅ gpt-4o, gpt-4.1, o3-mini, gpt-5.1 in usgovvirginia/usgovarizona | MAF + AOAI direct | ❌ (use Azure ML Classic Hub) |
| IL5 (v1.1) | Same Gov catalog | MAF + AOAI direct | ❌ |

## Honest gaps

- **Cross-workload Copilot continuity** — Fabric's Copilot remembers
  context across workloads in some scenarios; Loom Copilot v1 is
  per-pane scoped (cross-pane continuity is v1.1)
- **Foundry portal Gov** — unavailable; orchestration via MAF, not
  Foundry portal observability
- **Some advanced AOAI features in Gov** — Batch API, Content Safety,
  Realtime API not in Gov audit tables; Loom Copilot doesn't depend
  on these for core functionality

## Forward migration

Loom Copilot agent definitions export to Foundry Agent Service formats.
Per-workload Copilots in Fabric replace Loom Copilot slash-commands
when Fabric Gov GA arrives.

## Related

- ADR: [fiab-0009 Copilot orchestration](../adr/0009-copilot-orchestration.md)
- Build PRP: PRP-09 (Data Agents tools), PRP-04 (Setup Wizard)
- Related parity: [Data Agents parity](data-agents-parity.md)
- Console: [Loom Copilot runtime](../console/copilot-runtime.md)
- Memory: [[copilot-chat-two-backends]]
