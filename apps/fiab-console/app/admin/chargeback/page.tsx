import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

/**
 * /admin/chargeback — kept as a stable deep link (IA-03).
 *
 * The per-domain chargeback report is now the "Chargeback report" TAB of the
 * FinOps hub. The full surface (ChargebackReportPane) is unchanged — moved, not
 * rewritten — so bookmarks and external links keep landing on the same UI.
 */
export default function ChargebackRedirect() {
  redirect('/admin/finops?tab=chargeback');
}
