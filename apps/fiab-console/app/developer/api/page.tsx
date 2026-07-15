'use client';

import { makeStyles, tokens } from '@fluentui/react-components';
import { PageShell } from '@/lib/components/page-shell';
import { ApiExplorer } from '@/lib/components/developer/api-explorer';
import { SectionExplainer, LearnPopover } from '@/lib/components/ui/learn-popover';

const useStyles = makeStyles({
  explainer: { marginBottom: tokens.spacingVerticalL },
});

export default function DeveloperApiPage() {
  const s = useStyles();
  return (
    <PageShell
      title="Developer — API reference"
      subtitle="The full OpenAPI 3.1 contract for the Loom REST API, browsable and copy-ready."
      breadcrumbs={[{ label: 'Home', href: '/' }, { label: 'Developer', href: '/developer' }, { label: 'API reference' }]}
    >
      <div className={s.explainer}>
        <SectionExplainer>
          Every capability in Loom is reachable through this REST API — the same surface the{' '}
          <code>loom</code> CLI, the Loom SDK, and the Terraform module ride on. Authenticate with a
          scoped API token (Settings → Developer → API tokens) and call any route below.{' '}
          <LearnPopover
            title="OpenAPI + codegen"
            content="The machine-readable spec lives at /api/openapi.json (unauthenticated). Feed it to openapi-generator, Postman, or your SDK codegen to produce a typed client for any language. The server URL in the spec is this deployment, so generated clients target the right cloud (Commercial or Government) automatically."
            tips={[
              'GET /api/openapi.json → the raw OpenAPI 3.1 document',
              'curl -H "Authorization: Bearer loom_pat_…" <host>/api/v1/whoami',
              'openapi-generator-cli generate -i <host>/api/openapi.json -g python',
            ]}
            learnMoreHref="https://spec.openapis.org/oas/v3.1.0"
          />
        </SectionExplainer>
      </div>
      <ApiExplorer />
    </PageShell>
  );
}
