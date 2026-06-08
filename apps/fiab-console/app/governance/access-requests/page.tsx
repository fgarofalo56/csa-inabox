'use client';

/**
 * /governance/access-requests — the F16 multi-tier access-request approval
 * inbox. Hosts the AccessRequestInboxEditor inside the standard PageShell so
 * the e2e h1-coverage check passes and the surface matches every other
 * governance page.
 *
 * The workflow: a requester asks for access to a catalog data asset
 * (Governance → Data catalog → Request access). The request lands here at the
 * Manager tier and advances manager → privacy → approver → access provider as
 * each tier approves. The final approval provisions a real Azure RBAC grant on
 * the backing store and subscribes the requester. No Microsoft Fabric needed.
 */

import { PageShell } from '@/lib/components/page-shell';
import { Section } from '@/lib/components/ui/section';
import { Badge } from '@fluentui/react-components';
import { AccessRequestInboxEditor } from '@/lib/editors/access-request-inbox';

export default function AccessRequestsPage() {
  return (
    <PageShell
      title="Access requests"
      subtitle="Multi-tier approval inbox for data-asset access — manager, privacy, approver, then access provider. The final approval provisions a real Azure RBAC grant on the backing store."
      breadcrumbs={[
        { label: 'Home', href: '/' },
        { label: 'Governance', href: '/governance' },
        { label: 'Access requests' },
      ]}
    >
      <Section
        title="Approval workflow"
        actions={<Badge appearance="tint" color="informative">live · Cosmos + Azure RBAC</Badge>}
      >
        <AccessRequestInboxEditor />
      </Section>
    </PageShell>
  );
}
