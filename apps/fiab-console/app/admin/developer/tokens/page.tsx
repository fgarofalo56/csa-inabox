'use client';

import { makeStyles, tokens } from '@fluentui/react-components';
import { AdminShell } from '@/lib/components/admin-shell';
import { TokensPane } from '@/lib/components/developer/tokens-pane';
import { SectionExplainer, LearnPopover } from '@/lib/components/ui/learn-popover';

const useStyles = makeStyles({
  explainer: { marginBottom: tokens.spacingVerticalL },
});

export default function AdminDeveloperTokensPage() {
  const s = useStyles();
  return (
    <AdminShell sectionTitle="API tokens">
      <div className={s.explainer}>
        <SectionExplainer>
          Every scoped API token (PAT) in your tenant — who created it, its scope, when it was last used, and when it expires.
          Users create and manage their own tokens under Settings → Developer; here a tenant admin has org-wide oversight and can
          revoke any token immediately.{' '}
          <LearnPopover
            title="Scoped API tokens"
            content="Non-interactive clients (CI, Terraform, SCIM, scripts) authenticate with a bearer token instead of a browser session. Tokens carry a typed scope (read-only / read-write / admin), expire within 90 days, and store only a one-way hash server-side. Create, revoke, and use-after-revoke all emit to the SIEM audit stream."
            tips={[
              'Revoking a token takes effect immediately on the next request.',
              'An admin-scoped token only reaches admin surfaces while its creator is still a tenant admin.',
              'Loom stores a SHA-256 hash — the secret is shown once and never again.',
            ]}
            learnMoreHref="https://learn.microsoft.com/entra/identity-platform/access-tokens"
          />
        </SectionExplainer>
      </div>
      <TokensPane admin />
    </AdminShell>
  );
}
