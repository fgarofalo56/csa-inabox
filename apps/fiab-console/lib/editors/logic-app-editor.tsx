'use client';

import { clientFetch } from '@/lib/client-fetch';
/**
 * LogicAppEditor — Azure Logic Apps (Consumption) focused editor.
 *
 * Opens the Workflow Definition Language (WDL) workflow FULLY BUILT-OUT from
 * either the live Microsoft.Logic/workflows resource (when bound) or the
 * bundle's stamped state.content.definition (fallback). Never empty.
 *
 * Surfaces (parity with the Azure portal Logic App designer + code view):
 *   - Designer tab: a top-down execution-order flow — the trigger(s) followed
 *     by every action rendered as a connected card (name, type, key config),
 *     including branch (If) sub-actions, with runAfter dependency labels.
 *   - Parameters tab: the WDL parameters (type/default/description) and the
 *     deploy-time parameter VALUES.
 *   - Code view tab: a Monaco JSON view of the full `definition`.
 *
 * "Run trigger" POSTs /api/items/logic-app/[id]/run when a live Logic App is
 * bound; otherwise an honest MessageBar gate names what to provision
 * (the Logic App + LOOM_LOGIC_SUB / LOOM_LOGIC_RG / LOOM_LOGIC_LOCATION + the
 * "Logic App Contributor" role), per .claude/rules/no-vaporware.md.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  Subtitle2, Body1, Body1Strong, Caption1, Badge, Button, Spinner,
  Tab, TabList, Dropdown, Option, Tooltip,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Play20Regular, ArrowSync20Regular, Flash20Regular, Branch20Regular,
  ArrowRight16Regular, Options20Regular, ArrowExportLtr20Regular, Save20Regular,
} from '@fluentui/react-icons';
import { EmptyState } from '@/lib/components/empty-state';
import { ItemEditorChrome } from './item-editor-chrome';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';

const useStyles = makeStyles({
  pad: { padding: tokens.spacingHorizontalL, display: 'flex', flexDirection: 'column', gap: tokens.spacingHorizontalM, flex: 1, minHeight: 0 },
  tabs: { borderBottom: `1px solid ${tokens.colorNeutralStroke2}`, paddingTop: tokens.spacingVerticalS, paddingLeft: tokens.spacingHorizontalS, paddingRight: tokens.spacingHorizontalS },
  toolbar: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' },
  flow: { display: 'flex', flexDirection: 'column', gap: 0, alignItems: 'stretch', maxWidth: '760px', width: '100%', minWidth: 0 },
  node: {
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    borderRadius: tokens.borderRadiusXLarge,
    paddingTop: tokens.spacingVerticalSNudge, paddingBottom: tokens.spacingVerticalSNudge,
    paddingLeft: tokens.spacingHorizontalM, paddingRight: tokens.spacingHorizontalM,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
    display: 'flex', flexDirection: 'column', gap: tokens.spacingHorizontalXS,
    minWidth: 0, maxWidth: '100%', boxSizing: 'border-box',
    transition: 'box-shadow 0.15s ease',
    ':hover': { boxShadow: tokens.shadow16 },
  },
  trigger: { borderLeft: `4px solid ${tokens.colorBrandStroke1}` },
  action: { borderLeft: `4px solid ${tokens.colorPaletteBlueBorderActive}` },
  branch: { borderLeft: `4px solid ${tokens.colorPaletteMarigoldBorderActive}` },
  branchKids: { marginLeft: tokens.spacingHorizontalXXL, marginTop: tokens.spacingVerticalS, display: 'flex', flexDirection: 'column', gap: 0 },
  connector: { display: 'flex', justifyContent: 'center', color: tokens.colorNeutralForeground3, paddingTop: tokens.spacingVerticalXXS, paddingBottom: tokens.spacingVerticalXXS },
  nodeHead: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' },
  cfg: { fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground2, wordBreak: 'break-word', overflowWrap: 'anywhere', minWidth: 0, maxWidth: '100%' },
  outputsBlob: {
    fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase200, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
    color: tokens.colorNeutralForeground2, backgroundColor: tokens.colorNeutralBackground3,
    borderRadius: tokens.borderRadiusMedium, padding: tokens.spacingHorizontalMNudge,
    border: `1px solid ${tokens.colorNeutralStroke2}`, maxHeight: '280px', overflow: 'auto',
  },
  runAfter: { color: tokens.colorNeutralForeground3 },
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
});

interface WdlDefinition {
  $schema?: string;
  contentVersion?: string;
  parameters?: Record<string, { type?: string; defaultValue?: unknown; metadata?: { description?: string } }>;
  triggers?: Record<string, any>;
  actions?: Record<string, any>;
  outputs?: Record<string, any>;
}

interface DetailResponse {
  ok: boolean;
  error?: string;
  logicApp?: { id: string; displayName: string; description?: string; logicAppName?: string; bound?: boolean };
  definition?: WdlDefinition;
  parameters?: Record<string, { value?: unknown }>;
  workflowState?: string;
  primaryTrigger?: string;
  fromContent?: boolean;
}

interface RunResponse {
  ok: boolean;
  error?: string;
  gate?: { reason: string; remediation: string; link?: string };
  triggered?: boolean;
  trigger?: string;
  runName?: string;
  status?: string;
  failureReason?: string;
  steps?: string[];
}

interface Props { item: FabricItemType; id: string }

/** Pull the human-meaningful config line out of an action/trigger spec. */
function summarizeConfig(spec: any): string[] {
  if (!spec || typeof spec !== 'object') return [];
  const out: string[] = [];
  const inputs = spec.inputs || {};
  if (spec.type === 'Recurrence' && spec.recurrence) {
    const r = spec.recurrence;
    out.push(`every ${r.interval ?? 1} ${String(r.frequency || '').toLowerCase()}${r.schedule?.hours ? ` at ${r.schedule.hours.join(',')}:${(r.schedule.minutes || [0]).join(',')}` : ''} (${r.timeZone || 'UTC'})`);
  }
  if (inputs.method && inputs.uri) out.push(`${inputs.method} ${inputs.uri}`);
  else if (inputs.method && spec.type === 'Request') out.push(`${inputs.method} (callable endpoint)`);
  else if (inputs.method) out.push(String(inputs.method));
  if (inputs.from) out.push(`from: ${typeof inputs.from === 'string' ? inputs.from : JSON.stringify(inputs.from)}`);
  if (inputs.where) out.push(`where: ${inputs.where}`);
  if (inputs.content) out.push(`content: ${typeof inputs.content === 'string' ? inputs.content : JSON.stringify(inputs.content)}`);
  if (typeof inputs.statusCode !== 'undefined') out.push(`statusCode: ${inputs.statusCode}`);
  if (inputs.retryPolicy) out.push(`retry: ${inputs.retryPolicy.type} ×${inputs.retryPolicy.count} @ ${inputs.retryPolicy.interval}`);
  if (spec.expression) out.push(`condition: ${JSON.stringify(spec.expression)}`);
  return out;
}

/** Order actions by their runAfter dependency chain (topological, best-effort). */
function orderActions(actions: Record<string, any>): string[] {
  const names = Object.keys(actions);
  const ordered: string[] = [];
  const remaining = new Set(names);
  let guard = 0;
  while (remaining.size && guard++ < names.length + 2) {
    for (const n of Array.from(remaining)) {
      const after = Object.keys(actions[n]?.runAfter || {});
      if (after.every((dep) => !remaining.has(dep))) {
        ordered.push(n);
        remaining.delete(n);
      }
    }
  }
  // Append any cyclic / unresolved leftovers so nothing is dropped.
  for (const n of names) if (!ordered.includes(n)) ordered.push(n);
  return ordered;
}

function ActionNode({ name, spec, kind }: { name: string; spec: any; kind: 'trigger' | 'action' }) {
  const s = useStyles();
  const isBranch = spec?.type === 'If' || spec?.type === 'Switch';
  const cfg = summarizeConfig(spec);
  const runAfter = Object.keys(spec?.runAfter || {});
  const nodeClass = kind === 'trigger' ? s.trigger : isBranch ? s.branch : s.action;
  return (
    <div className={`${s.node} ${nodeClass}`} data-node={name}>
      <div className={s.nodeHead}>
        {kind === 'trigger'
          ? <Flash20Regular />
          : isBranch ? <Branch20Regular /> : <ArrowRight16Regular />}
        <Body1Strong>{name.replace(/_/g, ' ')}</Body1Strong>
        <Badge appearance="outline" color={kind === 'trigger' ? 'brand' : isBranch ? 'warning' : 'informative'}>
          {spec?.type}{spec?.kind ? ` · ${spec.kind}` : ''}
        </Badge>
        {runAfter.length > 0 && <Caption1 className={s.runAfter}>after: {runAfter.join(', ')}</Caption1>}
      </div>
      {cfg.map((c, i) => <div key={i} className={s.cfg}>{c}</div>)}
      {isBranch && (
        <>
          {spec?.actions && Object.keys(spec.actions).length > 0 && (
            <div className={s.branchKids}>
              <Caption1>if true:</Caption1>
              <FlowBody actions={spec.actions} />
            </div>
          )}
          {spec?.else?.actions && Object.keys(spec.else.actions).length > 0 && (
            <div className={s.branchKids}>
              <Caption1>else:</Caption1>
              <FlowBody actions={spec.else.actions} />
            </div>
          )}
          {spec?.cases && Object.entries(spec.cases).map(([cn, c]: [string, any]) => (
            <div key={cn} className={s.branchKids}>
              <Caption1>case {cn}:</Caption1>
              <FlowBody actions={c.actions || {}} />
            </div>
          ))}
        </>
      )}
    </div>
  );
}

function FlowBody({ actions }: { actions: Record<string, any> }) {
  const s = useStyles();
  const order = orderActions(actions || {});
  return (
    <div className={s.flow}>
      {order.map((n, i) => (
        <div key={n}>
          {i > 0 && <div className={s.connector}>↓</div>}
          <ActionNode name={n} spec={actions[n]} kind="action" />
        </div>
      ))}
    </div>
  );
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
  // Which trigger to fire — defaults to the first; a picker appears when the
  // workflow has more than one trigger (the run route already accepts `trigger`).
  const [selTrigger, setSelTrigger] = useState('');

  // Editable WDL code view — the real authoring surface. Persisted via PUT
  // (ARM Microsoft.Logic/workflows when bound, always to Cosmos state).
  const [draft, setDraft] = useState<string>('');
  const [dirty, setDirty] = useState(false);
  const [savingDef, setSavingDef] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ intent: 'success' | 'error'; text: string } | null>(null);

  const load = useCallback(async () => {
    if (!workspaceId || id === 'new') { setDetail({ ok: true, definition: { triggers: {}, actions: {} } }); return; }
    setLoadErr(null);
    try {
      const r = await clientFetch(`/api/items/logic-app/${encodeURIComponent(id)}?workspaceId=${encodeURIComponent(workspaceId)}`);
      const j: DetailResponse = await r.json();
      if (!j.ok) { setLoadErr(j.error || 'failed to load workflow'); return; }
      setDetail(j);
    } catch (e: any) { setLoadErr(e?.message || String(e)); }
  }, [workspaceId, id]);

  useEffect(() => { load(); }, [load]);

  const definition: WdlDefinition = detail?.definition || { triggers: {}, actions: {} };
  const triggers = definition.triggers || {};
  const actions = definition.actions || {};
  const triggerNames = useMemo(() => Object.keys(triggers), [triggers]);
  // Keep the selected trigger valid as the definition loads/changes.
  useEffect(() => {
    if (triggerNames.length && !triggerNames.includes(selTrigger)) setSelTrigger(triggerNames[0]);
  }, [triggerNames, selTrigger]);
  const wdlParams = definition.parameters || {};
  const paramValues = detail?.parameters || {};
  const bound = !!detail?.logicApp?.bound;
  const definitionJson = useMemo(() => JSON.stringify(definition, null, 2), [definition]);

  // Re-seed the editable draft whenever a fresh definition loads (and the user
  // hasn't started editing).
  useEffect(() => { if (!dirty) setDraft(definitionJson); }, [definitionJson, dirty]);

  const saveDefinition = useCallback(async () => {
    if (!workspaceId || id === 'new') {
      setSaveMsg({ intent: 'error', text: 'Save the item before editing its workflow definition.' });
      return;
    }
    let parsed: unknown;
    try { parsed = JSON.parse(draft); }
    catch (e: any) { setSaveMsg({ intent: 'error', text: `Invalid JSON: ${e?.message || String(e)}` }); return; }
    setSavingDef(true); setSaveMsg(null);
    try {
      const r = await clientFetch(`/api/items/logic-app/${encodeURIComponent(id)}?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ definition: parsed }),
      });
      const j = await r.json().catch(() => ({}));
      if (!j?.ok) { setSaveMsg({ intent: 'error', text: j?.error || `HTTP ${r.status}` }); return; }
      setDirty(false);
      setSaveMsg({ intent: 'success', text: j.upserted ? 'Saved + deployed to Azure Logic App (ARM).' : 'Saved to workspace (deploy by binding a live Logic App).' });
      await load();
    } catch (e: any) { setSaveMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setSavingDef(false); }
  }, [workspaceId, id, draft, load]);

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
    } catch (e: any) { setRunRes({ ok: false, error: e?.message || String(e) }); }
    finally { setRunning(false); }
  }, [workspaceId, id, triggerNames, selTrigger]);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Run', actions: [
        { label: 'Run trigger', onClick: workspaceId ? runTrigger : undefined, disabled: !workspaceId || running },
      ]},
      { label: 'Workflow', actions: [
        { label: 'Refresh', onClick: load },
      ]},
      { label: 'View', actions: [
        { label: 'Designer', onClick: () => setTab('designer') },
        { label: 'Parameters', onClick: () => setTab('parameters') },
        { label: 'Code view', onClick: () => setTab('code') },
      ]},
    ]},
  ], [workspaceId, running, runTrigger, load]);

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon}
      main={
        <>
          <div className={s.tabs}>
            <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as string)}>
              <Tab value="designer">Designer</Tab>
              <Tab value="parameters">Parameters</Tab>
              <Tab value="code">Code view</Tab>
            </TabList>
          </div>
          <div className={s.pad}>
            <div className={s.toolbar}>
              <Badge appearance="filled" color="brand">Microsoft.Logic/workflows</Badge>
              {detail?.workflowState && <Badge appearance="outline">{detail.workflowState}</Badge>}
              <Badge appearance="outline" color={bound ? 'success' : 'warning'}>
                {bound ? `bound: ${detail?.logicApp?.logicAppName}` : 'not deployed (showing definition)'}
              </Badge>
              <Button appearance="primary" icon={<Play20Regular />} disabled={!workspaceId || running} onClick={runTrigger}>
                {running ? 'Running…' : 'Run trigger'}
              </Button>
              {triggerNames.length > 1 && (
                <Tooltip relationship="label" content="Choose which trigger to fire — this workflow has more than one">
                  <Dropdown size="small" aria-label="Trigger to run" style={{ minWidth: 160 }}
                    value={selTrigger} selectedOptions={selTrigger ? [selTrigger] : []}
                    onOptionSelect={(_, d) => { if (d.optionValue) setSelTrigger(d.optionValue); }}>
                    {triggerNames.map((tn) => <Option key={tn} value={tn} text={tn}>{tn}</Option>)}
                  </Dropdown>
                </Tooltip>
              )}
              <Button appearance="subtle" icon={<ArrowSync20Regular />} onClick={load}>Refresh</Button>
            </div>

            {loadErr && <MessageBar intent="error"><MessageBarBody>{loadErr}</MessageBarBody></MessageBar>}
            {!detail && !loadErr && <Spinner size="small" label="Loading workflow…" labelPosition="after" />}

            {/* Honest run gate / result */}
            {runRes?.gate && (
              <MessageBar intent="warning">
                <MessageBarBody>
                  <MessageBarTitle>{runRes.gate.reason}</MessageBarTitle>
                  {runRes.gate.remediation}
                  {runRes.gate.link && <> <a href={runRes.gate.link} target="_blank" rel="noreferrer">Learn more</a>.</>}
                </MessageBarBody>
              </MessageBar>
            )}
            {runRes && !runRes.gate && runRes.ok && (
              <MessageBar intent={runRes.status === 'Failed' ? 'error' : 'success'}>
                <MessageBarBody>
                  <MessageBarTitle>Trigger {runRes.trigger} fired{runRes.status ? ` → ${runRes.status}` : ''}</MessageBarTitle>
                  <div className={s.runOut}>{(runRes.steps || []).join('\n')}{runRes.failureReason ? `\n${runRes.failureReason}` : ''}</div>
                </MessageBarBody>
              </MessageBar>
            )}
            {runRes && !runRes.gate && !runRes.ok && (
              <MessageBar intent="error"><MessageBarBody>{runRes.error}</MessageBarBody></MessageBar>
            )}

            {detail && tab === 'designer' && (
              <>
                {!bound && (
                  <MessageBar intent="info">
                    <MessageBarBody>
                      <MessageBarTitle>Workflow definition (not yet deployed)</MessageBarTitle>
                      This Logic App opens built-out from its installed Workflow Definition Language definition. To make
                      “Run trigger” fire a real run, deploy it as a <code>Microsoft.Logic/workflows</code> resource: set
                      <code> LOOM_LOGIC_SUB</code> / <code>LOOM_LOGIC_RG</code> / <code>LOOM_LOGIC_LOCATION</code> and grant
                      the Console UAMI the <strong>Logic App Contributor</strong> role, then re-install the app.
                    </MessageBarBody>
                  </MessageBar>
                )}
                {triggerNames.length === 0 && Object.keys(actions).length === 0 ? (
                  <EmptyState
                    icon={<Flash20Regular />}
                    title="No triggers or actions yet"
                    body="This workflow has no triggers or actions defined. The Designer is a read-only flow view — open the Code view tab to add a trigger and actions to the Workflow Definition Language definition, then Save to deploy."
                  />
                ) : (
                <div className={s.flow}>
                  {triggerNames.map((tn, i) => (
                    <div key={tn}>
                      {i > 0 && <div className={s.connector}>↓</div>}
                      <ActionNode name={tn} spec={triggers[tn]} kind="trigger" />
                    </div>
                  ))}
                  {triggerNames.length > 0 && Object.keys(actions).length > 0 && <div className={s.connector}>↓</div>}
                  <FlowBody actions={actions} />
                </div>
                )}
              </>
            )}

            {detail && tab === 'parameters' && (
              <>
                <Subtitle2 className={s.sectionHead}><Options20Regular />Definition parameters</Subtitle2>
                {Object.keys(wdlParams).length === 0 && (
                  <EmptyState
                    icon={<Options20Regular />}
                    title="No parameters declared"
                    body="This workflow declares no Workflow Definition Language parameters. Parameters and their deploy-time values appear here once the definition declares them."
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
                {definition.outputs && Object.keys(definition.outputs).length > 0 && (
                  <>
                    <Subtitle2 className={s.sectionHead} style={{ marginTop: tokens.spacingVerticalM }}>
                      <ArrowExportLtr20Regular />Outputs
                    </Subtitle2>
                    <div className={s.outputsBlob}>{JSON.stringify(definition.outputs, null, 2)}</div>
                  </>
                )}
              </>
            )}

            {detail && tab === 'code' && (
              <>
                <Body1>Workflow Definition Language (WDL) — edit the triggers, actions, and parameters here.</Body1>
                <Caption1 style={{ color: tokens.colorNeutralForeground3, display: 'block', marginBottom: tokens.spacingVerticalS }}>
                  This is the authoring surface: change triggers/actions in the WDL JSON and <strong>Save</strong>.
                  {bound
                    ? ' Saving deploys the workflow to the bound Azure Logic App via ARM (PUT Microsoft.Logic/workflows) and persists it.'
                    : ' Saving persists to the workspace; bind/deploy a live Logic App (set LOOM_LOGIC_SUB / LOOM_LOGIC_RG / LOOM_LOGIC_LOCATION + grant the Console UAMI "Logic App Contributor") to push it to ARM.'}
                  {' '}The Designer tab renders this same definition as a read-only flow.
                </Caption1>
                {saveMsg && (
                  <MessageBar intent={saveMsg.intent}><MessageBarBody>{saveMsg.text}</MessageBarBody></MessageBar>
                )}
                <div className={s.toolbar}>
                  <Button appearance="primary" icon={<Save20Regular />} disabled={savingDef || !dirty} onClick={saveDefinition}>
                    {savingDef ? 'Saving…' : 'Save workflow'}
                  </Button>
                  <Button appearance="subtle" disabled={!dirty} onClick={() => { setDraft(definitionJson); setDirty(false); setSaveMsg(null); }}>
                    Revert
                  </Button>
                </div>
                <MonacoTextarea
                  value={draft}
                  onChange={(v) => { setDraft(v); setDirty(true); }}
                  language="json"
                  height={520}
                  ariaLabel="Workflow definition JSON (editable)"
                />
              </>
            )}
          </div>
        </>
      }
    />
  );
}

export default LogicAppEditor;
