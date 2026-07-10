'use client';

/**
 * /admin/copilot-usage — per-persona Copilot token metering.
 *
 * Renders the real App Insights usage panel (copilot.usage events → Log
 * Analytics KQL). All token counts are the live AOAI prompt/completion split;
 * honest gate when App Insights / Log Analytics is unconfigured.
 */

import { DataUsage24Regular } from '@fluentui/react-icons';
import { AdminShell } from '@/lib/components/admin-shell';
import { CopilotUsagePane } from '@/lib/components/admin/copilot-usage';
import { TeachingBanner } from '@/lib/components/shared/teaching-toast';

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
      <TeachingBanner
        surfaceKey="admin-copilot-usage"
        title="Real token metering, per persona"
        message="Every count comes from Application Insights copilot.usage events via Log Analytics KQL — live Azure OpenAI prompt/completion splits by persona, model, day, and hashed user. No synthetic numbers. An honest gate shows the exact env var when App Insights isn't wired up."
        icon={DataUsage24Regular}
        accent="var(--loom-accent-blue)"
        learnMoreHref="https://learn.microsoft.com/azure/azure-monitor/logs/log-analytics-overview"
      />
      <CopilotUsagePane />
    </AdminShell>
  );
}
