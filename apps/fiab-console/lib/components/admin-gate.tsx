'use client';

/**
 * AdminGate — honest MessageBar for admin sub-pages that don't yet have
 * a real backend. Mirrors the PurviewGate pattern. Replaces 7 EmptyState
 * placeholders the v2 validator flagged as F-grade vaporware.
 */

import { MessageBar, MessageBarBody, MessageBarTitle, Caption1, makeStyles, tokens } from '@fluentui/react-components';
import { Open20Regular } from '@fluentui/react-icons';

export interface AdminGateProps {
  surface: string;
  backendRoute: string;
  envVar?: string;
  cosmosContainer?: string;
  bicepModule?: string;
  /** Upstream system-of-record (M365 admin, Entra portal, Purview, etc.) */
  deepLink?: string;
  deepLinkLabel?: string;
  /** Additional explanation. */
  extra?: string;
}

const useStyles = makeStyles({
  link: { color: tokens.colorBrandForeground1, marginLeft: tokens.spacingHorizontalXS, display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalXS },
});

export function AdminGate({ surface, backendRoute, envVar, cosmosContainer, bicepModule, deepLink, deepLinkLabel, extra }: AdminGateProps) {
  const s = useStyles();
  return (
    <MessageBar intent="warning">
      <MessageBarBody>
        <MessageBarTitle>{surface} is not wired in this deployment</MessageBarTitle>
        Requires:
        <ul style={{ marginTop: tokens.spacingVerticalSNudge, marginBottom: tokens.spacingVerticalSNudge, paddingLeft: tokens.spacingHorizontalXL }}>
          <li>Backend route <code>{backendRoute}</code> (not yet implemented)</li>
          {envVar && <li>Env var <code>{envVar}</code> set on the Loom container app</li>}
          {cosmosContainer && <li>Cosmos container <code>{cosmosContainer}</code></li>}
          {bicepModule && <li>Bicep module <code>{bicepModule}</code></li>}
        </ul>
        {extra && <Caption1 style={{ display: 'block', marginBottom: tokens.spacingVerticalSNudge }}>{extra}</Caption1>}
        {deepLink && (
          <Caption1>
            For now, use the system of record:
            <a className={s.link} href={deepLink} target="_blank" rel="noreferrer">
              {deepLinkLabel || deepLink} <Open20Regular />
            </a>
          </Caption1>
        )}
      </MessageBarBody>
    </MessageBar>
  );
}
