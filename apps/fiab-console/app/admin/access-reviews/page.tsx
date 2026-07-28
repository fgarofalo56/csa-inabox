import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

/**
 * /admin/access-reviews — kept as a stable deep link (IA-06).
 *
 * Recertification campaigns are now the "Reviews" TAB of the Access governance
 * hub (also a gate-registry surface path). AccessReviewsPanel is unchanged —
 * moved, not rewritten.
 */
export default function AccessReviewsRedirect() {
  redirect('/admin/access-governance?tab=reviews');
}
