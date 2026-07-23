'use client';

/**
 * WorkspaceIdentityPanel — the Workspace Settings → Identity tab (I6).
 *
 * The tenant-admin surface for per-workspace managed-identity enforcement: it
 * shows the current identity mode, the provisioned `uami-ws-<id>` + its
 * per-backend grant readiness (green/red), the 14-day shadow-divergence rollup
 * (I4), the I9 security-review status line, and the Enable-enforcement toggle —
 * DISABLED with an inline reason until the I7 grant-check preflight is ready, the
 * 14-day divergence is zero, AND the I9 review is signed off. Per ux-standards G2
 * this IS the Fix-it wizard for the `svc-workspace-identity` gate.
 *
 * Every value is live from GET /api/admin/workspaces/{id}/identity (real ARM +
 * data-plane + Cosmos probes — no-vaporware.md). Enforcement stays operator-gated:
 * this panel never flips a workspace on its own, and the POST refuses to enable
 * until the preconditions hold. First open is GUIDED, never a red error banner.
 * Fluent v9 + Loom tokens only.
 */

import { useCallback, useEffect, useState } from 'react';
import { clientFetch } from '@/lib/client-fetch';
import {
  Badge, Button, Spinner, Subtitle2, Body1, Caption1, Divider, Tooltip,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  ShieldKeyholeRegular, CheckmarkCircleFilled, DismissCircleFilled,
  SubtractCircleRegular, InfoRegular, ShieldCheckmarkRegular,
} from '@fluentui/react-icons';
import type { Workspace } from '@/lib/types/workspace';

interface GrantEval {
  backend: string;
  wouldAllow: boolean | null;
  reason?: string;
  source?: string;
  checkedAt?: string;
}
interface Preflight {
  ready: boolean;
  uamiProvisioned: boolean;
  missingGrants: string[];
  divergences: number;
  observedCalls: number;
  grantEvaluations: GrantEval[];
  reasons: string[];
  warnings: string[];
}
interface DivergenceRollup {
  windowDays: number;
  since: string;
  observedCalls: number;
  divergences: number;
  byBackend: Record<string, number>;
  unreadable: boolean;
}
interface Review {
  signedOff: boolean;
  reviewer?: string;
  reviewDate: string;
  program: string;
  docPath: string;
  openHighFindings: number;
  reason?: string;
}
interface IdentityData {
  workspaceId: string;
  mode: 'off' | 'shadow' | 'enforce';
  enforce: boolean;
  enforceAt?: string;
  enforceBy?: string;
  identity: {
    status?: string;
    uamiName?: string;
    uamiClientId?: string;
    principalId?: string;
  } | null;
  preflight: Preflight;
  divergenceRollup: DivergenceRollup;
  review: Review;
  readiness: { canEnable: boolean; blockers: string[] };
  panelEnabled: boolean;
}

const useStyles = makeStyles({
  panel: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, paddingTop: tokens.spacingVerticalM },
  section: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  sectionHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS },
  badgeRow: { display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', alignItems: 'center', minWidth: 0 },
  note: { color: tokens.colorNeutralForeground3, lineHeight: 1.5 },
  card: {
    display: 'flex', flexDirection: 'column', gap: '2px',
    padding: tokens.spacingVerticalM, borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
  },
  grantRow: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: tokens.spacingHorizontalS,
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
    borderRadius: tokens.borderRadiusMedium, minWidth: 0,
  },
  grantLeft: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, minWidth: 0 },
  grantName: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  metricGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: tokens.spacingHorizontalM },
  metricValue: { fontSize: tokens.fontSizeBase500, fontWeight: tokens.fontWeightSemibold },
  ok: { color: tokens.colorPaletteGreenForeground1, flexShrink: 0 },
  bad: { color: tokens.colorPaletteRedForeground1, flexShrink: 0 },
  na: { color: tokens.colorNeutralForeground3, flexShrink: 0 },
  actionRow: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' },
  mono: { fontFamily: tokens.fontFamilyMonospace, wordBreak: 'break-all' },
  blockerList: { margin: 0, paddingInlineStart: tokens.spacingHorizontalL, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS },
});

async function getIdentity(id: string): Promise<IdentityData> {
  const r = await clientFetch(`/api/admin/workspaces/${encodeURIComponent(id)}/identity`);
  const j = await r.json();
  if (!r.ok || j?.ok === false) throw new Error(j?.error || `HTTP ${r.status}`);
  return j.data as IdentityData;
}

function GrantDot({ v }: { v: boolean | null }) {
  const styles = useStyles();
  if (v === true) return <CheckmarkCircleFilled className={styles.ok} aria-label="granted" />;
  if (v === false) return <DismissCircleFilled className={styles.bad} aria-label="would be denied" />;
  return <SubtractCircleRegular className={styles.na} aria-label="not applicable" />;
}

export function WorkspaceIdentityPanel({
  workspaceId,
  onSaved,
}: {
  workspaceId: string;
  onSaved?: (ws: Workspace) => void;
}) {
  const styles = useStyles();
  const [data, setData] = useState<IdentityData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setLoadError(null);
    try { setData(await getIdentity(workspaceId)); }
    catch (e: any) { setLoadError(e?.message || String(e)); }
    finally { setLoading(false); }
  }, [workspaceId]);

  useEffect(() => { void load(); }, [load]);

  const toggle = async (enforce: boolean) => {
    setBusy(true); setActionError(null);
    try {
      const r = await clientFetch(`/api/admin/workspaces/${encodeURIComponent(workspaceId)}/identity`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enforce }),
      });
      const j = await r.json();
      if (!r.ok || j?.ok === false) {
        setActionError(j?.blockers?.[0] || j?.error || `HTTP ${r.status}`);
        return;
      }
      if (j?.data?.workspace && onSaved) onSaved(j.data.workspace as Workspace);
      await load();
    } catch (e: any) {
      setActionError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <Spinner size="tiny" label="Reading workspace identity…" />;
  if (loadError) {
    return (
      <div className={styles.panel}>
        <MessageBar intent="error"><MessageBarBody>{loadError}</MessageBarBody></MessageBar>
        <Button appearance="secondary" onClick={() => void load()}>Retry</Button>
      </div>
    );
  }
  if (!data) return null;

  const { mode, enforce, preflight, divergenceRollup: roll, review, readiness } = data;
  const enforcing = enforce;
  const firstBlocker = readiness.blockers[0];

  return (
    <div className={styles.panel}>
      {/* Status header */}
      <div className={styles.badgeRow}>
        <ShieldKeyholeRegular />
        <Badge appearance="tint" color="brand">Global mode: {mode}</Badge>
        <Badge appearance="filled" color={enforcing ? 'success' : 'informative'}>
          {enforcing ? 'Enforcing (per-workspace UAMI)' : 'Observe / shared UAMI'}
        </Badge>
        {preflight.uamiProvisioned
          ? <Badge appearance="tint" color="success">UAMI provisioned</Badge>
          : <Badge appearance="tint" color="warning">No workspace UAMI</Badge>}
      </div>
      <Body1 className={styles.note}>
        Per-workspace managed identity shrinks a workspace&apos;s blast radius: when enforced, its
        data-plane calls run as its own <code>uami-ws-{data.workspaceId}</code> scoped to only that
        workspace&apos;s lake / database, instead of the shared Console UAMI. Enforcement is a phased,
        operator-gated security-posture change — shadow first, enable per workspace only when green.
      </Body1>

      {/* Managed identity */}
      <div className={styles.section}>
        <Subtitle2 className={styles.sectionHead}>Managed identity</Subtitle2>
        {data.identity?.uamiName ? (
          <div className={styles.card}>
            <Caption1 className={styles.note}>User-assigned managed identity</Caption1>
            <span className={styles.mono}>{data.identity.uamiName}</span>
            {data.identity.uamiClientId && (
              <Caption1 className={`${styles.note} ${styles.mono}`}>client id: {data.identity.uamiClientId}</Caption1>
            )}
          </div>
        ) : (
          <MessageBar intent="info">
            <MessageBarBody>
              <MessageBarTitle>Not provisioned yet</MessageBarTitle>
              This workspace has no <code>uami-ws-{data.workspaceId}</code> in ARM. Set{' '}
              <code>LOOM_WORKSPACE_IDENTITY_MODE=shadow</code> (with the workspace-identity sub/RG) and
              re-create the workspace, or run the identity backfill, to provision one before enforcing.
              The workspace runs on the shared Console UAMI meanwhile — nothing is blocked.
            </MessageBarBody>
          </MessageBar>
        )}
      </div>

      {/* Grant readiness */}
      <div className={styles.section}>
        <Subtitle2 className={styles.sectionHead}>Grant readiness</Subtitle2>
        {preflight.grantEvaluations.length === 0 ? (
          <Caption1 className={styles.note}>
            No backend grants to evaluate for this workspace (no scoped backends configured, or the
            identity plane is unconfigured — see the security-review section below).
          </Caption1>
        ) : (
          <div className={styles.card} style={{ gap: tokens.spacingVerticalXXS }}>
            {preflight.grantEvaluations.map((g) => (
              <div key={g.backend} className={styles.grantRow}>
                <span className={styles.grantLeft}>
                  <GrantDot v={g.wouldAllow} />
                  <span className={styles.grantName}>{g.backend}</span>
                </span>
                {g.reason
                  ? <Tooltip content={g.reason} relationship="description">
                      <Badge appearance="tint" color={g.wouldAllow === true ? 'success' : g.wouldAllow === false ? 'danger' : 'subtle'}>
                        {g.wouldAllow === true ? 'granted' : g.wouldAllow === false ? 'missing' : 'n/a'}
                      </Badge>
                    </Tooltip>
                  : <Badge appearance="tint" color={g.wouldAllow === true ? 'success' : g.wouldAllow === false ? 'danger' : 'subtle'}>
                      {g.wouldAllow === true ? 'granted' : g.wouldAllow === false ? 'missing' : 'n/a'}
                    </Badge>}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Shadow divergence rollup */}
      <div className={styles.section}>
        <Subtitle2 className={styles.sectionHead}>Shadow divergence — last {roll.windowDays} days</Subtitle2>
        {roll.unreadable ? (
          <MessageBar intent="warning">
            <MessageBarBody>The shadow-divergence audit could not be read from Cosmos — readiness cannot be certified without it.</MessageBarBody>
          </MessageBar>
        ) : (
          <>
            <div className={styles.metricGrid}>
              <div className={styles.card}>
                <Caption1 className={styles.note}>Calls observed</Caption1>
                <span className={styles.metricValue}>{roll.observedCalls.toLocaleString()}</span>
              </div>
              <div className={styles.card}>
                <Caption1 className={styles.note}>Divergences</Caption1>
                <span className={styles.metricValue} style={{ color: roll.divergences > 0 ? tokens.colorPaletteRedForeground1 : tokens.colorPaletteGreenForeground1 }}>
                  {roll.divergences.toLocaleString()}
                </span>
              </div>
            </div>
            {roll.divergences > 0 && (
              <Caption1 className={styles.note}>
                Diverging backends: {Object.entries(roll.byBackend).map(([b, n]) => `${b} (${n})`).join(' · ')}. The
                shared UAMI succeeded where the workspace UAMI would have been denied — resolve those grants first.
              </Caption1>
            )}
            {roll.observedCalls === 0 && (
              <Caption1 className={styles.note}>
                No shadow observations recorded yet. Run in shadow mode long enough to exercise this workspace&apos;s
                data-plane paths before enforcing, so any divergence can surface.
              </Caption1>
            )}
          </>
        )}
      </div>

      {/* Security review (I9) */}
      <div className={styles.section}>
        <Subtitle2 className={styles.sectionHead}>Security review</Subtitle2>
        <div className={styles.badgeRow}>
          {review.signedOff
            ? <><ShieldCheckmarkRegular className={styles.ok} /><Body1>Security review: signed-off {review.reviewer ? `by ${review.reviewer} ` : ''}({review.reviewDate})</Body1></>
            : <><InfoRegular className={styles.na} /><Body1>Security review: pending named sign-off</Body1></>}
        </div>
        {!review.signedOff && review.reason && (
          <Caption1 className={styles.note}>{review.reason}</Caption1>
        )}
        <Caption1 className={styles.note}>
          I9 AppSec gate · {review.openHighFindings} open HIGH finding(s) · source: <code>{review.docPath}</code>
        </Caption1>
      </div>

      <Divider />

      {/* Enable / disable enforcement */}
      <div className={styles.section}>
        <Subtitle2 className={styles.sectionHead}>Enforcement</Subtitle2>
        {actionError && <MessageBar intent="error"><MessageBarBody>{actionError}</MessageBarBody></MessageBar>}
        <div className={styles.actionRow}>
          {enforcing ? (
            <>
              <Button appearance="outline" disabled={busy} onClick={() => void toggle(false)}>
                {busy ? <Spinner size="tiny" /> : 'Disable enforcement'}
              </Button>
              <Caption1 className={styles.note}>
                Rollback is instant + fail-safe: the next request falls back to the shared UAMI within the
                credential-cache TTL (~5 min). No redeploy.
              </Caption1>
            </>
          ) : readiness.canEnable ? (
            <Button appearance="primary" disabled={busy} onClick={() => void toggle(true)}>
              {busy ? <Spinner size="tiny" /> : 'Enable enforcement'}
            </Button>
          ) : (
            <>
              <Tooltip content={firstBlocker || 'Not ready to enforce yet.'} relationship="description">
                <Button appearance="primary" disabled aria-describedby="i6-enable-reason">Enable enforcement</Button>
              </Tooltip>
              <span id="i6-enable-reason" hidden>{firstBlocker}</span>
            </>
          )}
        </div>
        {!enforcing && !readiness.canEnable && readiness.blockers.length > 0 && (
          <MessageBar intent="info">
            <MessageBarBody>
              <MessageBarTitle>Enforcement not ready</MessageBarTitle>
              <ul className={styles.blockerList}>
                {readiness.blockers.map((b, i) => <li key={i}>{b}</li>)}
              </ul>
            </MessageBarBody>
          </MessageBar>
        )}
        {enforcing && data.enforceBy && (
          <Caption1 className={styles.note}>
            Enforced by {data.enforceBy}{data.enforceAt ? ` on ${new Date(data.enforceAt).toLocaleString()}` : ''}.
          </Caption1>
        )}
      </div>
    </div>
  );
}

export default WorkspaceIdentityPanel;
