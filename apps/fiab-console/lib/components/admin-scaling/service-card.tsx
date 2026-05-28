'use client';

import { ReactNode } from 'react';
import {
  Body1, Subtitle2, Caption1, Badge, Button, Spinner,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';

const useStyles = makeStyles({
  card: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: '8px',
    padding: '16px',
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    backgroundColor: tokens.colorNeutralBackground1,
  },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px' },
  title: { display: 'flex', flexDirection: 'column', gap: '2px' },
  controls: { display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'flex-end' },
  footer: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px' },
  current: { color: tokens.colorNeutralForeground2, fontSize: '12px' },
});

export function ServiceCard({
  title, subtitle, currentLabel, statusBadge, lastChanged,
  controls, costPreview, gateMessage,
  loading, dirty, applying, onApply, applyError, applyOk,
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
}) {
  const styles = useStyles();
  return (
    <section className={styles.card} aria-label={`${title} scaling card`}>
      <div className={styles.header}>
        <div className={styles.title}>
          <Subtitle2>{title}</Subtitle2>
          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{subtitle}</Caption1>
        </div>
        {statusBadge && (
          <Badge appearance="outline" color={statusBadge.intent === 'danger' ? 'danger' : statusBadge.intent || 'success'}>
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
