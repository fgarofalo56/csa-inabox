/**
 * Sovereign AI Agents — app-install content bundle.
 *
 * A turnkey **sovereign multi-agent governance** workspace built on the
 * Azure AI Foundry Agent Service *Standard agent setup* (BYO Azure Storage,
 * BYO Azure Cosmos DB, BYO Azure AI Search, Customer-Managed Keys, and
 * optional Bring-Your-Own virtual network). Standard setup keeps every byte
 * of agent state — threads, files, and vector stores — inside the tenant's
 * own Azure resources, which is the mechanism that delivers full data
 * sovereignty / data residency and CMK encryption for regulated and
 * sovereign-cloud deployments.
 *   - Standard agent setup (data sovereignty):
 *     https://learn.microsoft.com/azure/foundry/agents/concepts/standard-agent-setup
 *   - BYO virtual-network / private networking:
 *     https://learn.microsoft.com/azure/foundry/agents/how-to/virtual-networks
 *   - CMK + data residency (Foundry architecture):
 *     https://learn.microsoft.com/azure/foundry/concepts/architecture#data-storage
 *
 * The scenario is a **three-agent governance review** — a DataAnalyst, a
 * QualityReviewer, and a GovernanceOfficer collaborate (orchestrated by a
 * main Review Orchestrator) to render an auditable publication verdict on a
 * data product. This is the in-repo example at
 * examples/ai-agents/multi-agent-governance/team.py and its data-product
 * contract examples/ai-agents/contracts/multi-agent-governance.yaml, ported
 * to the Foundry Agent Service "connected agents" / workflow pattern:
 *   - Connected / multi-agent systems:
 *     https://learn.microsoft.com/azure/foundry/agents/how-to/connected-agents
 *
 * Five runnable surfaces ship on install, each with seeded sample data:
 *
 *   1. prompt-flow      `sovereign-governance-review` — a 6-node orchestrated
 *      multi-agent flow (input → analyst → quality → governance → verdict
 *      synthesis → human-in-the-loop gate / output). Read-only tool policy,
 *      human-in-the-loop required for APPROVED verdicts, max 12 turns,
 *      Content-Safety severity-max Medium — all carried verbatim from the
 *      contract's `policy` block. (Cosmos-only editor surface.)
 *
 *   2. ai-search-index  `governance-review-corpus` — BYO AI Search vector +
 *      keyword index that backs the agents' grounding (catalog entries,
 *      lineage, prior verdicts). HNSW 1536-dim text-embedding-3-small,
 *      tenant-isolation filter, seeded with 8 real-shaped governance
 *      documents. (Real `aiSearchProvisioner`.)
 *
 *   3. kql-database     `agent-audit` — the auditable transcript / decision
 *      store. AgentReviews (one row per verdict), AgentTurns (one row per
 *      agent message), and ToolCalls (one row per tool invocation), plus
 *      two functions (review_verdicts, agent_cost_rollup), retention/caching
 *      policies, and 5 starter compliance queries. Seeded with real-shaped
 *      sample rows. (Real `kqlDatabaseProvisioner`.)
 *
 *   4. evaluation       `sovereign-agent-quality` — an 8-metric suite:
 *      verdict-accuracy, groundedness, tool-policy-adherence,
 *      human-in-loop-coverage, transcript-completeness, data-residency-pass,
 *      cost-per-review, p95-latency — with a pre-populated baseline run.
 *      (Cosmos-only editor surface.)
 *
 *   5. notebook         `Sovereign Agents Walkthrough` — a runnable Foundry
 *      Agent Service walkthrough: stand up the three connected agents on a
 *      standard (BYO) project, run a governance review, persist the
 *      transcript to the agent-audit ADX DB, then score it with the
 *      evaluation suite. (Real `notebookProvisioner`.)
 *
 * Parity doc: docs/fiab/parity/sovereign-ai-agents.md
 */
import type { AppBundle } from './types';

// ─── Governance review system prompt (orchestrator) ─────────────────────
// Carries the contract's policy verbatim: read-only tools, human-in-loop
// for approvals, max 12 turns, deny write/publish/exec tools.

const ORCHESTRATOR_SYSTEM_PROMPT = `You are the Review Orchestrator for a SOVEREIGN multi-agent data-product
governance review running entirely inside the tenant's own Azure boundary
(Azure AI Foundry Agent Service, Standard setup, BYO Cosmos / Storage / AI
Search, Customer-Managed Keys). You coordinate three specialist connected
agents and render a single auditable verdict.

CONNECTED AGENTS
- DataAnalyst       — searches the catalog, traces lineage. Tools:
                      search_catalog, get_lineage.
- QualityReviewer   — runs the quality suite, flags failing metrics. Tool:
                      assess_quality.
- GovernanceOfficer — validates the data contract, weighs analyst + quality
                      findings, proposes the verdict. Tool: validate_contract.

VERDICT VOCABULARY (exactly one)
  APPROVED | APPROVED_WITH_CONDITIONS | REJECTED | INCONCLUSIVE

HARD POLICY (from the data-product contract — NEVER override)
- READ-ONLY. Allowed tools: search_catalog, get_lineage, assess_quality,
  validate_contract. DENIED tools: write_catalog, publish_data_product,
  exec_sql. If any agent proposes a write/publish/exec action, refuse and
  record it as a policy violation.
- HUMAN-IN-THE-LOOP IS REQUIRED before any APPROVED or
  APPROVED_WITH_CONDITIONS verdict is final. Emit the verdict as 'proposed'
  and set requires_human_approval=true; a human reviewer must confirm.
- At most 12 turns total. If consensus is not reached by turn 12, return
  INCONCLUSIVE with the open questions.
- Content Safety severity-max = Medium on every agent message.

SOVEREIGNTY
- Never call a tool, model, or endpoint outside the tenant's Azure region.
- Never emit raw PII. Catalog rows carrying PII classifications must be
  referenced by asset name + classification label only.
- Every decision must be fully reconstructable from the persisted transcript
  (AgentTurns) and tool calls (ToolCalls) in the agent-audit ADX database.

OUTPUT
- A JSON object: { verdict, requires_human_approval, conditions[],
  rejection_reasons[], findings_summary, turn_count, tools_used[],
  policy_violations[] }.`;

// ─── AI Search grounding corpus — seed governance documents ─────────────

const GOV_DOC_1 = `The Sovereign AI Agents app runs the governance review on the Azure AI \
Foundry Agent Service Standard setup. In Standard setup all agent state — \
conversation threads, uploaded files, and vector stores — is stored in the \
tenant's OWN Azure resources: Azure Cosmos DB (threads + conversation \
history), Azure Storage (files + attachments), and Azure AI Search (vector \
stores). This is the mechanism that delivers data sovereignty and data \
residency: nothing leaves the tenant's subscription, and the Foundry \
endpoint is regional so data lives in the same region as the endpoint.`;

const GOV_DOC_2 = `Customer-Managed Keys (CMK) are supported on the Standard agent setup \
(Basic setup is Microsoft-managed keys only). To enable CMK, deploy an \
Azure Key Vault in the same region as the Foundry resource with soft-delete \
and purge-protection ON, and grant the Foundry managed identity the Key \
Vault Crypto User role. All customer data at rest is then encrypted under \
the tenant's own key, satisfying sovereign-cloud and regulated-industry \
encryption mandates.`;

const GOV_DOC_3 = `For the strictest isolation, the Standard setup supports Bring-Your-Own \
virtual network (private networking). The platform injects agent compute \
into a delegated subnet (delegated to Microsoft.App/environments, /27 or \
larger), public egress is disabled, and inbound access is locked behind a \
private endpoint on the Foundry account. Private endpoints to the BYO \
Azure AI Search, Azure Storage, and Azure Cosmos DB must be created \
separately. The result is no public egress and no data exfiltration path.`;

const GOV_DOC_4 = `The governance review is a three-agent collaboration: DataAnalyst, \
QualityReviewer, and GovernanceOfficer, coordinated by a Review \
Orchestrator. The DataAnalyst uses search_catalog and get_lineage to locate \
the product and trace its upstream/downstream. The QualityReviewer runs \
assess_quality (completeness, accuracy, timeliness, consistency) against \
the gold-layer gate. The GovernanceOfficer runs validate_contract and \
renders the verdict. Connected agents let a main agent delegate to \
purpose-built sub-agents without a hand-coded orchestrator.`;

const GOV_DOC_5 = `The data-product contract pins the agent policy: read_only=true, \
human_in_loop_required=true, human_in_loop_for_verdicts=[APPROVED, \
APPROVED_WITH_CONDITIONS], allowed_tools=[search_catalog, get_lineage, \
assess_quality, validate_contract], denied_tools=[write_catalog, \
publish_data_product, exec_sql], max_turns=12, \
content_safety_severity_max=Medium. The review output is auditable: the \
full transcript is persisted, with turn_count, tokens, and a cost estimate, \
and quality rules constrain verdict to the allowed set and turn_count to \
1..12.`;

const GOV_DOC_6 = `A worked verdict: review of gold.finance.revenue_summary. The \
QualityReviewer's assess_quality returned Completeness 92.1% (pass), \
Accuracy 88.5% (pass), Timeliness 78.3% (FAIL — 26h since refresh against a \
24h SLA), Consistency 91.0% (pass), overall 87.5% over an 80% gate (pass \
with warnings). The GovernanceOfficer's validate_contract found 5/6 checks \
passing with cost_center missing. Verdict: APPROVED_WITH_CONDITIONS — fix \
timeliness (adjust pipeline schedule) and add the cost_center field before \
marketplace publication. Because the verdict is an approval, it required \
human confirmation before becoming final.`;

const GOV_DOC_7 = `Tool-call governance is enforced at the orchestrator. Each agent may only \
invoke its allow-listed read tools; any attempt to invoke write_catalog, \
publish_data_product, or exec_sql is refused and recorded as a \
policy_violation in the transcript. This guarantees the review can never \
mutate the catalog or publish a product on its own — publication is always \
a separate, human-authorized step. The denied-tool list is the technical \
control behind the "agents advise, humans decide" sovereignty posture.`;

const GOV_DOC_8 = `Auditability lands in the agent-audit Azure Data Explorer database. \
AgentReviews holds one row per completed review (review_id, verdict, \
requires_human_approval, turn_count, token totals, cost_usd_estimate). \
AgentTurns holds one row per agent message (review_id, turn_index, agent, \
content, tokens_in/out). ToolCalls holds one row per tool invocation \
(review_id, agent, tool, args_redacted, allowed, latency_ms). Compliance \
queries roll these up into verdict distributions, per-review cost, \
policy-violation counts, and human-approval coverage.`;

// ─── KQL functions for the agent-audit DB ───────────────────────────────

const KQL_FN_VERDICTS = `// Verdict distribution over a window, with the share that required (and
// received) human approval. Powers the governance dashboard + the
// human-in-loop-coverage evaluation metric.
//
// Usage:  review_verdicts(ago(30d), now())
.create-or-alter function review_verdicts(StartTime: datetime = datetime(null),
                                          EndTime:   datetime = datetime(null))
{
    let _start = iff(isnull(StartTime), ago(30d), StartTime);
    let _end   = iff(isnull(EndTime),   now(),    EndTime);
    AgentReviews
    | where completed_at between (_start .. _end)
    | summarize
        reviews              = count(),
        required_human       = countif(requires_human_approval == true),
        human_confirmed      = countif(requires_human_approval == true and human_approved == true),
        avg_turns            = avg(turn_count),
        avg_cost_usd         = avg(cost_usd_estimate)
        by verdict
    | extend human_loop_coverage = iff(required_human == 0, 1.0,
                                       round(1.0 * human_confirmed / required_human, 4))
    | order by reviews desc
}`;

const KQL_FN_COST = `// Per-review token + cost rollup, joining the review header to its turns.
// Backs the cost-per-review evaluation metric and the FinOps view of the
// agent fleet. Flags reviews that breached the contract's 12-turn ceiling.
.create-or-alter function agent_cost_rollup(StartTime: datetime = datetime(null))
{
    let _start = iff(isnull(StartTime), ago(7d), StartTime);
    AgentReviews
    | where completed_at > _start
    | join kind=leftouter (
        AgentTurns
        | summarize turn_rows = count(),
                    turn_tokens_in  = sum(tokens_in),
                    turn_tokens_out = sum(tokens_out)
            by review_id
      ) on review_id
    | extend over_turn_budget = turn_count > 12
    | project review_id, data_product, verdict, turn_count, over_turn_budget,
              tokens_in_total, tokens_out_total, cost_usd_estimate,
              completed_at
    | order by cost_usd_estimate desc
}`;

// ─── Starter compliance KQL queries ─────────────────────────────────────

const KQL_Q_VERDICTS = `// Verdict distribution + human-in-the-loop coverage over the last 30 days.
review_verdicts(ago(30d), now())`;

const KQL_Q_VIOLATIONS = `// Policy violations: any attempt by an agent to call a DENIED tool
// (write_catalog, publish_data_product, exec_sql). These should be rare —
// a spike means a prompt regression weakened the read-only guardrail.
ToolCalls
| where event_time > ago(30d)
| where allowed == false
| summarize attempts = count(), tools = make_set(tool)
    by review_id, agent
| order by attempts desc`;

const KQL_Q_UNAPPROVED = `// Approvals still awaiting human confirmation — these verdicts are
// PROPOSED, not final, and block publication until a human signs off.
AgentReviews
| where verdict in ('APPROVED', 'APPROVED_WITH_CONDITIONS')
  and requires_human_approval == true
  and human_approved != true
| project review_id, data_product, verdict, completed_at,
          age = datetime_diff('hour', now(), completed_at)
| order by age desc`;

const KQL_Q_COST = `// Top 25 most expensive reviews in the last 7 days, with turn-budget flag.
agent_cost_rollup(ago(7d))
| take 25`;

const KQL_Q_TRANSCRIPT = `// Full reconstructable transcript for a single review — the audit artifact.
// Replace the review_id with the one under audit.
let _review = 'rev-2026-05-30-0007';
AgentTurns
| where review_id == _review
| order by turn_index asc
| project turn_index, agent, content, tokens_in, tokens_out, turn_time`;

// ─── Notebook source cells (Foundry Agent Service walkthrough) ──────────

const NB_INTRO = `# Sovereign AI Agents — End-to-End Walkthrough

This notebook stands up the **three-agent governance review** on the Azure
AI Foundry Agent Service **Standard setup** (Bring-Your-Own Cosmos DB,
Storage, and AI Search; Customer-Managed Keys; optional BYO virtual network)
and runs one review end-to-end:

1. Confirm the project is a **standard** (data-sovereign) project
2. Create the three connected agents (DataAnalyst, QualityReviewer,
   GovernanceOfficer) + a Review Orchestrator
3. Run a governance review of \`gold.finance.revenue_summary\`
4. Persist the transcript to the \`agent-audit\` ADX database
5. Score the review with the \`sovereign-agent-quality\` evaluation suite

> **Sovereignty note.** In Standard setup all agent state (threads, files,
> vector stores) is stored in *your* Azure resources, in *your* region,
> encrypted under *your* CMK. Nothing leaves the tenant boundary. See
> https://learn.microsoft.com/azure/foundry/agents/concepts/standard-agent-setup`;

const NB_SETUP = `# Imports + environment. Authentication is via the Loom container app's
# managed identity (DefaultAzureCredential). No keys on disk.
import os, json, time, uuid

from azure.identity import DefaultAzureCredential
from azure.ai.projects import AIProjectClient
from azure.ai.agents.models import ConnectedAgentTool, MessageRole

PROJECT_ENDPOINT = os.environ["AZURE_AI_PROJECT_ENDPOINT"]   # standard (BYO) project
MODEL_DEPLOYMENT = os.environ.get("AZURE_OPENAI_DEPLOYMENT", "gpt-4o")
TENANT_ID        = os.environ.get("LOOM_TENANT_ID", "tenant-demo")

credential = DefaultAzureCredential()
project = AIProjectClient(endpoint=PROJECT_ENDPOINT, credential=credential)
print(f"Connected to Foundry project: {PROJECT_ENDPOINT}")`;

const NB_VERIFY_SOVEREIGN = `# 0 — Confirm this is a STANDARD (data-sovereign) project, not Basic.
# Standard setup keeps threads in BYO Cosmos, files in BYO Storage, and
# vector stores in BYO AI Search. We verify the three BYO connections exist
# before creating any agent so we never accidentally run on Microsoft-managed
# multitenant storage.
required = {
    "cosmos":  os.environ.get("LOOM_AGENT_COSMOS_ACCOUNT"),
    "storage": os.environ.get("LOOM_AGENT_STORAGE_ACCOUNT"),
    "search":  os.environ.get("LOOM_AI_SEARCH_SERVICE"),
}
missing = [k for k, v in required.items() if not v]
assert not missing, (
    f"Standard (sovereign) setup requires BYO resources; missing: {missing}. "
    "Set LOOM_AGENT_COSMOS_ACCOUNT / LOOM_AGENT_STORAGE_ACCOUNT / "
    "LOOM_AI_SEARCH_SERVICE, or the agents will fall back to Microsoft-managed "
    "storage and you lose data sovereignty."
)
print("Standard setup verified — all agent state stays in-tenant:", required)`;

const NB_CREATE_AGENTS = `# 1 — Create the three connected specialist agents + the orchestrator.
# Each specialist gets only its read-only allow-listed tools; the
# orchestrator delegates to them via ConnectedAgentTool.

analyst = project.agents.create_agent(
    model=MODEL_DEPLOYMENT, name="DataAnalyst",
    instructions=("You examine a data product. Use search_catalog to find it "
                  "and get_lineage to trace upstream/downstream. Be factual. "
                  "READ-ONLY: never propose write/publish/exec actions."),
    # tools=[search_catalog_tool, get_lineage_tool]
)
quality = project.agents.create_agent(
    model=MODEL_DEPLOYMENT, name="QualityReviewer",
    instructions=("You run assess_quality on the product. Report completeness, "
                  "accuracy, timeliness, consistency vs the gold gate. Flag "
                  "failing metrics with exact scores + thresholds."),
    # tools=[assess_quality_tool]
)
governance = project.agents.create_agent(
    model=MODEL_DEPLOYMENT, name="GovernanceOfficer",
    instructions=("You validate_contract and render a verdict: APPROVED, "
                  "APPROVED_WITH_CONDITIONS, REJECTED, or INCONCLUSIVE. "
                  "Approvals require human confirmation; emit them as proposed."),
    # tools=[validate_contract_tool]
)

orchestrator = project.agents.create_agent(
    model=MODEL_DEPLOYMENT, name="ReviewOrchestrator",
    instructions=open_orchestrator_prompt(),  # the bundled system prompt
    tools=[
        ConnectedAgentTool(id=analyst.id,    name=analyst.name,    description="Catalog search + lineage").definitions[0],
        ConnectedAgentTool(id=quality.id,    name=quality.name,    description="Quality assessment").definitions[0],
        ConnectedAgentTool(id=governance.id, name=governance.name, description="Contract validation + verdict").definitions[0],
    ],
)
print(f"Created orchestrator {orchestrator.id} + 3 connected agents.")`;

const NB_RUN_REVIEW = `# 2 — Run one governance review. The orchestrator delegates to each
# connected agent (read-only tools only), then renders the verdict. Per the
# contract policy, APPROVED* verdicts come back as proposed + requires
# human approval (max 12 turns, Content Safety severity-max Medium).
thread = project.agents.threads.create()
project.agents.messages.create(
    thread_id=thread.id, role=MessageRole.USER,
    content="Review data product 'gold.finance.revenue_summary' for publication.",
)
run = project.agents.runs.create_and_process(thread_id=thread.id, agent_id=orchestrator.id)

messages = list(project.agents.messages.list(thread_id=thread.id))
verdict = json.loads(messages[-1].text_messages[-1].text.value)
print(json.dumps(verdict, indent=2))
assert verdict["verdict"] in ("APPROVED","APPROVED_WITH_CONDITIONS","REJECTED","INCONCLUSIVE")
if verdict["verdict"].startswith("APPROVED"):
    assert verdict["requires_human_approval"] is True, "Approvals MUST require human-in-the-loop"`;

const NB_PERSIST = `# 3 — Persist the transcript to the agent-audit ADX database so the review
# is fully reconstructable (compliance requirement). We write one
# AgentReviews header row + one AgentTurns row per message via the Loom BFF,
# which holds the AllDatabasesAdmin-scoped managed identity.
import urllib.request
LOOM_BFF = os.environ.get("LOOM_BFF_BASE", "https://loom.example.com")

review_id = f"rev-{time.strftime('%Y-%m-%d')}-{uuid.uuid4().hex[:4]}"
payload = {
    "tenantId": TENANT_ID,
    "review_id": review_id,
    "data_product": "gold.finance.revenue_summary",
    "verdict": verdict["verdict"],
    "requires_human_approval": verdict["requires_human_approval"],
    "turns": [
        {"turn_index": i, "agent": m.role, "content": (m.text_messages[-1].text.value if m.text_messages else "")}
        for i, m in enumerate(messages)
    ],
}
req = urllib.request.Request(
    f"{LOOM_BFF}/api/items/kql-database/agent-audit/ingest",
    method="POST", headers={"Content-Type": "application/json"},
    data=json.dumps(payload).encode(),
)
with urllib.request.urlopen(req, timeout=30) as resp:
    print("Persisted:", json.loads(resp.read()))`;

const NB_EVALUATE = `# 4 — Score the review with the sovereign-agent-quality evaluation suite.
# Same JSON the Loom evaluation editor renders into its score cards.
req = urllib.request.Request(
    f"{LOOM_BFF}/api/items/evaluation/sovereign-agent-quality/run",
    method="POST", headers={"Content-Type": "application/json"},
    data=json.dumps({"datasetRef": "sovereign-agent-eval-seed", "tenantId": TENANT_ID,
                     "reviewId": review_id}).encode(),
)
with urllib.request.urlopen(req, timeout=120) as resp:
    ev = json.loads(resp.read())
print(json.dumps(ev["results"], indent=2))
print("verdict_accuracy   >= 0.90 ?", ev["results"]["verdict_accuracy"]      >= 0.90)
print("tool_policy        == 1.00 ?", ev["results"]["tool_policy_adherence"] == 1.00)
print("human_loop_cov     == 1.00 ?", ev["results"]["human_in_loop_coverage"] == 1.00)
print("data_residency     == 1.00 ?", ev["results"]["data_residency_pass"]   == 1.00)`;

const NB_NEXT = `## What to try next

- **Tighten the policy.** Edit the orchestrator system prompt in the
  \`sovereign-governance-review\` prompt-flow editor to require *two* human
  approvers for REJECTED-overrides, then re-run cell 4 — \`human_in_loop_coverage\`
  must stay 1.00.
- **Add a connected agent.** A \`CostSentinel\` agent that runs
  \`agent_cost_rollup\` and vetoes reviews projected over budget.
- **Audit a real review.** Run the "Full reconstructable transcript" starter
  query in the \`agent-audit\` ADX database against any \`review_id\`.
- **Go fully private.** Move the project to Standard + BYO virtual network
  (private endpoints on Cosmos / Storage / AI Search, public egress disabled)
  per https://learn.microsoft.com/azure/foundry/agents/how-to/virtual-networks`;

// ─── Bundle ─────────────────────────────────────────────────────────────

const bundle: AppBundle = {
  appId: 'app-sovereign-ai-agents',
  intro: `# Sovereign AI Agents

A turnkey **sovereign multi-agent governance** workspace on the Azure AI
Foundry Agent Service **Standard setup** — Bring-Your-Own Cosmos DB,
Storage, and AI Search, Customer-Managed Keys, and optional BYO virtual
network. Every byte of agent state (threads, files, vector stores) stays
inside your Azure boundary, in your region, under your key. That is what
makes the agents *sovereign*.

The scenario is a **three-agent governance review**: a DataAnalyst, a
QualityReviewer, and a GovernanceOfficer collaborate (via a Review
Orchestrator using Foundry connected agents) to render an **auditable
publication verdict** on a data product — read-only tools only, human in
the loop for every approval.

You get five runnable surfaces from the first install:

1. **Prompt-flow** \`sovereign-governance-review\` — 6-node orchestrated
   multi-agent flow. Read-only tool policy, human-in-the-loop required for
   approvals, 12-turn ceiling, Content-Safety severity-max Medium.
2. **AI Search index** \`governance-review-corpus\` — HNSW vector + keyword
   grounding corpus, 8 seed governance documents, tenant-isolation filter.
3. **KQL database** \`agent-audit\` — auditable transcript + decision store
   (AgentReviews / AgentTurns / ToolCalls) with verdict + cost rollup
   functions and 5 compliance queries. Seeded with sample rows.
4. **Evaluation** \`sovereign-agent-quality\` — 8 metrics incl.
   verdict-accuracy, tool-policy-adherence, human-in-loop-coverage,
   data-residency-pass. Baseline run pre-populated.
5. **Notebook** — a runnable Foundry Agent Service walkthrough: create the
   agents, run a review, persist the transcript, score it.

## Next steps

- Open the **prompt-flow** editor and review the orchestrator system prompt;
  it carries the contract's read-only + human-in-loop policy verbatim.
- Open the **agent-audit** KQL database and run the
  "Policy violations" and "Approvals awaiting human confirmation" queries.
- Open the **evaluation** editor and run \`sovereign-agent-quality\`. If
  \`tool_policy_adherence\` drops below 1.00, an agent attempted a denied
  (write/publish/exec) tool — revisit the orchestrator prompt.`,
  sourceDocs: [
    'examples/ai-agents/multi-agent-governance/team.py',
    'examples/ai-agents/contracts/multi-agent-governance.yaml',
    'examples/ai-agents/README.md',
    'examples/ai-agents/ARCHITECTURE.md',
    'https://learn.microsoft.com/azure/foundry/agents/concepts/standard-agent-setup',
    'https://learn.microsoft.com/azure/foundry/agents/how-to/virtual-networks',
    'https://learn.microsoft.com/azure/foundry/agents/how-to/connected-agents',
    'https://learn.microsoft.com/azure/foundry/concepts/architecture#data-storage',
    'docs/fiab/parity/sovereign-ai-agents.md',
  ],
  items: [
    // ─── 1. Prompt-flow: sovereign governance review ───────────────────
    {
      itemType: 'prompt-flow',
      displayName: 'Sovereign Governance Review',
      description:
        '6-node orchestrated multi-agent flow: input → DataAnalyst → QualityReviewer → GovernanceOfficer → verdict synthesis → human-in-the-loop gate. Read-only tools, human approval required for APPROVED verdicts, 12-turn ceiling, Content-Safety severity-max Medium.',
      learnDoc: 'sovereign-ai-agents/prompt-flow',
      content: {
        kind: 'prompt-flow',
        systemPrompt: ORCHESTRATOR_SYSTEM_PROMPT,
        nodes: [
          {
            id: 'node-input',
            kind: 'input',
            name: 'review_request',
            config: {
              schema: {
                data_product: { type: 'string', required: true, description: 'Fully-qualified product name, e.g. gold.finance.revenue_summary.' },
                tenantId: { type: 'string', required: true, description: 'Applied as the $filter tenant scope on every search_catalog / corpus call.' },
                requested_by_hash: { type: 'string', required: true, description: 'Pseudonymized requester id — never raw PII.' },
              },
              description:
                'Entry point. Validates the inbound review request. The requester is referenced only by hash to keep the sovereign no-raw-PII rule.',
            },
          },
          {
            id: 'node-analyst',
            kind: 'tool',
            name: 'DataAnalyst',
            config: {
              agentRole: 'connected-agent',
              model: 'gpt-4o',
              deployment: 'gpt-4o',
              endpointEnv: 'AZURE_AI_PROJECT_ENDPOINT',
              authMode: 'managed-identity',
              temperature: 0,
              allowedTools: ['search_catalog', 'get_lineage'],
              deniedTools: ['write_catalog', 'publish_data_product', 'exec_sql'],
              groundingIndex: 'governance-review-corpus',
              instructions:
                'Find the product in the catalog and trace its lineage. Report classifications + owner + upstream/downstream. READ-ONLY: refuse and flag any write/publish/exec request.',
              description:
                'DataAnalyst connected agent. Uses search_catalog + get_lineage against the BYO AI Search corpus. Output feeds the QualityReviewer and is recorded as AgentTurns.',
            },
          },
          {
            id: 'node-quality',
            kind: 'tool',
            name: 'QualityReviewer',
            config: {
              agentRole: 'connected-agent',
              model: 'gpt-4o',
              deployment: 'gpt-4o',
              endpointEnv: 'AZURE_AI_PROJECT_ENDPOINT',
              authMode: 'managed-identity',
              temperature: 0,
              allowedTools: ['assess_quality'],
              deniedTools: ['write_catalog', 'publish_data_product', 'exec_sql'],
              qualityGate: { completeness: 0.90, accuracy: 0.85, timeliness: 0.80, consistency: 0.85, overall: 0.80 },
              instructions:
                'Run assess_quality. Report completeness / accuracy / timeliness / consistency vs the gold gate, flag failing metrics with exact scores and thresholds, and recommend a fix for each failure.',
              description:
                'QualityReviewer connected agent. Runs the quality suite against the gold-layer gate (the same thresholds as the in-repo example). A failing metric becomes a verdict condition.',
            },
          },
          {
            id: 'node-governance',
            kind: 'tool',
            name: 'GovernanceOfficer',
            config: {
              agentRole: 'connected-agent',
              model: 'gpt-4o',
              deployment: 'gpt-4o',
              endpointEnv: 'AZURE_AI_PROJECT_ENDPOINT',
              authMode: 'managed-identity',
              temperature: 0.1,
              allowedTools: ['validate_contract'],
              deniedTools: ['write_catalog', 'publish_data_product', 'exec_sql'],
              verdictVocabulary: ['APPROVED', 'APPROVED_WITH_CONDITIONS', 'REJECTED', 'INCONCLUSIVE'],
              instructions:
                'Validate the data contract. Weigh the analyst + quality findings. Propose exactly one verdict from the vocabulary, with conditions (if APPROVED_WITH_CONDITIONS) or rejection_reasons (if REJECTED). Approvals are PROPOSED, never final.',
              description:
                'GovernanceOfficer connected agent. Runs validate_contract and proposes the verdict. Approvals are emitted as proposed so the human-in-loop gate downstream can require confirmation.',
            },
          },
          {
            id: 'node-synthesize',
            kind: 'llm',
            name: 'synthesize_verdict',
            config: {
              model: 'gpt-4o',
              deployment: 'gpt-4o',
              endpointEnv: 'AZURE_OPENAI_ENDPOINT',
              authMode: 'managed-identity',
              temperature: 0,
              max_tokens: 900,
              maxTurns: 12,
              system: '$ref:systemPrompt',
              contentSafety: { enabled: true, input: { severity_max: 'medium' }, output: { severity_max: 'medium', refuseOnViolation: true } },
              outputShape: {
                verdict: 'one of APPROVED | APPROVED_WITH_CONDITIONS | REJECTED | INCONCLUSIVE',
                requires_human_approval: 'true when verdict starts with APPROVED',
                conditions: 'string[]',
                rejection_reasons: 'string[]',
                findings_summary: 'string',
                turn_count: 'int (<= 12)',
                tools_used: 'string[]',
                policy_violations: 'string[] — any denied-tool attempt',
              },
              description:
                'Synthesis step. Folds the three agents’ findings into one structured, auditable verdict object per the orchestrator system prompt. Caps at 12 turns; returns INCONCLUSIVE if consensus is not reached.',
            },
          },
          {
            id: 'node-hitl',
            kind: 'output',
            name: 'human_in_the_loop_gate',
            config: {
              humanInLoop: {
                required: true,
                forVerdicts: ['APPROVED', 'APPROVED_WITH_CONDITIONS'],
                gateState: 'proposed',
                approverRole: 'Data Governance Approver',
                description:
                  'APPROVED / APPROVED_WITH_CONDITIONS verdicts are emitted as PROPOSED and block publication until a human approver confirms. REJECTED / INCONCLUSIVE are final and need no approval.',
              },
              persist: {
                target: 'kql-database',
                database: 'agent-audit',
                tables: ['AgentReviews', 'AgentTurns', 'ToolCalls'],
                description:
                  'The full transcript + every tool call is persisted to the agent-audit ADX database so the verdict is fully reconstructable for audit.',
              },
              telemetry: { appInsights: true, logFields: ['review_id', 'verdict', 'requires_human_approval', 'turn_count', 'tokens_in', 'tokens_out', 'cost_usd_estimate', 'policy_violations'] },
              description:
                'Final gate + sink. Enforces human-in-the-loop on approvals, persists the auditable transcript to ADX, and emits FinOps + policy telemetry to Application Insights.',
            },
          },
        ],
        edges: [
          { from: 'node-input', to: 'node-analyst' },
          { from: 'node-analyst', to: 'node-quality' },
          { from: 'node-quality', to: 'node-governance' },
          { from: 'node-governance', to: 'node-synthesize' },
          { from: 'node-synthesize', to: 'node-hitl' },
        ],
      },
    },

    // ─── 2. AI Search index: grounding corpus ──────────────────────────
    {
      itemType: 'ai-search-index',
      displayName: 'governance-review-corpus',
      description:
        'BYO Azure AI Search vector + keyword index backing the agents’ grounding (sovereignty model, agent roles, contract policy, prior verdicts). HNSW 1536-dim text-embedding-3-small, tenant-isolation filter. Seeded with 8 governance documents.',
      learnDoc: 'sovereign-ai-agents/ai-search-index',
      content: {
        kind: 'ai-search-index',
        schema: {
          fields: [
            { name: 'id', type: 'Edm.String', key: true, filterable: true },
            { name: 'tenantId', type: 'Edm.String', filterable: true },
            { name: 'title', type: 'Edm.String', searchable: true },
            { name: 'content', type: 'Edm.String', searchable: true },
            { name: 'category', type: 'Edm.String', filterable: true },
            { name: 'document_id', type: 'Edm.String', filterable: true },
            { name: 'source_url', type: 'Edm.String', filterable: true },
            { name: 'created_at', type: 'Edm.DateTimeOffset', filterable: true },
            { name: 'tags', type: 'Collection(Edm.String)', filterable: true },
            { name: 'embedding', type: 'Collection(Edm.Single)', searchable: true },
          ],
        },
        vectorConfig: { dimensions: 1536, algorithm: 'hnsw' },
        scoringProfiles: [
          {
            name: 'policy-boost',
            description:
              'Weights matches in the "policy" and "sovereignty" categories so the governance agents always retrieve the controlling rules (read-only tools, human-in-loop, CMK, BYO networking) before anecdotal prior-verdict docs.',
          },
        ],
        sampleDocs: [
          { id: 'gov-001-chunk-0', tenantId: 'tenant-demo', title: 'Standard setup = data sovereignty (BYO Cosmos/Storage/Search)', content: GOV_DOC_1, category: 'sovereignty', document_id: 'gov-001', source_url: 'https://learn.microsoft.com/azure/foundry/agents/concepts/standard-agent-setup', created_at: '2026-05-10T10:00:00Z', tags: ['sovereignty', 'standard-setup', 'byo', 'data-residency'] },
          { id: 'gov-002-chunk-0', tenantId: 'tenant-demo', title: 'Customer-Managed Keys on the Standard agent setup', content: GOV_DOC_2, category: 'sovereignty', document_id: 'gov-002', source_url: 'https://learn.microsoft.com/azure/foundry/concepts/architecture#data-storage', created_at: '2026-05-11T09:30:00Z', tags: ['sovereignty', 'cmk', 'key-vault', 'encryption'] },
          { id: 'gov-003-chunk-0', tenantId: 'tenant-demo', title: 'BYO virtual network / private networking', content: GOV_DOC_3, category: 'sovereignty', document_id: 'gov-003', source_url: 'https://learn.microsoft.com/azure/foundry/agents/how-to/virtual-networks', created_at: '2026-05-12T14:00:00Z', tags: ['sovereignty', 'private-network', 'byo-vnet', 'no-egress'] },
          { id: 'gov-004-chunk-0', tenantId: 'tenant-demo', title: 'The three-agent governance review topology', content: GOV_DOC_4, category: 'agents', document_id: 'gov-004', source_url: 'https://learn.microsoft.com/azure/foundry/agents/how-to/connected-agents', created_at: '2026-05-13T11:15:00Z', tags: ['agents', 'connected-agents', 'orchestration', 'roles'] },
          { id: 'gov-005-chunk-0', tenantId: 'tenant-demo', title: 'Data-product contract: agent policy', content: GOV_DOC_5, category: 'policy', document_id: 'gov-005', source_url: 'examples/ai-agents/contracts/multi-agent-governance.yaml', created_at: '2026-05-14T08:45:00Z', tags: ['policy', 'read-only', 'human-in-loop', 'allowed-tools'] },
          { id: 'gov-006-chunk-0', tenantId: 'tenant-demo', title: 'Worked verdict: gold.finance.revenue_summary', content: GOV_DOC_6, category: 'verdict', document_id: 'gov-006', source_url: 'examples/ai-agents/multi-agent-governance/team.py', created_at: '2026-05-20T16:20:00Z', tags: ['verdict', 'approved-with-conditions', 'quality', 'finance'] },
          { id: 'gov-007-chunk-0', tenantId: 'tenant-demo', title: 'Tool-call governance: denied write/publish/exec', content: GOV_DOC_7, category: 'policy', document_id: 'gov-007', source_url: 'examples/ai-agents/contracts/multi-agent-governance.yaml', created_at: '2026-05-15T13:00:00Z', tags: ['policy', 'denied-tools', 'guardrail', 'least-privilege'] },
          { id: 'gov-008-chunk-0', tenantId: 'tenant-demo', title: 'Auditability lands in the agent-audit ADX database', content: GOV_DOC_8, category: 'audit', document_id: 'gov-008', source_url: 'docs/fiab/parity/sovereign-ai-agents.md', created_at: '2026-05-16T10:30:00Z', tags: ['audit', 'adx', 'transcript', 'tool-calls'] },
        ],
      },
    },

    // ─── 3. KQL database: agent-audit ──────────────────────────────────
    {
      itemType: 'kql-database',
      displayName: 'agent-audit',
      description:
        'Auditable transcript + decision store for the governance agents. AgentReviews (one row per verdict), AgentTurns (one row per agent message), ToolCalls (one row per tool invocation). Includes review_verdicts + agent_cost_rollup functions and 5 compliance queries. Seeded with sample rows.',
      learnDoc: 'sovereign-ai-agents/agent-audit',
      content: {
        kind: 'kql-database',
        tables: [
          {
            name: 'AgentReviews',
            columns: [
              { name: 'review_id', type: 'string' },
              { name: 'data_product', type: 'string' },
              { name: 'verdict', type: 'string' },
              { name: 'requires_human_approval', type: 'bool' },
              { name: 'human_approved', type: 'bool' },
              { name: 'turn_count', type: 'int' },
              { name: 'tokens_in_total', type: 'long' },
              { name: 'tokens_out_total', type: 'long' },
              { name: 'cost_usd_estimate', type: 'real' },
              { name: 'requested_by_hash', type: 'string' },
              { name: 'completed_at', type: 'datetime' },
            ],
            sample: [
              ['rev-2026-05-30-0007', 'gold.finance.revenue_summary', 'APPROVED_WITH_CONDITIONS', true,  true,  6, 41200, 7800, 0.214, 'h:9f2a', '2026-05-30T14:05:00Z'],
              ['rev-2026-05-30-0008', 'silver.finance.transactions', 'REJECTED',                 false, false, 8, 52900, 9100, 0.281, 'h:9f2a', '2026-05-30T15:40:00Z'],
              ['rev-2026-05-29-0003', 'gold.sales.pipeline_summary', 'APPROVED',                 true,  true,  5, 33100, 6400, 0.176, 'h:c41b', '2026-05-29T10:12:00Z'],
              ['rev-2026-05-28-0011', 'gold.hr.headcount_monthly',   'INCONCLUSIVE',             false, false, 12, 79400, 14200, 0.422, 'h:7e88', '2026-05-28T18:55:00Z'],
              ['rev-2026-05-31-0001', 'gold.finance.revenue_summary', 'APPROVED_WITH_CONDITIONS', true,  false, 6, 40500, 7600, 0.209, 'h:9f2a', '2026-05-31T09:03:00Z'],
            ],
          },
          {
            name: 'AgentTurns',
            columns: [
              { name: 'review_id', type: 'string' },
              { name: 'turn_index', type: 'int' },
              { name: 'agent', type: 'string' },
              { name: 'content', type: 'string' },
              { name: 'tokens_in', type: 'long' },
              { name: 'tokens_out', type: 'long' },
              { name: 'turn_time', type: 'datetime' },
            ],
            sample: [
              ['rev-2026-05-30-0007', 0, 'DataAnalyst',       'gold.finance.revenue_summary is certified, domain Finance, owner Finance Data Team. Classifications [Financial Data, Confidential]. Lineage: raw→bronze→silver→gold; downstream Power BI Finance Dashboard + /api/v1/revenue.', 7100, 1400, '2026-05-30T14:00:10Z'],
              ['rev-2026-05-30-0007', 1, 'QualityReviewer',   'Gold Layer Standard: Completeness 92.1% pass, Accuracy 88.5% pass, Timeliness 78.3% FAIL (26h vs 24h SLA), Consistency 91.0% pass. Overall 87.5% over 80% gate — pass with warnings. Fix: adjust pipeline schedule.', 7600, 1700, '2026-05-30T14:01:55Z'],
              ['rev-2026-05-30-0007', 2, 'GovernanceOfficer', 'validate_contract: 5/6 checks pass; cost_center missing. Proposed verdict APPROVED_WITH_CONDITIONS: (1) fix timeliness, (2) add cost_center. Requires human approval before publication.', 6900, 1500, '2026-05-30T14:03:40Z'],
              ['rev-2026-05-30-0008', 0, 'DataAnalyst',       'silver.finance.transactions is endorsed (not certified), classifications [PII - Customer ID, Financial Data]. Referenced by name + classification only (no raw PII).', 7300, 1300, '2026-05-30T15:35:05Z'],
              ['rev-2026-05-30-0008', 1, 'QualityReviewer',   'Completeness 71.2% FAIL (gate 90%), Accuracy 83.0% FAIL (gate 85%). Two gold-gate failures.', 7700, 1600, '2026-05-30T15:37:20Z'],
              ['rev-2026-05-30-0008', 2, 'GovernanceOfficer', 'Verdict REJECTED. Reasons: completeness + accuracy below gold gate; PII-classified silver asset not eligible for gold publication without remediation.', 7000, 1500, '2026-05-30T15:39:30Z'],
            ],
          },
          {
            name: 'ToolCalls',
            columns: [
              { name: 'review_id', type: 'string' },
              { name: 'agent', type: 'string' },
              { name: 'tool', type: 'string' },
              { name: 'args_redacted', type: 'string' },
              { name: 'allowed', type: 'bool' },
              { name: 'latency_ms', type: 'int' },
              { name: 'event_time', type: 'datetime' },
            ],
            sample: [
              ['rev-2026-05-30-0007', 'DataAnalyst',       'search_catalog',    '{"query":"gold.finance.revenue_summary"}', true,  240, '2026-05-30T14:00:05Z'],
              ['rev-2026-05-30-0007', 'DataAnalyst',       'get_lineage',       '{"asset":"gold.finance.revenue_summary"}', true,  180, '2026-05-30T14:00:08Z'],
              ['rev-2026-05-30-0007', 'QualityReviewer',   'assess_quality',    '{"dataset":"gold.finance.revenue_summary"}', true,  3100, '2026-05-30T14:01:50Z'],
              ['rev-2026-05-30-0007', 'GovernanceOfficer', 'validate_contract', '{"product":"gold.finance.revenue_summary"}', true,  420, '2026-05-30T14:03:35Z'],
              ['rev-2026-05-30-0008', 'GovernanceOfficer', 'publish_data_product', '{"product":"silver.finance.transactions"}', false, 2, '2026-05-30T15:39:00Z'],
            ],
          },
        ],
        functions: [
          { name: 'review_verdicts', body: KQL_FN_VERDICTS },
          { name: 'agent_cost_rollup', body: KQL_FN_COST },
        ],
        ingestionPolicies: [
          {
            table: 'AgentReviews',
            policy:
              '.alter-merge table AgentReviews policy retention softdelete = 730d\n' +
              '.alter-merge table AgentReviews policy caching   hot        =  90d',
          },
          {
            table: 'AgentTurns',
            policy:
              '.alter-merge table AgentTurns policy retention softdelete = 730d\n' +
              '.alter-merge table AgentTurns policy caching   hot        =  30d',
          },
          {
            table: 'ToolCalls',
            policy:
              '.alter-merge table ToolCalls policy retention softdelete = 730d\n' +
              '.alter-merge table ToolCalls policy caching   hot        =  30d',
          },
        ],
        starterQueries: [
          { name: 'Verdict distribution + human-in-loop coverage (30d)', kql: KQL_Q_VERDICTS },
          { name: 'Policy violations — denied-tool attempts (30d)',       kql: KQL_Q_VIOLATIONS },
          { name: 'Approvals awaiting human confirmation',                kql: KQL_Q_UNAPPROVED },
          { name: 'Top 25 most expensive reviews (7d)',                   kql: KQL_Q_COST },
          { name: 'Full reconstructable transcript (audit)',             kql: KQL_Q_TRANSCRIPT },
        ],
      },
    },

    // ─── 4. Evaluation: sovereign agent quality ────────────────────────
    {
      itemType: 'evaluation',
      displayName: 'Sovereign Agent Quality',
      description:
        '8-metric evaluation suite for the governance agents: verdict-accuracy, groundedness, tool-policy-adherence, human-in-loop-coverage, transcript-completeness, data-residency-pass, cost-per-review, p95 latency. Baseline run pre-populated against the sovereign-agent-eval-seed dataset.',
      learnDoc: 'sovereign-ai-agents/evaluation',
      content: {
        kind: 'evaluation',
        datasetRef: 'sovereign-agent-eval-seed',
        metrics: [
          { name: 'verdict_accuracy', description: 'Fraction of reviews whose final verdict matches the human-labeled gold verdict in the seed dataset (exact match over the 4-value vocabulary). The headline correctness metric. Target ≥ 0.90.' },
          { name: 'groundedness', description: 'LLM-as-judge (0–1): fraction of factual claims in each agent turn that are supported by a retrieved governance-review-corpus chunk or a tool result. Catches agents asserting catalog/lineage facts not actually returned by their tools. Target ≥ 0.90.' },
          { name: 'tool_policy_adherence', description: 'Fraction of tool calls that were on the allow-list (search_catalog, get_lineage, assess_quality, validate_contract). Any denied-tool attempt (write_catalog, publish_data_product, exec_sql) drops this below 1.00. This MUST be 1.00 — a sub-1.0 value is a guardrail breach and pages immediately.' },
          { name: 'human_in_loop_coverage', description: 'Of the reviews whose verdict was APPROVED or APPROVED_WITH_CONDITIONS, the fraction that carried requires_human_approval=true. Per the contract, every approval requires a human; target == 1.00.' },
          { name: 'transcript_completeness', description: 'Fraction of reviews whose full transcript was persisted to AgentTurns + ToolCalls (one turn row per message, one tool row per call). Auditability requires the verdict be fully reconstructable; target == 1.00.' },
          { name: 'data_residency_pass', description: 'Fraction of reviews where every model/tool/storage endpoint resolved inside the tenant region and the project was a Standard (BYO Cosmos/Storage/Search) project. A sub-1.0 value means an agent touched Microsoft-managed or out-of-region storage — a sovereignty violation. Target == 1.00.' },
          { name: 'cost_per_review', description: 'Mean cost_usd_estimate per review (tokens_in + tokens_out priced at the deployment rate). Tracked for FinOps; the contract caps a single review at $1.00. Target ≤ $0.30 mean for the 3-agent / ≤12-turn pattern.' },
          { name: 'latency_p95', description: 'End-to-end review latency p95, in ms. Multi-agent reviews are slower than single-shot RAG; the contract SLA is p95 ≤ 60000 ms, p99 ≤ 120000 ms. Target p95 ≤ 45000 ms.' },
        ],
        baseline: {
          runId: 'baseline-2026-05-30-sovereign',
          results: {
            verdict_accuracy: 0.93,
            groundedness: 0.91,
            tool_policy_adherence: 1.0,
            human_in_loop_coverage: 1.0,
            transcript_completeness: 1.0,
            data_residency_pass: 1.0,
            cost_per_review: 0.24,
            latency_p95: 41800,
          },
        },
      },
    },

    // ─── 5. Notebook: walkthrough ──────────────────────────────────────
    {
      itemType: 'notebook',
      displayName: 'Sovereign Agents Walkthrough',
      description:
        'Runnable Foundry Agent Service walkthrough: verify the Standard (BYO/sovereign) project, create the three connected agents + orchestrator, run a governance review, persist the transcript to the agent-audit ADX database, then score it with the sovereign-agent-quality evaluation.',
      learnDoc: 'sovereign-ai-agents/walkthrough',
      content: {
        kind: 'notebook',
        // NotebookContent.defaultLang is the workspace default kernel
        // (pyspark in Fabric/Synapse); each code cell below pins lang:'python'
        // since the Foundry Agent Service SDK runs as plain Python.
        defaultLang: 'pyspark',
        cells: [
          { id: 'cell-md-intro', type: 'markdown', source: NB_INTRO },
          { id: 'cell-setup', type: 'code', lang: 'python', source: NB_SETUP },
          { id: 'cell-md-verify', type: 'markdown', source: '## 0 — Verify data sovereignty (Standard, not Basic, setup)' },
          { id: 'cell-verify', type: 'code', lang: 'python', source: NB_VERIFY_SOVEREIGN },
          { id: 'cell-md-agents', type: 'markdown', source: '## 1 — Create the three connected agents + orchestrator' },
          { id: 'cell-agents', type: 'code', lang: 'python', source: NB_CREATE_AGENTS },
          { id: 'cell-md-run', type: 'markdown', source: '## 2 — Run one governance review' },
          { id: 'cell-run', type: 'code', lang: 'python', source: NB_RUN_REVIEW },
          { id: 'cell-md-persist', type: 'markdown', source: '## 3 — Persist the auditable transcript to ADX' },
          { id: 'cell-persist', type: 'code', lang: 'python', source: NB_PERSIST },
          { id: 'cell-md-eval', type: 'markdown', source: '## 4 — Score the review with the evaluation suite' },
          { id: 'cell-eval', type: 'code', lang: 'python', source: NB_EVALUATE },
          { id: 'cell-md-next', type: 'markdown', source: NB_NEXT },
        ],
      },
    },
  ],
};

export default bundle;
