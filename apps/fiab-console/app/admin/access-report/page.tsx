import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

/**
 * /admin/access-report — kept as a stable deep link (IA-06).
 *
 * The unified who-has-access report is now the "Report" TAB of the Access
 * governance hub. AccessReportPanel is unchanged — moved, not rewritten.
 */
export default function AccessReportRedirect() {
  redirect('/admin/access-governance?tab=report');
}
