import { AdminShell } from '@/lib/components/admin-shell';
import { CopilotQualityPanel } from '@/lib/components/admin/copilot-quality-panel';
import { runtimeFlag } from '@/lib/admin/runtime-flags';
import { MessageBar, MessageBarBody, MessageBarTitle } from '@fluentui/react-components';

export const dynamic = 'force-dynamic';

export default async function AdminCopilotQualityPage() {
  // FLAG0 kill-switch (default-ON, fail-open): flipping 'e5-copilot-quality' OFF
  // reverts /admin/copilot-quality to a hidden surface in seconds — the eval
  // harness (Function + nightly/per-roll runs) keeps writing scores either way;
  // this only controls the admin view.
  const enabled = await runtimeFlag('e5-copilot-quality');
  return (
    <AdminShell
      sectionTitle="Copilot quality"
      learn={{
        title: 'Copilot quality — retrieval + grounding evals',
        content:
          'The real-data admin view for the in-product Copilot eval harness. The copilot-evaluator Function replays authored golden Q/A sets (content/evals) against the LIVE retrieval + Azure OpenAI answer path for every Copilot surface, then scores retrieval hit-rate/MRR and an LLM-judge grounding-fidelity rubric — so a corpus, prompt, or tier-router change can never silently regress Copilot. Every score is a real Cosmos read; no Fabric dependency.',
        tips: [
          'Each tile grades a surface from its latest run: retrieval hit-rate, judge grounding (1–5), and pass-rate, with a trend sparkline.',
          'Floor dots compare each metric to its E3 ratcheted floor (content/evals/eval-floors.json) — a red dot is below floor.',
          'The judge rubric actively penalizes any answer that claims Microsoft Fabric or a Power BI workspace is required (no-fabric-dependency).',
          '“Run now” triggers a live evaluation through the evaluator Function; nightly + per-roll runs happen automatically.',
          'Open a worst question to see the expected vs retrieved chunks and the judge’s rationale — the retrieval-vs-grounding drill-down.',
        ],
        learnMoreHref: 'https://learn.microsoft.com/azure/ai-foundry/concepts/evaluation-approach-gen-ai',
      }}
    >
      {enabled ? (
        <CopilotQualityPanel />
      ) : (
        <MessageBar intent="info">
          <MessageBarBody>
            <MessageBarTitle>Copilot quality view disabled</MessageBarTitle>
            The <code>e5-copilot-quality</code> runtime flag is OFF. The eval harness keeps running and
            writing scores; re-enable the flag on <a href="/admin/runtime-flags">Runtime flags</a> to view them.
          </MessageBarBody>
        </MessageBar>
      )}
    </AdminShell>
  );
}
