'use client';

/**
 * PowerAutomateDesignerTab — the "Designer" authoring tab for a cloud flow.
 *
 * Surfaces flow authoring as a first-class tab in Loom instead of a buried
 * deep-link. Microsoft Learn (power-automate/developer/embed-flow-dev) confirms
 * the only embedding path for the flow designer is the Flow widget JS SDK
 * (msflowsdk-1.1.js), whose GET_ACCESS_TOKEN event requires a *delegated user*
 * JWT with audience https://service.flow.microsoft.com. The Loom Console
 * authenticates server-side with a UAMI service principal, which is not a valid
 * delegated user credential for the widget — so the designer can't be embedded
 * and instead opens in a new tab. No fake designer, no dead control.
 *
 * The flow metadata (state, trigger, timestamps) is shown alongside so the tab
 * is informative on its own, matching the make.powerautomate.com flow details
 * header.
 */

import {
  Badge, Caption1, makeStyles, tokens,
} from '@fluentui/react-components';
import { MakerStudioGateBar } from './maker-studio';

const useStyles = makeStyles({
  wrap: { display: 'flex', flexDirection: 'column', gap: '12px' },
  metaGrid: { display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 16px', alignItems: 'baseline' },
  metaKey: { color: tokens.colorNeutralForeground3, fontSize: '12px' },
});

export interface DesignerFlowMeta {
  name: string;
  displayName: string;
  state?: string;
  triggerType?: string;
  createdTime?: string;
  lastModifiedTime?: string;
}

export interface PowerAutomateDesignerTabProps {
  envId?: string | null;
  flowId?: string | null;
  flow?: DesignerFlowMeta | null;
}

/** make.powerautomate.com flow designer URL for a flow in an environment. */
export function flowDesignerHref(envId: string, flowId: string): string {
  return `https://make.powerautomate.com/environments/${encodeURIComponent(envId)}/flows/${encodeURIComponent(flowId)}/details`;
}

export function PowerAutomateDesignerTab({ envId, flowId, flow }: PowerAutomateDesignerTabProps) {
  const s = useStyles();

  if (!flowId || !envId) {
    return (
      <div className={s.wrap}>
        <Caption1>Select a cloud flow to open its designer.</Caption1>
      </div>
    );
  }

  return (
    <div className={s.wrap} data-testid="pa-designer">
      <MakerStudioGateBar
        intent="info"
        title="Flow designer requires a delegated user token — opens in a new tab"
        openLabel="Open in Flow Designer"
        openHref={flowDesignerHref(envId, flowId)}
      >
        The Power Automate flow designer is only embeddable through the Flow widget JS SDK
        (<code>msflowsdk-1.1.js</code>), whose <code>GET_ACCESS_TOKEN</code> event expects a delegated
        user JWT with audience <code>https://service.flow.microsoft.com</code>. Loom authenticates with
        a UAMI service principal server-side, which is not a valid delegated user credential for the
        widget. Opening it here launches the cloud-flow designer in a new browser tab. Triggering runs
        and reviewing run history remain available on the <strong>Runs</strong> view of this editor.
      </MakerStudioGateBar>

      {flow && (
        <div className={s.metaGrid}>
          <span className={s.metaKey}>Display name</span><span><strong>{flow.displayName}</strong></span>
          <span className={s.metaKey}>Flow id</span><span><code>{flow.name}</code></span>
          <span className={s.metaKey}>State</span>
          <span>
            <Badge appearance="tint" color={flow.state === 'Started' ? 'success' : flow.state === 'Stopped' ? 'danger' : 'subtle'}>
              {flow.state || '—'}
            </Badge>
          </span>
          <span className={s.metaKey}>Trigger</span><span>{flow.triggerType || '—'}</span>
          <span className={s.metaKey}>Created</span><span>{flow.createdTime || '—'}</span>
          <span className={s.metaKey}>Modified</span><span>{flow.lastModifiedTime || '—'}</span>
        </div>
      )}
    </div>
  );
}
