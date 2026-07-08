'use client';

/**
 * ImpactAnalysisPanel (Wave-2 W8) — the "what breaks downstream?" body rendered
 * inside a destructive-change confirm dialog (delete / rename / schema-edit).
 *
 * Fetches GET /api/items/[type]/[id]/impact (real unified lineage store — no
 * mock) and renders every downstream dependent grouped by kind, each badged
 * direct (1-hop) vs transitive (>1-hop) and click-through-linked when the node
 * resolves to a Loom item. When dependents exist — OR when lineage backends were
 * unreachable (`degraded`, so impact is unverified) — it requires an explicit
 * typed confirmation before the destructive action may proceed, and reports its
 * readiness to the host dialog via `onReadyChange`.
 *
 * Reused by the shared catalog-list / workspace delete affordance (lib/panes/
 * folders.tsx) and available to any item editor's delete surface.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Badge, Spinner, Link, Input, Field,
  MessageBar, MessageBarBody, MessageBarTitle,
  Accordion, AccordionItem, AccordionHeader, AccordionPanel,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { clientFetch } from '@/lib/client-fetch';

export type ImpactSeverity = 'direct' | 'transitive';

interface ImpactDependent {
  id: string;
  label: string;
  type?: string;
  kind: string;
  severity: ImpactSeverity;
  distance: number;
  openHref?: string;
  source: string;
}
interface ImpactGroup {
  kind: string;
  count: number;
  hasDirect: boolean;
  dependents: ImpactDependent[];
}
interface ImpactCounts { total: number; direct: number; transitive: number }
interface SourceStatus { source: string; ok: boolean; gate?: string; nodeCount: number }
interface ImpactResponse {
  ok: boolean;
  error?: string;
  dependents?: ImpactDependent[];
  groups?: ImpactGroup[];
  counts?: ImpactCounts;
  degraded?: boolean;
  partial?: boolean;
  sources?: SourceStatus[];
}

export type DestructiveAction = 'delete' | 'rename' | 'edit';

interface Props {
  type: string;
  id: string;
  itemName?: string;
  /** The destructive action being confirmed — tunes the copy + confirm word. */
  action?: DestructiveAction;
  /**
   * Called whenever the panel's readiness changes. The host dialog gates its
   * destructive button on this: `false` while loading or while a required typed
   * confirmation is unmet, `true` once safe (no dependents) or explicitly
   * confirmed. Also called with the impact summary so the host can label counts.
   */
  onReadyChange?: (ready: boolean, summary?: { total: number; degraded: boolean }) => void;
}

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: '420px' },
  summary: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  depRow: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS,
    padding: `${tokens.spacingVerticalXS} 0`,
  },
  depMain: { display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 },
  depLabel: { fontSize: tokens.fontSizeBase300, fontWeight: tokens.fontWeightSemibold, wordBreak: 'break-word' },
  depMeta: { fontSize: '11px', color: tokens.colorNeutralForeground3, wordBreak: 'break-all' },
  groupList: { display: 'flex', flexDirection: 'column' },
});

const ACTION_WORD: Record<DestructiveAction, string> = {
  delete: 'DELETE',
  rename: 'RENAME',
  edit: 'EDIT',
};
const ACTION_VERB: Record<DestructiveAction, string> = {
  delete: 'deleting',
  rename: 'renaming',
  edit: 'schema-editing',
};

function severityBadge(sev: ImpactSeverity) {
  return sev === 'direct'
    ? <Badge appearance="filled" color="danger" size="small">Direct</Badge>
    : <Badge appearance="tint" color="warning" size="small">Transitive</Badge>;
}

export function ImpactAnalysisPanel({ type, id, itemName, action = 'delete', onReadyChange }: Props) {
  const styles = useStyles();
  const [data, setData] = useState<ImpactResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmText, setConfirmText] = useState('');
  // Keep the latest onReadyChange without making it a fetch dependency.
  const readyCb = useRef(onReadyChange);
  readyCb.current = onReadyChange;

  const word = ACTION_WORD[action];

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    setConfirmText('');
    readyCb.current?.(false);
    clientFetch(`/api/items/${encodeURIComponent(type)}/${encodeURIComponent(id)}/impact`)
      .then((r) => r.json())
      .then((d: ImpactResponse) => {
        if (cancelled) return;
        if (!d || d.ok === false) {
          setError(d?.error || 'Failed to load impact analysis.');
          // A failed fetch is itself unverified impact → require confirmation.
          setData(null);
          return;
        }
        setData(d);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e?.message || String(e));
      });
    return () => { cancelled = true; };
  }, [type, id]);

  const total = data?.counts?.total ?? 0;
  const degraded = !!data?.degraded || (!!error && !data);
  // A typed confirmation is required when there ARE dependents, or when impact
  // could not be verified (degraded / error). Zero verified dependents → ready.
  const confirmRequired = total > 0 || degraded;
  const ready = useMemo(() => {
    if (!data && !error) return false; // still loading
    if (!confirmRequired) return true;
    return confirmText.trim().toUpperCase() === word;
  }, [data, error, confirmRequired, confirmText, word]);

  useEffect(() => {
    readyCb.current?.(ready, { total, degraded });
  }, [ready, total, degraded]);

  if (!data && !error) {
    return <div className={styles.root}><Spinner size="tiny" label="Checking downstream impact…" /></div>;
  }

  return (
    <div className={styles.root}>
      {/* Honest gate: no lineage source reachable → impact is UNVERIFIED. */}
      {degraded && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Downstream impact could not be verified.</MessageBarTitle>
            {error
              ? `The lineage store was unreachable (${error}). `
              : 'No lineage source was reachable. '}
            Dependents may exist that are not listed here. Proceed only if you are
            certain nothing downstream consumes this item.
          </MessageBarBody>
        </MessageBar>
      )}

      {/* Partial: some sources gated → the graph may be incomplete. */}
      {!degraded && data?.partial && (
        <MessageBar intent="info">
          <MessageBarBody>
            Some lineage sources were unavailable, so additional dependents beyond
            those listed may exist.
            {data.sources?.filter((s) => !s.ok).map((s) => (
              <span key={s.source}> · {s.source}: {s.gate || 'gated'}</span>
            ))}
          </MessageBarBody>
        </MessageBar>
      )}

      {!degraded && total === 0 && (
        <MessageBar intent="success">
          <MessageBarBody>
            No downstream dependents found. Nothing else in the catalog consumes
            {itemName ? ` "${itemName}"` : ' this item'}.
          </MessageBarBody>
        </MessageBar>
      )}

      {total > 0 && (
        <>
          <div className={styles.summary}>
            <Badge appearance="filled" color="danger">{total} downstream {total === 1 ? 'dependent' : 'dependents'}</Badge>
            {(data?.counts?.direct ?? 0) > 0 && (
              <Badge appearance="tint" color="danger" size="small">{data!.counts!.direct} direct</Badge>
            )}
            {(data?.counts?.transitive ?? 0) > 0 && (
              <Badge appearance="tint" color="warning" size="small">{data!.counts!.transitive} transitive</Badge>
            )}
          </div>
          <MessageBar intent="warning">
            <MessageBarBody>
              {ACTION_VERB[action].replace(/^\w/, (c) => c.toUpperCase())}
              {itemName ? ` "${itemName}"` : ' this item'} may break the items
              below. Review them before you continue.
            </MessageBarBody>
          </MessageBar>
          <Accordion multiple collapsible defaultOpenItems={(data?.groups || []).map((g) => g.kind)}>
            {(data?.groups || []).map((g) => (
              <AccordionItem key={g.kind} value={g.kind}>
                <AccordionHeader>
                  {g.kind} <span style={{ color: tokens.colorNeutralForeground3, marginLeft: 6 }}>({g.count})</span>
                </AccordionHeader>
                <AccordionPanel>
                  <div className={styles.groupList}>
                    {g.dependents.map((dep) => (
                      <div className={styles.depRow} key={`${dep.source}:${dep.id}`}>
                        {severityBadge(dep.severity)}
                        <div className={styles.depMain}>
                          {dep.openHref ? (
                            <Link href={dep.openHref} className={styles.depLabel}>{dep.label}</Link>
                          ) : (
                            <span className={styles.depLabel}>{dep.label}</span>
                          )}
                          <span className={styles.depMeta}>
                            {dep.kind} · {dep.source}{dep.distance > 1 ? ` · ${dep.distance} hops` : ''} · {dep.id}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </AccordionPanel>
              </AccordionItem>
            ))}
          </Accordion>
        </>
      )}

      {confirmRequired && (
        <Field
          label={`Type ${word} to confirm this ${action}`}
          hint="This is a deliberate guard because the change affects other catalog items."
        >
          <Input
            value={confirmText}
            onChange={(_, d) => setConfirmText(d.value)}
            placeholder={word}
            aria-label={`Type ${word} to confirm`}
            data-testid="impact-confirm-input"
          />
        </Field>
      )}
    </div>
  );
}
