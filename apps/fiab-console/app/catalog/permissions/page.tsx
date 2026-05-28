import { CatalogShell } from '@/lib/components/catalog/catalog-shell';
import { PermissionMatrix } from '@/lib/components/catalog/permission-matrix';

export default function CatalogPermissionsPage() {
  return (
    <CatalogShell sectionTitle="Permissions" sectionBadge="Federated">
      <PermissionMatrix />
    </CatalogShell>
  );
}
