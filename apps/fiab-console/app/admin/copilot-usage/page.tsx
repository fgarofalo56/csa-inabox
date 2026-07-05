'use client';

/**
 * /admin/copilot-usage — per-persona Copilot token metering.
 *
 * Renders the real App Insights usage panel (copilot.usage events → Log
 * Analytics KQL). All token counts are the live AOAI prompt/completion split;
 * honest gate when App Insights / Log Analytics is unconfigured.
 */

import { AdminShell } from '@/lib/components/admin-shell';
import { CopilotUsagePane } from '@/lib/components/admin/copilot-usage';

export default function CopilotUsagePage() {
  return (
    <AdminShell
      sectionTitle="Copilot usage"
      learn={{
        title: 'Copilot usage',
        content: 'Per-persona Copilot token metering sourced from Application Insights copilot.usage events via Log Analytics KQL. Every count is the live Azure OpenAI prompt/completion split — real prompt and completion tokens broken down by persona, model, day, and hashed user. No synthetic or estimated numbers.',
        tips: [
          'Break down consumption by persona and model to see which assistants and deployments drive spend.',
          'User identities are hashed, so you can spot heavy users without exposing who they are.',
          'The panel shows an honest gate when Application Insights / Log Analytics is not wired up.',
        ],
      }}
    >
      <CopilotUsagePane />
    </AdminShell>
  );
}
