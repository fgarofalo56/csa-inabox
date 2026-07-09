'use client';

import { makeStyles, tokens } from '@fluentui/react-components';
import { PageShell } from '@/lib/components/page-shell';
import { TokensPane } from '@/lib/components/developer/tokens-pane';
import { SectionExplainer, LearnPopover } from '@/lib/components/ui/learn-popover';

const useStyles = makeStyles({
  explainer: { marginBottom: tokens.spacingVerticalL },
});

export default function DeveloperTokensPage() {
  const s = useStyles();
  return (
    <PageShell
      title="Developer — API tokens"
      subtitle="Scoped, revocable tokens for calling the Loom API from CI, scripts, and Terraform — without a browser session."
      breadcrumbs={[{ label: 'Home', href: '/' }, { label: 'Settings' }, { label: 'Developer' }]}
    >
      <div className={s.explainer}>
        <SectionExplainer>
          Create a scoped API token to authenticate non-interactive clients with an{' '}
          <code>Authorization: Bearer</code> header instead of a browser sign-in. Pick a scope
          (read-only, read-write, or admin) and an expiry up to 90 days. The full token is shown
          once at creation — Loom keeps only a one-way hash.{' '}
          <LearnPopover
            title="Using your token"
            content="Send the token as a bearer header on any Loom API request. Verify it works with GET /api/v1/whoami, which echoes your identity and the token's scope. A read-only token can only make GET requests; an admin-scoped token reaches admin surfaces only while you remain a tenant admin. Revoke a token any time — it stops working on the next request."
            tips={[
              'curl -H "Authorization: Bearer loom_pat_…" https://<host>/api/v1/whoami',
              'Store the token in your CI secret store — never commit it.',
              'Rotate by creating a new token and revoking the old one.',
            ]}
            learnMoreHref="https://learn.microsoft.com/entra/identity-platform/access-tokens"
          />
        </SectionExplainer>
      </div>
      <TokensPane />
    </PageShell>
  );
}
