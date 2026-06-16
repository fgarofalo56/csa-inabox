'use client';

/**
 * /org-reports — Organization reports consumer gallery.
 *
 * A top-level surface (visible to every authenticated member) where colleagues
 * browse and open CoE reports published to the organization. The admin-side
 * clone + publish lives in Admin → Organizational visuals; this is the consumer
 * half. Azure-native — no Microsoft Fabric / Power BI workspace.
 */

import * as React from 'react';
import { PageShell } from '@/lib/components/page-shell';
import { OrgReportsPane } from '@/lib/coe-library/org-reports-pane';

export default function OrgReportsPage(): React.ReactElement {
  return (
    <PageShell
      title="Organization reports"
      subtitle="CoE reports published to your organization — open any one to view it."
    >
      <OrgReportsPane />
    </PageShell>
  );
}
