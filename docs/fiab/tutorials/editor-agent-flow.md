# Tutorial: Agent flow editor

> CSA Loom `agent-flow` editor — a standalone **visual multi-agent workflow**.
> Chain grounded data tools (lakehouse / warehouse / KQL / AI Search), capability
> tools (**MCP servers**, **OpenAPI**, **functions**), and connected **sub-agents**
> on a canvas, then run the flow against your real Azure backends and publish it
> as an MCP tool. Azure-native — **no Microsoft Fabric or Foundry dependency on
> the default path**.

## What it is

A single chat agent answers from whatever you paste into its prompt. An agent
flow is a *design*: an orchestrator with explicit instructions, a set of tools
that are bound to **your real Loom items**, and sub-agents it can delegate to.
At run time, Azure OpenAI grounds over the bound items and delegates to each
sub-agent, and the whole run is recorded.

Three tabs: **Design**, **Runs**, **Publish**.

## When to use it

- One question needs data from more than one place (an order table *and* live
  telemetry) with a citation trail.
- You want specialized sub-agents (pricing, compliance, logistics) that an
  orchestrator can call.
- You want the finished flow callable by other systems as an MCP tool.

## Step-by-step in Loom

1. **Create the item.** **+ New item → Agent flow**, then **Create agent flow**.
2. **Write the orchestrator instructions.** On **Design**, the first card is the
   orchestrator prompt — what the flow should do and how it should combine its
   tools and sub-agents. This grounds the Azure OpenAI orchestrator at run time.
   For example:
   > You are a supply-chain analyst. Use the warehouse tool for order data and
   > the KQL tool for live telemetry, delegate pricing questions to the pricing
   > sub-agent, and always cite the source.
3. **Compose the flow on the canvas.** The `AgentFlowCanvas` below lets you add:
   - **Grounded data tools** — bound to real Loom items (lakehouse, warehouse,
     KQL database, AI Search index).
   - **Capability tools** — MCP servers, OpenAPI operations, functions.
   - **Connected sub-agents** — other agents the orchestrator can delegate to.
   - **Guardrails** — the flow's guardrail settings, shown inline.

   Node positions persist as part of the item's layout.
4. **Run it.** The canvas has an embedded run pane. Ask a question there and the
   flow executes for real through the item's own owner-scoped run route
   (`POST /api/items/agent-flow/<id>/run`) — real grounded orchestration over the
   bound items and sub-agents, not a simulation.
5. **Save.** The ribbon's **Save** and the bottom save bar both persist the
   instructions, tools, sub-agents, guardrails, and layout; the save bar shows
   the last saved time.
6. **Review the history.** **Runs** lists every execution: started, the question,
   how many grounded sources and capability tools were used, how many sub-agents
   (with a check mark when delegation actually happened), total tokens, and
   status. Runs are persisted with the item and survive reloads — newest first,
   up to 50 retained.
7. **Publish as an MCP tool.** **Publish** exposes the saved flow as an MCP tool
   other systems can call, showing the tool name and the publish time. Publishing
   requires a flow with content (instructions, tools, or sub-agents) **and no
   unsaved changes** — if the item is dirty, an info MessageBar tells you to save
   first so the MCP server serves the latest design.

## The Azure backend it rides on

- **Orchestration:** **Azure OpenAI** connected-agents runtime, grounded over
  your bound Loom items.
- **Grounded data tools:** the real backends behind those items — ADLS Gen2 /
  Delta (lakehouse), Synapse SQL (warehouse), Azure Data Explorer (KQL), Azure
  AI Search.
- **Capability tools:** your deployed MCP servers, OpenAPI endpoints, and
  functions.
- **Routes:** `POST /api/items/agent-flow/<id>/run`,
  `GET /api/items/agent-flow/<id>/runs` — owner-scoped, with the run history
  persisted to the item's state.

## Honest gates

| Condition | What you see | Exact remediation |
|---|---|---|
| No runs yet | *"No runs yet. Switch to Design and ask a question in the run pane."* | Run the flow once |
| Unsaved changes on **Publish** | Info MessageBar *"Unsaved changes"*; publish is blocked | **Save** the flow, then publish |
| Empty flow | Publish is unavailable until the flow has instructions, tools, or sub-agents | Author the flow first |
| A bound tool's backend is unconfigured | That tool's own honest gate surfaces at run time with its remediation | Configure the named backend for that item type |

## No Fabric required

Azure OpenAI plus the Azure backends behind your bound items. No Fabric
capacity, workspace, OneLake path, or Power BI workspace is used on the default
path.

## Learn more

- Data agent editor tutorial: `editor-data-agent.md`
- Cross-item Copilot tutorial: `editor-cross-item-copilot.md`
- Azure AI connected agents:
  <https://learn.microsoft.com/azure/ai-services/agents/concepts/connected-agents>
