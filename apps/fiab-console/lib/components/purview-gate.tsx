'use client';

/**
 * PurviewGate — honest MessageBar surfacing what's required for a
 * given governance surface to render real data.
 *
 * Per .claude/rules/no-vaporware.md: governance sub-pages previously
 * rendered hardcoded arrays of fake assets / classifications / metrics
 * (alice/bob/eve owners, "88% / 23%" metrics, static SVG lineage).
 * This component replaces the fake data with a structured gate that
 * names the missing backend, the env var to set, the bicep module
 * that would deploy it, and a deep-link to the upstream Purview portal.
 */

import { MessageBar, MessageBarBody, MessageBarTitle, Caption1, makeStyles, tokens } from '@fluentui/react-components';
import { Open20Regular } from '@fluentui/react-icons';

export interface PurviewGateProps {
  /** Short label for the surface ("Data catalog", "Classifications", ...). */
  surface: string;
  /** BFF route that would back this surface when implemented. */
  backendRoute: string;
  /** Env var that needs to be set on the Container App. */
  envVar: string;
  /** Bicep module that would provision the resource. */
  bicepModule: string;
  /** Optional Purview portal deep-link to surface as system-of-record. */
  purviewDeepLink?: string;
}

const useStyles = makeStyles({
  link: { color: tokens.colorBrandForeground1, marginLeft: 4, display: 'inline-flex', alignItems: 'center', gap: 4 },
});

export function PurviewGate({ surface, backendRoute, envVar, bicepModule, purviewDeepLink }: PurviewGateProps) {
  const s = useStyles();
  return (
    <MessageBar intent="warning">
      <MessageBarBody>
        <MessageBarTitle>{surface} is not wired in this deployment</MessageBarTitle>
        Real Purview-backed data requires:
        <ul style={{ marginTop: 6, marginBottom: 6, paddingLeft: 18 }}>
          <li>Backend route <code>{backendRoute}</code> (not yet implemented)</li>
          <li>Env var <code>{envVar}</code> set on the Loom container app</li>
          <li>Bicep module <code>{bicepModule}</code> provisioning the Purview account + scans</li>
          <li>Console UAMI granted <strong>Purview Data Source Administrator</strong> + <strong>Data Curator</strong></li>
        </ul>
        {purviewDeepLink && (
          <Caption1>
            For now, open the Purview portal directly:
            <a className={s.link} href={purviewDeepLink} target="_blank" rel="noreferrer">
              {purviewDeepLink} <Open20Regular />
            </a>
          </Caption1>
        )}
      </MessageBarBody>
    </MessageBar>
  );
}
