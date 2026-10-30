'use client';

/** Settings -> Findings (W1-4, ADR-008 decision 8): advisory only; a finding never blocks anything. */
import { useEffect, useState } from 'react';
import { Badge, Body1, Caption1, MessageBar, MessageBarBody, Spinner, Subtitle2, makeStyles, tokens } from '@fluentui/react-components';
import { CheckmarkCircle24Regular } from '@fluentui/react-icons';
import { EmptyState } from '@/lib/components/empty-state';
import { getFindings, type ApiResult, type FindingsData } from './api';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: 0 },
  card: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, minWidth: 0,
    padding: tokens.spacingHorizontalL, borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground1, boxShadow: tokens.shadow4,
  },
  badges: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap', minWidth: 0 },
  muted: { color: tokens.colorNeutralForeground3 },
});

export function FindingsTab() {
  const s = useStyles();
  const [res, setRes] = useState<ApiResult<FindingsData> | null>(null);
  useEffect(() => { void getFindings().then(setRes); }, []);

  if (!res) return <Spinner label="Loading findings" />;
  if (!res.ok || !res.data) {
    return <MessageBar intent="error"><MessageBarBody>{res.error ?? 'Findings are unavailable.'}</MessageBarBody></MessageBar>;
  }
  const { findings, available } = res.data;
  return (
    <div className={s.root}>
      <Caption1 className={s.muted}>Pairings that exist in API Management outside Loom&apos;s publications and would be blocked by the environment rules. Advisory: nothing here blocks anything.</Caption1>
      {findings.length === 0 ? (
        <EmptyState
          icon={<CheckmarkCircle24Regular />}
          title={available ? 'No findings' : 'Nothing to check yet'}
          body={available ? 'No gateway MCP server points at a registered MCP endpoint in an incompatible environment.' : 'Findings appear once a gateway has been registered and its inventory synced.'}
        />
      ) : findings.map((f) => (
        <div key={f.id} className={s.card}>
          <div className={s.badges}>
            <Subtitle2>{f.gatewayName}</Subtitle2>
            <Badge appearance="tint" color="warning">Advisory</Badge>
            <Badge appearance="outline">{f.resourceKind}: {f.resourceName}</Badge>
          </div>
          <Body1>{f.message}</Body1>
        </div>
      ))}
    </div>
  );
}
