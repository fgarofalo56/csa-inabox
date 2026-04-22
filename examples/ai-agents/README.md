# AI Agent Examples

Example applications demonstrating how to build AI agents with Azure AI Foundry and Semantic Kernel for the CSA-in-a-Box platform.

## Examples

### 1. Data Analyst Agent (`data-analyst-agent/`)

Single agent with CSA platform plugins for querying data and assessing quality.

```bash
cd examples/ai-agents/data-analyst-agent
python agent.py
```

**Demonstrates:**
- `ChatCompletionAgent` with GPT-5.4
- Custom SK plugins (DataQueryPlugin, QualityPlugin)
- Interactive chat with tool calling
- `DefaultAzureCredential` authentication

### 2. Multi-Agent Governance Review (`multi-agent-governance/`)

Three agents collaborating via `GroupChatOrchestration` to review a data product:
- **DataAnalyst** — searches catalog, traces lineage
- **QualityReviewer** — runs quality assessment suites
- **GovernanceOfficer** — validates contracts, renders verdict

```bash
cd examples/ai-agents/multi-agent-governance
python team.py "gold.finance.revenue_summary"
```

**Demonstrates:**
- `GroupChatOrchestration` with `RoundRobinGroupChatManager`
- Multi-agent collaboration with role specialization
- `InProcessRuntime` for agent execution
- Agent response callbacks for real-time output

### 3. Hosted Agent (`hosted-agent/`)

Containerized agent deployed to Azure AI Foundry Agent Service.

```bash
# Build and deploy
docker build -t csa-hosted-agent .
az acr login --name <registry>
docker tag csa-hosted-agent <registry>.azurecr.io/csa-hosted-agent:v1
docker push <registry>.azurecr.io/csa-hosted-agent:v1
```

**Demonstrates:**
- Agent containerization with Docker
- Azure Container Registry push
- Foundry Agent Service deployment
- MCP tool connections

## Prerequisites

```bash
pip install semantic-kernel[azure] azure-identity azure-ai-projects
```

Environment variables:
```bash
export AZURE_OPENAI_ENDPOINT="https://<your-openai>.openai.azure.com/"
```

## Tutorial

See [docs/tutorials/07-agents-foundry-sk/](../../docs/tutorials/07-agents-foundry-sk/) for the complete step-by-step tutorial.
