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
 * The Suspense fallback is intentionally Fluent-free: this is a Server Component,
 * and importing @fluentui/react-components here pulls Fluent's context modules
 * into the server graph, which breaks `next build`'s "collect page data" step
 * (`d.createContext is not a function`). All Fluent UI lives below the
 * LandingZonesShell client boundary.
 *
 * So the fallback is styled with the design-system CSS variables (`--loom-*`,
 * defined in globals.css and injected at the root layout) instead of Fluent
 * tokens — theme-aware (the `html[data-theme='dark']` block swaps them), no
 * Fluent JS import. It renders a polished card skeleton matching the Web-3.0
 * surface treatment (raised surface, large radius, elevation) rather than a
 * bare "Loading…" string.
 */
const skeletonBar = (width: string, height = 'var(--loom-space-4)'): React.CSSProperties => ({
  width,
  height,
  borderRadius: 'var(--loom-radius-sm)',
  background: 'var(--loom-surface-sunken)',
});

function LandingZonesFallback() {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--loom-space-5)',
        padding: 'var(--loom-space-6)',
        borderRadius: 'var(--loom-radius-lg)',
        background: 'var(--loom-surface-raised)',
        border: '1px solid var(--loom-stroke-subtle)',
        boxShadow: 'var(--loom-elev-2)',
      }}
    >
      <span style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>
        Loading landing zones…
      </span>
      {/* Header row: title + subtitle skeleton */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--loom-space-3)' }}>
        <div style={skeletonBar('40%', 'var(--loom-space-5)')} />
        <div style={skeletonBar('64%')} />
      </div>
      {/* Card-grid skeleton: three placeholder tiles */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(min(260px, 100%), 1fr))',
          gap: 'var(--loom-space-4)',
        }}
      >
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--loom-space-3)',
              padding: 'var(--loom-space-4)',
              borderRadius: 'var(--loom-radius-lg)',
              background: 'var(--loom-surface-canvas)',
              border: '1px solid var(--loom-stroke-subtle)',
            }}
          >
            <div style={skeletonBar('52%')} />
            <div style={skeletonBar('100%', 'var(--loom-space-3)')} />
            <div style={skeletonBar('80%', 'var(--loom-space-3)')} />
          </div>
        ))}
      </div>
    </div>
  );
}

export default function LandingZonesPage() {
  return (
    <AdminShell sectionTitle="Setup & landing zones">
      <Suspense fallback={<LandingZonesFallback />}>
        <LandingZonesShell />
      </Suspense>
    </AdminShell>
  );
}
