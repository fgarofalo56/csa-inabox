import { Suspense } from 'react';
import { AdminShell } from '@/lib/components/admin-shell';
import { LandingZonesShell } from '@/lib/panes/landing-zones-shell';

export const dynamic = 'force-dynamic';

/**
 * /admin/landing-zones — Data Landing Zone overview + management (item-3) and
 * the dlz-attach form, as tabs. This is the post-deploy home the Setup Wizard
 * redirects to (item-1). LandingZonesShell reads search params, so it is wrapped
 * in Suspense per Next's useSearchParams requirement.
 *
 * The Suspense fallback is intentionally a plain element (no Fluent component):
 * this is a Server Component, and importing @fluentui/react-components here pulls
 * Fluent's context modules into the server graph, which breaks `next build`'s
 * "collect page data" step (`d.createContext is not a function`). All Fluent UI
 * lives below the LandingZonesShell client boundary.
 */
export default function LandingZonesPage() {
  return (
    <AdminShell sectionTitle="Setup & landing zones">
      <Suspense fallback={<div style={{ padding: 24 }}>Loading landing zones…</div>}>
        <LandingZonesShell />
      </Suspense>
    </AdminShell>
  );
}
