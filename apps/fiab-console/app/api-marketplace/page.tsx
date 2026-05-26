import { PageShell } from '@/lib/components/page-shell';
import { ItemsByTypePane } from '@/lib/components/items-by-type-pane';

export default function ApiMarketplacePage() {
  return (
    <PageShell
      title="API marketplace"
      subtitle="Every API your tenant exposes via APIM — apis, products, and policies. Click into one to manage operations, subscriptions, and quotas."
    >
      <ItemsByTypePane
        types={['apim-api', 'apim-product', 'apim-policy']}
        emptyHint="No APIM items in this tenant yet."
      />
    </PageShell>
  );
}
