'use client';

/**
 * PurviewGate — honest, well-designed infra gate for every governance /
 * unified-catalog surface that needs Microsoft Purview.
 *
 * Per .claude/rules/no-vaporware.md + ui-parity.md: when the runtime
 * requires infrastructure that isn't wired in this deployment, the UI MUST
 * show a Fluent MessageBar (intent="warning") that names the EXACT env var,
 * bicep module, and UAMI roles to provision — and the full surface still
 * renders around it. This gate is NOT a dead end: it is the single source of
 * truth for "what one-time action makes this surface go live."
 *
 * It is driven by the real /api/governance/purview/status probe, so it tells
 * the operator the actual reason (not configured vs. cross-cloud Commercial↔Gov
 * mismatch vs. an upstream Purview error) instead of a generic stub banner.
 *
 * Usage:
 *   const { status, reload } = usePurviewStatus();
 *   <PurviewGate status={status} surface="Scans & sources" reload={reload} />
 *   // renders a small "live" chip when connected, the warning bar otherwise.
 *   ... full surface renders below, querying its real backend route ...
 */

import { useCallback, useEffect, useState } from 'react';
import {
  MessageBar, MessageBarBody, MessageBarTitle, MessageBarActions,
  Button, Caption1, Spinner, Badge, makeStyles, tokens,
} from '@fluentui/react-components';
import { Open16Regular, ArrowSync16Regular, ShieldCheckmark20Regular } from '@fluentui/react-icons';

/** Shape returned by GET /api/governance/purview/status. */
export interface PurviewStatus {
  /** true when LOOM_PURVIEW_ACCOUNT is set AND the data-plane answered. */
  configured: boolean;
  /** the resolved Purview account name (when configured). */
  account?: string;
  /** machine reason. */
  reason: 'live' | 'not_configured' | 'cross_cloud' | 'upstream_error' | 'loading';
  /** human message. */
  message?: string;
  /** structured remediation hint (env var, bicep, roles, follow-up). */
  hint?: {
    missingEnvVar?: string;
    bicepModule?: string;
    bicepStatus?: string;
    rolesRequired?: { name: string; scope: string; reason: string }[];
    followUp?: string;
  };
  /** Purview portal deep-link for the system-of-record fallback. */
  purviewPortal?: string;
}

const PURVIEW_PORTAL = 'https://purview.microsoft.com/';
const BOOTSTRAP_DOC =
  'https://github.com/fgarofalo56/csa-inabox/blob/main/docs/fiab/v3-tenant-bootstrap.md#microsoft-purview-unified-catalog';

/** Default hint used when the probe can't reach the data plane at all. */
const DEFAULT_HINT: NonNullable<PurviewStatus['hint']> = {
  missingEnvVar: 'LOOM_PURVIEW_ACCOUNT',
  bicepModule: 'platform/fiab/bicep/modules/admin-plane/catalog.bicep',
  bicepStatus:
    'catalog.bicep deploys Microsoft.Purview/accounts and wires LOOM_PURVIEW_ACCOUNT into the Console app when purviewEnabled = true.',
  rolesRequired: [
    { name: 'Data Curator', scope: 'Governance domain (Purview portal — not ARM RBAC)', reason: 'Read business domains, glossary terms, and governed assets.' },
    { name: 'Data Product Owner', scope: 'Governance domain (Purview portal — not ARM RBAC)', reason: 'Create / publish / update data products via the Unified Catalog plane.' },
    { name: 'Data Reader', scope: 'Data Map collection (Purview portal — not ARM RBAC)', reason: 'Browse assets, lineage, scans, and classifications.' },
  ],
  followUp:
    'Set LOOM_PURVIEW_ACCOUNT to a Purview account in the SAME cloud as the Loom Console, grant the Console UAMI the three roles at the governance-domain level, then restart the Console app.',
};

const useStyles = makeStyles({
  list: { marginTop: 6, marginBottom: 6, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 2 },
  roleRow: { fontSize: 12, color: tokens.colorNeutralForeground2 },
  liveRow: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 },
});

/**
 * Hook: probes the deployment's Purview wiring once and exposes the status.
 * Surfaces call this, render the gate when not live, and render their full
 * UI regardless (gated controls disable themselves when !configured).
 */
export function usePurviewStatus(): { status: PurviewStatus; reload: () => void } {
  const [status, setStatus] = useState<PurviewStatus>({ configured: false, reason: 'loading' });

  const reload = useCallback(async () => {
    setStatus({ configured: false, reason: 'loading' });
    try {
      const r = await fetch('/api/governance/purview/status');
      const j = await r.json().catch(() => null);
      if (j && typeof j.configured === 'boolean') {
        setStatus(j as PurviewStatus);
      } else {
        setStatus({ configured: false, reason: 'not_configured', hint: DEFAULT_HINT });
      }
    } catch (e: any) {
      setStatus({ configured: false, reason: 'upstream_error', message: e?.message || String(e), hint: DEFAULT_HINT });
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);
  return { status, reload };
}

function titleFor(reason: PurviewStatus['reason'], surface: string): string {
  switch (reason) {
    case 'cross_cloud':
      return `${surface} needs a Purview account in this cloud`;
    case 'upstream_error':
      return `${surface}: Microsoft Purview returned an error`;
    case 'not_configured':
    default:
      return `${surface} needs Microsoft Purview wired in this deployment`;
  }
}

/**
 * The gate banner. When Purview is live, renders a compact green confirmation
 * chip (so callers can always render <PurviewGate> at the top of the surface).
 * Otherwise renders the actionable warning bar.
 */
export function PurviewGate({
  status,
  surface,
  reload,
}: {
  status: PurviewStatus;
  surface: string;
  reload?: () => void;
}) {
  const s = useStyles();

  if (status.reason === 'loading') {
    return (
      <div className={s.liveRow}>
        <Spinner size="tiny" />
        <Caption1>Checking Microsoft Purview connection…</Caption1>
      </div>
    );
  }

  // Live: small confirmation chip instead of a warning bar.
  if (status.configured && status.reason === 'live') {
    return (
      <div className={s.liveRow}>
        <ShieldCheckmark20Regular style={{ color: tokens.colorPaletteGreenForeground1 }} />
        <Caption1>
          Connected to Microsoft Purview
          {status.account ? <> — <code>{status.account}</code></> : null}
        </Caption1>
        <Badge appearance="tint" color="success" size="small">live</Badge>
        {reload && (
          <Button size="small" appearance="transparent" icon={<ArrowSync16Regular />} onClick={reload}>
            Recheck
          </Button>
        )}
      </div>
    );
  }

  const hint = status.hint || DEFAULT_HINT;
  const portal = status.purviewPortal || PURVIEW_PORTAL;
  const crossCloud = status.reason === 'cross_cloud';

  return (
    <MessageBar intent={status.reason === 'upstream_error' ? 'error' : 'warning'} style={{ marginBottom: 16 }}>
      <MessageBarBody>
        <MessageBarTitle>{titleFor(status.reason, surface)}</MessageBarTitle>

        {crossCloud ? (
          <>
            The only Microsoft Purview account in this tenant is in a different Azure cloud than the Loom Console
            (for example, Purview in <strong>US Gov</strong> while Loom runs in <strong>Commercial</strong>). Purview&apos;s
            data plane can&apos;t be reached across clouds with a single account name, so this surface is gated.
            Provision a Purview account in the Console&apos;s cloud, or point the Console at one that lives there.
          </>
        ) : status.reason === 'upstream_error' ? (
          <>{status.message || 'Purview answered with an error. Check the Console UAMI role grants and the account firewall.'}</>
        ) : (
          <>The full {surface.toLowerCase()} experience is built and ready — it calls live Microsoft Purview REST once these are in place:</>
        )}

        <ul className={s.list}>
          <li>
            Env var <code>{hint.missingEnvVar || 'LOOM_PURVIEW_ACCOUNT'}</code> set on the Loom Console app
            {crossCloud ? ' to an account in this cloud' : ''}.
          </li>
          <li>
            Bicep module <code>{hint.bicepModule || DEFAULT_HINT.bicepModule}</code>
            {hint.bicepStatus ? <> — {hint.bicepStatus}</> : null}
          </li>
          <li>
            Console UAMI granted these governance-domain roles (in the Purview portal, not ARM RBAC):
            <div className={s.list} style={{ marginTop: 2 }}>
              {(hint.rolesRequired || DEFAULT_HINT.rolesRequired!).map((r) => (
                <span key={r.name} className={s.roleRow}>
                  <strong>{r.name}</strong> @ {r.scope} — {r.reason}
                </span>
              ))}
            </div>
          </li>
        </ul>

        {hint.followUp && <Caption1 style={{ display: 'block', marginTop: 4 }}>{hint.followUp}</Caption1>}
      </MessageBarBody>

      <MessageBarActions>
        <Button as="a" size="small" icon={<Open16Regular />} href={BOOTSTRAP_DOC} target="_blank" rel="noreferrer">
          Setup guide
        </Button>
        <Button as="a" size="small" appearance="transparent" icon={<Open16Regular />} href={portal} target="_blank" rel="noreferrer">
          Open Purview portal
        </Button>
        {reload && (
          <Button size="small" appearance="transparent" icon={<ArrowSync16Regular />} onClick={reload}>
            Recheck
          </Button>
        )}
      </MessageBarActions>
    </MessageBar>
  );
}
