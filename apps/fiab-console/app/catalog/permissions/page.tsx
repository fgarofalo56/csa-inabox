import { CatalogShell } from '@/lib/components/catalog/catalog-shell';
import { PermissionMatrix } from '@/lib/components/catalog/permission-matrix';

export default function CatalogPermissionsPage() {
  return (
    <CatalogShell
      sectionTitle="Permissions"
      sectionBadge="Federated"
      explainer={
        <>
          Grant access to catalog assets without leaving Loom. Pick a source, securable, principal, and
          role, and the request fans out to the right back-end privileges automatically &mdash; Databricks
          Unity Catalog <code>GRANT</code>s and Fabric/OneLake roles &mdash; so one Loom role maps to the
          native permissions each platform expects. Every grant is a real POST (no mocked principals or
          fake grants) and the outcome lands in a live, sortable audit log below the form. Use Permissions
          to provision least-privilege access and to keep a reviewable trail of who was granted what.
        </>
      }
    >
      <PermissionMatrix />
    </CatalogShell>
  );
}
