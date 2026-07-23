import { TargetArrow24Regular } from '@fluentui/react-icons';
import { AdminShell } from '@/lib/components/admin-shell';
import { CopilotQualityTabs } from '@/lib/components/admin/copilot-quality-tabs';
import { TeachingBanner } from '@/lib/components/shared/teaching-toast';

export const dynamic = 'force-dynamic';

/**
 * /admin/copilot-quality (E5) — per-surface Copilot answer-quality scores.
 *
 * Distinct from /admin/agent-quality (AGENT evals) and /admin/copilot-usage
 * (token metering): this reads the copilot-evaluator Function's real
 * retrieval-hit-rate / MRR / LLM-judge-grounding runs (Cosmos loom-copilot-evals)
 * against the golden eval sets, with per-surface floors, run-history trends,
 * worst-question drill-in, and an on-demand "Run now". Azure-native, no Fabric
 * dependency.
 */
export default function AdminCopilotQualityPage() {
  return (
    <AdminShell
      sectionTitle="Copilot quality"
      learn={{
        title: 'Copilot quality — retrieval & grounding evals',
        content:
          'Per-surface answer quality for the Loom Copilot: retrieval hit-rate / MRR against the golden eval sets, LLM-judge grounding/relevance/completeness, and the pass-rate that gates a corpus change. Every score is a REAL run of the copilot-evaluator Function against the same searchDocs + Azure OpenAI path production uses — scored, capped, and written to Cosmos. Compares each surface against its E3 floor and trends it across nightly + per-roll runs.',
        tips: [
          'Retrieval hit-rate is deterministic and authoritative even when the LLM judge is deferred (daily cap).',
          '"Run now" fires the same E2 HTTP trigger the nightly schedule + every roll use.',
          'A surface below its floor is the signal a corpus or prompt change regressed retrieval or grounding.',
          'Drill in to see the exact expected-vs-retrieved chunks and the judge’s own rationale per failing question.',
        ],
        learnMoreHref: 'https://learn.microsoft.com/azure/ai-foundry/concepts/evaluation-approach-gen-ai',
      }}
    >
      <TeachingBanner
        surfaceKey="admin-copilot-quality"
        title="Real Copilot answer-quality evals"
        message="Scores come from the copilot-evaluator Function running the golden eval sets through the real retrieval + Azure OpenAI judge path and writing to Cosmos. Retrieval hit-rate/MRR is deterministic; grounding is LLM-judged (capped per day). Each surface is measured against its E3 floor. No synthetic numbers — an honest gate shows the exact remediation when the evaluator Function is unwired."
        icon={TargetArrow24Regular}
        accent="var(--loom-accent-blue)"
        learnMoreHref="https://learn.microsoft.com/azure/ai-foundry/concepts/evaluation-approach-gen-ai"
      />
      <CopilotQualityTabs />
    </AdminShell>
  );
}
