/**
 * /admin/api-management - W1-5: redirects to the API Gateway hub when the plane is on.
 *
 * LOOM_APIPLANE_ENABLED=false keeps the previous single-gateway page primary (rollback path):
 * the page body now lives in app/admin/api-gateway/_legacy/api-management-legacy.tsx, unchanged.
 * Dynamic so the flag is read per request, not baked in at build time.
 */
import { redirect } from 'next/navigation';
import LegacyApiManagementPage from '../api-gateway/_legacy/api-management-legacy';
import { HUB_PATH, legacyRedirectTarget } from '../api-gateway/_lib/flag';

export const dynamic = 'force-dynamic';

export default function ApiManagementPage() {
  const target = legacyRedirectTarget(HUB_PATH);
  if (target) redirect(target);
  return <LegacyApiManagementPage />;
}
