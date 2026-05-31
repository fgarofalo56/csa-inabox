import { PageShell } from '@/lib/components/page-shell';
import { ApiMarketplace } from '@/lib/components/marketplace/api-marketplace';

export default function ApiMarketplacePage() {
  return (
    <PageShell
      title="API marketplace"
      subtitle="Discover the APIs your tenant publishes through API Management. Browse products and APIs, inspect operations and OpenAPI specs, try a live call through the gateway, and subscribe to request access keys."
    >
      <ApiMarketplace />
    </PageShell>
  );
}
