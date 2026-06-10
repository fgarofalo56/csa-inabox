'use client';

/**
 * PowerAppsStudioTab — the "Studio" authoring tab for a bound Power App.
 *
 * Surfaces canvas/model-driven authoring as a first-class tab in Loom instead
 * of a buried "Open in maker" link. Microsoft Learn confirms:
 *   - Power Apps Studio (canvas authoring) cannot be iframed — it sends a
 *     frame-ancestors CSP. The embeddable player is in the "Play / embed" tab.
 *   - Model-driven apps don't support third-party iframe embedding at all
 *     (power-apps/maker/.../limits-and-config). They open in the maker / app URL.
 *
 * The tab renders the honest constraint + a primary "Open Canvas Studio" (or
 * "Open in maker" for model-driven) button. No fake designer, no dead control.
 */

import { Caption1, makeStyles } from '@fluentui/react-components';
import { MakerStudioGateBar } from './maker-studio';

const useStyles = makeStyles({
  wrap: { display: 'flex', flexDirection: 'column', gap: '12px' },
});

export interface PowerAppsStudioTabProps {
  /** Power Apps app id (GUID). */
  appId?: string;
  /** Power Platform environment id. */
  envId?: string | null;
  /** appType — used to detect model-driven (no iframe authoring). */
  appType?: string;
  /** Optional display name for the heading. */
  displayName?: string;
}

/** make.powerapps.com canvas studio URL for an app in an environment. */
export function canvasStudioHref(envId: string, appId: string): string {
  return `https://make.powerapps.com/e/${encodeURIComponent(envId)}/studio/${encodeURIComponent(appId)}`;
}

/** make.powerapps.com maker apps URL (model-driven authoring entry). */
export function makerAppsHref(envId: string): string {
  return `https://make.powerapps.com/environments/${encodeURIComponent(envId)}/apps`;
}

export function PowerAppsStudioTab({ appId, envId, appType, displayName }: PowerAppsStudioTabProps) {
  const s = useStyles();
  const isModelDriven = (appType || '').toLowerCase().includes('modeldriven');

  if (!appId || !envId) {
    return (
      <div className={s.wrap}>
        <Caption1>Bind this item to a Power App to open its authoring studio.</Caption1>
      </div>
    );
  }

  if (isModelDriven) {
    return (
      <div className={s.wrap} data-testid="pa-studio-modeldriven">
        <MakerStudioGateBar
          intent="warning"
          title="Model-driven apps cannot be embedded — author in the maker portal"
          openLabel="Open in maker"
          openHref={makerAppsHref(envId)}
        >
          Microsoft documentation confirms model-driven apps and pages don&apos;t support third-party
          iframe embedding. The app designer (forms, views, charts, dashboards, sitemap) runs in the
          Power Apps maker portal. The full editor surface — details, connectors, publish, play/open —
          remains available on the other tabs of this editor.
        </MakerStudioGateBar>
      </div>
    );
  }

  return (
    <div className={s.wrap} data-testid="pa-studio-canvas">
      <MakerStudioGateBar
        intent="info"
        title="Canvas Studio opens in a new tab"
        openLabel="Open Canvas Studio"
        openHref={canvasStudioHref(envId, appId)}
      >
        Power Apps Studio (the canvas authoring environment for{displayName ? ` ${displayName}` : ' this app'})
        enforces a <code>frame-ancestors</code> Content-Security-Policy and cannot be embedded in an iframe.
        Opening it here launches the studio in a new browser tab. Your changes auto-save back to the
        environment, and the <strong>Play / embed</strong> tab in this editor reflects the latest published
        revision. Use the <strong>Publish latest revision</strong> action on the Details tab to make saved
        changes live for shared users.
      </MakerStudioGateBar>
    </div>
  );
}
