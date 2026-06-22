import { Suspense } from 'react';
import { PageShell } from '@/lib/components/page-shell';
import { LoomMarketplace } from '@/lib/components/marketplace/loom-marketplace';

export const dynamic = 'force-dynamic';

export default function MarketplacePage() {
  return (
    <PageShell
      title="Marketplace"
      subtitle="The tenant's data-mesh exchange — discover, publish, share, and subscribe to data products, APIs, and live Delta Sharing data shares in one place."
    >
      {/* useSearchParams in LoomMarketplace requires a Suspense boundary. */}
      <Suspense fallback={null}>
        <LoomMarketplace />
      </Suspense>
    </PageShell>
  );
}
