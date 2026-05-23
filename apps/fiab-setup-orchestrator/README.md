# Loom Setup Orchestrator (Tier B — Gov MAF orchestrator)

The Tier B orchestration backend for the Loom Setup Wizard + Loom
Copilot runtime in **GCC-High / IL5** (where Foundry Agent Service
isn't Gov-GA confirmed).

In Commercial / GCC, the wizard front-end calls **Foundry Agent
Service** directly — this orchestrator only deploys for the
GCC-High / IL5 boundaries.

**Public brand**: Loom Setup Orchestrator (this dir uses
`fiab-setup-orchestrator` as repo-internal nickname).

## Status

**SCAFFOLDED.** Real implementation per [PRP-04](../../PRPs/active/csa-loom/PRP-04-setup-wizard.md)
+ [ADR fiab-0009](../../docs/fiab/adr/0009-copilot-orchestration.md).

## Tech stack

- .NET 10 + Microsoft Agent Framework 1.0 (April 2026 release)
- Azure OpenAI Gov endpoint (gpt-4o in usgovvirginia)
- MCP client → self-hosted Azure MCP Server
- Plugins:
  - BicepRenderer (deterministic function: answers → .bicepparam)
  - ArmDeployer (uses @azure/arm-resources directly)
- Thread state: Cosmos DB session container
- Container Apps (Commercial / GCC) or AKS (GCC-H / IL5)

## Scaffolded structure

```
apps/fiab-setup-orchestrator/
├── README.md
├── Dockerfile
├── Program.cs
├── ChatHandler/
│   └── ConversationFlow.cs
├── Plugins/
│   ├── BicepRenderer.cs
│   └── ArmDeployer.cs
├── McpClient/
└── Tests/
```

## Build + run

Once implemented:
```bash
cd apps/fiab-setup-orchestrator
dotnet restore
dotnet build
dotnet run
```

Container image:
```bash
docker build -t fiab-setup-orchestrator .
docker run -p 5000:5000 fiab-setup-orchestrator
```

## Related

- [Setup Wizard docs](../../docs/fiab/console/setup-wizard.md)
- [PRP-04](../../PRPs/active/csa-loom/PRP-04-setup-wizard.md)
- ADR: [fiab-0009 Copilot orchestration](../../docs/fiab/adr/0009-copilot-orchestration.md)
- Research: [`temp/fiab-research/06-copilot-driven-deploy.md`](../../temp/fiab-research/06-copilot-driven-deploy.md)
