'use client';

import { ReactNode } from 'react';
import {
  Body1, Subtitle2, Caption1, Badge, Button, Spinner,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
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
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: '#fff',
  },
  title: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 },
  controls: { display: 'flex', gap: tokens.spacingHorizontalM, flexWrap: 'wrap', alignItems: 'flex-end' },
  footer: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: tokens.spacingHorizontalM },
  current: { color: tokens.colorNeutralForeground2, fontSize: '12px' },
});

export function ServiceCard({
  title, subtitle, currentLabel, statusBadge, lastChanged,
  controls, costPreview, gateMessage,
  loading, dirty, applying, onApply, applyError, applyOk,
  accent, icon,
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
}) {
  const styles = useStyles();
  const bar = accent || tokens.colorBrandStroke1;
  return (
    <section className={styles.card} aria-label={`${title} scaling card`}>
      <div className={styles.accent} style={{ backgroundColor: bar }} aria-hidden />
      <div className={styles.header}>
        <div className={styles.titleWrap}>
          {icon && <span className={styles.iconWrap} style={{ backgroundColor: bar }} aria-hidden>{icon}</span>}
          <div className={styles.title}>
            <Subtitle2 style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{title}</Subtitle2>
            <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{subtitle}</Caption1>
          </div>
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
            <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
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
