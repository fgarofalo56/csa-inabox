import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

/**
 * /admin/agent-quality — kept as a stable deep link (IA-04).
 *
 * Agent evals / red-team / traces / latency SLO are now the "Agent quality" TAB
 * of the AI operations hub. AgentQualityPanel is unchanged — moved, not
 * rewritten.
 */
export default function AgentQualityRedirect() {
  redirect('/admin/ai-operations?tab=agents');
}
