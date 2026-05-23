# Loom Setup Wizard

The Loom Setup Wizard is the conversational deployment surface. It
greets the customer, interviews about environment, renders the
`.bicepparam` live in a right-pane preview, validates via Azure Bicep
MCP, then calls Azure ARM through the self-hosted Azure MCP server
to deploy. Progress streams back to chat narratively; next steps are
narrated post-deploy.

## Where it lives

Per [ADR fiab-0008 deployment shape](../adr/0008-deployment-shape.md)
+ [AMENDMENTS A8](https://github.com/fgarofalo56/csa-inabox/blob/csa-loom-pillar/temp/fiab-prd/AMENDMENTS.md), the Wizard
is a route inside the deployed Loom Console at `/setup` — reached
**after** the initial `azd up` or Deploy-to-Azure button install
completes.

The Wizard's job is **adding additional DLZs** + **changing major
configuration** post-initial-deploy. The first DLZ comes up as part of
the initial install; subsequent DLZs (when the customer onboards a
new agency / domain) come up via the Wizard.

## Two-tier orchestration

Per [ADR fiab-0009 Copilot orchestration](../adr/0009-copilot-orchestration.md):

### Tier A — Commercial / GCC

- **Foundry Agent Service** (GA Mar 2026) hosts the
  `loom-deploy-agent`
- Tools: MCP server (Azure MCP + Azure Bicep MCP), function tools
  (`render_bicepparam`, `submit_deployment`, `poll_deployment`,
  `activate_pim_for_group`)
- Thread persistence managed by Agent Service
- Identity: Entra Agent ID + UAMI

### Tier B — GCC-High / IL5

- **Loom Setup Orchestrator** (.NET 10 Container App / AKS workload)
  running Microsoft Agent Framework 1.0
- Azure OpenAI Gov endpoint (gpt-4o or gpt-4.1 in usgovvirginia)
- MCP client → self-hosted Azure MCP Server
- Plugins: BicepRenderer, ArmDeployer
- Thread state: Cosmos DB session container

The Console front-end is **identical** between tiers — same `/setup`
route, same SSE stream, same UX. Only the orchestrator differs.

## Conversation flow

```
Greet
  → Environment metadata (4-6 turns):
      - Target Entra tenant ID
      - Target subscription IDs (single-sub vs multi-sub)
      - Azure region (boundary-aware allow-list)
      - Audit boundary (Commercial / GCC / GCC-High / IL5)
      - Capacity SKU (F4 trial / F8 / F32 / F64 / F128 / F512)
  → Workload selection (1 turn):
      - Pre-checked: Databricks, Synapse Serverless, ADX, Power BI,
        Purview, AOAI, AI Search, MCP, Console
      - Optional: SHIR for on-prem, Confidential Compute, custom domain
  → Networking + Identity (2 turns):
      - Hub-spoke topology (default yes)
      - ER / VPN gateway
      - VNet CIDR ranges (auto-suggest if blank)
      - Admin Entra group object ID(s)
      - Domain Stewards groups (multi-sub)
  → Naming convention (1 turn):
      - CAF abbreviations (default) or custom prefix
  → Live .bicepparam preview (continuous):
      - Right pane shows assembled .bicepparam live
      - User can hover any line for explanation
      - User can directly edit; wizard re-validates
  → Validation (Bicep MCP snapshot)
  → Confirm gate
      - User clicks "Deploy" or types "deploy"
  → Deploy + stream progress
      - Wizard activates PIM-for-Groups → Contributor on target sub (2h)
      - submit_deployment via MCP
      - Poll deployment status; narrate progress to chat
  → Narrate next steps
      - "Your DLZ is live. Want to create your first workspace?"
```

## Error handling

On deployment `Failed` state:
- Wizard reads the error from ARM
- Proposes a fix ("VNet CIDR conflicts with existing peering; want
  me to suggest 10.10.0.0/16 instead?")
- User can approve the fix or edit manually
- Wizard rolls forward (resumes from failed step) or rolls back
  (deletes partial resources via MCP)

## Identity model

Per [Reference architecture §4.6](../architecture.md) JIT elevation
flow:

1. User confirms deploy
2. Wizard activates **PIM-for-Groups** membership of `Loom MCP
   Operators` → grants Contributor on target sub
   - Justification: SHA-256 of the rendered `.bicepparam`
   - End time: now + 2 hours
3. Wizard submits deployment as MCP MI
4. ARM provisions
5. Wizard reduces MCP MI scope from sub-level to RG-level on new
   Loom RGs
6. PIM membership expires

## Related

- ADR: [fiab-0009 Copilot orchestration](../adr/0009-copilot-orchestration.md), [fiab-0008 Deployment shape](../adr/0008-deployment-shape.md)
- Build PRP: PRP-04 — Loom Setup Wizard
- MCP server: [MCP troubleshooting runbook](../runbooks/mcp-troubleshooting.md)
- Deployment: [Deployment overview](../deployment/index.md)
