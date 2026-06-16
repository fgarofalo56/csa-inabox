import { Suspense } from 'react';
import { Spinner } from '@fluentui/react-components';
import { AdminShell } from '@/lib/components/admin-shell';
import { LandingZonesShell } from '@/lib/panes/landing-zones-shell';

export const dynamic = 'force-dynamic';

/**
 * /admin/landing-zones — Data Landing Zone overview + management (item-3) and
 * the dlz-attach form, as tabs. This is the post-deploy home the Setup Wizard
 * redirects to (item-1). LandingZonesShell reads search params, so it is wrapped
 * in Suspense per Next's useSearchParams requirement.
 */
export default function LandingZonesPage() {
  return (
    <AdminShell sectionTitle="Setup & landing zones">
      <Suspense fallback={<Spinner label="Loading landing zones…" />}>
        <LandingZonesShell />
      </Suspense>
    </AdminShell>
  );
}
