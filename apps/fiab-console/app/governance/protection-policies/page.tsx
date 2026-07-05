'use client';

/**
 * /governance/protection-policies — EH Phase-1 §2.3 management surface.
 * Mounts the ProtectionPoliciesPane (over /api/admin/protection-policies). The
 * pane self-gates: a 403 from the tenant-admin-gated BFF renders an honest
 * "tenant administrator required" MessageBar. PageShell keeps the Governance
 * web3 look + breadcrumb trail consistent with sibling governance surfaces.
 */

import { PageShell } from '@/lib/components/page-shell';
import { SectionExplainer } from '@/lib/components/ui/learn-popover';
import { ProtectionPoliciesPane } from '@/lib/governance/protection-policies-pane';

export default function ProtectionPoliciesPage() {
  return (
    <PageShell
      title="Protection policies"
      subtitle="Restrict labeled data to an exact allow-list — real RBAC reconcile, sovereign by default."
      breadcrumbs={[{ label: 'Home', href: '/' }, { label: 'Governance', href: '/governance' }, { label: 'Protection policies' }]}
    >
      <SectionExplainer>
        Protection policies restrict access to data carrying a given sensitivity label down to an
        exact allow-list of principals &mdash; a restrict-only model that reconciles into real Azure
        RBAC role assignments on the labeled resources. It is sovereign by default with no Microsoft
        Fabric dependency; managing policies requires a tenant administrator, and the surface renders
        an honest gate otherwise.
      </SectionExplainer>
      <ProtectionPoliciesPane />
    </PageShell>
  );
}
