# fiab-0009: Copilot orchestration — Foundry Agent Service in Commercial; MAF + AOAI direct in Gov

**Status:** Accepted
**Date:** 2026-05-22

## Context

The Loom Setup Wizard + Loom Copilot need an agent orchestration
layer that:
1. Manages conversation threads with the user
2. Invokes MCP tools (Azure MCP server, Azure Bicep MCP)
3. Renders the live `.bicepparam` preview during deploy
4. Streams progress narratively during deployment
5. Surfaces NL2SQL / NL2DAX / NL2KQL tools for Loom Data Agents at
   runtime
6. Works in every supported audit boundary

Per `temp/fiab-research/06-copilot-driven-deploy.md`:

- **Azure AI Foundry Agent Service** GA'd in Commercial Azure on
  2026-03-16. Hosts agents server-side; manages thread persistence;
  Entra Agent ID as first-class identity; native MCP tool support;
  Foundry Toolboxes (preview).
- **In Azure Government**, Foundry Agent Service has **no confirmed
  single Gov-wide GA**. Microsoft says "model and tool availability
  varies by region" within Gov.
- **Underlying Azure OpenAI** is fully authorized across FedRAMP High
  + DoD IL4 + IL5 + IL6 + Top Secret. GPT-4o / GPT-4.1 / o3-mini /
  GPT-5.1 in usgovvirginia + usgovarizona.
- **Microsoft Agent Framework 1.0** (April 2026 release; SK +
  AutoGen successor) is a library, deployable anywhere, with native
  MCP client.

## Decision

**Two-tier orchestration sharing the same Next.js Console front-end
and the same self-hosted Azure MCP server backend:**

### Tier A — Commercial / GCC

```
Loom Console (/setup route)
   │
   │ SSE chat stream
   ▼
Foundry Agent Service (e.g. eastus2)
   • Agent: "loom-deploy-agent"
   • Tools:
     - MCP tool → self-hosted Azure MCP Server
     - MCP tool → Azure Bicep MCP server
     - Function tool → render_bicepparam(answers)
     - Function tool → submit_deployment(template, params, sub)
     - Function tool → poll_deployment(opId)
     - Function tool → activate_pim_for_group(group, scope, hours)
   • Thread persistence: managed by Agent Service
   • Identity: Entra Agent ID + UAMI
```

### Tier B — GCC-High / IL5 (and Gov-IL4 fallback if Foundry isn't yet GA there)

```
Loom Console (/setup route)
   │
   ▼
Loom Setup Orchestrator (Container App / AKS workload, .NET 10 or Python 3.12)
   • Microsoft Agent Framework 1.0
   • Azure OpenAI Gov endpoint (gpt-4o or gpt-4.1 in usgovvirginia)
   • MCP client → self-hosted Azure MCP Server (sidecar or separate workload)
   • Plugins: BicepRenderer, ArmDeployer (uses @azure/arm-resources direct)
   • Thread state: Cosmos DB session container (BYO state persistence)
```

The Next.js Console **interaction surface is identical** in both
tiers — same `/setup` route, same SSE stream, same `.bicepparam`
preview pane, same confirm gate, same progress narration. Only the
orchestration layer behind the API swaps.

Boundary auto-detection: at runtime, the Console reads
`environment().name` and selects which tier to call.

The **Loom Copilot runtime** (the chat sidebar across all Console
panes) uses the same orchestration pattern — Tier A or Tier B based
on boundary.

## Consequences

### Positive

- Same UX across Commercial + Gov — no separate product
- Tier B uses MAF library which is trivially deployable in Gov
  (it's just an SDK pointed at the Gov AOAI endpoint)
- Foundry Agent Service in Commercial gets server-side thread
  persistence + hosted MCP + Foundry portal observability + Entra
  Agent ID — full SaaS-feel
- Forward-compatible: when Foundry Agent Service Gov-GAs, Gov
  customers can opt-in to Tier A; Tier B remains for orgs that prefer
  library-mode

### Negative

- Two orchestrator implementations to maintain (Foundry SDK and MAF)
- Tier B needs to implement thread persistence in Cosmos DB
  (Foundry handles this server-side in Tier A)
- Tier B requires the MCP client to be configured in MAF (not as
  polished as Foundry's native MCP tool registration)

### Neutral

- The MCP server itself + Azure Bicep MCP + ARM client are identical
  in both tiers — only the orchestrator wraps them differently
- Both tiers stream via SSE to the same Next.js client component;
  no client-side branching

## Alternatives considered

| Alternative | Why not chosen |
|---|---|
| Foundry Agent Service only | Gov-GA unconfirmed; can't ship to GCC-High / IL5 without a fallback |
| MAF only (skip Foundry) | Misses the polished Foundry portal observability + Entra Agent ID + Toolboxes (preview) in Commercial |
| Semantic Kernel only | SK is supported but MAF (April 2026) is the unified successor; new code should target MAF |
| OpenAI Agents SDK | Wire-compatible with Foundry's Responses API; doesn't add value over Foundry directly |
| Custom orchestrator (no framework) | Reinvents agent loop semantics; harder to swap models / providers |

## References

- PRD: [`temp/fiab-prd/06-custom-apps.md`](../../../temp/fiab-prd/06-custom-apps.md) §6.2, [`07-deployment.md`](../../../temp/fiab-prd/07-deployment.md)
- Research: [`temp/fiab-research/06-copilot-driven-deploy.md`](../../../temp/fiab-research/06-copilot-driven-deploy.md)
- External: [Foundry Agent Service overview](https://learn.microsoft.com/azure/foundry/agents/overview), [MAF launch](https://devblogs.microsoft.com/agent-framework/), [Foundry region support](https://learn.microsoft.com/azure/foundry/reference/region-support)
- Build: PRP-04 — `apps/fiab-setup-orchestrator/` + Console `/setup` route
