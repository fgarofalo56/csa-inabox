import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

/**
 * /admin/copilot-usage — kept as a stable deep link (IA-04).
 *
 * Per-persona Copilot token metering is now the "Usage" TAB of the AI
 * operations hub. CopilotUsagePane is unchanged — moved, not rewritten.
 */
export default function CopilotUsageRedirect() {
  redirect('/admin/ai-operations?tab=usage');
}
