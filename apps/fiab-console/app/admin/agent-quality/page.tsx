import { AdminShell } from '@/lib/components/admin-shell';
import { AgentQualityPanel } from '@/lib/components/admin/agent-quality-panel';

export const dynamic = 'force-dynamic';

export default function AdminAgentQualityPage() {
  return (
    <AdminShell
      sectionTitle="Agent Quality"
      learn={{
        title: 'Agent Quality — evals, red-team, traces & SLOs',
        content:
          'One home for agent evaluation + observability: LLM-judge eval sets with regression-vs-baseline, defensive red-team refusal results, per-agent trace timelines with token/cost/latency and model tier, and the live Copilot turn-latency SLO. Every tile reads a real Azure OpenAI / Cosmos backend — no Fabric dependency.',
        tips: [
          'Evaluations replay a prompt-set through the agent, then an AOAI judge scores 1–5',
          'Red-team refusal rate is the Azure-native analog of the AI Red Teaming Agent',
          'Traces surface real token usage + estimated cost + the tier-router model tier',
          'Latency SLO is the same objective the tier router reads under load',
        ],
        learnMoreHref: 'https://learn.microsoft.com/azure/ai-foundry/concepts/observability',
      }}
    >
      <AgentQualityPanel />
    </AdminShell>
  );
}
