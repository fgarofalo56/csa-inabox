'use client';

import { AdminShell } from '@/lib/components/admin-shell';
import { AccessPackagesPanel } from '@/lib/components/admin/access-packages-panel';
import { SectionExplainer, LearnPopover } from '@/lib/components/ui/learn-popover';
import { makeStyles, tokens } from '@fluentui/react-components';

const useStyles = makeStyles({
  explainer: { marginBottom: tokens.spacingVerticalL },
});

export default function AdminAccessPackagesPage() {
  const s = useStyles();
  return (
    <AdminShell
      sectionTitle="Access packages"
      learn={{
        title: 'Access packages & approval policies',
        content:
          'Bundle related grants into a single requestable access package, and define who approves requests. A package groups {resource, role} grants; an approval policy picks which of the four approval stages apply and who approves each. Separation-of-duties rules block incompatible package combinations.',
        tips: [
          'Requesting a package opens one approval per grant in the standard inbox',
          'The default approval policy = the full four-stage chain (unchanged)',
          'SoD conflicts can block or warn at request time',
          'Tenant-admin only',
        ],
        learnMoreHref: 'https://learn.microsoft.com/entra/id-governance/entitlement-management-access-package-create',
      }}
    >
      <div className={s.explainer}>
        <SectionExplainer>
          Author <strong>access packages</strong> — reusable bundles of grants users can request in one
          click — and the <strong>approval policies</strong> that govern them. A package request opens the
          normal multi-tier approval per grant; the final approval provisions real Azure RBAC.{' '}
          <LearnPopover
            title="Packages, policies & SoD"
            content="An approval policy selects an ordered subset of the four canonical stages (manager, privacy reviewer, approver, access provider) and can name approvers per stage. The default policy enables all four — identical to the built-in chain. A separation-of-duties rule marks two packages incompatible: requesting one while holding the other blocks (or warns)."
            tips={['Everything is authored with pickers — no JSON', 'The final access-provider stage is always on so a grant can complete']}
          />
        </SectionExplainer>
      </div>
      <AccessPackagesPanel />
    </AdminShell>
  );
}
