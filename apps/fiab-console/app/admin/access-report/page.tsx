'use client';

import { AdminShell } from '@/lib/components/admin-shell';
import { AccessReportPanel } from '@/lib/components/admin/access-report-panel';
import { SectionExplainer, LearnPopover } from '@/lib/components/ui/learn-popover';
import { makeStyles, tokens } from '@fluentui/react-components';

const useStyles = makeStyles({
  explainer: { marginBottom: tokens.spacingVerticalL },
});

export default function AdminAccessReportPage() {
  const s = useStyles();
  return (
    <AdminShell
      sectionTitle="Access report"
      learn={{
        title: 'Who has access',
        content:
          'A unified view of every effective access grant across Loom — answer "what can this person reach?" and "who has access to this resource?" from one place. Merges the entitlement ledger, live workspace ACLs, and Entra group membership.',
        tips: [
          'Backed by the access-assignments entitlement ledger (PK /principalId)',
          'Per-resource view expands Entra groups to their members where Graph is available',
          'Run backfill once to seed the ledger from existing grants',
          'Tenant-admin only',
        ],
        learnMoreHref: 'https://learn.microsoft.com/entra/id-governance/entitlement-management-overview',
      }}
    >
      <div className={s.explainer}>
        <SectionExplainer>
          Every effective access grant in Loom, in one report. Look up a <strong>principal</strong> to
          see everything they can reach, or a <strong>resource</strong> to see everyone who can reach
          it — direct grants, data-product subscriptions, and workspace roles, with Entra group members
          expanded where available.{' '}
          <LearnPopover
            title="Where the data comes from"
            content="The report merges the access-assignments entitlement ledger (written by every grant path going forward) with the live workspace-roles ACL container, de-duplicating the same effective grant. If the ledger is empty, run Backfill to seed it from your existing F15/F16 requests and workspace ACLs."
            tips={['CSV export respects the current filter', 'Group expansion is honest — it no-ops when Graph identity is not configured']}
          />
        </SectionExplainer>
      </div>
      <AccessReportPanel />
    </AdminShell>
  );
}
