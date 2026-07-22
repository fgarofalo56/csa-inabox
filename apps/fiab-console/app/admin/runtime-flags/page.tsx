'use client';

import { AdminShell } from '@/lib/components/admin-shell';
import { AdminRuntimeFlagsPane } from '@/lib/panes/admin-runtime-flags';
import { SectionExplainer } from '@/lib/components/ui/learn-popover';
import { makeStyles, tokens } from '@fluentui/react-components';

const useStyles = makeStyles({
  explainer: { marginBottom: tokens.spacingVerticalL },
});

export default function AdminRuntimeFlagsPage() {
  const s = useStyles();
  return (
    <AdminShell
      sectionTitle="Runtime flags"
      learn={{
        title: 'Runtime kill-switches',
        content:
          'Cosmos-backed, default-ON operational flags. When a user-visible feature regresses in production, flip its flag OFF here to revert the surface to its previous behavior in seconds — no git revert, no image rebuild, no ACA revision roll.',
        tips: [
          'Default-ON: a missing flag doc means enabled — flags never gate a feature',
          'Every flip is audited (who, prior/new, timestamp) and streamed to the SIEM trail',
          'Replicas converge within ~15 seconds (short-TTL read cache)',
        ],
        learnMoreHref: 'https://learn.microsoft.com/azure/azure-app-configuration/concept-feature-management',
      }}
    >
      <div className={s.explainer}>
        <SectionExplainer>
          Operational kill-switches for user-visible features. Each registered flag is default-ON;
          flipping it OFF reverts the owning surface to its pre-feature render path on the next page
          load — cutting a regression&apos;s time-to-revert from a rebuild-and-roll (~15–30 min) to a
          toggle (seconds). Flags are never spend or configuration gates.
        </SectionExplainer>
      </div>
      <AdminRuntimeFlagsPane />
    </AdminShell>
  );
}
