# Tutorial: Spindle (AIP Logic & agents) editor

> CSA Loom `aip-logic` editor — **Spindle Studio**, the Azure-native equivalent
> of Palantir **AIP Logic** and AIP agents: author typed AI logic and
> tool-calling agents over a Weave **ontology**, grounded on real data and run on
> **Azure OpenAI / Azure AI Foundry**. **No Microsoft Fabric required.**

## What it is

AIP Logic builds no-code, typed LLM functions; AIP runs agents over the
ontology. Spindle Studio covers both. You define a **typed input schema** and an
**ordered set of steps** with dropdowns (no freeform JSON), bind a **Weave
ontology** so the function grounds on its entity types and Lakehouse / Warehouse
bindings, then run it two ways:

- **Logic mode** — a single grounded turn that writes real read-only T-SQL /
  Spark-SQL against Synapse and cites real rows, or
- **Agent mode** — a multi-step, tool-calling agent on the production copilot
  orchestrator with the full Loom data-tool registry.

You can also **publish** the logic as a real **Azure AI Foundry Agent Service**
agent and inspect its per-step run trace.

## When to use it

- You want a reusable, typed AI function (typed input → steps → typed output)
  grounded on governed data instead of an ad-hoc prompt.
- You want an agent that can call Loom data tools to answer multi-step questions
  over your ontology.
- You want to deploy the logic as a managed Foundry agent and audit its steps.

## Step-by-step in Loom

1. **Create the item.** Choose **+ New item → Spindle (AIP Logic & agents)**
   (Fabric IQ). The editor opens at `/items/aip-logic/<id>`.
2. **Define typed inputs.** Add named input parameters with types (string /
   number / boolean) in the field builder.
3. **Ground on the Weave.** Bind a Weave **ontology** so Spindle runs against its
   entity types and Lakehouse / Warehouse bindings (real Synapse queries).
4. **Add ordered steps.** Use **Add step** to add LLM-prompt, extract, or branch
   steps from a dropdown — no freeform JSON.
5. **Define the output.** Set the typed output shape the function returns.
6. **Invoke.** Flip the **Logic / Agent** switch, then run: **Invoke function**
   (single grounded turn) or **Run agent** (multi-step tool-calling). Both hit
   the live **Azure OpenAI** deployment; the agent returns a per-step run trace,
   or an honest remediation gate if no model is deployed.
7. **Publish as a Foundry agent.** Use **Publish** to deploy the logic to **Azure
   AI Foundry Agent Service**, then run and inspect its steps — or use the
   Azure-native Invoke path where Agent Service is unsupported (for example Azure
   Government).

## The Azure backend it rides on

- **LLM:** an **Azure OpenAI** deployment (`LOOM_AOAI_*`); an unset deployment
  produces an honest gate naming the env var.
- **Grounding data:** read-only **Synapse SQL / Spark-SQL** against the ontology's
  Lakehouse / Warehouse.
- **Managed agents (optional):** **Azure AI Foundry Agent Service**.

## No Fabric required

Spindle grounds on a **Loom Ontology** and runs on Azure OpenAI / Foundry by
default. Fabric Reflex / Fabric AI are never on the default path; honest gates
name the exact AOAI or Foundry env var when a backend is unconfigured.

## Learn more

- Ontology editor tutorial: `editor-ontology.md`
- Azure OpenAI: <https://learn.microsoft.com/azure/ai-services/openai/overview>
- Azure AI Foundry Agent Service:
  <https://learn.microsoft.com/azure/ai-services/agents/overview>
