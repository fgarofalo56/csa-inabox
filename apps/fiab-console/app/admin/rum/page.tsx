import { AdminShell } from '@/lib/components/admin-shell';
import { RumPanel } from '@/lib/components/admin/rum-panel';

export const dynamic = 'force-dynamic';

export default function AdminRumPage() {
  return (
    <AdminShell
      sectionTitle="Real-user monitoring"
      learn={{
        title: 'Real-user monitoring (RUM)',
        content:
          'What real browsers experience on every console surface: page-load p50/p95 from Navigation Timing, Web Vitals (LCP/FCP/TTFB/CLS/INP-approx), and unhandled client errors — captured first-party (no CDN), scrubbed of PII, shipped through the session-gated BFF to the SAME App Insights resource as server telemetry, and charted here from the Log Analytics workspace. Complements the synthetic journeys: journeys prove the paths a robot walks; RUM sees every path a human does.',
        tips: [
          'Kill instantly via the rum1-client-telemetry runtime flag — no roll',
          'Sample rate rides LOOM_RUM_SAMPLE_RATE (0–100, default 100)',
          'Surfaces are route SHAPES — ids/query strings never leave the page',
          'Rows appear in AppBrowserTimings / AppExceptions with role loom-console-browser',
        ],
        learnMoreHref: 'https://learn.microsoft.com/azure/azure-monitor/app/javascript',
      }}
    >
      <RumPanel />
    </AdminShell>
  );
}
