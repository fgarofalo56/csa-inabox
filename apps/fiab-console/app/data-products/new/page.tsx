import { DataProductCreateWizard } from '@/lib/data-products/data-product-create-wizard';

/**
 * /data-products/new — the Data Product Creation Wizard (single).
 * Three pages → real Cosmos draft + best-effort Purview Unified Catalog
 * registration, then redirect to /data-products/<id>.
 */
export default function NewDataProductPage() {
  return <DataProductCreateWizard />;
}
