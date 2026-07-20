'use client';

import { AdminShell } from '@/lib/components/admin-shell';
import { AccessReviewsPanel } from '@/lib/components/admin/access-reviews-panel';
import { SectionExplainer, LearnPopover } from '@/lib/components/ui/learn-popover';
import { makeStyles, tokens } from '@fluentui/react-components';

const useStyles = makeStyles({
  explainer: { marginBottom: tokens.spacingVerticalL },
});

export default function AdminAccessReviewsPage() {
  const s = useStyles();
  return (
    <AdminShell
      sectionTitle="Access reviews"
      learn={{
        title: 'Access reviews & recertification',
        content:
          'Schedule recertification campaigns that ask reviewers to attest or revoke each effective grant, with bulk decisions, reviewer delegation, and auto-revoke of anything left undecided when the campaign closes. The Azure-native 1:1 of Microsoft Entra ID Governance Access Reviews.',
        tips: [
          'Campaigns snapshot in-scope grants from the entitlement ledger (PK /principalId)',
          'Every revoke runs the real ARM / data-plane revoke, then marks the ledger row revoked',
          'Auto-revoke-on-close and the deadline sweep enforce "no response = removed"',
          'Entra group targets reconcile via read-only Graph (opt-in graph-group-sync gate)',
        ],
        learnMoreHref: 'https://learn.microsoft.com/entra/id-governance/access-reviews-overview',
      }}
    >
      <div className={s.explainer}>
        <SectionExplainer>
          Run <strong>recertification campaigns</strong> — reviewers attest or revoke access on a
          cadence, in bulk, with delegation and auto-revoke on no-response. Reconcile{' '}
          <strong>Entra group-targeted</strong> packages and run a <strong>leaver revoke-all</strong>{' '}
          when someone departs.{' '}
          <LearnPopover
            title="Real backend, real revokes"
            content="A campaign snapshots the in-scope grants from the access-assignments entitlement ledger. Attest records a decision; Revoke tears down the real Azure grant (ARM role assignment + Synapse/ADX/storage data-plane) and marks the ledger row revoked — the same path the expiry sweeper uses. Closing a campaign auto-revokes anything still undecided when you opted in."
            tips={['The review sweep closes past-deadline campaigns automatically', 'Group sync is read-only on Entra — Loom never mutates tenant groups']}
          />
        </SectionExplainer>
      </div>
      <AccessReviewsPanel />
    </AdminShell>
  );
}
