import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

/**
 * /admin/access-requests — kept as a stable deep link (IA-06).
 *
 * The onboarding queue is now the "Requests" TAB of the Access governance hub.
 * AccessRequestsPanel is unchanged — moved, not rewritten.
 */
export default function AccessRequestsRedirect() {
  redirect('/admin/access-governance?tab=requests');
}
