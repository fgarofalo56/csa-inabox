import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

/**
 * /admin/access-packages — kept as a stable deep link (IA-06).
 *
 * Access packages + approval policies + separation-of-duties are now the
 * "Packages" TAB of the Access governance hub (also a gate-registry surface
 * path). AccessPackagesPanel is unchanged — moved, not rewritten.
 */
export default function AccessPackagesRedirect() {
  redirect('/admin/access-governance?tab=packages');
}
