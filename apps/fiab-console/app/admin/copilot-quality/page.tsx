import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

/**
 * /admin/copilot-quality — kept as a stable deep link (IA-04).
 *
 * Answer quality / search relevance / tier routing / prompts / budgets are now
 * the "Copilot quality" TAB of the AI operations hub, where CopilotQualityTabs
 * renders its five sub-tabs verbatim. Sub-tabs stay deep-linkable through
 * /admin/ai-operations?tab=quality&sub=<answers|search|tier|prompts|budgets>.
 */
export default function CopilotQualityRedirect() {
  redirect('/admin/ai-operations?tab=quality');
}
