'use client';

import { clientFetch } from '@/lib/client-fetch';
/**
 * LogicAppEditor — Azure Logic Apps (Consumption) editor.
 *
 * The workflow item is AUTO-BOUND (`.claude/rules/auto-bind-by-default.md`):
 * opening this editor provisions and binds the backing
 * `Microsoft.Logic/workflows` resource — named identically to the Loom item —
 * if it does not already exist, and self-heals a broken binding. There is no
 * "bind a Logic App first" step and no re-install instruction.
 *
 * Surfaces (parity with the Azure portal Logic App designer):
 *   - Designer tab: a REAL visual authoring canvas (React Flow + the shared
 *     Loom canvas kit) — drag operations from the palette, connect steps into
 *     runAfter dependencies, configure each step with typed controls in the
 *     docked inspector, undo/redo, align/distribute, auto-layout, resizable
 *     panes. Every edit rewrites the Workflow Definition Language document.
 *   - Parameters tab: WDL parameters (type/default/description) + deploy values.
 *   - Runs tab: REAL run history from the service, with per-run action detail.
 *   - Code view tab: Monaco JSON over the same definition, for operations the
 *     palette does not yet model (managed connectors).
 *
 * "Save workflow" PUTs the definition to the real Logic App via ARM; "Run
 * trigger" fires a real manual run and polls run history. Per
 * `.claude/rules/no-vaporware.md` there is no local-only save path: a save that
 * cannot reach Azure reports a gate rather than pretending it succeeded.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  Subtitle2, Body1, Caption1, Badge, Button, Spinner,
  Tab, TabList, Dropdown, Option, Tooltip,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Play20Regular, ArrowSync20Regular,
  Options20Regular, ArrowExportLtr20Regular, Save20Regular, History20Regular,
} from '@fluentui/react-icons';
import { EmptyState } from '@/lib/components/empty-state';
import { ItemEditorChrome } from './item-editor-chrome';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';
import { TeachingBanner } from '@/lib/components/shared/teaching-toast';
import { HonestGate } from '@/lib/components/shared/honest-gate';
import { useRegisterRibbonCommands } from '@/lib/components/shared/ribbon-commands';
import { WorkflowDesignerCanvas } from '@/lib/components/logic-app/workflow-designer-canvas';
import { LOGIC_APP_GATE_ID } from '@/lib/logic-app/gate-id';
import { emptyDefinition, type WdlDefinition, type ValidationIssue } from '@/lib/logic-app/wdl-model';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';

const useStyles = makeStyles({
  pad: { padding: tokens.spacingHorizontalL, display: 'flex', flexDirection: 'column', gap: tokens.spacingHorizontalM, flex: 1, minHeight: 0 },
  designerPad: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, flex: 1, minHeight: 0, minWidth: 0 },
  tabs: { borderBottom: `1px solid ${tokens.colorNeutralStroke2}`, paddingTop: tokens.spacingVerticalS, paddingLeft: tokens.spacingHorizontalS, paddingRight: tokens.spacingHorizontalS },
  toolbar: {
    display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap', minWidth: 0,
    paddingLeft: tokens.spacingHorizontalL, paddingRight: tokens.spacingHorizontalL,
    paddingTop: tokens.spacingVerticalS,
  },
  gateWrap: { paddingLeft: tokens.spacingHorizontalL, paddingRight: tokens.spacingHorizontalL },
  canvasHost: { flex: 1, minHeight: 0, minWidth: 0, display: 'flex' },
  outputsBlob: {
    fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase200, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
    color: tokens.colorNeutralForeground2, backgroundColor: tokens.colorNeutralBackground3,
    borderRadius: tokens.borderRadiusMedium, padding: tokens.spacingHorizontalMNudge,
    border: `1px solid ${tokens.colorNeutralStroke2}`, maxHeight: '280px', overflow: 'auto',
  },
  sectionHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, color: tokens.colorNeutralForeground2 },
  tableWrap: {
    overflow: 'auto', maxHeight: '420px',
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge,
    boxShadow: tokens.shadow4,
  },
  cell: { fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase200, wordBreak: 'break-word', overflowWrap: 'anywhere' },
  runOut: {
    fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase200, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
    backgroundColor: tokens.colorNeutralBackground3, borderRadius: tokens.borderRadiusMedium, padding: tokens.spacingHorizontalMNudge,
    border: `1px solid ${tokens.colorNeutralStroke2}`, maxHeight: '200px', overflow: 'auto',
  },
  clickable: { cursor: 'pointer' },
  badgeRow: { display: 'flex', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap', minWidth: 0, alignItems: 'center' },
});

interface Gate {
  /** 'not-configured' is env-fixable → the shared HonestGate Fix-it wizard. */
  code?: 'not-configured' | 'not-authorized' | 'arm-error';
  reason: string;
  remediation: string;
  link?: string;
  missing?: string[];
}

interface DetailResponse {
  ok: boolean;
  error?: string;
  logicApp?: {
    id: string; displayName: string; description?: string;
    logicAppName?: string; resourceGroup?: string; subscriptionId?: string;
    bound?: boolean; justCreated?: boolean;
  };
  definition?: WdlDefinition;
  parameters?: Record<string, { value?: unknown }>;
  workflowState?: string;
  gate?: Gate;
  source?: 'azure' | 'saved' | 'bundle';
}

interface RunResponse {
  ok: boolean;
  error?: string;
  gate?: Gate;
  triggered?: boolean;
  trigger?: string;
  runName?: string;
  status?: string;
  failureReason?: string;
  steps?: string[];
}

interface RunRow {
  name?: string; status?: string; startTime?: string; endTime?: string;
  durationMs?: number; trigger?: string; error?: string; clientTrackingId?: string;
}

interface ActionRow {
  name?: string; status?: string; startTime?: string; endTime?: string;
  durationMs?: number; code?: string; retryCount?: number; error?: string;
}

interface Props { item: FabricItemType; id: string }

function statusColor(status?: string): 'success' | 'danger' | 'warning' | 'informative' {
  switch (status) {
    case 'Succeeded': return 'success';
    case 'Failed': return 'danger';
    case 'Cancelled': case 'Aborted': case 'TimedOut': return 'warning';
    default: return 'informative';
  }
}

function fmtDuration(ms?: number): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

function fmtTime(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export function LogicAppEditor({ item, id }: Props) {
  const s = useStyles();
  const qc = useQueryClient();
  // The page primes ['item', <slug>, id] with the Cosmos record (carries workspaceId).
  const cached = qc.getQueryData<any>(['item', item.slug, id]);
  const workspaceId: string | undefined = cached?.workspaceId;

  const [detail, setDetail] = useState<DetailResponse | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [tab, setTab] = useState('designer');
  const [running, setRunning] = useState(false);
  const [runRes, setRunRes] = useState<RunResponse | null>(null);
  const [selTrigger, setSelTrigger] = useState('');

  // The working definition. The designer mutates it; Save PUTs it to the real
  // Logic App. `dirty` gates the Save button and the chrome's unsaved marker.
  const [working, setWorking] = useState<WdlDefinition>(() => emptyDefinition());
  const [dirty, setDirty] = useState(false);
  const [savingDef, setSavingDef] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ intent: 'success' | 'error'; text: string } | null>(null);
  const [codeDraft, setCodeDraft] = useState('');
  const [codeErr, setCodeErr] = useState<string | null>(null);
  // Pre-run validation from the designer. Surfaced only AFTER a save attempt so
  // a freshly created workflow opens clean (ux-baseline.md §6).
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [showValidation, setShowValidation] = useState(false);
  const blockingIssues = useMemo(() => issues.filter((i) => i.severity === 'error'), [issues]);

  // Runs tab state — real history from the service.
  const [runs, setRuns] = useState<RunRow[] | null>(null);
  const [runsErr, setRunsErr] = useState<string | null>(null);
  const [runsGate, setRunsGate] = useState<Gate | null>(null);
  const [loadingRuns, setLoadingRuns] = useState(false);
  const [openRun, setOpenRun] = useState<string | null>(null);
  const [runActions, setRunActions] = useState<ActionRow[] | null>(null);

  const load = useCallback(async () => {
    setShowValidation(false);
    if (!workspaceId || id === 'new') {
      setDetail({ ok: true, definition: emptyDefinition() });
      setWorking(emptyDefinition());
      return;
    }
    setLoadErr(null);
    try {
      const r = await clientFetch(`/api/items/logic-app/${encodeURIComponent(id)}?workspaceId=${encodeURIComponent(workspaceId)}`);
      const j: DetailResponse = await r.json();
      if (!j.ok) { setLoadErr(j.error || 'failed to load workflow'); return; }
      setDetail(j);
      setWorking(j.definition || emptyDefinition());
      setDirty(false);
    } catch (e: any) { setLoadErr(e?.message || String(e)); }
  }, [workspaceId, id]);

  useEffect(() => { load(); }, [load]);

  const triggerNames = useMemo(() => Object.keys(working.triggers || {}), [working]);
  useEffect(() => {
    if (triggerNames.length && !triggerNames.includes(selTrigger)) setSelTrigger(triggerNames[0]);
  }, [triggerNames, selTrigger]);

  const wdlParams = (working.parameters || {}) as Record<string, { type?: string; defaultValue?: unknown; metadata?: { description?: string } }>;
  const paramValues = detail?.parameters || {};
  const bound = !!detail?.logicApp?.bound;
  const gate = detail?.gate;

  const definitionJson = useMemo(() => JSON.stringify(working, null, 2), [working]);
  useEffect(() => { setCodeDraft(definitionJson); }, [definitionJson]);

  const onDesignerChange = useCallback((next: WdlDefinition) => {
    setWorking(next);
    setDirty(true);
    setSaveMsg(null);
  }, []);

  const saveDefinition = useCallback(async () => {
    if (!workspaceId || id === 'new') {
      setSaveMsg({ intent: 'error', text: 'Save the item before editing its workflow definition.' });
      return;
    }
    // A save attempt is the moment validation becomes fair to show — and Azure
    // would reject these anyway, so name them here instead of round-tripping a 400.
    setShowValidation(true);
    if (blockingIssues.length > 0) {
      setSaveMsg({
        intent: 'error',
        text: `Fix ${blockingIssues.length} problem${blockingIssues.length === 1 ? '' : 's'} before saving: ${blockingIssues.map((i) => i.message).join(' ')}`,
      });
      return;
    }
    setSavingDef(true); setSaveMsg(null);
    try {
      const r = await clientFetch(`/api/items/logic-app/${encodeURIComponent(id)}?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ definition: working }),
      });
      const j = await r.json().catch(() => ({}));
      if (!j?.ok) {
        setSaveMsg({ intent: 'error', text: j?.gate?.remediation || j?.error || `HTTP ${r.status}` });
        return;
      }
      setDirty(false);
      setSaveMsg({ intent: 'success', text: 'Saved to the Azure Logic App (PUT Microsoft.Logic/workflows).' });
      await load();
    } catch (e: any) { setSaveMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setSavingDef(false); }
  }, [workspaceId, id, working, load, blockingIssues]);

  const loadRuns = useCallback(async () => {
    if (!workspaceId || id === 'new') return;
    setLoadingRuns(true); setRunsErr(null); setRunsGate(null);
    try {
      const r = await clientFetch(`/api/items/logic-app/${encodeURIComponent(id)}/runs?workspaceId=${encodeURIComponent(workspaceId)}`);
      const j = await r.json().catch(() => ({}));
      if (!j?.ok) {
        if (j?.gate) setRunsGate(j.gate); else setRunsErr(j?.error || `HTTP ${r.status}`);
        setRuns([]);
        return;
      }
      setRuns(j.runs || []);
    } catch (e: any) { setRunsErr(e?.message || String(e)); }
    finally { setLoadingRuns(false); }
  }, [workspaceId, id]);

  useEffect(() => { if (tab === 'runs') loadRuns(); }, [tab, loadRuns]);

  const openRunDetail = useCallback(async (runName: string) => {
    if (!workspaceId) return;
    setOpenRun(runName); setRunActions(null);
    try {
      const r = await clientFetch(`/api/items/logic-app/${encodeURIComponent(id)}/runs?workspaceId=${encodeURIComponent(workspaceId)}&runName=${encodeURIComponent(runName)}`);
      const j = await r.json().catch(() => ({}));
      setRunActions(j?.ok ? (j.actions || []) : []);
    } catch { setRunActions([]); }
  }, [workspaceId, id]);

  const runTrigger = useCallback(async () => {
    if (!workspaceId) return;
    setRunning(true); setRunRes(null);
    try {
      const r = await clientFetch(`/api/items/logic-app/${encodeURIComponent(id)}/run?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ trigger: selTrigger || triggerNames[0] }),
      });
      const j: RunResponse = await r.json();
      setRunRes(j);
      if (j.ok) loadRuns();
    } catch (e: any) { setRunRes({ ok: false, error: e?.message || String(e) }); }
    finally { setRunning(false); }
  }, [workspaceId, id, triggerNames, selTrigger, loadRuns]);

  const applyCode = useCallback(() => {
    try {
      const parsed = JSON.parse(codeDraft);
      setWorking(parsed);
      setDirty(true);
      setCodeErr(null);
    } catch (e: any) { setCodeErr(e?.message || String(e)); }
  }, [codeDraft]);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Workflow', actions: [
        { label: 'Save workflow', onClick: workspaceId ? saveDefinition : undefined, disabled: !workspaceId || savingDef || !dirty },
        { label: 'Refresh', onClick: load },
      ]},
      { label: 'Run', actions: [
        { label: 'Run trigger', onClick: workspaceId ? runTrigger : undefined, disabled: !workspaceId || running },
      ]},
      { label: 'View', actions: [
        { label: 'Designer', onClick: () => setTab('designer') },
        { label: 'Parameters', onClick: () => setTab('parameters') },
        { label: 'Runs', onClick: () => setTab('runs') },
        { label: 'Code view', onClick: () => setTab('code') },
      ]},
    ]},
  ], [workspaceId, running, runTrigger, load, saveDefinition, savingDef, dirty]);

  useRegisterRibbonCommands(ribbon, 'logic-app');

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon} dirty={dirty} commandSearch
      main={
        <>
          <div className={s.tabs}>
            <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as string)}>
              <Tab value="designer">Designer</Tab>
              <Tab value="parameters">Parameters</Tab>
              <Tab value="runs">Runs</Tab>
              <Tab value="code">Code view</Tab>
            </TabList>
          </div>

          <div className={s.toolbar}>
            <div className={s.badgeRow}>
              <Badge appearance="filled" color="brand">Microsoft.Logic/workflows</Badge>
              {detail?.workflowState && <Badge appearance="outline">{detail.workflowState}</Badge>}
              <Badge appearance="outline" color={bound ? 'success' : 'warning'}>
                {bound ? `bound: ${detail?.logicApp?.logicAppName}` : 'not bound'}
              </Badge>
              {detail?.logicApp?.justCreated && (
                <Badge appearance="tint" color="success">workflow created</Badge>
              )}
            </div>
            <Button appearance="primary" icon={<Save20Regular />} disabled={!workspaceId || savingDef || !dirty} onClick={saveDefinition}>
              {savingDef ? 'Saving…' : 'Save workflow'}
            </Button>
            <Button icon={<Play20Regular />} disabled={!workspaceId || running} onClick={runTrigger}>
              {running ? 'Running…' : 'Run trigger'}
            </Button>
            {triggerNames.length > 1 && (
              <Tooltip relationship="label" content="Choose which trigger to fire — this workflow has more than one">
                <Dropdown size="small" aria-label="Trigger to run" style={{ minWidth: '160px' }}
                  value={selTrigger} selectedOptions={selTrigger ? [selTrigger] : []}
                  onOptionSelect={(_, d) => { if (d.optionValue) setSelTrigger(d.optionValue); }}>
                  {triggerNames.map((tn) => <Option key={tn} value={tn} text={tn}>{tn}</Option>)}
                </Dropdown>
              </Tooltip>
            )}
            <Button appearance="subtle" icon={<ArrowSync20Regular />} onClick={load}>Refresh</Button>
          </div>

          <div className={s.gateWrap}>
            {loadErr && <MessageBar intent="error"><MessageBarBody>{loadErr}</MessageBarBody></MessageBar>}

            {/* Honest gate. A missing-env gate is env-fixable, so it renders
                through the shared <HonestGate> with an inline Fix-it wizard
                (G2). An RBAC/ARM gate cannot be resolved by writing env, so it
                stays a MessageBar naming the exact role — honest, not a Fix-it
                button that would do nothing. */}
            {gate && gate.code === 'not-configured' && (
              <HonestGate
                gateId={LOGIC_APP_GATE_ID}
                surface="Workflow designer"
                missing={gate.missing}
                detail={gate.remediation}
                onResolved={load}
              />
            )}
            {gate && gate.code !== 'not-configured' && (
              <MessageBar intent="warning" layout="multiline">
                <MessageBarBody>
                  <MessageBarTitle>{gate.reason}</MessageBarTitle>
                  {gate.remediation}
                  {gate.link && <> <a href={gate.link} target="_blank" rel="noreferrer">Learn more</a>.</>}
                </MessageBarBody>
              </MessageBar>
            )}

            {saveMsg && (
              <MessageBar intent={saveMsg.intent} layout="multiline"><MessageBarBody>{saveMsg.text}</MessageBarBody></MessageBar>
            )}

            {runRes?.gate && (
              <MessageBar intent="warning" layout="multiline">
                <MessageBarBody>
                  <MessageBarTitle>{runRes.gate.reason}</MessageBarTitle>
                  {runRes.gate.remediation}
                  {runRes.gate.link && <> <a href={runRes.gate.link} target="_blank" rel="noreferrer">Learn more</a>.</>}
                </MessageBarBody>
              </MessageBar>
            )}
            {runRes && !runRes.gate && runRes.ok && (
              <MessageBar intent={runRes.status === 'Failed' ? 'error' : 'success'} layout="multiline">
                <MessageBarBody>
                  <MessageBarTitle>Trigger {runRes.trigger} fired{runRes.status ? ` → ${runRes.status}` : ''}</MessageBarTitle>
                  <div className={s.runOut}>{(runRes.steps || []).join('\n')}{runRes.failureReason ? `\n${runRes.failureReason}` : ''}</div>
                </MessageBarBody>
              </MessageBar>
            )}
            {runRes && !runRes.gate && !runRes.ok && (
              <MessageBar intent="error"><MessageBarBody>{runRes.error}</MessageBarBody></MessageBar>
            )}
          </div>

          {!detail && !loadErr && (
            <div className={s.pad}><Spinner size="small" label="Loading workflow…" labelPosition="after" /></div>
          )}

          {detail && tab === 'designer' && (
            <div className={s.designerPad}>
              <div className={s.gateWrap}>
                <TeachingBanner
                  surfaceKey="logic-app-designer"
                  title="Design a workflow, run it on Azure Logic Apps"
                  message="Drag an operation from the palette onto the canvas, connect steps to set their run-after order, and configure each step in the inspector. Save writes the Workflow Definition Language document to the real Microsoft.Logic/workflows resource; Run trigger executes it and the Runs tab shows the real run history."
                  learnMoreHref="https://learn.microsoft.com/azure/logic-apps/logic-apps-overview"
                />
              </div>
              <div className={s.canvasHost}>
                <WorkflowDesignerCanvas
                  definition={working}
                  onChange={onDesignerChange}
                  showValidation={showValidation}
                  onValidationChange={setIssues}
                />
              </div>
            </div>
          )}

          {detail && tab === 'parameters' && (
            <div className={s.pad}>
              <Subtitle2 className={s.sectionHead}><Options20Regular />Definition parameters</Subtitle2>
              {Object.keys(wdlParams).length === 0 && (
                <EmptyState
                  icon={<Options20Regular />}
                  title="No parameters declared"
                  body="This workflow declares no Workflow Definition Language parameters. Add them on the Code view tab to reuse the workflow across environments — their deploy-time values appear here."
                />
              )}
              {Object.keys(wdlParams).length > 0 && (
                <div className={s.tableWrap}>
                  <Table aria-label="Workflow parameters" size="small">
                    <TableHeader><TableRow>
                      <TableHeaderCell>Name</TableHeaderCell>
                      <TableHeaderCell>Type</TableHeaderCell>
                      <TableHeaderCell>Default</TableHeaderCell>
                      <TableHeaderCell>Deploy value</TableHeaderCell>
                      <TableHeaderCell>Description</TableHeaderCell>
                    </TableRow></TableHeader>
                    <TableBody>
                      {Object.entries(wdlParams).map(([pn, p]) => (
                        <TableRow key={pn}>
                          <TableCell className={s.cell}>{pn}</TableCell>
                          <TableCell>{p.type || '—'}</TableCell>
                          <TableCell className={s.cell}>{p.defaultValue !== undefined ? JSON.stringify(p.defaultValue) : '—'}</TableCell>
                          <TableCell className={s.cell}>{paramValues[pn]?.value !== undefined ? JSON.stringify(paramValues[pn]?.value) : '—'}</TableCell>
                          <TableCell><Caption1>{p.metadata?.description || ''}</Caption1></TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
              {working.outputs && Object.keys(working.outputs).length > 0 && (
                <>
                  <Subtitle2 className={s.sectionHead}>
                    <ArrowExportLtr20Regular />Outputs
                  </Subtitle2>
                  <div className={s.outputsBlob}>{JSON.stringify(working.outputs, null, 2)}</div>
                </>
              )}
            </div>
          )}

          {detail && tab === 'runs' && (
            <div className={s.pad}>
              <div className={s.badgeRow}>
                <Subtitle2 className={s.sectionHead}><History20Regular />Run history</Subtitle2>
                <Button appearance="subtle" size="small" icon={<ArrowSync20Regular />} onClick={loadRuns}>Refresh</Button>
              </div>

              {runsGate && (
                <MessageBar intent="warning" layout="multiline">
                  <MessageBarBody>
                    <MessageBarTitle>{runsGate.reason}</MessageBarTitle>
                    {runsGate.remediation}
                    {runsGate.link && <> <a href={runsGate.link} target="_blank" rel="noreferrer">Learn more</a>.</>}
                  </MessageBarBody>
                </MessageBar>
              )}
              {runsErr && <MessageBar intent="error"><MessageBarBody>{runsErr}</MessageBarBody></MessageBar>}
              {loadingRuns && <Spinner size="small" label="Loading run history…" labelPosition="after" />}

              {!loadingRuns && runs && runs.length === 0 && !runsGate && !runsErr && (
                <EmptyState
                  icon={<History20Regular />}
                  title="No runs yet"
                  body="This workflow has not run. Use Run trigger to fire it — the run and every action's status will appear here, straight from Azure Logic Apps."
                />
              )}

              {!loadingRuns && runs && runs.length > 0 && (
                <div className={s.tableWrap}>
                  <Table aria-label="Workflow run history" size="small">
                    <TableHeader><TableRow>
                      <TableHeaderCell>Status</TableHeaderCell>
                      <TableHeaderCell>Started</TableHeaderCell>
                      <TableHeaderCell>Duration</TableHeaderCell>
                      <TableHeaderCell>Trigger</TableHeaderCell>
                      <TableHeaderCell>Run</TableHeaderCell>
                    </TableRow></TableHeader>
                    <TableBody>
                      {runs.map((r) => (
                        <TableRow
                          key={r.name}
                          className={s.clickable}
                          onClick={() => r.name && openRunDetail(r.name)}
                          tabIndex={0}
                          onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && r.name) { e.preventDefault(); openRunDetail(r.name); } }}
                          aria-label={`Run ${r.name} — ${r.status}`}
                        >
                          <TableCell><Badge appearance="tint" color={statusColor(r.status)}>{r.status || 'Unknown'}</Badge></TableCell>
                          <TableCell>{fmtTime(r.startTime)}</TableCell>
                          <TableCell>{fmtDuration(r.durationMs)}</TableCell>
                          <TableCell className={s.cell}>{r.trigger || '—'}</TableCell>
                          <TableCell className={s.cell}>{r.name}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}

              {openRun && (
                <>
                  <Subtitle2 className={s.sectionHead}>Actions in run {openRun}</Subtitle2>
                  {!runActions && <Spinner size="tiny" label="Loading actions…" labelPosition="after" />}
                  {runActions && runActions.length === 0 && (
                    <Caption1>No action detail available for this run.</Caption1>
                  )}
                  {runActions && runActions.length > 0 && (
                    <div className={s.tableWrap}>
                      <Table aria-label={`Actions in run ${openRun}`} size="small">
                        <TableHeader><TableRow>
                          <TableHeaderCell>Action</TableHeaderCell>
                          <TableHeaderCell>Status</TableHeaderCell>
                          <TableHeaderCell>Duration</TableHeaderCell>
                          <TableHeaderCell>Retries</TableHeaderCell>
                          <TableHeaderCell>Error</TableHeaderCell>
                        </TableRow></TableHeader>
                        <TableBody>
                          {runActions.map((a) => (
                            <TableRow key={a.name}>
                              <TableCell className={s.cell}>{a.name}</TableCell>
                              <TableCell><Badge appearance="tint" color={statusColor(a.status)}>{a.status || '—'}</Badge></TableCell>
                              <TableCell>{fmtDuration(a.durationMs)}</TableCell>
                              <TableCell>{a.retryCount ?? 0}</TableCell>
                              <TableCell className={s.cell}>{a.error || '—'}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {detail && tab === 'code' && (
            <div className={s.pad}>
              <Body1>Workflow Definition Language (WDL)</Body1>
              <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                The same document the Designer edits. Use this for operations the palette does not
                model yet (managed connectors) — Loom preserves them untouched. Apply, then Save
                to write it to the Azure Logic App.
              </Caption1>
              {codeErr && <MessageBar intent="error"><MessageBarBody>Invalid JSON: {codeErr}</MessageBarBody></MessageBar>}
              <div className={s.badgeRow}>
                <Button appearance="primary" onClick={applyCode}>Apply to designer</Button>
                <Button appearance="subtle" onClick={() => { setCodeDraft(definitionJson); setCodeErr(null); }}>Revert</Button>
              </div>
              <MonacoTextarea
                value={codeDraft}
                onChange={(v) => setCodeDraft(v)}
                language="json"
                height={520}
                ariaLabel="Workflow definition JSON (editable)"
              />
            </div>
          )}
        </>
      }
    />
  );
}

export default LogicAppEditor;
