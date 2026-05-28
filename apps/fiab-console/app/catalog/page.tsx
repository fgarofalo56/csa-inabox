import { CatalogShell } from '@/lib/components/catalog/catalog-shell';
import { FederatedSearch } from '@/lib/components/catalog/federated-search';

export default function CatalogSearchPage() {
  return (
    <CatalogShell sectionTitle="Federated search" sectionBadge="Preview">
      <FederatedSearch />
    </CatalogShell>
  );
}
