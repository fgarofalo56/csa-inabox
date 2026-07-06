'use client';

/**
 * /governance/workspace-egress — workspace outbound access protection (rel-T89).
 * Mounts the WorkspaceEgressPane (over /api/governance/workspace-egress). The pane
 * self-gates: a 403 from the tenant-admin-gated BFF renders an honest "tenant
 * administrator required" MessageBar. Azure-native parity with Microsoft Fabric's
 * workspace outbound access protection — enforced as real NSG outbound rules, no
 * Fabric dependency. PageShell keeps the Governance web3 look + breadcrumb trail
 * consistent with sibling governance surfaces.
 */

import { PageShell } from '@/lib/components/page-shell';
import { SectionExplainer } from '@/lib/components/ui/learn-popover';
import { WorkspaceEgressPane } from '@/lib/governance/workspace-egress-pane';

export default function WorkspaceEgressPage() {
  return (
    <PageShell
      title="Outbound access protection"
      subtitle="Restrict a workspace's data-plane compute to an exact outbound allow-list — real Azure NSG egress rules, sovereign by default."
      breadcrumbs={[{ label: 'Home', href: '/' }, { label: 'Governance', href: '/governance' }, { label: 'Outbound access protection' }]}
    >
      <SectionExplainer>
        Workspace outbound access protection lets a tenant administrator define, per workspace, an
        allow-list of outbound destinations (Azure service tags, IPv4 ranges, or FQDNs) for the
        workspace&apos;s data-plane compute. Service-tag and IP destinations are enforced as real
        Azure Network Security Group outbound rules on the compute subnet; with default-deny on, a
        final Deny-to-Internet rule ensures only the allow-list can egress. FQDN destinations are
        saved and reported as needing an Azure Firewall application rule. This is the Azure-native
        one-for-one of Microsoft Fabric&apos;s workspace outbound access protection, with no Microsoft
        Fabric dependency; managing policies requires a tenant administrator.
      </SectionExplainer>
      <WorkspaceEgressPane />
    </PageShell>
  );
}
