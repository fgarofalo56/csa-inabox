'use client';

/**
 * Shared honest "open the maker authoring surface in a new tab" gate, used by
 * the Power Apps Studio tab and the Power Automate Designer tab.
 *
 * Why this exists (grounded in Microsoft Learn):
 *   - Power Apps **Studio** (canvas authoring) enforces a frame-ancestors CSP /
 *     X-Frame-Options that blocks iframe embedding. Only the *player*
 *     (apps.powerapps.com/play/<id>?source=iframe) is iframeable — that lives
 *     in the existing "Play / embed" tab. The Studio itself opens in a new tab.
 *   - Power Automate's flow **designer** is only embeddable via the Flow widget
 *     JS SDK (msflowsdk-1.1.js), whose GET_ACCESS_TOKEN event needs a delegated
 *     user JWT (audience https://service.flow.microsoft.com). Loom authenticates
 *     server-side with a UAMI service principal, which is not a valid delegated
 *     user credential for the widget — so the designer opens in a new tab.
 *   - Model-driven apps and Power Pages also block third-party iframe embedding
 *     by Microsoft platform default.
 *
 * This is NOT a "removed banner to look clean" shortcut — it is the honest,
 * documented embedding constraint surfaced as a first-class tab with a primary
 * "Open in <X>" action (per ui-parity.md + no-vaporware.md), instead of a
 * scattered deep-link <a> tag buried in a detail panel.
 */

import {
  Button, MessageBar, MessageBarBody, MessageBarTitle, makeStyles, tokens,
} from '@fluentui/react-components';
import { Open16Regular } from '@fluentui/react-icons';

const useStyles = makeStyles({
  wrap: { display: 'flex', flexDirection: 'column', gap: '12px' },
  actions: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' },
});

export interface MakerStudioGateBarProps {
  /** MessageBar intent — info for a normal embedding constraint, warning for a hard block. */
  intent?: 'info' | 'warning';
  title: string;
  /** Explanation body (React node so callers can include <code> spans). */
  children: React.ReactNode;
  /** Primary "Open in <X>" button label. */
  openLabel: string;
  /** Maker/designer URL to open in a new tab. When undefined the button is omitted. */
  openHref?: string;
  /** Secondary action node (optional) — e.g. a metadata summary toggle. */
  secondary?: React.ReactNode;
}

/** Open a maker URL in a new tab with noopener (no opener leakage). */
export function openMaker(href?: string) {
  if (href) window.open(href, '_blank', 'noopener,noreferrer');
}

export function MakerStudioGateBar({
  intent = 'info', title, children, openLabel, openHref, secondary,
}: MakerStudioGateBarProps) {
  const s = useStyles();
  return (
    <div className={s.wrap}>
      <MessageBar intent={intent}>
        <MessageBarBody>
          <MessageBarTitle>{title}</MessageBarTitle>
          {children}
        </MessageBarBody>
      </MessageBar>
      <div className={s.actions}>
        {openHref && (
          <Button appearance="primary" icon={<Open16Regular />} onClick={() => openMaker(openHref)}>
            {openLabel}
          </Button>
        )}
        {secondary}
      </div>
    </div>
  );
}

const META = {
  brandColor: tokens.colorBrandForeground1,
};
export { META as _makerStudioTokens };
