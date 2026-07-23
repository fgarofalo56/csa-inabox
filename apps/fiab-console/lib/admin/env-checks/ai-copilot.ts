/**
 * R30 fragment — the 'ai-copilot' domain slice of ENV_CHECKS (formerly part of the
 * lib/admin/env-checks.ts monolith). An env-adding item edits ONLY its own
 * domain fragment; ./index.ts merges every fragment into the same exported
 * ENV_CHECKS array (public API unchanged). Import ONLY from './core' here —
 * never './index' (barrel-cycle rule, WS-E1 gotcha).
 */
import type { EnvSpec } from './core';

export const AI_COPILOT_ENV_CHECKS: EnvSpec[] = [
  {
    // WS-1.1 — the model tier router's REASONING (strong) + MINI tiers. The
    // router (lib/foundry/model-tier-router.ts) is default-ON: it classifies
    // every copilot / agent / data-agent turn and, when a strong deployment is
    // wired, rides it for hard analytical/agentic turns (design / debug /
    // multi-step / tool-heavy / long-context) while cheap turns can ride mini.
    // When NO strong deployment is configured the router SILENTLY rides the
    // single default AOAI deployment (LOOM_AOAI_DEPLOYMENT) for every turn — the
    // turn still works, it just is not upshifted. optionalDefault so that
    // fully-functional posture is a pass (never a hard-fail), while the gate +
    // Fix-it stay discoverable on /admin/gates for an admin who wants best-per-
    // task routing. The strong tier binds to the BEST reasoning model the cloud
    // can serve (bicep miniDeployment/strongDeployment from the availability
    // matrix — Commercial gpt-5.6/gpt-5.5; Gov gpt-5.2/gpt-5.1/gpt-5; floor
    // gpt-4.1), so it works in Commercial AND Gov (*.openai.azure.us).
    id: 'svc-model-reasoning-tier', category: 'ai-copilot',
    title: 'Model tier router — reasoning (strong) + mini tiers', severity: 'optional',
    required: ['LOOM_AOAI_STRONG_DEPLOYMENT', 'LOOM_AOAI_MINI_DEPLOYMENT'],
    warnOnMiss: true,
    optionalDefault: true,
    optionalDefaultDetail: 'the model tier router rides the single resolved default AOAI deployment (LOOM_AOAI_DEPLOYMENT) for every turn — hard analytical turns are not upshifted to a stronger reasoning model, but every turn still works. Set LOOM_AOAI_STRONG_DEPLOYMENT (a reasoning-capable o-series / gpt-5-class deployment) so hard turns ride the reasoning tier, and LOOM_AOAI_MINI_DEPLOYMENT (a cheap model, e.g. gpt-4.1-mini) so lightweight turns ride mini.',
    remediation: 'Deploy a reasoning-capable model on the Foundry hub (Commercial: gpt-5.6 / gpt-5.5; Gov: gpt-5.2 / gpt-5.1 / gpt-5; floor gpt-4.1) and set LOOM_AOAI_STRONG_DEPLOYMENT to its deployment name so hard analytical/agentic turns route to it; set LOOM_AOAI_MINI_DEPLOYMENT to a cheap model (gpt-4.1-mini) for lightweight turns. A push-button deploy wires both from the Foundry project automatically. Opt out entirely with LOOM_MODEL_TIER_ROUTING_ENABLED=false or Admin → Copilot & Agents → Model tiers.',
    provisionedBy: 'modules/ai/foundry-project.bicep (miniDeployment / strongDeployment) → modules/admin-plane/main.bicep apps[] env (LOOM_AOAI_MINI_DEPLOYMENT / LOOM_AOAI_STRONG_DEPLOYMENT)',
    role: 'Cognitive Services OpenAI User (UAMI) on the AOAI/Foundry account',
    docs: 'docs/fiab/model-strategy.md',
    // X-MATRIX (AOAI-model-lag): the strong/mini tiers bind to the best model
    // the cloud can serve — Gov lags Commercial ('limited', non-blocking note).
    availability: {
      commercial: 'ga', gccHigh: 'limited', il5: 'limited',
      fallbackNote: 'The Gov AOAI model catalog lags Commercial — the tier router binds LOOM_AOAI_STRONG_DEPLOYMENT to the best Gov-available reasoning model (gpt-5.2 / gpt-5.1 / gpt-5; floor gpt-4.1) instead of the Commercial flagship; every turn still works.',
    },
  },
  {
    // WS-9 — Sovereign Agent Mesh egress profile + allow-list. Both are OPT-IN
    // knobs: unset ⇒ the mesh runs on the cloud default profile (Gov cloud →
    // 'gov', else 'commercial') and a FAIL-CLOSED air-gap posture only when
    // LOOM_MESH_PROFILE=air-gap is explicitly set — so the mesh is fully
    // functional day-one (default-ON / opt-out). LOOM_A2A_EGRESS_ALLOW is the
    // comma-separated host-suffix allow-list that lets an air-gap / gov agent
    // reach an approved in-boundary proxy (empty ⇒ nothing egresses).
    id: 'svc-agent-mesh', category: 'ai-copilot', title: 'Sovereign Agent Mesh (egress profile + allow-list)', severity: 'optional',
    required: ['LOOM_MESH_PROFILE', 'LOOM_A2A_EGRESS_ALLOW'],
    warnOnMiss: true, optionalDefault: true,
    optionalDefaultDetail: 'the mesh runs on the cloud default egress profile (Gov cloud → gov, else commercial) with an empty egress allow-list. Set LOOM_MESH_PROFILE=air-gap for a sovereign/disconnected boundary (fail-closed egress) and LOOM_A2A_EGRESS_ALLOW to a comma-separated host-suffix list only if an approved in-boundary proxy exists.',
    remediation: 'Optional. Set LOOM_MESH_PROFILE (commercial | gov | air-gap) to pin the mesh egress posture, and LOOM_A2A_EGRESS_ALLOW to a comma-separated host-suffix allow-list for approved external hops. Both are opt-in — the mesh works without them.',
    provisionedBy: 'modules/admin-plane/main.bicep (apps[] env — LOOM_MESH_PROFILE / LOOM_A2A_EGRESS_ALLOW, opt-in)',
    docs: 'docs/fiab/parity/sovereign-agent-mesh.md',
  },

  // ── AI & Copilot (new surfaces) ──
  {
    id: 'svc-learning-hub', category: 'ai-copilot', title: 'Learning Hub — help agent + sample-data install', severity: 'optional',
    // The Learning Hub help-copilot answers from an AOAI/Foundry model; the
    // use-case apps install + notebook-import provision into Synapse/Databricks
    // and seed sample data into ADLS. The model gate is the recommended one; the
    // probeAoai() live check below confirms a deployment actually resolves.
    anyOf: [['LOOM_AOAI_ENDPOINT', 'LOOM_FOUNDRY_PROJECT_ENDPOINT', 'LOOM_FOUNDRY_ENDPOINT']], warnOnMiss: true,
    remediation: 'The Learning Hub help agent needs an AOAI/Foundry model (set LOOM_AOAI_ENDPOINT + LOOM_AOAI_DEPLOYMENT or a Foundry project endpoint). The use-case apps install + notebook-import additionally provision into Synapse/Databricks + seed sample data into ADLS (see those service checks). The hub content + tutorials render Loom-native without a model — only the conversational help agent is gated.',
    provisionedBy: 'modules/admin-plane (agentFoundryEnabled / aiFoundryEnabled) → AIServices account + project → apps[] env',
    role: 'Cognitive Services OpenAI User (UAMI) on the AOAI/Foundry account',
  },
  {
    id: 'svc-mcp-catalog', category: 'ai-copilot', title: 'MCP Servers — built-in server', severity: 'optional',
    // The deployable catalog list is a static built-in module (lib/mcp/catalog.ts)
    // and always renders. The built-in Loom MCP server endpoint is the only env
    // that gates the "use the built-in server" path.
    required: ['LOOM_BUILTIN_MCP_URL'], warnOnMiss: true,
    remediation: 'The MCP Servers catalog list renders from the built-in module without config. Set LOOM_BUILTIN_MCP_URL to point at the deployed built-in Loom MCP server (the bootstrap deploys + wires it). Deploying additional catalog servers uses the Container Apps env — see the "MCP Servers — deploy backend" check.',
    provisionedBy: 'modules/admin-plane (built-in MCP Container App) → apps[] env LOOM_BUILTIN_MCP_URL',
    role: 'none (HTTP endpoint); deployed catalog servers use the MCP catalog UAMI',
  },
  {
    id: 'svc-aoai-embeddings', category: 'ai-copilot', title: 'AOAI embeddings deployment (RAG / vector index)', severity: 'optional',
    required: ['LOOM_AOAI_EMBED_DEPLOYMENT'], warnOnMiss: true,
    remediation: 'Set LOOM_AOAI_EMBED_DEPLOYMENT (e.g. text-embedding-3-small) so Index-my-data and vector search can embed (embedding_not_configured). Deploy the model from the AI Foundry hub if absent.',
    provisionedBy: 'modules/admin-plane (agentFoundryEnabled → embedding model deployment) → apps[] env',
    role: 'Cognitive Services OpenAI User (UAMI) on the AOAI/Foundry account',
  },
  {
    // E2 (loom-next-level) — the copilot-evaluator Function: nightly + per-roll
    // Copilot quality evals (retrieval hit-rate/MRR + LLM-judge grounding) over
    // the E1 golden sets, scored against the REAL searchDocs + aoai-chat-client
    // path via the internal eval-probe route and written to Cosmos
    // loom-copilot-evals. LOOM_COPILOT_EVALUATOR_URL is the deployed Function's
    // base URL (bicep-wired from the module output) — the E5 admin "Run now"
    // proxy targets it. The Function itself is default-ON in bicep
    // (functionAppsConfig.copilotEvaluatorEnabled) and opt-out at runtime via
    // LOOM_COPILOT_EVAL_ENABLED=false; its judge spend is capped per day
    // (LOOM_COPILOT_EVAL_JUDGE_DAILY_CAP, default 500) and its judge deployment
    // resolves LOOM_COPILOT_EVAL_JUDGE_DEPLOYMENT → strong → mini → default —
    // never a hardcoded model name.
    id: 'svc-copilot-evaluator', category: 'ai-copilot',
    title: 'Copilot quality evaluator (eval harness Function)', severity: 'optional',
    required: ['LOOM_COPILOT_EVALUATOR_URL'], warnOnMiss: true,
    remediation: 'Deploy the copilot-evaluator Function (modules/admin-plane/copilot-evaluator-function.bicep — default-ON via the functionAppsConfig bag) and set LOOM_COPILOT_EVALUATOR_URL to its https://<app>.azurewebsites.net base URL so admin "Run now" + the corpus-staging workflow can trigger runs. The Function needs Search Index Data Reader (AI Search), Cognitive Services OpenAI User (AOAI judge), Cosmos DB Built-in Data Contributor (loom-copilot-evals) and Storage Blob Data Owner (its host storage) — all granted by the bicep module. Opt out with LOOM_COPILOT_EVAL_ENABLED=false; tune the judge with LOOM_COPILOT_EVAL_JUDGE_DEPLOYMENT + LOOM_COPILOT_EVAL_JUDGE_DAILY_CAP (default 500 judged Q/day).',
    provisionedBy: 'modules/admin-plane/copilot-evaluator-function.bicep (wired in admin-plane/main.bicep via functionAppsConfig; LOOM_COPILOT_EVALUATOR_URL on the Console apps[] env)',
    role: 'Function MI: Search Index Data Reader (AI Search) + Cognitive Services OpenAI User (AOAI) + Cosmos DB Built-in Data Contributor + Storage Blob Data Owner (host storage)',
    docs: 'docs/fiab/runbooks/copilot-evaluator.md',
    // X2 — every backing service (Functions, AI Search, AOAI, Cosmos) is
    // in-tenant and GA in all three boundaries; eval sets ship in-image (no
    // external fetch at IL5).
    availability: { commercial: 'ga', gccHigh: 'ga', il5: 'ga' },
  },
  {
    // N11 + N12 — TUNING KNOBS ONLY. Both features are DEFAULT-ON with code
    // defaults and are 100% functional with these UNSET:
    //   • LOOM_GRAPHRAG_MAX_HOPS      — GraphRAG traversal depth over the
    //     authored Weave ontology (Apache AGE on in-VNet PostgreSQL). Unset ⇒
    //     2 hops. Clamped to [1,4] so a mis-typed value can never widen the
    //     blast radius. The FEATURE toggle is the FLAG0 runtime flag
    //     `n11-graphrag-grounding` (default-ON) + the per-agent "Graph
    //     grounding" switch — never this var.
    //   • LOOM_NL2SQL_REPAIR_MAX_ATTEMPTS — bounded self-healing repair
    //     attempts per plan step. Unset ⇒ 2. Clamped to [0,5]; 0 disables the
    //     repair sub-loop entirely (the loop then behaves exactly as pre-N12).
    // optionalDefault so the unset state is a PASS (never a red day-one gate),
    // while the Fix-it stays discoverable on /admin/gates for an operator who
    // wants to tune depth/attempts. The backing services are the ones the
    // ontology + warehouse gates already cover (svc-weave-ontology, svc-synapse).
    id: 'svc-graphrag-nl2sql-repair', category: 'ai-copilot',
    title: 'GraphRAG grounding depth + NL2SQL self-healing attempts (tuning)', severity: 'optional',
    required: ['LOOM_GRAPHRAG_MAX_HOPS', 'LOOM_NL2SQL_REPAIR_MAX_ATTEMPTS'],
    warnOnMiss: true,
    optionalDefault: true,
    optionalDefaultDetail:
      'GraphRAG grounding traverses 2 hops and the self-healing NL2SQL loop makes up to 2 bounded repair attempts per step — both fully functional defaults. Set LOOM_GRAPHRAG_MAX_HOPS (1–4) to widen/narrow ontology traversal and LOOM_NL2SQL_REPAIR_MAX_ATTEMPTS (0–5, 0 disables repair) to tune the repair budget.',
    remediation:
      'Optional. Set LOOM_GRAPHRAG_MAX_HOPS (1–4, default 2) to change how far a data agent traverses the authored ontology graph, and LOOM_NL2SQL_REPAIR_MAX_ATTEMPTS (0–5, default 2) to change the bounded self-healing repair budget per plan step. Both are pure tuning — the features are default-ON without them. To turn GraphRAG grounding OFF entirely use the runtime flag n11-graphrag-grounding on /admin/runtime-flags (seconds-fast, no roll) or the per-agent "Graph grounding" switch in the data-agent editor.',
    provisionedBy: 'modules/admin-plane/main.bicep (apps[] env — LOOM_GRAPHRAG_MAX_HOPS / LOOM_NL2SQL_REPAIR_MAX_ATTEMPTS, emitted empty so the code defaults apply)',
    role: 'none (the underlying grants are the Weave PostgreSQL/AGE principal + the Synapse SQL reader the ontology and warehouse gates already cover)',
    docs: 'docs/fiab/parity/reasoning-mode-data-agents.md',
    // X-MATRIX: the backing substrates are Azure Database for PostgreSQL
    // (Apache AGE) + Synapse SQL + AOAI — all GA in Commercial, GCC-High and
    // IL5. GraphRAG runs entirely in-VNet with ZERO external egress, so the
    // capability is identical (and fully functional) in a disconnected enclave.
    availability: { commercial: 'ga', gccHigh: 'ga', il5: 'ga' },
  },
  {
    id: 'svc-iq-mcp', category: 'ai-copilot', title: 'Fabric IQ MCP bridge', severity: 'optional',
    required: ['LOOM_IQ_MCP_ENABLED'], warnOnMiss: true,
    remediation: 'Set LOOM_IQ_MCP_ENABLED=true (+ LOOM_IQ_MCP_TOKEN when the bridge requires auth) so the IQ MCP panel exposes the ontology tools to Copilot. The built-in Loom tools work without it.',
    provisionedBy: 'modules/admin-plane (built-in MCP Container App) → apps[] env',
    role: 'none (HTTP endpoint; token via Key Vault when set)',
  },
];
