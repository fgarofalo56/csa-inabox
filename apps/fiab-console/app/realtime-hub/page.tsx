import { Suspense } from 'react';
import { PageShell } from '@/lib/components/page-shell';
import { TeachingBanner } from '@/lib/components/shared/teaching-toast';
import { RealTimeIntelligenceHub } from '@/lib/components/realtime-hub/realtime-intelligence-hub';

export const dynamic = 'force-dynamic';

export default function RealTimeHubPage() {
  return (
    <PageShell
      title="Real-Time Intelligence"
      subtitle="Your unified real-time surface — deployed streams and KQL tables, source discovery across every subscription, Activator automation rules, and governed business events, all in one hub. Azure-native by default; no Microsoft Fabric required."
    >
      <TeachingBanner
        surfaceKey="realtime-hub"
        title="Four real-time surfaces, one hub"
        message="Streams shows your deployed eventstreams and KQL tables; Discover sources finds raw Azure event sources across every subscription; Activator turns conditions into automated actions; Business events governs the signals other apps subscribe to. Every tab runs on an Azure-native backend — no Microsoft Fabric capacity required."
        learnMoreHref="https://learn.microsoft.com/fabric/real-time-intelligence/overview"
      />
      {/* useSearchParams in RealTimeIntelligenceHub requires a Suspense boundary. */}
      <Suspense fallback={null}>
        <RealTimeIntelligenceHub />
      </Suspense>
    </PageShell>
  );
}
