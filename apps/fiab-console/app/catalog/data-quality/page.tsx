import { redirect } from 'next/navigation';

/**
 * /catalog/data-quality → /governance/data-quality (canonical).
 *
 * This route previously rendered a standalone data-quality rule editor that was
 * never listed in CatalogShell's left rail and had no inbound navigation, so it
 * was unreachable and duplicated the rail-listed governance surface. The full
 * DQ experience (Rules + Run + Results + Monitors, all Azure-native, no Fabric
 * dependency) lives at /governance/data-quality. Redirect any stale deep-links
 * there rather than serving a duplicate.
 */
export default function CatalogDataQualityRedirect() {
  redirect('/governance/data-quality');
}
