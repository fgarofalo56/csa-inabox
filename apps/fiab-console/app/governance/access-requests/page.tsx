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
import { Badge, tokens } from '@fluentui/react-components';
import { SectionExplainer } from '@/lib/components/ui/learn-popover';
import { TeachingBanner } from '@/lib/components/shared/teaching-toast';
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
      <SectionExplainer>
        When a user requests access to a catalog data asset, the request lands here and advances
        through a multi-tier approval chain &mdash; manager, then privacy, then approver, then access
        provider &mdash; with each tier able to approve or reject. The final approval provisions a
        real Azure RBAC role assignment on the backing store and subscribes the requester; state is
        tracked in Cosmos, with no Microsoft Fabric dependency.
      </SectionExplainer>
      <div style={{ marginBottom: tokens.spacingVerticalL }}>
        <TeachingBanner
          surfaceKey="governance-access-requests"
          title="Approve in tier order"
          message="Each tab is one approval tier — manager, then privacy, then approver, then access provider — and its badge counts the requests awaiting you. Approving advances a request to the next tier; the final Access provider approval provisions a real Azure RBAC grant on the backing store and subscribes the requester."
          learnMoreHref="https://learn.microsoft.com/azure/role-based-access-control/overview"
        />
      </div>
      <Section
        title="Approval workflow"
        actions={<Badge appearance="tint" color="informative">live · Cosmos + Azure RBAC</Badge>}
      >
        <AccessRequestInboxEditor />
      </Section>
    </PageShell>
  );
}
