'use client';

import { GovernanceShell } from '@/lib/components/governance-shell';
import {
  Body1, Caption1, Subtitle2, Badge, Button, Input,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Open24Regular } from '@fluentui/react-icons';
import { useState } from 'react';

/**
 * Purview integration page — passthrough embed of Microsoft Purview's
 * web portal inside Loom. When PURVIEW_ACCOUNT is configured, we embed
 * the Unified Catalog via iframe; otherwise we render configuration
 * UI so the operator can wire the connection.
 *
 * Why iframe instead of API stitching: Purview's full Atlas catalog
 * UX is huge (search, lineage, glossary, business terms, mass-edit).
 * Replicating all of it in Loom would take months. The integration
 * pattern: native experience in Loom for top-N workflows (catalog
 * browse, classifications, labels, scans, policies), embed Purview
 * for everything else.
 */

const useStyles = makeStyles({
  shell: { display: 'flex', flexDirection: 'column', gap: 12 },
  config: {
    padding: 16, border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: 8, backgroundColor: tokens.colorNeutralBackground1,
    display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 640,
  },
  frame: {
    width: '100%', height: '70vh',
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 8,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  placeholder: {
    width: '100%', height: '60vh',
    border: `2px dashed ${tokens.colorNeutralStroke2}`, borderRadius: 8,
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    color: tokens.colorNeutralForeground3, gap: 12, textAlign: 'center', padding: 24,
  },
});

export default function PurviewPage() {
  const s = useStyles();
  const [account, setAccount] = useState('');
  const [embedded, setEmbedded] = useState(false);

  return (
    <GovernanceShell sectionTitle="Microsoft Purview" sectionBadge="Embedded">
      <Body1 style={{ color: tokens.colorNeutralForeground3, marginBottom: 12 }}>
        Purview&apos;s full Unified Catalog, Atlas lineage explorer, glossary, and business terms — embedded inside Loom. Single-sign-on via the same Entra ID session you used to enter Loom.
      </Body1>
      {!embedded ? (
        <div className={s.shell}>
          <div className={s.config}>
            <Subtitle2>Connect a Purview account</Subtitle2>
            <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
              Loom will deep-link into your existing Purview account and route the user&apos;s OBO token. No data copies — your existing scans, glossary, and policies stay where they are.
            </Caption1>
            <div>
              <Caption1>Purview account name</Caption1>
              <Input value={account} onChange={(_, d) => setAccount(d.value)} placeholder="contoso-purview" />
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <Button appearance="primary" disabled={!account.trim()} onClick={() => setEmbedded(true)}>
                Embed Purview
              </Button>
              <Button appearance="secondary" as="a" href="https://web.purview.azure.com" target="_blank" rel="noreferrer" icon={<Open24Regular />}>
                Open in new tab
              </Button>
            </div>
            <div>
              <Badge appearance="outline" color="brand">Tip</Badge>
              <span style={{ marginLeft: 8, color: tokens.colorNeutralForeground3 }}>
                If your Purview account is private (private endpoint), Loom routes the iframe through its BFF. Public Purview accounts embed directly.
              </span>
            </div>
          </div>
          <div className={s.placeholder} role="region" aria-label="Purview embed preview">
            <Subtitle2>Purview portal preview</Subtitle2>
            <Caption1>Will load <code>https://web.purview.azure.com/resource/{'{account}'}</code> once connected.</Caption1>
          </div>
        </div>
      ) : (
        // In real impl: <iframe src={`https://web.purview.azure.com/resource/${account}`} sandbox="allow-scripts allow-same-origin allow-forms allow-popups" />
        <div className={s.placeholder}>
          <Subtitle2>Purview portal would render here</Subtitle2>
          <Body1>Account: <code>{account}</code></Body1>
          <Caption1>The real iframe needs Purview&apos;s X-Frame-Options to allow loom-console-* origin, which is set when the operator runs <code>az purview account update --frame-ancestors</code>.</Caption1>
          <Button appearance="secondary" onClick={() => setEmbedded(false)}>Reconfigure</Button>
        </div>
      )}
    </GovernanceShell>
  );
}
