'use client';

/**
 * CopilotBuilderPane — the shared inline Copilot builder pane (G1).
 *
 * Extracted verbatim in behaviour from the 3 proven bespoke implementations
 * (kql-database NL2KQL assist, kql-dashboard generate-tile, semantic-model
 * copilot-structure) so the 7 remaining design surfaces (eventstream,
 * stream-analytics, lakehouse, materialized-lake-view, mirrored-database,
 * ml-experiment/automl, graph) reuse ONE component instead of 7 more one-offs.
 *
 * Flow (human-in-the-loop, no surprise writes — per no-vaporware.md):
 *   1. User types a plain-English request → "Propose".
 *   2. POST { action:'propose', prompt } → the surface's assist route returns a
 *      structured plan { summary, ops[] } grounded on the item's REAL backend
 *      state. Nothing is written.
 *   3. The pane renders the plan (per-op badge + one-line description).
 *   4. "Apply" → POST { action:'apply', plan } → the route captures a checkpoint
 *      THEN applies the ops to the Loom-native Cosmos doc (the Azure-native
 *      DEFAULT — works with no Fabric/Power BI). Result surfaces applied/skipped.
 *   5. Checkpoints list with one-click Restore (reversible — a pre-restore
 *      snapshot is auto-captured server-side).
 *
 * The pane is surface-agnostic: it renders `op.describe` + `op.badge` verbatim
 * (each route owns its op semantics) and treats the plan opaquely. Every colour /
 * space / radius is a Fluent `tokens.*` value — no raw px / hex (web3-ui.md).
 * No default export. No editor-registry / Azure-SDK imports (client-safe).
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  Badge, Button, Card, Caption1, Divider, Field, MessageBar, MessageBarBody,
  MessageBarTitle, Spinner, Subtitle2, Textarea, makeStyles, tokens,
} from '@fluentui/react-components';
import { Sparkle16Regular } from '@fluentui/react-icons';

// ── Wire contract (matches makeCopilotBuilderRoute) ─────────────────────────

export type BuilderOpBadgeColor = 'brand' | 'success' | 'informative' | 'warning' | 'danger';

export interface BuilderPlanOp {
  kind: string;
  /** One-line human description rendered in the plan list. */
  describe: string;
  /** Short badge label. */
  badge: string;
  /** Badge colour. */
  badgeColor: BuilderOpBadgeColor;
  [k: string]: unknown;
}

export interface BuilderPlan {
  summary: string;
  ops: BuilderPlanOp[];
}

export interface BuilderCheckpoint {
  id: string;
  createdAt: string;
  label: string;
  source: 'copilot' | 'manual' | 'pre-restore';
  stats?: Record<string, number>;
}

interface ProposeErr {
  text: string;
  gate?: { missing: string; detail: string };
}

export interface CopilotBuilderPaneProps {
  /** Assist route base, e.g. `/api/items/eventstream/<id>/assist`. Do NOT append a query. */
  endpoint: string;
  /** MessageBar title shown above the composer. */
  title: string;
  /** MessageBar body — one or two sentences describing what the builder does. */
  intro: ReactNode;
  /** Field label above the textarea. */
  fieldLabel: string;
  /** Field hint below the label. */
  fieldHint?: string;
  /** Textarea placeholder — a concrete example request for THIS surface. */
  placeholder: string;
  /**
   * Called after a successful apply / restore so the host editor can reload the
   * item's authoring doc from Cosmos (the doc was mutated server-side).
   */
  onApplied?: () => void;
  /** Noun used in the apply button ("Apply 3 edits"). Default "edit". */
  opNoun?: string;
}

// ── styles (ported from useCopilotPaneStyles) ───────────────────────────────

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalM },
  actionRow: { display: 'flex', columnGap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' },
  planCard: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalS, padding: tokens.spacingVerticalM },
  opList: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalXS, margin: 0, padding: 0, listStyleType: 'none' },
  opRow: {
    display: 'flex', alignItems: 'flex-start', columnGap: tokens.spacingHorizontalS,
    paddingTop: tokens.spacingVerticalXS, paddingBottom: tokens.spacingVerticalXS,
    paddingLeft: tokens.spacingHorizontalS, paddingRight: tokens.spacingHorizontalS,
    borderRadius: tokens.borderRadiusMedium, backgroundColor: tokens.colorNeutralBackground2,
  },
  opText: { flex: 1, minWidth: 0, lineHeight: tokens.lineHeightBase300 },
  sectionHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', columnGap: tokens.spacingHorizontalS },
  cpList: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalXS },
  cpRow: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', columnGap: tokens.spacingHorizontalS,
    paddingTop: tokens.spacingVerticalXS, paddingBottom: tokens.spacingVerticalXS,
    paddingLeft: tokens.spacingHorizontalM, paddingRight: tokens.spacingHorizontalM,
    borderRadius: tokens.borderRadiusMedium,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    transitionProperty: 'background-color, border-color', transitionDuration: tokens.durationFaster,
    ':hover': {
      backgroundColor: tokens.colorNeutralBackground1Hover,
      border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke1}`,
    },
  },
  cpMeta: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalXXS, minWidth: 0 },
  cpLabelRow: { display: 'flex', columnGap: tokens.spacingHorizontalXS, alignItems: 'center' },
  applyList: { margin: `${tokens.spacingVerticalXS} 0 0`, paddingLeft: tokens.spacingHorizontalXL },
  skippedWrap: { marginTop: tokens.spacingVerticalS },
  skippedList: { margin: `${tokens.spacingVerticalXXS} 0 0`, paddingLeft: tokens.spacingHorizontalXL },
  emptyState: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', rowGap: tokens.spacingVerticalXS,
    paddingTop: tokens.spacingVerticalL, paddingBottom: tokens.spacingVerticalL,
    color: tokens.colorNeutralForeground3, textAlign: 'center', borderRadius: tokens.borderRadiusMedium,
    border: `${tokens.strokeWidthThin} dashed ${tokens.colorNeutralStroke2}`,
  },
});

function statsLine(stats?: Record<string, number>): string {
  if (!stats) return '';
  const parts = Object.entries(stats).map(([k, v]) => `${v} ${k}`);
  return parts.join(', ');
}

export function CopilotBuilderPane(props: CopilotBuilderPaneProps) {
  const { endpoint, title, intro, fieldLabel, fieldHint, placeholder, onApplied, opNoun = 'edit' } = props;
  const cs = useStyles();
  const [prompt, setPrompt] = useState('');
  const [proposing, setProposing] = useState(false);
  const [plan, setPlan] = useState<BuilderPlan | null>(null);
  const [proposeErr, setProposeErr] = useState<ProposeErr | null>(null);
  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState<{ ok: boolean; text: string; applied?: string[]; skipped?: string[] } | null>(null);
  const [checkpoints, setCheckpoints] = useState<BuilderCheckpoint[] | null>(null);
  const [cpErr, setCpErr] = useState<string | null>(null);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [restoreMsg, setRestoreMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const loadCheckpoints = useCallback(async () => {
    setCpErr(null);
    try {
      const r = await fetch(`${endpoint}?action=checkpoints`);
      const j = await r.json();
      if (!j.ok) { setCpErr(j.error || `HTTP ${r.status}`); setCheckpoints([]); return; }
      setCheckpoints(Array.isArray(j.checkpoints) ? j.checkpoints : []);
    } catch (e: any) { setCpErr(e?.message || String(e)); setCheckpoints([]); }
  }, [endpoint]);

  useEffect(() => { void loadCheckpoints(); }, [loadCheckpoints]);

  const propose = useCallback(async () => {
    const q = prompt.trim();
    if (!q) return;
    setProposing(true); setPlan(null); setProposeErr(null); setApplyResult(null);
    try {
      const r = await fetch(endpoint, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'propose', prompt: q }),
      });
      const j = await r.json();
      if (!j.ok) { setProposeErr({ text: j.error || `HTTP ${r.status}`, gate: j.gate }); return; }
      setPlan(j.plan as BuilderPlan);
    } catch (e: any) { setProposeErr({ text: e?.message || String(e) }); }
    finally { setProposing(false); }
  }, [prompt, endpoint]);

  const apply = useCallback(async () => {
    if (!plan || plan.ops.length === 0) return;
    setApplying(true); setApplyResult(null);
    try {
      const r = await fetch(endpoint, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'apply', plan }),
      });
      const j = await r.json();
      if (!j.ok) { setApplyResult({ ok: false, text: j.error || `HTTP ${r.status}` }); return; }
      setApplyResult({ ok: true, text: j.note || 'Applied.', applied: j.applied, skipped: j.skipped });
      setPlan(null);
      await loadCheckpoints();
      onApplied?.();
    } catch (e: any) { setApplyResult({ ok: false, text: e?.message || String(e) }); }
    finally { setApplying(false); }
  }, [plan, endpoint, loadCheckpoints, onApplied]);

  const restore = useCallback(async (checkpointId: string) => {
    setRestoringId(checkpointId); setRestoreMsg(null);
    try {
      const r = await fetch(endpoint, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'restore', checkpointId }),
      });
      const j = await r.json();
      if (!j.ok) { setRestoreMsg({ ok: false, text: j.error || `HTTP ${r.status}` }); return; }
      setRestoreMsg({ ok: true, text: j.note || 'Restored.' });
      await loadCheckpoints();
      onApplied?.();
    } catch (e: any) { setRestoreMsg({ ok: false, text: e?.message || String(e) }); }
    finally { setRestoringId(null); }
  }, [endpoint, loadCheckpoints, onApplied]);

  const checkpointNow = useCallback(async () => {
    setRestoreMsg(null);
    try {
      const r = await fetch(endpoint, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'checkpoint', label: 'Manual checkpoint' }),
      });
      const j = await r.json();
      if (!j.ok) { setRestoreMsg({ ok: false, text: j.error || `HTTP ${r.status}` }); return; }
      setRestoreMsg({ ok: true, text: 'Checkpoint captured.' });
      await loadCheckpoints();
    } catch (e: any) { setRestoreMsg({ ok: false, text: e?.message || String(e) }); }
  }, [endpoint, loadCheckpoints]);

  return (
    <div className={cs.root}>
      <MessageBar intent="info">
        <MessageBarBody>
          <MessageBarTitle>{title}</MessageBarTitle>
          {intro}
        </MessageBarBody>
      </MessageBar>

      <Field label={fieldLabel} hint={fieldHint}>
        <Textarea
          value={prompt}
          onChange={(_, d) => setPrompt(d.value)}
          placeholder={placeholder}
          rows={3}
          resize="vertical"
          aria-label={fieldLabel}
          onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); void propose(); } }}
        />
      </Field>
      <div className={cs.actionRow}>
        <Button appearance="primary" icon={proposing ? <Spinner size="tiny" /> : <Sparkle16Regular />} disabled={proposing || !prompt.trim()} onClick={propose}>
          {proposing ? 'Asking Copilot…' : 'Propose edits'}
        </Button>
        <Button appearance="secondary" disabled={!!restoringId} onClick={checkpointNow}>Save checkpoint now</Button>
      </div>

      {proposeErr && (
        <MessageBar intent={proposeErr.gate ? 'warning' : 'error'}>
          <MessageBarBody>
            <MessageBarTitle>{proposeErr.gate ? `Copilot not configured (${proposeErr.gate.missing})` : 'Copilot could not produce a plan'}</MessageBarTitle>
            {proposeErr.gate ? proposeErr.gate.detail : proposeErr.text}
          </MessageBarBody>
        </MessageBar>
      )}

      {plan && (
        <Card className={cs.planCard}>
          <div className={cs.sectionHead}>
            <Subtitle2>Proposed plan</Subtitle2>
            {plan.ops.length > 0 && (
              <Badge appearance="tint" color="brand">{plan.ops.length} {opNoun}{plan.ops.length === 1 ? '' : 's'}</Badge>
            )}
          </div>
          <Caption1>{plan.summary}</Caption1>
          {plan.ops.length === 0 ? (
            <MessageBar intent="warning"><MessageBarBody>Copilot did not find a valid edit for that request against the current item.</MessageBarBody></MessageBar>
          ) : (
            <ul className={cs.opList}>
              {plan.ops.map((op, i) => (
                <li key={i} className={cs.opRow}>
                  <Badge appearance="tint" color={op.badgeColor}>{op.badge}</Badge>
                  <span className={cs.opText}>{op.describe}</span>
                </li>
              ))}
            </ul>
          )}
          <div className={cs.actionRow}>
            <Button appearance="primary" disabled={applying || plan.ops.length === 0} icon={applying ? <Spinner size="tiny" /> : <Sparkle16Regular />} onClick={apply}>
              {applying ? 'Applying…' : `Apply ${plan.ops.length} ${opNoun}${plan.ops.length === 1 ? '' : 's'}`}
            </Button>
            <Button appearance="secondary" disabled={applying} onClick={() => setPlan(null)}>Discard</Button>
          </div>
        </Card>
      )}

      {applyResult && (
        <MessageBar intent={applyResult.ok ? 'success' : 'error'}>
          <MessageBarBody>
            <MessageBarTitle>{applyResult.ok ? 'Edits applied' : 'Apply failed'}</MessageBarTitle>
            {applyResult.text}
            {applyResult.applied && applyResult.applied.length > 0 && (
              <ul className={cs.applyList}>{applyResult.applied.map((a, i) => <li key={i}>{a}</li>)}</ul>
            )}
            {applyResult.skipped && applyResult.skipped.length > 0 && (
              <div className={cs.skippedWrap}><strong>Skipped:</strong>
                <ul className={cs.skippedList}>{applyResult.skipped.map((a, i) => <li key={i}>{a}</li>)}</ul>
              </div>
            )}
          </MessageBarBody>
        </MessageBar>
      )}

      <Divider />

      <div className={cs.sectionHead}>
        <div className={cs.cpLabelRow}>
          <Subtitle2>Checkpoints</Subtitle2>
          {Array.isArray(checkpoints) && checkpoints.length > 0 && (
            <Badge appearance="tint" color="informative">{checkpoints.length}</Badge>
          )}
        </div>
        <Button size="small" appearance="subtle" disabled={checkpoints === null} onClick={loadCheckpoints}>Refresh</Button>
      </div>
      {restoreMsg && (
        <MessageBar intent={restoreMsg.ok ? 'success' : 'error'}><MessageBarBody>{restoreMsg.text}</MessageBarBody></MessageBar>
      )}
      {cpErr && <MessageBar intent="error"><MessageBarBody>{cpErr}</MessageBarBody></MessageBar>}
      {checkpoints === null ? (
        <Spinner size="tiny" label="Loading checkpoints…" labelPosition="after" />
      ) : checkpoints.length === 0 ? (
        <div className={cs.emptyState}>
          <Subtitle2>No checkpoints yet</Subtitle2>
          <Caption1>One is captured automatically before each Copilot apply. You can also save one now with “Save checkpoint now”.</Caption1>
        </div>
      ) : (
        <div className={cs.cpList}>
          {checkpoints.map((c) => (
            <div key={c.id} className={cs.cpRow}>
              <div className={cs.cpMeta}>
                <span className={cs.cpLabelRow}>
                  <Badge appearance="outline" color={c.source === 'pre-restore' ? 'warning' : c.source === 'manual' ? 'informative' : 'brand'}>{c.source}</Badge>
                  <strong>{c.label}</strong>
                </span>
                <Caption1>{new Date(c.createdAt).toLocaleString()}{statsLine(c.stats) ? ` · ${statsLine(c.stats)}` : ''}</Caption1>
              </div>
              <Button size="small" appearance="secondary" disabled={restoringId === c.id} icon={restoringId === c.id ? <Spinner size="tiny" /> : undefined} onClick={() => restore(c.id)}>
                {restoringId === c.id ? 'Restoring…' : 'Restore'}
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
