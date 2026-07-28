import { AdminShell } from '@/lib/components/admin-shell';
import { AiOperationsTabs } from '@/lib/components/admin/ai-operations-tabs';

export const dynamic = 'force-dynamic';

/**
 * /admin/ai-operations — the ONE AI-operations hub (IA-04, loom-apex Phase B).
 *
 * Five tabs replacing five sibling admin pages: Copilot token Usage, Agent
 * quality (evals / red-team / traces / SLO), Copilot quality (answers, search,
 * tier routing, prompts, budgets), the closed-loop Model Fabric, and the Parity
 * Autopilot ledger. Every pane was moved verbatim; the five old routes remain
 * as redirect stubs into the matching `?tab=` deep link.
 */
export default function AdminAiOperationsPage() {
  return (
    <AdminShell
      sectionTitle="AI operations"
      learn={{
        title: 'AI operations — metering, quality, and the closed loop',
        content:
          'The single operations surface for everything the Loom Copilot and its agents do. Usage meters real Azure OpenAI prompt/completion tokens per persona from Application Insights. Agent quality runs LLM-judge eval sets, red-team refusal probes, per-agent traces and the turn-latency SLO. Copilot quality scores retrieval hit-rate / MRR and grounding against the golden eval sets, plus search relevance, tier routing, the prompt registry and token budgets. Model Fabric closes the loop — promoting the live-eval winner and demoting regressions across serving traffic-splits and the reasoning tier. Parity Autopilot keeps the UI honest with scheduled capture → vision-diff → gap issues. Real Azure OpenAI / Cosmos / Azure ML backends throughout; no Fabric dependency.',
        tips: [
          'Deep-link a tab with ?tab=usage | agents | quality | fabric | autopilot.',
          'Copilot-quality sub-tabs deep-link too: ?tab=quality&sub=answers | search | tier | prompts | budgets.',
          'The five former routes (/admin/copilot-usage, agent-quality, copilot-quality, model-fabric, parity-autopilot) redirect straight to their tab.',
          'Each tab keeps its own Learn popover — folding pages into a hub never drops the contextual help.',
        ],
        learnMoreHref: 'https://learn.microsoft.com/azure/ai-foundry/concepts/observability',
      }}
    >
      <AiOperationsTabs />
    </AdminShell>
  );
}
