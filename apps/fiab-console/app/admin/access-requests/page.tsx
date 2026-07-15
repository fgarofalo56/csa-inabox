'use client';

import { AdminShell } from '@/lib/components/admin-shell';
import { AccessRequestsPanel } from '@/lib/components/admin/access-requests-panel';
import { SectionExplainer, LearnPopover } from '@/lib/components/ui/learn-popover';
import { makeStyles, tokens } from '@fluentui/react-components';

const useStyles = makeStyles({
  explainer: { marginBottom: tokens.spacingVerticalL },
});

export default function AdminAccessRequestsPage() {
  const s = useStyles();
  return (
    <AdminShell
      sectionTitle="Access requests"
      learn={{
        title: 'Access requests',
        content:
          "Onboarding queue for people who don't yet have access. Approving a sign-in-boundary “Request access” submission surfaces the exact Entra step to set the person up; denying records a reason. Approval never silently mints access.",
        tips: [
          'Distinct from marketplace subscribe + the F16 asset-access workflow',
          'Backed by the signin-access-requests container (PK /tenantId)',
          'Tenant-admin only',
        ],
        learnMoreHref: 'https://learn.microsoft.com/entra/external-id/b2b-quickstart-add-guest-users-portal',
      }}
    >
      <div className={s.explainer}>
        <SectionExplainer>
          The onboarding queue for people who don&apos;t yet have access to CSA Loom. When someone
          hits the sign-in screen without access, they can use “Request access” to submit their
          Microsoft identity and a reason. Approve a request to see the exact step to onboard them
          (which Entra group to add them to), or deny it with a recorded reason.{' '}
          <LearnPopover
            title="How onboarding works"
            content="Group membership is the authorization source. Approving records the decision and shows you the precise Entra step; Loom does not modify tenant group membership on your behalf, so you add the user to the configured admin/onboarding group in Entra, after which they can sign in. Denials require a note and are written to the audit log."
            tips={['Requests are rate-limited per IP and per email', 'A duplicate pending request from the same email is de-duplicated', 'Set LOOM_ACCESS_REQUEST_WEBHOOK to also get a Teams/Logic App ping on each new request']}
          />
        </SectionExplainer>
      </div>
      <AccessRequestsPanel />
    </AdminShell>
  );
}
