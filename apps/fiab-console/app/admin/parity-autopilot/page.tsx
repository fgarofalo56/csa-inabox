'use client';

import { AdminShell } from '@/lib/components/admin-shell';
import { ParityAutopilotPanel } from '@/lib/components/admin/parity-autopilot-panel';

export default function AdminParityAutopilotPage() {
  return (
    <AdminShell
      sectionTitle="Parity Autopilot"
      learn={{
        title: 'Parity Autopilot (WS-10.5)',
        content:
          'A scheduled self-audit that keeps the UI honest at scale: it captures a live Playwright screenshot of a surface, runs an Azure OpenAI vision diff against that surface’s parity doc, and for every "built" capability it can’t see it proposes a fix plan and files a GitHub issue. This page is the run ledger + open-gap view.',
        tips: [
          'Runs are driven by .github/workflows/loom-parity-autopilot.yml (schedule + workflow_dispatch)',
          'Vision diff + plan-model use the deployed AOAI (gpt-4o vision + reasoning tier) — honest-gated if unset',
          'Issue filing reuses LOOM_FEEDBACK_GITHUB_TOKEN; air-gapped boundaries stay gated by design',
        ],
        learnMoreHref: 'https://learn.microsoft.com/azure/ai-services/openai/how-to/gpt-with-vision',
      }}
    >
      <ParityAutopilotPanel />
    </AdminShell>
  );
}
