'use client';

/**
 * Brownfield discovery list for the register dialog (W1-9, deploy-integrity R5).
 * Offers each APIM service the Console identity can see; the operator picks one and the dialog
 * registers it through the normal register call. Already-registered candidates are shown and not
 * selectable. A partial scan names the subscriptions that could not be read; the "nothing found"
 * empty state appears only for a COMPLETE scan (R7: absence is not reported when a read failed).
 */
import { useEffect, useState } from 'react';
import {
  Badge, Body1, Caption1, MessageBar, MessageBarBody, Spinner, Subtitle2, makeStyles, tokens,
} from '@fluentui/react-components';
import { Globe24Regular } from '@fluentui/react-icons';
import { EmptyState } from '@/lib/components/empty-state';
import type { DiscoveryCandidate, DiscoveryResult } from '@/lib/api-gateway/registry/discovery/types';
import { discoverGateways } from './_lib/hub-api';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, minWidth: 0 },
  list: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, minWidth: 0,
    maxHeight: '40vh', overflowY: 'auto',
  },
  card: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, minWidth: 0, textAlign: 'left',
    paddingTop: tokens.spacingVerticalS, paddingBottom: tokens.spacingVerticalS,
    paddingLeft: tokens.spacingHorizontalM, paddingRight: tokens.spacingHorizontalM,
    borderRadius: tokens.borderRadiusLarge,
    borderTopWidth: tokens.strokeWidthThin, borderRightWidth: tokens.strokeWidthThin,
    borderBottomWidth: tokens.strokeWidthThin, borderLeftWidth: tokens.strokeWidthThin,
    borderTopStyle: 'solid', borderRightStyle: 'solid', borderBottomStyle: 'solid', borderLeftStyle: 'solid',
    borderTopColor: tokens.colorNeutralStroke2, borderRightColor: tokens.colorNeutralStroke2,
    borderBottomColor: tokens.colorNeutralStroke2, borderLeftColor: tokens.colorNeutralStroke2,
    backgroundColor: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground1,
    boxShadow: tokens.shadow4,
    cursor: 'pointer',
    ':hover': { boxShadow: tokens.shadow8 },
    ':disabled': { cursor: 'not-allowed', opacity: 0.6, boxShadow: 'none' },
  },
  cardSelected: {
    backgroundColor: tokens.colorBrandBackground2,
    borderTopColor: tokens.colorBrandStroke1, borderRightColor: tokens.colorBrandStroke1,
    borderBottomColor: tokens.colorBrandStroke1, borderLeftColor: tokens.colorBrandStroke1,
  },
  name: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, fontWeight: tokens.fontWeightSemibold },
  badges: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalXS, minWidth: 0 },
  muted: { color: tokens.colorNeutralForeground3, overflowWrap: 'anywhere', minWidth: 0 },
});

export function DiscoveryList({ selectedResourceId, onPick }: {
  selectedResourceId: string;
  onPick: (c: DiscoveryCandidate) => void;
}) {
  const s = useStyles();
  const [state, setState] = useState<
    | { phase: 'loading' }
    | { phase: 'unavailable'; message: string }
    | { phase: 'done'; result: DiscoveryResult }
  >({ phase: 'loading' });

  useEffect(() => {
    let live = true;
    void discoverGateways().then((r) => {
      if (!live) return;
      const d = r.data;
      if (r.ok && d && Array.isArray(d.candidates) && Array.isArray(d.failures) && typeof d.partial === 'boolean') {
        setState({ phase: 'done', result: d });
      } else {
        setState({
          phase: 'unavailable',
          message: r.error ?? `Discovery did not return a usable answer (HTTP ${r.status}). Paste a resource id below instead.`,
        });
      }
    });
    return () => { live = false; };
  }, []);

  if (state.phase === 'loading') {
    return <Spinner size="tiny" label="Looking for API Management services in your subscriptions..." data-testid="discovery-loading" />;
  }
  if (state.phase === 'unavailable') {
    return (
      <MessageBar intent="warning" data-testid="discovery-unavailable">
        <MessageBarBody>Discovery could not run: {state.message}</MessageBarBody>
      </MessageBar>
    );
  }

  const { result } = state;
  return (
    <div className={s.root} data-testid="discovery-list">
      <Subtitle2>Found in your subscriptions</Subtitle2>
      {result.partial && (
        <MessageBar intent="warning" data-testid="discovery-partial">
          <MessageBarBody>
            Some reads failed, so this list may be incomplete:
            <ul>
              {result.failures.map((f, i) => (
                <li key={`${f.scope}-${f.kind}-${i}`}>
                  {f.scope === 'subscriptions' ? 'Subscription list' : f.scope} - HTTP {f.status}: {f.reason}
                </li>
              ))}
            </ul>
          </MessageBarBody>
        </MessageBar>
      )}
      {result.candidates.length === 0 && !result.partial && (
        <EmptyState
          icon={<Globe24Regular />}
          title="No API Management services found"
          body={`Scanned ${result.subscriptionsScanned} subscription${result.subscriptionsScanned === 1 ? '' : 's'} with no read failures. Paste a resource id below to register one Loom cannot list.`}
        />
      )}
      {result.candidates.length > 0 && (
        <div className={s.list} role="list" aria-label="Discovered gateways">
          {result.candidates.map((c) => {
            const selected = !c.alreadyRegistered && c.resourceId.toLowerCase() === selectedResourceId.trim().toLowerCase();
            return (
              <button
                key={c.resourceId}
                type="button"
                role="listitem"
                data-testid={`candidate-${c.name}`}
                className={`${s.card} ${selected ? s.cardSelected : ''}`}
                disabled={c.alreadyRegistered}
                aria-pressed={selected}
                onClick={() => onPick(c)}
              >
                <Body1 className={s.name}>{c.name}</Body1>
                <div className={s.badges}>
                  {c.alreadyRegistered && <Badge appearance="filled" color="informative">Already registered</Badge>}
                  <Badge appearance="tint">{c.sku}</Badge>
                  <Badge appearance="outline">{c.location}</Badge>
                  <Badge appearance="outline">{c.networkMode === 'unknown' ? 'Network unknown' : `VNet: ${c.networkMode}`}</Badge>
                  <Badge appearance="tint" color={c.access.canRead ? 'success' : 'warning'}>
                    {c.access.source === 'unavailable' ? 'Access unchecked' : c.access.canRead ? (c.access.canWrite ? 'Read + write' : 'Read') : 'No read access'}
                  </Badge>
                </div>
                <Caption1 className={s.muted}>{c.resourceId}</Caption1>
                <Caption1 className={s.muted}>{c.observeSummary}</Caption1>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
