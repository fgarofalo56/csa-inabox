'use client';

import { AdminShell } from '@/lib/components/admin-shell';
import { OrgVisualsPane } from '@/lib/panes/org-visuals';

export default function OrgVisualsPage() {
  return (
    <AdminShell
      sectionTitle="Organizational visuals"
      learn={{
        title: 'Organizational visuals',
        content: 'Upload, version, enable/disable, and remove tenant-wide custom visual bundles (.pbiviz) that report authors can drop into reports. Bundles are stored Azure-natively in Blob storage — no Power BI or Fabric admin portal required — and the enable/disable state controls which visuals are available across the tenant.',
        tips: [
          'Upload a new .pbiviz to add a version; disable rather than delete to retire a visual without breaking existing reports.',
          'Bundles live in Blob storage, so governance follows your Azure storage controls.',
          'Only enabled visuals appear to report authors — use disable to stage or pull a visual quickly.',
        ],
      }}
    >
      <OrgVisualsPane />
    </AdminShell>
  );
}
