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
    <AdminShell sectionTitle="Copilot usage">
      <CopilotUsagePane />
    </AdminShell>
  );
}
