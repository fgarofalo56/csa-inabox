'use client';

import { ReactNode } from 'react';
import {
  Body1, Subtitle2, Caption1, Badge, Button, Spinner,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens, ProgressBar,
} from '@fluentui/react-components';

/**
 * ServiceCard — Web-3.0 card chrome for the Admin → Scale by SKU grid.
 *
 * Each card frames one scalable backing service (Fabric/PBI capacity, Synapse
 * DWU, ADX, Databricks, AI Search, APIM, Cosmos, Container Apps, AI Foundry)
 * with a left accent bar + icon-wrap matching the capacity-page ScaleManagePanel
 * cards, an honest infra gate (Fluent MessageBar) when a service isn't
 * configured, and an Apply affordance. Pure chrome — the dropdowns/inputs and
 * the real scaling fetch live in the controls passed by the parent.
 *
 * `accent` + `icon` are optional and default to the brand color / no icon so
 * existing callers keep working without changes (the grid wires per-service
 * accents for the full Web-3.0 look).
 */
/** Shape of one resolved utilization snapshot from /api/admin/scaling/utilization */
export interface UtilizationSnapshot {
  available: boolean;
  value?: number;
  label?: string;
  unit?: string;
  reason?: string;
}

const useStyles = makeStyles({
  card: {
    position: 'relative',
    overflow: 'hidden',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusXLarge,
    padding: tokens.spacingVerticalL,
    paddingInlineStart: `calc(${tokens.spacingVerticalL} + 4px)`,
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow2,
    transition: 'box-shadow 120ms ease',
    ':hover': { boxShadow: tokens.shadow8 },
  },
  accent: { position: 'absolute', insetInlineStart: 0, insetBlockStart: 0, insetBlockEnd: 0, width: '4px' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: tokens.spacingHorizontalM },
  titleWrap: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, minWidth: 0 },
  iconWrap: {
    width: '40px', height: '40px', borderRadius: tokens.borderRadiusMedium, flexShrink: 0,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    color: tokens.colorNeutralForegroundOnBrand,
  },
  title: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, minWidth: 0 },
  titleName: { overflow: 'hidden', textOverflow: 'ellipsis' },
  titleSub: { color: tokens.colorNeutralForeground3 },
  controls: { display: 'flex', gap: tokens.spacingHorizontalM, flexWrap: 'wrap', alignItems: 'flex-end' },
  footer: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: tokens.spacingHorizontalM },
  current: { color: tokens.colorNeutralForeground2, fontSize: tokens.fontSizeBase200 },
  footerCaption: { color: tokens.colorNeutralForeground3 },
  // Utilization indicator: a compact labeled bar shown at the top-right of the
  // header alongside the status badge. Never blocks the card — loading shows a
  // thin indeterminate bar; n/a shows muted text.
  utilWrap: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-end',
    gap: tokens.spacingVerticalXXS,
    minWidth: '80px',
    flexShrink: 0,
  },
  utilLabel: {
    fontSize: tokens.fontSizeBase100,
    color: tokens.colorNeutralForeground3,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    fontWeight: tokens.fontWeightSemibold,
    lineHeight: 1,
  },
  utilValue: {
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorBrandForeground1,
    lineHeight: 1,
  },
  utilNA: {
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground4,
    lineHeight: 1,
  },
  utilBar: {
    width: '80px',
  },
});

export function ServiceCard({
  title, subtitle, currentLabel, statusBadge, lastChanged,
  controls, costPreview, gateMessage,
  loading, dirty, applying, onApply, applyError, applyOk,
  accent, icon, utilization, utilizationLoading,
}: {
  title: string;
  subtitle: string;
  currentLabel?: string;
  statusBadge?: { text: string; intent?: 'success' | 'warning' | 'danger' | 'info' };
  lastChanged?: string;
  controls?: ReactNode;
  costPreview?: ReactNode;
  gateMessage?: { title: string; body: string; intent?: 'warning' | 'info' };
  loading?: boolean;
  dirty?: boolean;
  applying?: boolean;
  onApply?: () => void;
  applyError?: string;
  applyOk?: string;
  /** Left accent + icon-wrap color. Defaults to the Loom brand stroke. */
  accent?: string;
  /** Optional service glyph rendered in the accent-colored icon-wrap. */
  icon?: ReactNode;
  /**
   * Current-utilization snapshot from /api/admin/scaling/utilization.
   * When provided, a compact labeled indicator appears at the top-right of
   * the card header. Only shows a real number when available:true; shows "—"
   * when available:false. Never blocks rendering — pass undefined while loading.
   */
  utilization?: UtilizationSnapshot;
  /** When true, a thin indeterminate bar replaces the utilization value. */
  utilizationLoading?: boolean;
}) {
  const styles = useStyles();
  const bar = accent || tokens.colorBrandStroke1;

  // Format the utilization value as a short human-readable string.
  // For percentage metrics round to 1 decimal; for counts format with SI suffix.
  function fmtUtil(snap: UtilizationSnapshot): string {
    if (!snap.available || snap.value === undefined) return '—';
    const v = snap.value;
    const u = (snap.unit || '').toLowerCase();
    if (u === 'percent' || u === '%') return `${v.toFixed(1)} %`;
    if (u === 'bytes') {
      if (v >= 1e9) return `${(v / 1e9).toFixed(1)} GB`;
      if (v >= 1e6) return `${(v / 1e6).toFixed(1)} MB`;
      if (v >= 1e3) return `${(v / 1e3).toFixed(0)} KB`;
      return `${v.toFixed(0)} B`;
    }
    if (u === 'nanocores' || u === 'nanocores (avg)') {
      // 1 core = 1_000_000_000 nanocores; show as mCPU (millicores) for readability
      return `${(v / 1_000_000).toFixed(0)} mCPU`;
    }
    // Generic: counts etc. Use comma-thousands for readability
    if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
    if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
    return v.toFixed(v % 1 === 0 ? 0 : 1);
  }

  // Bar value [0..1] for percentage metrics; null for non-percent metrics (no bar).
  function barValue(snap: UtilizationSnapshot): number | null {
    if (!snap.available || snap.value === undefined) return null;
    const u = (snap.unit || '').toLowerCase();
    if (u === 'percent' || u === '%') return Math.min(1, snap.value / 100);
    return null;
  }

  return (
    <section className={styles.card} aria-label={`${title} scaling card`}>
      <div className={styles.accent} style={{ backgroundColor: bar }} aria-hidden />
      <div className={styles.header}>
        <div className={styles.titleWrap}>
          {icon && <span className={styles.iconWrap} style={{ backgroundColor: bar }} aria-hidden>{icon}</span>}
          <div className={styles.title}>
            <Subtitle2 className={styles.titleName}>{title}</Subtitle2>
            <Caption1 className={styles.titleSub}>{subtitle}</Caption1>
          </div>
        </div>
        {/* Utilization indicator — shown at header right, never blocks the card */}
        <div className={styles.utilWrap} aria-label={utilization?.label ? `Current utilization: ${utilization.label}` : 'Current utilization'}>
          <Caption1 className={styles.utilLabel}>
            {utilization?.label || 'Utilization'}
          </Caption1>
          {utilizationLoading ? (
            <ProgressBar thickness="thin" className={styles.utilBar} aria-label="Loading utilization…" />
          ) : utilization?.available ? (
            <>
              <span className={styles.utilValue}>{fmtUtil(utilization)}</span>
              {barValue(utilization) !== null && (
                <ProgressBar
                  value={barValue(utilization)!}
                  thickness="thin"
                  className={styles.utilBar}
                  aria-label={`${utilization.label || 'Utilization'}: ${fmtUtil(utilization)}`}
                  color={barValue(utilization)! > 0.85 ? 'error' : barValue(utilization)! > 0.65 ? 'warning' : 'success'}
                />
              )}
            </>
          ) : (
            <span className={styles.utilNA} title={utilization?.reason || 'Metric not available'}>—</span>
          )}
        </div>
        {statusBadge && (
          <Badge appearance="filled" color={statusBadge.intent === 'danger' ? 'danger' : statusBadge.intent === 'info' ? 'informative' : statusBadge.intent || 'success'}>
            {statusBadge.text}
          </Badge>
        )}
      </div>

      {gateMessage && (
        <MessageBar intent={gateMessage.intent || 'warning'}>
          <MessageBarTitle>{gateMessage.title}</MessageBarTitle>
          <MessageBarBody>{gateMessage.body}</MessageBarBody>
        </MessageBar>
      )}

      {loading && <Spinner size="extra-small" label="Loading…" />}

      {!loading && !gateMessage && (
        <>
          {currentLabel && <Body1 className={styles.current}>Current: <strong>{currentLabel}</strong></Body1>}

          <div className={styles.controls}>{controls}</div>

          {costPreview}

          {applyError && (
            <MessageBar intent="error">
              <MessageBarTitle>Scale failed</MessageBarTitle>
              <MessageBarBody>{applyError}</MessageBarBody>
            </MessageBar>
          )}
          {applyOk && (
            <MessageBar intent="success">
              <MessageBarBody>{applyOk}</MessageBarBody>
            </MessageBar>
          )}

          <div className={styles.footer}>
            <Caption1 className={styles.footerCaption}>
              {lastChanged ? `Last changed: ${lastChanged}` : 'No changes recorded'}
            </Caption1>
            {onApply && (
              <Button
                appearance="primary"
                disabled={!dirty || applying}
                onClick={onApply}
              >
                {applying ? 'Applying…' : 'Apply'}
              </Button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
