'use client';

/**
 * Spindle Studio right-rail panels (Palantir AIP-Logic parity):
 *   - SpindleSettingsPanel — model tier / temperature / max-tokens / default mode
 *     + the evals-gate threshold. Wired to state.settings; the tier + temperature
 *     really route the use-LLM turns (see _block-graph.resolveTurnOverrides).
 *   - SpindleEvalsPanel    — authored eval cases (inputs + criteria) run against
 *     the REAL block graph + LLM-judge scoring (POST …/eval). Powers the publish
 *     gate.
 *   - SpindlePublishPanel  — "Publish as REST" (POST …/publish) through APIM with
 *     the evals-in-CI gate, then a Uses card (callable URL + working curl).
 *   - SpindleVersionsPanel — snapshot (POST …/versions) + a two-version diff.
 *
 * Fluent v9 + Loom tokens + shared editor primitives only. No mock data — every
 * action calls a real BFF route; honest MessageBar gates on missing infra.
 */
import { useCallback, useMemo, useState } from 'react';
import {
  Title3, Subtitle2, Body1, Caption1, Badge, Button, Input, Textarea, Field, Dropdown, Option,
  Slider, SpinButton, Switch, Divider, Spinner,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
} from '@fluentui/react-components';
import {
  Add20Regular, Dismiss16Regular, Play20Regular, Settings20Regular, Beaker20Regular,
  Globe20Regular, History20Regular, CheckmarkCircle20Regular, DismissCircle20Regular,
  Warning20Regular, ArrowSwap20Regular, Save20Regular,
} from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';
import { MODEL_TIERS, TIER_LABELS, type ModelTier } from '@/lib/foundry/model-tier-router';
import { useStyles, CodeBlock, SectionHead } from './shared';
import { diffSnapshots, type SnapshotLite } from './aip-logic-version-diff';

// ── shared prop shapes ──
export interface AipSettingsShape {
  tier?: ModelTier; temperature?: number; maxTokens?: number;
  defaultMode?: 'logic' | 'agent'; evalThreshold?: number; minPassRate?: number;
}
export interface AipEvalCase { id: string; name?: string; inputsText?: string; criteria?: string }
export interface AipEvalRowLite { id?: string; name?: string; criteria?: string; score?: number; status?: string; answer?: string; rationale?: string; error?: string }
export interface AipLastEval { ranAt?: string; summary?: { total: number; scored: number; avgScore: number; passRate: number; passThreshold: number }; passed?: boolean; rows?: AipEvalRowLite[]; context?: string }
export interface AipVersion { id: string; ts: string; label: string; meta?: Record<string, unknown>; snapshot?: SnapshotLite }

type Msg = { intent: 'success' | 'error' | 'warning'; text: string } | null;

// ───────────────────────── Settings ─────────────────────────
export function SpindleSettingsPanel({ settings, onChange }: {
  settings: AipSettingsShape; onChange: (patch: Partial<AipSettingsShape>) => void;
}) {
  const s = useStyles();
  const tier = settings.tier || 'standard';
  const temp = typeof settings.temperature === 'number' ? settings.temperature : 0.2;
  return (
    <div className={s.section}>
      <SectionHead icon={<Settings20Regular />} title="Model & settings" hint="How each Use-LLM block runs — the tier routes to a real Azure OpenAI deployment; temperature + max tokens are threaded into the live call." />
      <div className={s.blockGrid}>
        <Field label="Model tier" hint="Routes to LOOM_AOAI_MINI/STRONG deployment when set; else the default.">
          <Dropdown value={TIER_LABELS[tier]} selectedOptions={[tier]} onOptionSelect={(_, d) => onChange({ tier: (d.optionValue as ModelTier) || 'standard' })}>
            {MODEL_TIERS.map((t) => <Option key={t} value={t} text={TIER_LABELS[t]}>{TIER_LABELS[t]}</Option>)}
          </Dropdown>
        </Field>
        <Field label="Default run mode">
          <Dropdown value={settings.defaultMode === 'agent' ? 'Agent (tool-calling)' : 'Logic (deterministic)'} selectedOptions={[settings.defaultMode || 'logic']} onOptionSelect={(_, d) => onChange({ defaultMode: (d.optionValue as 'logic' | 'agent') || 'logic' })}>
            <Option value="logic">Logic (deterministic)</Option>
            <Option value="agent">Agent (tool-calling)</Option>
          </Dropdown>
        </Field>
      </div>
      <Field label={`Temperature — ${temp.toFixed(2)}`} hint="Lower = more deterministic. Reasoning deployments ignore this automatically.">
        <Slider min={0} max={1} step={0.05} value={temp} onChange={(_, d) => onChange({ temperature: d.value })} />
      </Field>
      <div className={s.blockGrid}>
        <Field label="Max completion tokens" hint="Per Use-LLM turn.">
          <SpinButton min={64} max={16000} step={64} value={settings.maxTokens ?? 1200} onChange={(_, d) => { const v = d.value ?? Number(d.displayValue); if (Number.isFinite(v)) onChange({ maxTokens: Number(v) }); }} />
        </Field>
        <Field label="Eval pass threshold (1–5)" hint="LLM-judge score a case must reach to pass the publish gate.">
          <SpinButton min={1} max={5} step={1} value={settings.evalThreshold ?? 4} onChange={(_, d) => { const v = d.value ?? Number(d.displayValue); if (Number.isFinite(v)) onChange({ evalThreshold: Math.max(1, Math.min(5, Number(v))) }); }} />
        </Field>
        <Field label={`Min pass-rate — ${Math.round((settings.minPassRate ?? 1) * 100)}%`} hint="Fraction of cases that must pass to publish.">
          <Slider min={0} max={1} step={0.1} value={settings.minPassRate ?? 1} onChange={(_, d) => onChange({ minPassRate: d.value })} />
        </Field>
      </div>
    </div>
  );
}

// ───────────────────────── Evals ─────────────────────────
export function SpindleEvalsPanel({ id, cases, onCases, lastEval, onRan, inputNames, ensureSaved, blocksReady }: {
  id: string; cases: AipEvalCase[]; onCases: (next: AipEvalCase[]) => void;
  lastEval: AipLastEval | null; onRan: (le: AipLastEval) => void;
  inputNames: string[]; ensureSaved: () => Promise<boolean>; blocksReady: boolean;
}) {
  const s = useStyles();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);

  const addCase = useCallback(() => {
    const tmpl = inputNames.length ? JSON.stringify(Object.fromEntries(inputNames.map((n) => [n, ''])), null, 0) : '{}';
    onCases([...cases, { id: `ec_${Date.now()}`, name: `Case ${cases.length + 1}`, inputsText: tmpl, criteria: '' }]);
  }, [cases, onCases, inputNames]);
  const patchCase = useCallback((cid: string, patch: Partial<AipEvalCase>) => onCases(cases.map((c) => c.id === cid ? { ...c, ...patch } : c)), [cases, onCases]);
  const removeCase = useCallback((cid: string) => onCases(cases.filter((c) => c.id !== cid)), [cases, onCases]);

  const runEvals = useCallback(async () => {
    setBusy(true); setMsg(null);
    try {
      const saved = await ensureSaved();
      if (!saved) { setMsg({ intent: 'error', text: 'Could not save the eval suite before running.' }); return; }
      const r = await clientFetch(`/api/items/aip-logic/${encodeURIComponent(id)}/eval`, { method: 'POST' });
      const j = await r.json().catch(() => ({}));
      if (!j?.ok) {
        const gate = j?.gate ? ` ${j.gate.remediation || ''}` : '';
        setMsg({ intent: j?.gate ? 'warning' : 'error', text: `${j?.error || `HTTP ${r.status}`}${gate}` });
        if (j?.summary) onRan({ summary: j.summary, rows: j.rows, passed: false });
        return;
      }
      onRan(j as AipLastEval);
      setMsg({ intent: j.passed ? 'success' : 'warning', text: j.passed ? `Suite passed — ${Math.round((j.summary?.passRate || 0) * 100)}% pass-rate, avg ${j.summary?.avgScore}/5.` : `Suite did not pass — ${Math.round((j.summary?.passRate || 0) * 100)}% pass-rate. Publish is blocked until it passes.` });
    } catch (e: any) { setMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setBusy(false); }
  }, [id, ensureSaved, onRan]);

  const rowsById = useMemo(() => new Map((lastEval?.rows || []).map((r) => [r.id || r.name || '', r])), [lastEval]);
  const gradable = cases.filter((c) => (c.criteria || '').trim()).length;

  return (
    <div className={s.section}>
      <SectionHead icon={<Beaker20Regular />} title="Evals" hint="Authored test cases (typed inputs + pass criteria). Each runs the REAL block graph and is graded 1–5 by an LLM judge. A passing suite is required to publish as REST." />
      <div className={s.addBar}>
        <Button appearance="secondary" icon={<Add20Regular />} onClick={addCase}>Add eval case</Button>
        <span className={s.spacer} />
        <Button appearance="primary" icon={busy ? <Spinner size="tiny" /> : <Play20Regular />} disabled={busy || gradable === 0 || !blocksReady} onClick={runEvals}>{busy ? 'Running…' : 'Run evals'}</Button>
      </div>
      {msg && <MessageBar intent={msg.intent}><MessageBarBody>{msg.text}</MessageBarBody></MessageBar>}
      {lastEval?.summary && (
        <div className={s.modeBar}>
          <Badge appearance="filled" color={lastEval.passed ? 'success' : 'danger'} icon={lastEval.passed ? <CheckmarkCircle20Regular /> : <DismissCircle20Regular />}>{lastEval.passed ? 'Passing' : 'Not passing'}</Badge>
          <Caption1 className={s.hint}>pass-rate {Math.round((lastEval.summary.passRate || 0) * 100)}% · avg {lastEval.summary.avgScore}/5 · threshold {lastEval.summary.passThreshold}/5 · {lastEval.summary.total} case(s)</Caption1>
        </div>
      )}
      {cases.length === 0 ? (
        <div className={s.empty}><Caption1>No eval cases yet. Add a case (inputs + a plain-language pass criterion) to gate publish.</Caption1></div>
      ) : cases.map((c) => {
        const res = rowsById.get(c.id) || rowsById.get(c.name || '');
        return (
          <div key={c.id} className={s.toolCard}>
            <div className={s.blockCardHead}>
              <Field label="Case name" className={s.fieldMed}><Input value={c.name || ''} onChange={(_, d) => patchCase(c.id, { name: d.value })} /></Field>
              <span className={s.spacer} />
              {res && (typeof res.score === 'number') && (
                <Badge appearance="tint" color={res.status === 'pass' ? 'success' : res.status === 'fail' ? 'danger' : 'warning'}>{res.status || 'scored'} · {res.score}/5</Badge>
              )}
              <Button size="small" appearance="subtle" icon={<Dismiss16Regular />} aria-label="Remove case" onClick={() => removeCase(c.id)} />
            </div>
            <Field label="Inputs (JSON)" hint="A typed inputs object — the test case values fed to the function.">
              <Textarea value={c.inputsText || '{}'} onChange={(_, d) => patchCase(c.id, { inputsText: d.value })} resize="vertical" />
            </Field>
            <Field label="Pass criteria" hint="What a correct output looks like — the LLM judge scores against this.">
              <Textarea value={c.criteria || ''} onChange={(_, d) => patchCase(c.id, { criteria: d.value })} resize="vertical" placeholder="e.g. Output is a one-line risk summary that names the customer and a High/Medium/Low band." />
            </Field>
            {res?.rationale && <Caption1 className={s.hint}>Judge: {res.rationale}</Caption1>}
            {res?.error && <Caption1 className={s.errorCaption}>{res.error}</Caption1>}
          </div>
        );
      })}
    </div>
  );
}

// ───────────────────────── Publish as REST ─────────────────────────
export function SpindlePublishPanel({ id, published, ensureSaved, blocksReady, hasEvalSuite }: {
  id: string;
  published: { publishedApiPath?: string; publishedCallableUrl?: string | null; publishedAt?: string };
  ensureSaved: () => Promise<boolean>; blocksReady: boolean; hasEvalSuite: boolean;
}) {
  const s = useStyles();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const [result, setResult] = useState<{ callableUrl?: string; curl?: string; path?: string } | null>(
    published.publishedApiPath ? { callableUrl: published.publishedCallableUrl || undefined, path: published.publishedApiPath } : null,
  );
  const [failedRows, setFailedRows] = useState<AipEvalRowLite[]>([]);

  const publish = useCallback(async () => {
    setBusy(true); setMsg(null); setFailedRows([]);
    try {
      const saved = await ensureSaved();
      if (!saved) { setMsg({ intent: 'error', text: 'Could not save before publishing.' }); return; }
      const r = await clientFetch(`/api/items/aip-logic/${encodeURIComponent(id)}/publish`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      const j = await r.json().catch(() => ({}));
      if (!j?.ok) {
        if (j?.code === 'eval_gate_failed' && j?.eval?.rows) setFailedRows((j.eval.rows as AipEvalRowLite[]).filter((x) => x.status !== 'pass'));
        const gate = j?.gate ? ` ${j.gate.remediation || ''}` : '';
        setMsg({ intent: j?.gate ? 'warning' : 'error', text: `${j?.error || `HTTP ${r.status}`}${gate}` });
        return;
      }
      setResult({ callableUrl: j.callableUrl, curl: j.curl, path: j.api?.path });
      setMsg({ intent: 'success', text: `Published to APIM as "${j.api?.displayName}" at /${j.api?.path}. Evals passed — gate cleared.` });
    } catch (e: any) { setMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setBusy(false); }
  }, [id, ensureSaved]);

  return (
    <div className={s.section}>
      <SectionHead icon={<Globe20Regular />} title="Publish as REST" hint="Expose this function as a typed REST endpoint through Azure API Management. Publish is gated: the attached eval suite must pass first (evals-in-CI)." />
      {!hasEvalSuite && (
        <MessageBar intent="warning"><MessageBarBody><MessageBarTitle>Evals gate</MessageBarTitle>Add + pass at least one eval case (Evals tab) — publish is blocked until the suite passes.</MessageBarBody></MessageBar>
      )}
      <div className={s.addBar}>
        <Button appearance="primary" icon={busy ? <Spinner size="tiny" /> : <Globe20Regular />} disabled={busy || !blocksReady} onClick={publish}>{busy ? 'Publishing…' : result ? 'Re-publish REST API' : 'Publish as REST'}</Button>
        {result?.path && <Badge appearance="tint" color="success">/{result.path}</Badge>}
      </div>
      {msg && <MessageBar intent={msg.intent}><MessageBarBody>{msg.text}</MessageBarBody></MessageBar>}
      {failedRows.length > 0 && (
        <div className={s.tableWrap}>
          <Table aria-label="Failing eval cases" size="small">
            <TableHeader><TableRow><TableHeaderCell>Case</TableHeaderCell><TableHeaderCell>Score</TableHeaderCell><TableHeaderCell>Judge</TableHeaderCell></TableRow></TableHeader>
            <TableBody>
              {failedRows.map((r, i) => (
                <TableRow key={r.id || i}>
                  <TableCell><Caption1>{r.name || r.criteria?.slice(0, 40) || `Case ${i + 1}`}</Caption1></TableCell>
                  <TableCell><Badge appearance="tint" color="danger">{r.score ?? 0}/5</Badge></TableCell>
                  <TableCell><Caption1 className={s.hint}>{r.rationale || r.error || '—'}</Caption1></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {result?.callableUrl && (
        <>
          <Divider />
          <Subtitle2>Uses</Subtitle2>
          <Caption1 className={s.hint}>Call the published function through the APIM gateway with a subscription key.</Caption1>
          <div className={s.kv}><Caption1 className={s.hint}>Callable URL</Caption1><Body1>{result.callableUrl}</Body1></div>
          {result.curl && <CodeBlock ariaLabel="curl to invoke the published Spindle REST API" content={result.curl} />}
        </>
      )}
    </div>
  );
}

// ───────────────────────── Versions + diff ─────────────────────────
export function SpindleVersionsPanel({ id, versions, onVersions, currentSnapshot, ensureSaved, blocksReady }: {
  id: string; versions: AipVersion[]; onVersions: (next: AipVersion[]) => void;
  currentSnapshot: SnapshotLite; ensureSaved: () => Promise<boolean>; blocksReady: boolean;
}) {
  const s = useStyles();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const [label, setLabel] = useState('');
  const [leftId, setLeftId] = useState('');
  const [rightId, setRightId] = useState('__current__');

  const snapshot = useCallback(async () => {
    setBusy(true); setMsg(null);
    try {
      const saved = await ensureSaved();
      if (!saved) { setMsg({ intent: 'error', text: 'Could not save before snapshotting.' }); return; }
      const r = await clientFetch(`/api/items/aip-logic/${encodeURIComponent(id)}/versions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: label.trim() || undefined }) });
      const j = await r.json().catch(() => ({}));
      if (!j?.ok) { setMsg({ intent: 'error', text: j?.error || `HTTP ${r.status}` }); return; }
      onVersions(j.versions as AipVersion[]); setLabel('');
      setMsg({ intent: 'success', text: `Saved version "${j.version?.label}".` });
    } catch (e: any) { setMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setBusy(false); }
  }, [id, label, ensureSaved, onVersions]);

  const options = useMemo(() => [{ id: '__current__', label: 'Current (unsaved edits)' }, ...versions.map((v) => ({ id: v.id, label: `${v.label} · ${new Date(v.ts).toLocaleString()}` }))], [versions]);
  const snapOf = useCallback((vid: string): SnapshotLite | undefined => vid === '__current__' ? currentSnapshot : versions.find((v) => v.id === vid)?.snapshot, [versions, currentSnapshot]);
  const diff = useMemo(() => (leftId && rightId ? diffSnapshots(snapOf(leftId), snapOf(rightId)) : null), [leftId, rightId, snapOf]);
  const changeColor = (c: string) => c === 'added' ? 'success' : c === 'removed' ? 'danger' : c === 'edited' ? 'warning' : undefined;

  return (
    <div className={s.section}>
      <SectionHead icon={<History20Regular />} title="Versions" hint="Immutable snapshots of the function definition (inputs · block graph · output · settings). Snapshots are also captured automatically on publish. Compare any two." />
      <div className={s.addBar}>
        <Field label="Label (optional)" className={s.fieldStep}><Input value={label} onChange={(_, d) => setLabel(d.value)} placeholder="e.g. Added risk-band branch" /></Field>
        <Button appearance="primary" icon={busy ? <Spinner size="tiny" /> : <Save20Regular />} disabled={busy || !blocksReady} onClick={snapshot}>Save version</Button>
      </div>
      {msg && <MessageBar intent={msg.intent}><MessageBarBody>{msg.text}</MessageBarBody></MessageBar>}
      {versions.length === 0 ? (
        <div className={s.empty}><Caption1>No versions yet — save one, or publish (publish snapshots a version automatically).</Caption1></div>
      ) : (
        <>
          <div className={s.blockGrid}>
            <Field label="Compare (base)">
              <Dropdown value={options.find((o) => o.id === leftId)?.label || 'Pick a version'} selectedOptions={leftId ? [leftId] : []} onOptionSelect={(_, d) => setLeftId(String(d.optionValue || ''))}>
                {options.map((o) => <Option key={o.id} value={o.id} text={o.label}>{o.label}</Option>)}
              </Dropdown>
            </Field>
            <Field label="Against">
              <Dropdown value={options.find((o) => o.id === rightId)?.label || 'Pick a version'} selectedOptions={rightId ? [rightId] : []} onOptionSelect={(_, d) => setRightId(String(d.optionValue || ''))}>
                {options.map((o) => <Option key={o.id} value={o.id} text={o.label}>{o.label}</Option>)}
              </Dropdown>
            </Field>
          </div>
          {diff && (
            <div className={s.runPanel}>
              <div className={s.traceHead}>
                <ArrowSwap20Regular />
                <Badge appearance="tint" color="success">+{diff.addedCount}</Badge>
                <Badge appearance="tint" color="danger">−{diff.removedCount}</Badge>
                <Badge appearance="tint" color="warning">~{diff.editedCount}</Badge>
                {diff.addedCount + diff.removedCount + diff.editedCount === 0 && <Caption1 className={s.hint}>Identical.</Caption1>}
              </div>
              {[...diff.inputs, ...diff.blocks].filter((r) => r.change !== 'unchanged').map((r) => (
                <div key={`${r.label}-${r.key}`} className={s.kv}>
                  <span><Badge appearance="outline" color={changeColor(r.change) as any}>{r.change}</Badge> <Caption1>{r.label}</Caption1></span>
                  {r.detail && <Caption1 className={s.hint}>{r.detail}</Caption1>}
                </div>
              ))}
              {diff.outputChanged && <div className={s.kv}><span><Badge appearance="outline" color="warning">output</Badge> <Caption1>Output contract</Caption1></span><Caption1 className={s.hint}>{diff.outputDetail}</Caption1></div>}
              {diff.settingsChanged && <div className={s.kv}><span><Badge appearance="outline" color="warning">settings</Badge> <Caption1>Model / settings</Caption1></span></div>}
            </div>
          )}
        </>
      )}
    </div>
  );
}
