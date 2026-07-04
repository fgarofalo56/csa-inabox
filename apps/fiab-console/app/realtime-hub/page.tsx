import { Suspense } from 'react';
import { PageShell } from '@/lib/components/page-shell';
import { RealTimeIntelligenceHub } from '@/lib/components/realtime-hub/realtime-intelligence-hub';

export const dynamic = 'force-dynamic';

export default function RealTimeHubPage() {
  return (
    <PageShell
      title="Real-Time Intelligence"
      subtitle="Your unified real-time surface — deployed streams and KQL tables, source discovery across every subscription, Activator automation rules, and governed business events, all in one hub. Azure-native by default; no Microsoft Fabric required."
    >
      {/* useSearchParams in RealTimeIntelligenceHub requires a Suspense boundary. */}
      <Suspense fallback={null}>
        <RealTimeIntelligenceHub />
      </Suspense>
    </PageShell>
  );
}
