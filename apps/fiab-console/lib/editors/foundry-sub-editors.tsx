'use client';

/**
 * v2.5 — Azure AI Foundry sub-editors
 *
 * Eight editor components, each fully wired to its BFF route. All UI
 * is real (no mocks). When the underlying service isn't provisioned
 * the BFF returns 503 + notDeployed=true, and the editor surfaces an
 * honest MessageBar with the hint from the BFF.
 *
 *   ProjectEditor          → /api/items/ai-foundry-project
 *   PromptFlowEditor       → /api/items/prompt-flow
 *   EvaluationEditor       → /api/items/evaluation
 *   ContentSafetyEditor    → /api/items/content-safety
 *   TracingEditor          → /api/items/tracing
 *   AiSearchIndexEditor    → /api/items/ai-search-index
 *   ComputeEditor          → /api/items/compute
 *   DatasetEditor          → /api/items/dataset
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Subtitle2, Body1, Caption1, Badge, Button, Input, Textarea, Spinner, Field, Dropdown, Option,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { ItemEditorChrome } from './item-editor-chrome';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';

const useStyles = makeStyles({
  pad: { padding: 16, display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0, flex: 1 },
  toolbar: { display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' },
  monaco: {
    width: '100%', minHeight: 220,
    fontFamily: 'Consolas, "Cascadia Code", monospace', fontSize: 13, padding: 12,
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 4,
    backgroundColor: tokens.colorNeutralBackground3, color: tokens.colorNeutralForeground1,
    resize: 'vertical',
  },
  tableWrap: { overflow: 'auto', maxHeight: 480, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 4 },
  cell: { fontSize: 12, whiteSpace: 'nowrap', maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis' },
  empty: { padding: 16, color: tokens.colorNeutralForeground3, fontStyle: 'italic' },
  card: { padding: 12, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 6 },
  formRow: { display: 'grid', gridTemplateColumns: '160px 1fr', gap: '6px 16px', alignItems: 'center' },
});

/**
 * Factory for the per-editor base ribbon. Each editor binds its own `reload`
 * handler + computes a portal deep-link from its detail data. When the editor
 * doesn't have a portal-targetable resource (e.g. nothing selected yet), pass
 * `portalUrl: null` to mark that action disabled with a precise tooltip.
 *
 * Previously this was a static `BASE_RIBBON` constant whose `Reload` and
 * `Open in Azure portal` actions had no onClick — the Ribbon auto-disabled
 * them with a "not wired" tooltip, surfacing 2 dead buttons across 8 editors
 * (16 total dead actions). This refactor wires them per-editor.
 */
function buildBaseRibbon(reload: () => void, portalUrl: string | null): RibbonTab[] {
  return [
    { id: 'home', label: 'Home', groups: [
      { label: 'Item', actions: [
        { label: 'Reload', onClick: reload },
        portalUrl
          ? { label: 'Open in Azure portal', onClick: () => window.open(portalUrl, '_blank', 'noopener,noreferrer') }
          : { label: 'Open in Azure portal', disabled: true, title: 'Open in Azure portal — no resource selected (open a specific item to enable)' },
      ]},
    ]},
  ];
}

function ErrorBar({ msg, hint, notDeployed }: { msg: string; hint?: string; notDeployed?: boolean }) {
  return (
    <MessageBar intent={notDeployed ? 'warning' : 'error'}>
      <MessageBarBody>
        <MessageBarTitle>{notDeployed ? 'Not yet provisioned' : 'Error'}</MessageBarTitle>
        {msg}{hint ? ` — ${hint}` : ''}
      </MessageBarBody>
    </MessageBar>
  );
}

interface FetchState<T> { loading: boolean; data: T | null; error?: string; hint?: string; notDeployed?: boolean; }

function useApi<T>(url: string | null, deps: unknown[] = []) {
  const [state, setState] = useState<FetchState<T>>({ loading: false, data: null });
  const reload = useCallback(async () => {
    if (!url) return;
    setState({ loading: true, data: null });
    try {
      const r = await fetch(url);
      const j = await r.json();
      if (!j.ok) {
        setState({ loading: false, data: null, error: j.error || `HTTP ${r.status}`, hint: j.hint, notDeployed: j.notDeployed });
        return;
      }
      setState({ loading: false, data: j as unknown as T });
    } catch (e: any) {
      setState({ loading: false, data: null, error: e?.message || String(e) });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, ...deps]);
  useEffect(() => { reload(); }, [reload]);
  return [state, reload] as const;
}

function Shell({ item, id, ribbon, children }: { item: FabricItemType; id: string; ribbon: RibbonTab[]; children: ReactNode }) {
  return <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={children} />;
}

// =====================================================================
// 1. ProjectEditor
// =====================================================================

export function ProjectEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const isNew = id === 'new' || id === 'create';
  const [list, reload] = useApi<{ projects: any[] }>(isNew ? '/api/items/ai-foundry-project' : null);
  const [detail, reloadDetail] = useApi<{ project: any }>(isNew ? null : `/api/items/ai-foundry-project/${encodeURIComponent(id)}`, [id]);

  // Ribbon: bind Reload to whichever fetch is active; deep-link to ai.azure.com
  // for a known project or omit when listing.
  const ribbon = useMemo(() => {
    const portalUrl = !isNew && detail.data?.project?.name
      ? `https://ai.azure.com/projects/${encodeURIComponent(detail.data.project.name)}`
      : null;
    return buildBaseRibbon(isNew ? reload : reloadDetail, portalUrl);
  }, [isNew, reload, reloadDetail, detail.data]);

  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDisplay, setNewDisplay] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  const save = async () => {
    if (!newName || !newDisplay) { setSaveMsg('Name and display name required.'); return; }
    setCreating(true); setSaveMsg(null);
    const r = await fetch('/api/items/ai-foundry-project', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: newName, displayName: newDisplay, description: newDesc }),
    });
    const j = await r.json();
    setCreating(false);
    if (!j.ok) setSaveMsg(j.error || `HTTP ${r.status}`); else { setSaveMsg(`Created project ${j.project.name}`); reload(); setNewName(''); setNewDisplay(''); setNewDesc(''); }
  };

  if (isNew) {
    return <Shell item={item} id={id} ribbon={ribbon}>
      <div className={s.pad}>
        <Subtitle2>AI Foundry projects</Subtitle2>
        <Caption1>Child workspaces of the Foundry hub. Inherit hub-level connections; scope flows + evaluations + data assets.</Caption1>
        <div className={s.card}>
          <Subtitle2>New project</Subtitle2>
          <div className={s.formRow}>
            <span>Name</span><Input value={newName} onChange={(_, d) => setNewName(d.value)} placeholder="my-project (lowercase, no spaces)" />
            <span>Display name</span><Input value={newDisplay} onChange={(_, d) => setNewDisplay(d.value)} placeholder="My Project" />
            <span>Description</span><Input value={newDesc} onChange={(_, d) => setNewDesc(d.value)} />
          </div>
          <div className={s.toolbar} style={{ marginTop: 8 }}>
            <Button appearance="primary" onClick={save} disabled={creating}>{creating ? 'Creating…' : 'Create project'}</Button>
            {saveMsg && <Caption1>{saveMsg}</Caption1>}
          </div>
        </div>
        {list.loading ? <Spinner size="small" /> : list.error ? <ErrorBar msg={list.error} hint={list.hint} notDeployed={list.notDeployed} /> : (
          <div className={s.tableWrap}>
            <Table size="small">
              <TableHeader><TableRow>
                <TableHeaderCell>Name</TableHeaderCell><TableHeaderCell>Display</TableHeaderCell>
                <TableHeaderCell>State</TableHeaderCell><TableHeaderCell>Location</TableHeaderCell>
              </TableRow></TableHeader>
              <TableBody>
                {(list.data?.projects || []).map((p: any) => (
                  <TableRow key={p.id || p.name}>
                    <TableCell className={s.cell}><strong>{p.name}</strong></TableCell>
                    <TableCell className={s.cell}>{p.displayName || '—'}</TableCell>
                    <TableCell className={s.cell}>{p.provisioningState || '—'}</TableCell>
                    <TableCell className={s.cell}>{p.location || '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </Shell>;
  }

  return <Shell item={item} id={id} ribbon={ribbon}>
    <div className={s.pad}>
      {detail.loading ? <Spinner size="small" /> : detail.error ? <ErrorBar msg={detail.error} hint={detail.hint} notDeployed={detail.notDeployed} /> : detail.data?.project ? (
        <>
          <Subtitle2>{detail.data.project.displayName || detail.data.project.name}</Subtitle2>
          <Body1>{detail.data.project.description || '—'}</Body1>
          <div className={s.formRow}>
            <span>Name</span><span>{detail.data.project.name}</span>
            <span>State</span><span>{detail.data.project.provisioningState}</span>
            <span>Location</span><span>{detail.data.project.location}</span>
            <span>Hub</span><span>{detail.data.project.hubResourceId?.split('/').pop()}</span>
          </div>
          <Button onClick={() => reloadDetail()}>Reload</Button>
        </>
      ) : null}
    </div>
  </Shell>;
}

// =====================================================================
// Helper: project picker that lists Foundry projects
// =====================================================================

function ProjectPicker({ value, onChange }: { value: string | null; onChange: (v: string) => void }) {
  const [list] = useApi<{ projects: any[] }>('/api/items/ai-foundry-project');
  const projects = list.data?.projects || [];
  return (
    <Field label="Project">
      <Dropdown
        value={value || ''}
        selectedOptions={value ? [value] : []}
        onOptionSelect={(_, d) => d.optionValue && onChange(d.optionValue)}
        placeholder={list.loading ? 'Loading…' : (projects.length ? 'Select a project' : 'No projects')}
      >
        {projects.map((p: any) => (<Option key={p.name} value={p.name}>{p.displayName || p.name}</Option>))}
      </Dropdown>
    </Field>
  );
}

// =====================================================================
// 2. PromptFlowEditor
// =====================================================================

export function PromptFlowEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const [project, setProject] = useState<string | null>(null);
  const [list, reload] = useApi<{ flows: any[] }>(project ? `/api/items/prompt-flow?project=${encodeURIComponent(project)}` : null, [project]);
  const [selected, setSelected] = useState<string | null>(null);
  const [defText, setDefText] = useState('');
  // Phase 4.5 — track whether the user has typed into defText. Without this
  // the useEffect that syncs from detail.data would clobber unsaved edits
  // whenever the list reloads (background polling, user clicked Reload, etc).
  const [defDirty, setDefDirty] = useState(false);
  const [runInputs, setRunInputs] = useState('{}');
  const [runResult, setRunResult] = useState<any>(null);
  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ intent: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => { if (id !== 'new' && id !== 'create') setSelected(id); }, [id]);

  const detailUrl = project && selected ? `/api/items/prompt-flow/${encodeURIComponent(selected)}?project=${encodeURIComponent(project)}` : null;
  const [detail] = useApi<{ flow: any }>(detailUrl, [project, selected]);
  useEffect(() => {
    // Only adopt server flow definition when the user hasn't typed into the
    // local editor since the last selection. Prevents clobbering edits.
    if (detail.data?.flow && !defDirty) {
      setDefText(JSON.stringify(detail.data.flow.flowDefinition || detail.data.flow, null, 2));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.data]);

  // Resetting selection clears the dirty flag so the next flow's body loads.
  useEffect(() => { setDefDirty(false); }, [selected]);

  const runFlow = async () => {
    if (!project || !selected) return;
    setRunning(true); setRunResult(null);
    let inputs: any = {};
    try { inputs = JSON.parse(runInputs || '{}'); } catch { setRunResult({ ok: false, error: 'Invalid JSON in inputs' }); setRunning(false); return; }
    const r = await fetch(`/api/items/prompt-flow/${encodeURIComponent(selected)}/run`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project, inputs }),
    });
    const j = await r.json();
    setRunResult(j);
    setRunning(false);
  };

  const saveFlow = async () => {
    if (!project || !selected) return;
    setSaving(true); setSaveMsg(null);
    let flowDefinition: any;
    try { flowDefinition = JSON.parse(defText || '{}'); } catch { setSaveMsg({ intent: 'error', text: 'Invalid JSON in flow definition' }); setSaving(false); return; }
    try {
      const r = await fetch(`/api/items/prompt-flow/${encodeURIComponent(selected)}?project=${encodeURIComponent(project)}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ flowDefinition }),
      });
      const j = await r.json();
      if (!j.ok) { setSaveMsg({ intent: 'error', text: j.error || `HTTP ${r.status}` }); }
      else { setSaveMsg({ intent: 'success', text: 'Flow definition saved to Foundry.' }); setDefDirty(false); }
    } catch (e: any) { setSaveMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setSaving(false); }
  };

  const ribbon = useMemo(() => {
    const portalUrl = project
      ? `https://ai.azure.com/projects/${encodeURIComponent(project)}/prompt-flow`
      : null;
    return buildBaseRibbon(reload, portalUrl);
  }, [reload, project]);

  return <Shell item={item} id={id} ribbon={ribbon}>
    <div className={s.pad}>
      <ProjectPicker value={project} onChange={setProject} />
      {!project ? <Caption1>Pick a project to list its prompt flows.</Caption1> : list.loading ? <Spinner size="small" /> : list.error ? <ErrorBar msg={list.error} hint={list.hint} notDeployed={list.notDeployed} /> : (
        <>
          <Caption1>{(list.data?.flows || []).length} flow(s)</Caption1>
          <div className={s.tableWrap}>
            <Table size="small">
              <TableHeader><TableRow>
                <TableHeaderCell>Name</TableHeaderCell><TableHeaderCell>Type</TableHeaderCell>
                <TableHeaderCell>Modified</TableHeaderCell><TableHeaderCell></TableHeaderCell>
              </TableRow></TableHeader>
              <TableBody>
                {(list.data?.flows || []).map((f: any) => (
                  <TableRow key={f.flowId}>
                    <TableCell className={s.cell}><strong>{f.flowName}</strong></TableCell>
                    <TableCell className={s.cell}>{f.flowType || '—'}</TableCell>
                    <TableCell className={s.cell}>{f.lastModifiedDate || '—'}</TableCell>
                    <TableCell><Button size="small" onClick={() => setSelected(f.flowId)}>Open</Button></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}
      {selected && (
        <div className={s.card}>
          <Subtitle2>Flow: {selected}</Subtitle2>
          <MonacoTextarea value={defText} onChange={(v) => { setDefText(v); setDefDirty(true); }} language="json" height={300} minHeight={200} ariaLabel="Prompt Flow definition" />
          {defDirty && <Caption1 style={{ color: tokens.colorPaletteRedForeground1 }}>Unsaved edits — click Save flow to PUT the definition to Foundry.</Caption1>}
          {saveMsg && <MessageBar intent={saveMsg.intent}><MessageBarBody>{saveMsg.text}</MessageBarBody></MessageBar>}
          <Subtitle2 style={{ marginTop: 8 }}>Run inputs (JSON)</Subtitle2>
          <MonacoTextarea value={runInputs} onChange={setRunInputs} language="json" height={140} minHeight={80} ariaLabel="Run inputs JSON" />
          <div className={s.toolbar} style={{ marginTop: 8 }}>
            <Button appearance="primary" onClick={runFlow} disabled={running}>{running ? 'Running…' : 'Run flow'}</Button>
            <Button onClick={saveFlow} disabled={saving || !defDirty}>{saving ? 'Saving…' : 'Save flow'}</Button>
            <Button onClick={reload}>Reload list</Button>
          </div>
          {runResult && (runResult.ok
            ? <pre className={s.monaco} style={{ minHeight: 80 }}>{JSON.stringify(runResult.result, null, 2)}</pre>
            : <ErrorBar msg={runResult.error} hint={runResult.hint} notDeployed={runResult.notDeployed} />)}
        </div>
      )}
    </div>
  </Shell>;
}

// =====================================================================
// 3. EvaluationEditor
// =====================================================================

export function EvaluationEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const [project, setProject] = useState<string | null>(null);
  const [list, reload] = useApi<{ evaluations: any[] }>(project ? `/api/items/evaluation?project=${encodeURIComponent(project)}` : null, [project]);
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => { if (id !== 'new' && id !== 'create') setSelected(id); }, [id]);
  const detailUrl = project && selected ? `/api/items/evaluation/${encodeURIComponent(selected)}?project=${encodeURIComponent(project)}&results=1` : null;
  const [detail] = useApi<{ evaluation: any; results: any }>(detailUrl, [project, selected]);

  const [form, setForm] = useState({ displayName: '', datasetId: '', modelDeployment: '', evaluators: 'groundedness,relevance,fluency' });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const create = async () => {
    if (!project) { setMsg('Pick a project first.'); return; }
    setBusy(true); setMsg(null);
    const r = await fetch('/api/items/evaluation', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        project,
        displayName: form.displayName,
        datasetId: form.datasetId,
        modelDeployment: form.modelDeployment || undefined,
        evaluatorIds: form.evaluators.split(',').map((x) => x.trim()).filter(Boolean),
      }),
    });
    const j = await r.json();
    setBusy(false);
    if (!j.ok) setMsg(j.error || `HTTP ${r.status}`); else { setMsg(`Created evaluation`); reload(); }
  };

  const ribbon = useMemo(() => {
    const portalUrl = project
      ? `https://ai.azure.com/projects/${encodeURIComponent(project)}/evaluations`
      : null;
    return buildBaseRibbon(reload, portalUrl);
  }, [reload, project]);

  return <Shell item={item} id={id} ribbon={ribbon}>
    <div className={s.pad}>
      <ProjectPicker value={project} onChange={setProject} />
      {project && (list.loading ? <Spinner size="small" /> : list.error ? <ErrorBar msg={list.error} hint={list.hint} notDeployed={list.notDeployed} /> : (
        <div className={s.tableWrap}>
          <Table size="small">
            <TableHeader><TableRow>
              <TableHeaderCell>Name</TableHeaderCell><TableHeaderCell>Status</TableHeaderCell>
              <TableHeaderCell>Dataset</TableHeaderCell><TableHeaderCell>Created</TableHeaderCell>
              <TableHeaderCell></TableHeaderCell>
            </TableRow></TableHeader>
            <TableBody>
              {(list.data?.evaluations || []).map((e: any) => (
                <TableRow key={e.id}>
                  <TableCell className={s.cell}><strong>{e.displayName || e.name}</strong></TableCell>
                  <TableCell className={s.cell}>{e.status || '—'}</TableCell>
                  <TableCell className={s.cell}>{e.datasetId || '—'}</TableCell>
                  <TableCell className={s.cell}>{e.createdDate || '—'}</TableCell>
                  <TableCell><Button size="small" onClick={() => setSelected(e.id)}>Open</Button></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ))}
      <div className={s.card}>
        <Subtitle2>New evaluation</Subtitle2>
        <div className={s.formRow}>
          <span>Display name</span><Input value={form.displayName} onChange={(_, d) => setForm((f) => ({ ...f, displayName: d.value }))} />
          <span>Dataset ID</span><Input value={form.datasetId} onChange={(_, d) => setForm((f) => ({ ...f, datasetId: d.value }))} placeholder="azureml://datastores/.../paths/..." />
          <span>Model deployment</span><Input value={form.modelDeployment} onChange={(_, d) => setForm((f) => ({ ...f, modelDeployment: d.value }))} placeholder="gpt-4o-mini" />
          <span>Evaluators</span><Input value={form.evaluators} onChange={(_, d) => setForm((f) => ({ ...f, evaluators: d.value }))} placeholder="comma-separated" />
        </div>
        <div className={s.toolbar} style={{ marginTop: 8 }}>
          <Button appearance="primary" onClick={create} disabled={busy}>{busy ? 'Submitting…' : 'Create evaluation'}</Button>
          {msg && <Caption1>{msg}</Caption1>}
        </div>
      </div>
      {selected && detail.data?.evaluation && (
        <div className={s.card}>
          <Subtitle2>{detail.data.evaluation.displayName || selected}</Subtitle2>
          <Caption1>Status: {detail.data.evaluation.status || '—'}</Caption1>
          {detail.data.evaluation.metrics && (
            <div className={s.tableWrap}>
              <Table size="small">
                <TableHeader><TableRow><TableHeaderCell>Metric</TableHeaderCell><TableHeaderCell>Value</TableHeaderCell></TableRow></TableHeader>
                <TableBody>{Object.entries(detail.data.evaluation.metrics).map(([k, v]) => (
                  <TableRow key={k}><TableCell className={s.cell}>{k}</TableCell><TableCell className={s.cell}>{String(v)}</TableCell></TableRow>
                ))}</TableBody>
              </Table>
            </div>
          )}
        </div>
      )}
    </div>
  </Shell>;
}

// =====================================================================
// 4. ContentSafetyEditor
// =====================================================================

export function ContentSafetyEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const [policies, reloadPolicies] = useApi<{ policies: any[] }>('/api/items/content-safety');
  const [text, setText] = useState('');
  const [result, setResult] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [imgB64, setImgB64] = useState('');

  // Content Safety is a tenant-level Azure AI Content Safety resource; without
  // an ARM id in the policies response, the most useful deep-link is the
  // Content Safety Studio app at contentsafety.azure.com.
  const ribbon = useMemo(
    () => buildBaseRibbon(reloadPolicies, 'https://contentsafety.cognitive.azure.com/'),
    [reloadPolicies],
  );

  const analyze = async (kind: 'text' | 'image') => {
    setBusy(true); setResult(null);
    const body: any = { kind };
    if (kind === 'text') body.text = text;
    else body.imageBase64 = imgB64;
    const r = await fetch('/api/items/content-safety', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    setResult(j);
    setBusy(false);
  };

  const onFile = (f: File | undefined) => {
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      const r = reader.result as string;
      setImgB64(r.replace(/^data:.*?;base64,/, ''));
    };
    reader.readAsDataURL(f);
  };

  return <Shell item={item} id={id} ribbon={ribbon}>
    <div className={s.pad}>
      {policies.error
        ? <ErrorBar msg={policies.error} hint={policies.hint} notDeployed={policies.notDeployed} />
        : (
          <>
            <Subtitle2>Content Safety</Subtitle2>
            <Caption1>Default category set + severity thresholds. Custom blocklists land in v2.6.</Caption1>
            <div className={s.card}>
              <Subtitle2>Text moderation</Subtitle2>
              <Textarea value={text} onChange={(_, d) => setText(d.value)} resize="vertical" rows={4} placeholder="Paste text to evaluate…" />
              <Button appearance="primary" onClick={() => analyze('text')} disabled={busy || !text}>Analyze text</Button>
            </div>
            <div className={s.card}>
              <Subtitle2>Image moderation</Subtitle2>
              <input type="file" accept="image/*" onChange={(e) => onFile(e.target.files?.[0])} />
              <Button appearance="primary" onClick={() => analyze('image')} disabled={busy || !imgB64}>Analyze image</Button>
            </div>
            {result && (result.ok
              ? <pre className={s.monaco}>{JSON.stringify(result.result, null, 2)}</pre>
              : <ErrorBar msg={result.error} hint={result.hint} notDeployed={result.notDeployed} />)}
          </>
        )}
    </div>
  </Shell>;
}

// =====================================================================
// 5. TracingEditor
// =====================================================================

export function TracingEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const [hours, setHours] = useState(24);
  const [op, setOp] = useState('');
  const url = `/api/items/tracing?hours=${hours}${op ? `&operation=${encodeURIComponent(op)}` : ''}`;
  const [state, reload] = useApi<{ traces: any[] }>(url, [hours, op]);

  // Traces live in the backing Application Insights resource. Without an ARM
  // id on the response, the Foundry tracing surface itself is the cleanest
  // deep-link.
  const ribbon = useMemo(
    () => buildBaseRibbon(reload, 'https://ai.azure.com/tracing'),
    [reload],
  );

  return <Shell item={item} id={id} ribbon={ribbon}>
    <div className={s.pad}>
      <Subtitle2>Foundry traces</Subtitle2>
      <div className={s.toolbar}>
        <Field label="Window (hrs)"><Input type="number" value={String(hours)} onChange={(_, d) => setHours(Number(d.value) || 24)} /></Field>
        <Field label="Operation"><Input value={op} onChange={(_, d) => setOp(d.value)} placeholder="(any)" /></Field>
        <Button onClick={reload}>Reload</Button>
      </div>
      {state.loading ? <Spinner size="small" /> : state.error ? <ErrorBar msg={state.error} hint={state.hint} notDeployed={state.notDeployed} /> : (
        <div className={s.tableWrap}>
          <Table size="small">
            <TableHeader><TableRow>
              <TableHeaderCell>Time</TableHeaderCell><TableHeaderCell>Operation</TableHeaderCell>
              <TableHeaderCell>Name</TableHeaderCell><TableHeaderCell>Duration (ms)</TableHeaderCell>
              <TableHeaderCell>Success</TableHeaderCell><TableHeaderCell>Result</TableHeaderCell>
            </TableRow></TableHeader>
            <TableBody>
              {(state.data?.traces || []).map((t: any, i: number) => (
                <TableRow key={i}>
                  <TableCell className={s.cell}>{t.timestamp}</TableCell>
                  <TableCell className={s.cell}>{t.operationName || '—'}</TableCell>
                  <TableCell className={s.cell}>{t.name || '—'}</TableCell>
                  <TableCell className={s.cell}>{t.duration ?? '—'}</TableCell>
                  <TableCell className={s.cell}>{t.success === false ? <Badge color="danger">false</Badge> : t.success === true ? <Badge color="success">true</Badge> : '—'}</TableCell>
                  <TableCell className={s.cell}>{t.resultCode || '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  </Shell>;
}

// =====================================================================
// 6. AiSearchIndexEditor
// =====================================================================

export function AiSearchIndexEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const isNew = id === 'new' || id === 'create';
  const [list, reloadList] = useApi<{ indexes: any[] }>(isNew ? '/api/items/ai-search-index' : null);
  const [detail, reloadDetail] = useApi<{ index: any }>(isNew ? null : `/api/items/ai-search-index/${encodeURIComponent(id)}`, [id]);
  const [query, setQuery] = useState('*');
  const [hits, setHits] = useState<any>(null);
  const [busy, setBusy] = useState(false);

  // Deep-link to the index blade when we have an ARM id on the index payload;
  // fall back to the generic portal landing page otherwise.
  const ribbon = useMemo(() => {
    const armId = detail.data?.index?.id || detail.data?.index?.armId;
    const portalUrl = armId
      ? `https://portal.azure.com/#@/resource${armId}/overview`
      : 'https://portal.azure.com/';
    return buildBaseRibbon(isNew ? reloadList : reloadDetail, portalUrl);
  }, [isNew, reloadList, reloadDetail, detail.data]);

  const runSearch = async () => {
    setBusy(true); setHits(null);
    const r = await fetch(`/api/items/ai-search-index/${encodeURIComponent(id)}/search`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, top: 25 }),
    });
    const j = await r.json();
    setHits(j);
    setBusy(false);
  };

  if (isNew) {
    return <Shell item={item} id={id} ribbon={ribbon}>
      <div className={s.pad}>
        <Subtitle2>Azure AI Search indexes</Subtitle2>
        {list.loading ? <Spinner size="small" /> : list.error ? <ErrorBar msg={list.error} hint={list.hint} notDeployed={list.notDeployed} /> : (
          <div className={s.tableWrap}>
            <Table size="small">
              <TableHeader><TableRow><TableHeaderCell>Name</TableHeaderCell><TableHeaderCell>Fields</TableHeaderCell></TableRow></TableHeader>
              <TableBody>
                {(list.data?.indexes || []).map((i: any) => (
                  <TableRow key={i.name}>
                    <TableCell className={s.cell}><strong>{i.name}</strong></TableCell>
                    <TableCell className={s.cell}>{(i.fields || []).length}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </Shell>;
  }

  const idx = detail.data?.index;
  const fields: any[] = idx?.fields || [];
  const docs: any[] = hits?.ok ? (hits.result?.value || hits.result?.['value'] || []) : [];

  return <Shell item={item} id={id} ribbon={ribbon}>
    <div className={s.pad}>
      {detail.error ? <ErrorBar msg={detail.error} hint={detail.hint} notDeployed={detail.notDeployed} /> : idx && (
        <>
          <Subtitle2>Index: {idx.name}</Subtitle2>
          <div className={s.toolbar}>
            <Field label="Search query"><Input value={query} onChange={(_, d) => setQuery(d.value)} /></Field>
            <Button appearance="primary" onClick={runSearch} disabled={busy}>{busy ? 'Searching…' : 'Search'}</Button>
          </div>
          <Subtitle2 style={{ marginTop: 12 }}>Fields ({fields.length})</Subtitle2>
          <div className={s.tableWrap}>
            <Table size="small" aria-label="Index fields">
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>Name</TableHeaderCell>
                  <TableHeaderCell>Type</TableHeaderCell>
                  <TableHeaderCell>Key</TableHeaderCell>
                  <TableHeaderCell>Searchable</TableHeaderCell>
                  <TableHeaderCell>Filterable</TableHeaderCell>
                  <TableHeaderCell>Sortable</TableHeaderCell>
                  <TableHeaderCell>Facetable</TableHeaderCell>
                  <TableHeaderCell>Retrievable</TableHeaderCell>
                  <TableHeaderCell>Dims</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {fields.map((f: any) => (
                  <TableRow key={f.name}>
                    <TableCell className={s.cell}><strong>{f.name}</strong></TableCell>
                    <TableCell className={s.cell}><code>{f.type}</code></TableCell>
                    <TableCell className={s.cell}>{f.key ? '✓' : ''}</TableCell>
                    <TableCell className={s.cell}>{f.searchable ? '✓' : ''}</TableCell>
                    <TableCell className={s.cell}>{f.filterable ? '✓' : ''}</TableCell>
                    <TableCell className={s.cell}>{f.sortable ? '✓' : ''}</TableCell>
                    <TableCell className={s.cell}>{f.facetable ? '✓' : ''}</TableCell>
                    <TableCell className={s.cell}>{f.retrievable !== false ? '✓' : ''}</TableCell>
                    <TableCell className={s.cell}>{f.dimensions || ''}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {idx.vectorSearch && (
            <Caption1 style={{ marginTop: 8 }}>
              Vector search enabled · profiles: {(idx.vectorSearch?.profiles || []).map((p: any) => p.name).join(', ') || '—'}
            </Caption1>
          )}
          {hits && !hits.ok && (
            <ErrorBar msg={hits.error} hint={hits.hint} notDeployed={hits.notDeployed} />
          )}
          {hits?.ok && (
            <>
              <Subtitle2 style={{ marginTop: 12 }}>Results ({docs.length})</Subtitle2>
              {docs.length === 0 ? (
                <Caption1>No documents matched.</Caption1>
              ) : (
                <div className={s.tableWrap}>
                  <Table size="small" aria-label="Search results">
                    <TableHeader>
                      <TableRow>
                        <TableHeaderCell>Score</TableHeaderCell>
                        {/* Show all retrievable fields; cap at 6 to keep the grid readable. */}
                        {fields.filter(f => f.retrievable !== false).slice(0, 6).map((f) => (
                          <TableHeaderCell key={f.name}>{f.name}</TableHeaderCell>
                        ))}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {docs.map((d, i) => (
                        <TableRow key={i}>
                          <TableCell className={s.cell}>{(d['@search.score'] || 0).toFixed(3)}</TableCell>
                          {fields.filter(f => f.retrievable !== false).slice(0, 6).map((f) => (
                            <TableCell key={f.name} className={s.cell}>
                              {(() => {
                                const v = d[f.name];
                                if (v === undefined || v === null) return '—';
                                const s = typeof v === 'string' ? v : JSON.stringify(v);
                                return s.length > 80 ? s.slice(0, 80) + '…' : s;
                              })()}
                            </TableCell>
                          ))}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  </Shell>;
}

// =====================================================================
// 7. ComputeEditor
// =====================================================================

export function ComputeEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const isNew = id === 'new' || id === 'create';
  const [list, reload] = useApi<{ computes: any[] }>(isNew ? '/api/items/compute' : null);
  const [detail, reloadDetail] = useApi<{ compute: any }>(isNew ? null : `/api/items/compute/${encodeURIComponent(id)}`, [id]);

  const [form, setForm] = useState({ name: '', computeType: 'AmlCompute', vmSize: 'Standard_DS3_v2', minNodeCount: 0, maxNodeCount: 1 });
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const create = async () => {
    setBusy(true); setMsg(null);
    const r = await fetch('/api/items/compute', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(form),
    });
    const j = await r.json();
    setBusy(false);
    if (!j.ok) setMsg(j.error || `HTTP ${r.status}`); else { setMsg('Created'); reload(); }
  };

  const power = async (action: 'start' | 'stop', name: string) => {
    const r = await fetch(`/api/items/compute/${encodeURIComponent(name)}/${action}`, { method: 'POST' });
    const j = await r.json();
    if (!j.ok) setMsg(j.error); else { setMsg(`${action} requested`); reload(); reloadDetail(); }
  };

  // Compute resources are managed inside the Foundry workspace; ai.azure.com's
  // compute surface is the canonical deep-link.
  const ribbon = useMemo(
    () => buildBaseRibbon(isNew ? reload : reloadDetail, 'https://ai.azure.com/compute'),
    [isNew, reload, reloadDetail],
  );

  if (isNew) {
    return <Shell item={item} id={id} ribbon={ribbon}>
      <div className={s.pad}>
        <Subtitle2>Foundry computes</Subtitle2>
        <div className={s.card}>
          <Subtitle2>New compute</Subtitle2>
          <div className={s.formRow}>
            {/* v3.28 Phase 4.5: functional setForm so the Start/Stop polling
                refresh + concurrent typing don't clobber form edits. */}
            <span>Name</span><Input value={form.name} onChange={(_, d) => setForm((f) => ({ ...f, name: d.value }))} />
            <span>Type</span>
            <Dropdown value={form.computeType} selectedOptions={[form.computeType]}
              onOptionSelect={(_, d) => d.optionValue && setForm((f) => ({ ...f, computeType: d.optionValue! }))}>
              <Option value="AmlCompute">AmlCompute (cluster)</Option>
              <Option value="ComputeInstance">ComputeInstance</Option>
            </Dropdown>
            <span>VM size</span><Input value={form.vmSize} onChange={(_, d) => setForm((f) => ({ ...f, vmSize: d.value }))} />
            {form.computeType === 'AmlCompute' && <>
              <span>Min nodes</span><Input type="number" value={String(form.minNodeCount)} onChange={(_, d) => setForm((f) => ({ ...f, minNodeCount: Number(d.value) }))} />
              <span>Max nodes</span><Input type="number" value={String(form.maxNodeCount)} onChange={(_, d) => setForm((f) => ({ ...f, maxNodeCount: Number(d.value) }))} />
            </>}
          </div>
          <Button appearance="primary" onClick={create} disabled={busy || !form.name}>{busy ? 'Creating…' : 'Create compute'}</Button>
          {msg && <Caption1> {msg}</Caption1>}
        </div>
        {list.loading ? <Spinner size="small" /> : list.error ? <ErrorBar msg={list.error} hint={list.hint} notDeployed={list.notDeployed} /> : (
          <div className={s.tableWrap}>
            <Table size="small">
              <TableHeader><TableRow>
                <TableHeaderCell>Name</TableHeaderCell><TableHeaderCell>Type</TableHeaderCell>
                <TableHeaderCell>VM</TableHeaderCell><TableHeaderCell>State</TableHeaderCell>
                <TableHeaderCell></TableHeaderCell>
              </TableRow></TableHeader>
              <TableBody>
                {(list.data?.computes || []).map((c: any) => (
                  <TableRow key={c.name}>
                    <TableCell className={s.cell}><strong>{c.name}</strong></TableCell>
                    <TableCell className={s.cell}>{c.computeType || '—'}</TableCell>
                    <TableCell className={s.cell}>{c.vmSize || '—'}</TableCell>
                    <TableCell className={s.cell}>{c.state || c.provisioningState || '—'}</TableCell>
                    <TableCell>
                      <Button size="small" onClick={() => power('start', c.name)}>Start</Button>{' '}
                      <Button size="small" onClick={() => power('stop', c.name)}>Stop</Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </Shell>;
  }

  return <Shell item={item} id={id} ribbon={ribbon}>
    <div className={s.pad}>
      {detail.loading ? <Spinner size="small" /> : detail.error ? <ErrorBar msg={detail.error} hint={detail.hint} notDeployed={detail.notDeployed} /> : detail.data?.compute && (
        <>
          <Subtitle2>{detail.data.compute.name}</Subtitle2>
          <div className={s.formRow}>
            <span>Type</span><span>{detail.data.compute.computeType}</span>
            <span>VM</span><span>{detail.data.compute.vmSize || '—'}</span>
            <span>State</span><span>{detail.data.compute.state}</span>
            <span>Location</span><span>{detail.data.compute.location}</span>
          </div>
          <div className={s.toolbar}>
            <Button onClick={() => power('start', detail.data!.compute.name)}>Start</Button>
            <Button onClick={() => power('stop', detail.data!.compute.name)}>Stop</Button>
            <Button onClick={reloadDetail}>Reload</Button>
          </div>
          {msg && <Caption1>{msg}</Caption1>}
        </>
      )}
    </div>
  </Shell>;
}

// =====================================================================
// 8. DatasetEditor
// =====================================================================

export function DatasetEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const isNew = id === 'new' || id === 'create';
  const [project, setProject] = useState<string>('');
  const listUrl = `/api/items/dataset${project ? `?project=${encodeURIComponent(project)}` : ''}`;
  const [list, reload] = useApi<{ assets: any[] }>(isNew ? listUrl : null, [project]);
  const [detail, reloadDetail] = useApi<{ asset: any; versions: any[] }>(isNew ? null : `/api/items/dataset/${encodeURIComponent(id)}${project ? `?project=${encodeURIComponent(project)}` : ''}`, [id, project]);

  // Datasets live under the Foundry project; deep-link to the project's data
  // surface when scoped, otherwise to the hub-level data tab.
  const ribbon = useMemo(() => {
    const portalUrl = project
      ? `https://ai.azure.com/projects/${encodeURIComponent(project)}/data`
      : 'https://ai.azure.com/data';
    return buildBaseRibbon(isNew ? reload : reloadDetail, portalUrl);
  }, [isNew, reload, reloadDetail, project]);

  const [typeFilter, setTypeFilter] = useState<string>('');
  const [form, setForm] = useState({ name: '', dataType: 'uri_folder', dataUri: '', version: '1', description: '' });
  const [msg, setMsg] = useState<string | null>(null);

  const create = async () => {
    setMsg(null);
    const r = await fetch('/api/items/dataset', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...form, project: project || undefined }),
    });
    const j = await r.json();
    if (!j.ok) setMsg(j.error); else { setMsg('Created'); reload(); }
  };

  const filtered = (list.data?.assets || []).filter((a: any) => !typeFilter || a.dataType === typeFilter);

  if (isNew) {
    return <Shell item={item} id={id} ribbon={ribbon}>
      <div className={s.pad}>
        <Subtitle2>Foundry datasets</Subtitle2>
        <div className={s.toolbar}>
          <Field label="Scope">
            <Dropdown value={project || 'hub'} selectedOptions={[project || 'hub']}
              onOptionSelect={(_, d) => setProject(d.optionValue === 'hub' ? '' : (d.optionValue || ''))}>
              <Option value="hub">Hub (all)</Option>
              {/* Real project list is fetched lazily inside ProjectPicker; for the dataset scope picker, hub is canonical. */}
            </Dropdown>
          </Field>
          <ProjectPicker value={project || null} onChange={(v) => setProject(v)} />
          <Field label="Type">
            <Dropdown value={typeFilter || 'all'} selectedOptions={[typeFilter || 'all']}
              onOptionSelect={(_, d) => setTypeFilter(d.optionValue === 'all' ? '' : (d.optionValue || ''))}>
              <Option value="all">All</Option>
              <Option value="uri_file">uri_file</Option>
              <Option value="uri_folder">uri_folder</Option>
              <Option value="mltable">mltable</Option>
            </Dropdown>
          </Field>
        </div>
        <div className={s.card}>
          <Subtitle2>New asset</Subtitle2>
          <div className={s.formRow}>
            <span>Name</span><Input value={form.name} onChange={(_, d) => setForm((f) => ({ ...f, name: d.value }))} />
            <span>Type</span>
            <Dropdown value={form.dataType} selectedOptions={[form.dataType]}
              onOptionSelect={(_, d) => d.optionValue && setForm((f) => ({ ...f, dataType: d.optionValue! }))}>
              <Option value="uri_file">uri_file</Option>
              <Option value="uri_folder">uri_folder</Option>
              <Option value="mltable">mltable</Option>
            </Dropdown>
            <span>URI</span><Input value={form.dataUri} onChange={(_, d) => setForm((f) => ({ ...f, dataUri: d.value }))} placeholder="azureml:// or abfss://..." />
            <span>Version</span><Input value={form.version} onChange={(_, d) => setForm((f) => ({ ...f, version: d.value }))} />
            <span>Description</span><Input value={form.description} onChange={(_, d) => setForm((f) => ({ ...f, description: d.value }))} />
          </div>
          <Button appearance="primary" onClick={create} disabled={!form.name || !form.dataUri}>Create asset</Button>
          {msg && <Caption1> {msg}</Caption1>}
        </div>
        {list.loading ? <Spinner size="small" /> : list.error ? <ErrorBar msg={list.error} hint={list.hint} notDeployed={list.notDeployed} /> : (
          <div className={s.tableWrap}>
            <Table size="small">
              <TableHeader><TableRow>
                <TableHeaderCell>Name</TableHeaderCell><TableHeaderCell>Latest version</TableHeaderCell>
                <TableHeaderCell>Type</TableHeaderCell><TableHeaderCell>URI</TableHeaderCell>
              </TableRow></TableHeader>
              <TableBody>
                {filtered.map((a: any) => (
                  <TableRow key={a.id || a.name}>
                    <TableCell className={s.cell}><strong>{a.name}</strong></TableCell>
                    <TableCell className={s.cell}>{a.latestVersion || '—'}</TableCell>
                    <TableCell className={s.cell}>{a.dataType || '—'}</TableCell>
                    <TableCell className={s.cell}>{a.dataUri || '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </Shell>;
  }

  return <Shell item={item} id={id} ribbon={ribbon}>
    <div className={s.pad}>
      {detail.loading ? <Spinner size="small" /> : detail.error ? <ErrorBar msg={detail.error} hint={detail.hint} notDeployed={detail.notDeployed} /> : detail.data?.asset && (
        <>
          <Subtitle2>{detail.data.asset.name}</Subtitle2>
          <Body1>{detail.data.asset.description || '—'}</Body1>
          <div className={s.tableWrap}>
            <Table size="small">
              <TableHeader><TableRow>
                <TableHeaderCell>Version</TableHeaderCell><TableHeaderCell>Type</TableHeaderCell>
                <TableHeaderCell>URI</TableHeaderCell><TableHeaderCell>Created</TableHeaderCell>
              </TableRow></TableHeader>
              <TableBody>
                {(detail.data.versions || []).map((v: any) => (
                  <TableRow key={v.version}>
                    <TableCell className={s.cell}><strong>{v.version}</strong></TableCell>
                    <TableCell className={s.cell}>{v.dataType || '—'}</TableCell>
                    <TableCell className={s.cell}>{v.dataUri || '—'}</TableCell>
                    <TableCell className={s.cell}>{v.createdAt || '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}
    </div>
  </Shell>;
}
