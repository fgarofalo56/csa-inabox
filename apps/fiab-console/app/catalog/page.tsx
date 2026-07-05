import { CatalogShell } from '@/lib/components/catalog/catalog-shell';
import { FederatedSearch } from '@/lib/components/catalog/federated-search';

export default function CatalogSearchPage() {
  return (
    <CatalogShell
      sectionTitle="Federated search"
      sectionBadge="Preview"
      explainer={
        <>
          Search your entire governed estate from one box &mdash; a single query fans out to Microsoft
          Purview, Databricks Unity Catalog, and (optionally) Fabric OneLake at once, and results merge
          into one ranked, filterable table. Per-source badges show which back-end contributed each hit,
          and chips let you narrow by source or asset type. Selecting a result opens its detail view;
          if a source isn&apos;t provisioned its chip reads &ldquo;not configured&rdquo; with the exact env
          var or role to enable it. Use Search for keyword discovery across every source; use Browse when
          you already know where an asset lives.
        </>
      }
    >
      <FederatedSearch />
    </CatalogShell>
  );
}
