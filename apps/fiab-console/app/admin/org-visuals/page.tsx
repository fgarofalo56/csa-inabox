'use client';

import { AdminShell } from '@/lib/components/admin-shell';
import { OrgVisualsPane } from '@/lib/panes/org-visuals';

export default function OrgVisualsPage() {
  return (
    <AdminShell sectionTitle="Organizational visuals">
      <OrgVisualsPane />
    </AdminShell>
  );
}
