import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

/**
 * /admin/parity-autopilot — kept as a stable deep link (IA-04).
 *
 * The Parity Autopilot run ledger + open-gap view is now the "Parity Autopilot"
 * TAB of the AI operations hub. ParityAutopilotPanel is unchanged — moved, not
 * rewritten. The admin.parity-autopilot capability still guards the BFF routes.
 */
export default function ParityAutopilotRedirect() {
  redirect('/admin/ai-operations?tab=autopilot');
}
