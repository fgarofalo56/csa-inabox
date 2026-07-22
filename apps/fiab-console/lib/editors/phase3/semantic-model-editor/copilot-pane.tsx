'use client';

// copilot-pane.tsx — SemanticModelCopilotPane (NL → structured edit plan →
// checkpoint + apply → restore). Extracted byte-for-byte from
// ../semantic-model-editor.tsx.

import { useCallback, useEffect, useState } from 'react';
import {
  Subtitle2, Caption1, Badge, Button, Spinner, Field,
  Card, Divider, Textarea,
  MessageBar, MessageBarBody, MessageBarTitle, tokens,
} from '@fluentui/react-components';
import { Sparkle16Regular } from '@fluentui/react-icons';
import type { CopilotEditPlan, CopilotCheckpoint } from './types';
import { OP_LABEL } from './constants';
import { describeOp, opBadgeColor } from './helpers';
import { useCopilotPaneStyles } from './styles';

export function SemanticModelCopilotPane({ id }: { id: string }) {
  const cs = useCopilotPaneStyles();
  const [prompt, setPrompt] = useState('');
  const [proposing, setProposing] = useState(false);
  const [plan, setPlan] = useState<CopilotEditPlan | null>(null);
  const [proposeErr, setProposeErr] = useState<{ text: string; gate?: { missing: string; detail: string } } | null>(null);
  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState<{ ok: boolean; text: string; applied?: string[]; skipped?: string[]; xmla?: { attempted: boolean; backend?: string } } | null>(null);
  const [checkpoints, setCheckpoints] = useState<CopilotCheckpoint[] | null>(null);
  const [cpErr, setCpErr] = useState<string | null>(null);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [restoreMsg, setRestoreMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const loadCheckpoints = useCallback(async () => {
    setCpErr(null);
    try {
      const r = await fetch(`/api/items/semantic-model/${encodeURIComponent(id)}/copilot-structure?action=checkpoints`);
      const j = await r.json();
      if (!j.ok) { setCpErr(j.error || `HTTP ${r.status}`); setCheckpoints([]); return; }
      setCheckpoints(Array.isArray(j.checkpoints) ? j.checkpoints : []);
    } catch (e: any) { setCpErr(e?.message || String(e)); setCheckpoints([]); }
  }, [id]);

  useEffect(() => { loadCheckpoints(); }, [loadCheckpoints]);

  const propose = useCallback(async () => {
    const q = prompt.trim();
    if (!q) return;
    setProposing(true); setPlan(null); setProposeErr(null); setApplyResult(null);
    try {
      const r = await fetch(`/api/items/semantic-model/${encodeURIComponent(id)}/copilot-structure`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'propose', prompt: q }),
      });
      const j = await r.json();
      if (!j.ok) { setProposeErr({ text: j.error || `HTTP ${r.status}`, gate: j.gate }); return; }
      setPlan(j.plan as CopilotEditPlan);
    } catch (e: any) { setProposeErr({ text: e?.message || String(e) }); }
    finally { setProposing(false); }
  }, [prompt, id]);

  const apply = useCallback(async () => {
    if (!plan || plan.ops.length === 0) return;
    setApplying(true); setApplyResult(null);
    try {
      const r = await fetch(`/api/items/semantic-model/${encodeURIComponent(id)}/copilot-structure`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'apply', plan }),
      });
      const j = await r.json();
      if (!j.ok) { setApplyResult({ ok: false, text: j.error || `HTTP ${r.status}` }); return; }
      setApplyResult({ ok: true, text: j.note || 'Applied.', applied: j.applied, skipped: j.skipped, xmla: j.xmla });
      setPlan(null);
      await loadCheckpoints();
    } catch (e: any) { setApplyResult({ ok: false, text: e?.message || String(e) }); }
    finally { setApplying(false); }
  }, [plan, id, loadCheckpoints]);

  const restore = useCallback(async (checkpointId: string) => {
    setRestoringId(checkpointId); setRestoreMsg(null);
    try {
      const r = await fetch(`/api/items/semantic-model/${encodeURIComponent(id)}/copilot-structure`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'restore', checkpointId }),
      });
      const j = await r.json();
      if (!j.ok) { setRestoreMsg({ ok: false, text: j.error || `HTTP ${r.status}` }); return; }
      setRestoreMsg({ ok: true, text: j.note || 'Restored.' });
      await loadCheckpoints();
    } catch (e: any) { setRestoreMsg({ ok: false, text: e?.message || String(e) }); }
    finally { setRestoringId(null); }
  }, [id, loadCheckpoints]);

  const checkpointNow = useCallback(async () => {
    setRestoreMsg(null);
    try {
      const r = await fetch(`/api/items/semantic-model/${encodeURIComponent(id)}/copilot-structure`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'checkpoint', label: 'Manual checkpoint' }),
      });
      const j = await r.json();
      if (!j.ok) { setRestoreMsg({ ok: false, text: j.error || `HTTP ${r.status}` }); return; }
      setRestoreMsg({ ok: true, text: 'Checkpoint captured.' });
      await loadCheckpoints();
    } catch (e: any) { setRestoreMsg({ ok: false, text: e?.message || String(e) }); }
  }, [id, loadCheckpoints]);

  return (
    <div className={cs.root}>
      <MessageBar intent="info">
        <MessageBarBody>
          <MessageBarTitle>Copilot — edit model structure in natural language</MessageBarTitle>
          Describe a structure change (rename a measure, write business descriptions, suggest relationships). Copilot proposes a plan you review and approve. A checkpoint is captured before any edit so you can restore. Edits persist Azure-native to the Loom model and mirror to a live Analysis Services model via TMSL when one is configured — no Microsoft Fabric / Power BI required.
        </MessageBarBody>
      </MessageBar>

      <Field label="Ask Copilot to change the model structure" hint="Plain English — Copilot grounds the plan against the live tables and measures, then waits for your approval.">
        <Textarea
          value={prompt}
          onChange={(_, d) => setPrompt(d.value)}
          placeholder={'e.g. "Rename [Tot Sales] to [Total Sales] and write a description for every measure", or "Suggest relationships between the fact and dimension tables".'}
          rows={3}
          resize="vertical"
          aria-label="Ask Copilot to change the model structure"
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
              <Badge appearance="tint" color="brand">{plan.ops.length} edit{plan.ops.length === 1 ? '' : 's'}</Badge>
            )}
          </div>
          <Caption1>{plan.summary}</Caption1>
          {plan.ops.length === 0 ? (
            <MessageBar intent="warning"><MessageBarBody>Copilot did not find a valid structure edit for that request against the current model.</MessageBarBody></MessageBar>
          ) : (
            <ul className={cs.opList}>
              {plan.ops.map((op, i) => (
                <li key={i} className={cs.opRow}>
                  <Badge appearance="tint" color={opBadgeColor(op.kind)}>{OP_LABEL[op.kind]}</Badge>
                  <span className={cs.opText}>{describeOp(op)}</span>
                </li>
              ))}
            </ul>
          )}
          <div className={cs.actionRow}>
            <Button appearance="primary" disabled={applying || plan.ops.length === 0} icon={applying ? <Spinner size="tiny" /> : <Sparkle16Regular />} onClick={apply}>
              {applying ? 'Applying…' : `Apply ${plan.ops.length} edit(s)`}
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
              <ul style={{ margin: `${tokens.spacingVerticalXS} 0 0`, paddingLeft: tokens.spacingHorizontalXL }}>{applyResult.applied.map((a, i) => <li key={i}>{a}</li>)}</ul>
            )}
            {applyResult.skipped && applyResult.skipped.length > 0 && (
              <div style={{ marginTop: tokens.spacingVerticalS}}><strong>Skipped:</strong>
                <ul style={{ margin: `${tokens.spacingVerticalXXS} 0 0`, paddingLeft: tokens.spacingHorizontalXL }}>{applyResult.skipped.map((a, i) => <li key={i}>{a}</li>)}</ul>
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
        <Spinner size="tiny" label="Loading checkpoints…" labelPosition="after" style={{ justifyContent: 'flex-start' }} />
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
                <Caption1>{new Date(c.createdAt).toLocaleString()} · {c.stats.measures} measure(s), {c.stats.relationships} relationship(s)</Caption1>
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
