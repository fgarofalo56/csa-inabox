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
  Checkbox,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  Tab, TabList,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { ItemEditorChrome } from './item-editor-chrome';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';
import { AiSearchServiceTree } from '@/lib/components/ai-search/ai-search-tree';
import {
  type FieldRow, type VectorQuery,
  type SemanticConfig, type VectorAlgorithm, type VectorProfile, type VectorMetric,
  FIELD_TYPES, ANALYZERS, isVectorFieldType, apiFieldToRow, applyFieldRows,
  semanticConfigNames, vectorProfileNames, scoringProfileNames, facetableFieldNames,
  SCHEDULE_PRESETS, validateScheduleInterval, describeScheduleInterval,
  buildSemanticSection, parseSemanticSection, semanticEligibleFieldNames,
  VECTOR_METRICS, defaultHnswParameters, buildVectorSearchSection,
  parseVectorSearchSection, indexHasVectorField,
} from '@/lib/azure/search-field-shapes';
import { PromptFlowBuilder } from '@/lib/prompt-flow/flow-builder';
import {
  type FlowDag, parseFlowDag, serializeFlowDag, starterFlow, emptyFlow,
} from '@/lib/prompt-flow/flow-dag';

const useStyles = makeStyles({
  pad: { padding: tokens.spacingVerticalL, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minHeight: 0, flex: 1 },
  toolbar: { display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'center', flexWrap: 'wrap' },
  monaco: {
    width: '100%', minHeight: 220,
    fontFamily: 'Consolas, "Cascadia Code", monospace', fontSize: tokens.fontSizeBase300, padding: tokens.spacingVerticalM,
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground3, color: tokens.colorNeutralForeground1,
    resize: 'vertical',
  },
  tableWrap: { overflow: 'auto', maxHeight: 480, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium },
  cell: { fontSize: tokens.fontSizeBase200, whiteSpace: 'nowrap', maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis' },
  empty: { padding: tokens.spacingVerticalL, color: tokens.colorNeutralForeground3, fontStyle: 'italic' },
  card: { padding: tokens.spacingVerticalM, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge },
  formRow: { display: 'grid', gridTemplateColumns: '160px 1fr', gap: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalL}`, alignItems: 'center' },
  // Search Explorer query-options grid (label / control pairs, wraps responsively).
  optGrid: { display: 'grid', gridTemplateColumns: 'max-content minmax(220px, 1fr)', gap: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`, alignItems: 'center' },
  // One vector-query builder row.
  vqRow: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'flex-end', flexWrap: 'wrap', marginTop: tokens.spacingVerticalS },
  // Editable field-designer cell — compact controls inside the grid.
  fdInput: { minWidth: '120px' },
  fdNum: { width: '90px' },
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

/**
 * Render an AI Search `@search.highlights` map into bolded snippets. The service
 * wraps matched terms with the request's pre/post tags (default `<em>`/`</em>`);
 * we split on those tags and bold the matched spans WITHOUT innerHTML — so a
 * field value that happens to contain markup can never inject DOM. Grounded in
 * Learn (Shape search results — hit highlighting: `@search.highlights`).
 */
function renderHighlights(
  highlights: Record<string, string[]> | undefined,
  preTag: string,
  postTag: string,
): ReactNode {
  if (!highlights) return '—';
  const pre = preTag || '<em>';
  const post = postTag || '</em>';
  const entries = Object.entries(highlights);
  if (!entries.length) return '—';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS }}>
      {entries.map(([field, snippets], fi) => (
        <div key={fi}>
          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{field}: </Caption1>
          {(snippets || []).map((snippet, si) => {
            // Split on the pre tag, then each piece on the post tag; the segment
            // BEFORE the first post tag (after a pre) is the matched span.
            const parts: ReactNode[] = [];
            let rest = snippet;
            let k = 0;
            while (rest.length) {
              const pi = rest.indexOf(pre);
              if (pi < 0) { parts.push(rest); break; }
              if (pi > 0) parts.push(rest.slice(0, pi));
              rest = rest.slice(pi + pre.length);
              const ei = rest.indexOf(post);
              if (ei < 0) { parts.push(<strong key={`m${k++}`}>{rest}</strong>); break; }
              parts.push(<strong key={`m${k++}`} style={{ background: tokens.colorPaletteYellowBackground2 }}>{rest.slice(0, ei)}</strong>);
              rest = rest.slice(ei + post.length);
            }
            return <span key={si} style={{ display: 'block' }}>{parts}</span>;
          })}
        </div>
      ))}
    </div>
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
          <div className={s.toolbar} style={{ marginTop: tokens.spacingVerticalS }}>
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

// LLM-capable connection categories — only these can back an LLM node.
const LLM_CONNECTION_CATEGORIES = ['AzureOpenAI', 'OpenAI', 'AIServices', 'Serverless', 'CustomKeys'];

/**
 * Coerce whatever the prompt-flow REST returns for `flowDefinition` into a
 * FlowDag. Foundry stores the definition as flow.dag.yaml; the BFF may hand
 * it back as a YAML string OR (when round-tripped through JSON) as an object.
 */
function toFlowDag(raw: unknown): FlowDag {
  if (raw == null) return emptyFlow();
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (!t) return emptyFlow();
    if (t.startsWith('{')) {
      try { return objectToFlowDag(JSON.parse(t)); } catch { /* fall through to yaml */ }
    }
    return parseFlowDag(raw);
  }
  if (typeof raw === 'object') return objectToFlowDag(raw as Record<string, unknown>);
  return emptyFlow();
}

/** Map an already-parsed object (inputs/outputs/nodes maps) to a FlowDag. */
function objectToFlowDag(o: Record<string, any>): FlowDag {
  // Re-serialize to YAML and reparse so the single normalizer governs shape.
  // The object form mirrors flow.dag.yaml's nested maps, so round-trip it.
  const inputs = o.inputs && typeof o.inputs === 'object' && !Array.isArray(o.inputs)
    ? Object.entries(o.inputs).map(([name, v]: [string, any]) => ({ name, type: v?.type || 'string', ...(v && 'default' in v ? { default: v.default } : {}) }))
    : [];
  const outputs = o.outputs && typeof o.outputs === 'object' && !Array.isArray(o.outputs)
    ? Object.entries(o.outputs).map(([name, v]: [string, any]) => ({ name, type: v?.type || 'string', reference: v?.reference || '' }))
    : [];
  const nodes = Array.isArray(o.nodes)
    ? o.nodes.map((n: any) => ({
        name: String(n?.name ?? ''),
        type: (['llm', 'python', 'prompt'].includes(n?.type) ? n.type : 'python'),
        source: n?.source ? { type: n.source.type === 'package' ? 'package' : 'code', path: n.source.path, code: n.source.code, tool: n.source.tool } : undefined,
        inputs: (n?.inputs && typeof n.inputs === 'object' && !Array.isArray(n.inputs)) ? n.inputs : {},
        connection: n?.connection, api: n?.api, deploymentName: n?.deployment_name, provider: n?.provider, module: n?.module,
      }))
    : [];
  return { inputs, outputs, nodes } as FlowDag;
}

export function PromptFlowEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const isNew = id === 'new' || id === 'create';
  const [project, setProject] = useState<string | null>(null);
  const [list, reload] = useApi<{ flows: any[] }>(project ? `/api/items/prompt-flow?project=${encodeURIComponent(project)}` : null, [project]);
  const [selected, setSelected] = useState<string | null>(null);

  // Foundry connections — drive the LLM-node connection picker + honest gate.
  const [conn] = useApi<{ connections: any[] }>('/api/foundry/connections');
  const llmConnections = useMemo(
    () => (conn.data?.connections || [])
      .filter((c: any) => !c.category || LLM_CONNECTION_CATEGORIES.includes(c.category))
      .map((c: any) => c.name as string),
    [conn.data],
  );

  // The flow under edit, as a FlowDag. New flows start from a runnable starter.
  const [dag, setDag] = useState<FlowDag>(() => emptyFlow());
  const [dirty, setDirty] = useState(false);
  const [newFlowName, setNewFlowName] = useState('');
  const [runResult, setRunResult] = useState<any>(null);
  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [creating, setCreating] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ intent: 'success' | 'error' | 'info'; text: string } | null>(null);

  useEffect(() => { if (!isNew) setSelected(id); }, [id, isNew]);

  // Load the flow detail whenever a flow is selected. When a Foundry project is
  // bound we pass it (live data-plane); when it isn't, we still request the
  // route so a bundle-installed flow opens from its stamped content fallback.
  const detailUrl = selected
    ? `/api/items/prompt-flow/${encodeURIComponent(selected)}${project ? `?project=${encodeURIComponent(project)}` : ''}`
    : null;
  const [detail] = useApi<{ flow: any }>(detailUrl, [project, selected]);
  useEffect(() => {
    if (detail.data?.flow && !dirty) {
      setDag(toFlowDag(detail.data.flow.flowDefinition ?? detail.data.flow));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.data]);

  // Selecting a different flow resets dirty + run output.
  useEffect(() => { setDirty(false); setRunResult(null); }, [selected]);

  const onDagChange = useCallback((next: FlowDag) => { setDag(next); setDirty(true); }, []);

  const loadStarter = () => { setDag(starterFlow()); setDirty(true); setSaveMsg(null); };

  // Build the single-input test-run payload from the flow's input defaults.
  const runInputs = useMemo(() => {
    const o: Record<string, unknown> = {};
    for (const inp of dag.inputs) o[inp.name] = inp.default ?? '';
    return o;
  }, [dag.inputs]);

  const createFlow = async () => {
    if (!project || !newFlowName) { setSaveMsg({ intent: 'error', text: 'Pick a project and enter a flow name.' }); return; }
    setCreating(true); setSaveMsg(null);
    try {
      const r = await fetch('/api/items/prompt-flow', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ project, flowName: newFlowName, flowType: 'standard', flowDefinition: serializeFlowDag(dag) }),
      });
      const j = await r.json();
      if (!j.ok) { setSaveMsg({ intent: 'error', text: j.error || `HTTP ${r.status}` }); }
      else {
        setSaveMsg({ intent: 'success', text: `Created flow ${newFlowName} in Foundry.` });
        setDirty(false); reload();
        const fid = j.flow?.flowId || j.flow?.flowName || newFlowName;
        setSelected(fid);
      }
    } catch (e: any) { setSaveMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setCreating(false); }
  };

  const saveFlow = async () => {
    if (!project || !selected) return;
    setSaving(true); setSaveMsg(null);
    try {
      const r = await fetch(`/api/items/prompt-flow/${encodeURIComponent(selected)}?project=${encodeURIComponent(project)}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ flowDefinition: serializeFlowDag(dag) }),
      });
      const j = await r.json();
      if (!j.ok) { setSaveMsg({ intent: 'error', text: j.error || `HTTP ${r.status}` }); }
      else { setSaveMsg({ intent: 'success', text: 'flow.dag.yaml saved to Foundry.' }); setDirty(false); }
    } catch (e: any) { setSaveMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setSaving(false); }
  };

  const runFlow = async () => {
    if (!project || !selected) { setSaveMsg({ intent: 'info', text: 'Save the flow first — runs execute the persisted flow.dag.yaml.' }); return; }
    setRunning(true); setRunResult(null);
    try {
      const r = await fetch(`/api/items/prompt-flow/${encodeURIComponent(selected)}/run`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ project, inputs: runInputs }),
      });
      setRunResult(await r.json());
    } catch (e: any) { setRunResult({ ok: false, error: e?.message || String(e) }); }
    finally { setRunning(false); }
  };

  const ribbon = useMemo(() => {
    const portalUrl = project
      ? `https://ai.azure.com/projects/${encodeURIComponent(project)}/prompt-flow`
      : null;
    return buildBaseRibbon(reload, portalUrl);
  }, [reload, project]);

  const noLlmConnection = !conn.loading && !conn.error && llmConnections.length === 0;
  const perNode: Array<{ node: string; output: unknown }> = useMemo(() => {
    const nodeRuns = runResult?.result?.flowRunInfo?.node_runs || runResult?.result?.node_runs || runResult?.result?.nodeRuns;
    if (!nodeRuns || typeof nodeRuns !== 'object') return [];
    return Object.entries(nodeRuns).map(([node, info]: [string, any]) => ({ node, output: info?.output ?? info?.result ?? info }));
  }, [runResult]);
  const finalOutput = runResult?.result?.flow_runs?.[0]?.output ?? runResult?.result?.output ?? runResult?.result?.outputs ?? runResult?.result;

  return <Shell item={item} id={id} ribbon={ribbon}>
    <div className={s.pad}>
      <div className={s.toolbar}>
        <ProjectPicker value={project} onChange={setProject} />
        {project && !isNew && (
          <Field label="Flow">
            <Dropdown
              value={selected || ''} selectedOptions={selected ? [selected] : []}
              placeholder={list.loading ? 'Loading…' : ((list.data?.flows || []).length ? 'Select a flow' : 'No flows')}
              onOptionSelect={(_, d) => d.optionValue && setSelected(d.optionValue)}>
              {(list.data?.flows || []).map((f: any) => (
                <Option key={f.flowId} value={f.flowId}>{f.flowName || f.flowId}</Option>
              ))}
            </Dropdown>
          </Field>
        )}
      </div>

      {/* Honest infra gate — full builder still renders below. */}
      {conn.error && <ErrorBar msg={conn.error} hint={conn.hint} notDeployed={conn.notDeployed} />}
      {noLlmConnection && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>No LLM connection in this Foundry hub</MessageBarTitle>
            LLM nodes need an Azure OpenAI / AI Services connection. Create one in the Foundry hub
            (Management center → Connections) or provision it via bicep
            (<code>platform/fiab/bicep/modules/admin-plane/ai-foundry.bicep</code> — the AOAI + AI Services
            hub connections). The designer below still renders; Run is enabled once a connection exists
            and the flow is saved.
          </MessageBarBody>
        </MessageBar>
      )}
      {!project && <Caption1>Pick a project to load / build its prompt flows.</Caption1>}

      {(isNew || selected) && (
        <>
          <div className={s.toolbar}>
            {isNew && (
              <>
                <Field label="New flow name">
                  <Input value={newFlowName} onChange={(_, d) => setNewFlowName(d.value)} placeholder="my-flow" />
                </Field>
                <Button onClick={loadStarter}>Load starter flow</Button>
                <Button appearance="primary" disabled={creating || !project || !newFlowName} onClick={createFlow}>
                  {creating ? 'Creating…' : 'Create flow'}
                </Button>
              </>
            )}
            {!isNew && selected && (
              <>
                <Button appearance="primary" disabled={saving || !dirty} onClick={saveFlow}>{saving ? 'Saving…' : 'Save flow'}</Button>
                <Button disabled={running || llmConnections.length === 0} onClick={runFlow}>{running ? 'Running…' : 'Run'}</Button>
                <Button onClick={reload}>Reload</Button>
                {dirty && <Caption1 style={{ color: tokens.colorPaletteRedForeground1 }}>Unsaved changes</Caption1>}
              </>
            )}
          </div>
          {saveMsg && <MessageBar intent={saveMsg.intent === 'info' ? 'info' : saveMsg.intent}><MessageBarBody>{saveMsg.text}</MessageBarBody></MessageBar>}
          {detail.error && <ErrorBar msg={detail.error} hint={detail.hint} notDeployed={detail.notDeployed} />}

          <PromptFlowBuilder
            dag={dag}
            onChange={onDagChange}
            connections={llmConnections}
            connectionsLoading={conn.loading}
          />

          {runResult && (
            runResult.ok ? (
              <div className={s.card}>
                <Subtitle2>Run output</Subtitle2>
                {perNode.length > 0 && (
                  <div className={s.tableWrap}>
                    <Table size="small" aria-label="Per-node outputs">
                      <TableHeader><TableRow><TableHeaderCell>Node</TableHeaderCell><TableHeaderCell>Output</TableHeaderCell></TableRow></TableHeader>
                      <TableBody>
                        {perNode.map((p) => (
                          <TableRow key={p.node}>
                            <TableCell className={s.cell}><strong>{p.node}</strong></TableCell>
                            <TableCell className={s.cell}>{typeof p.output === 'string' ? p.output : JSON.stringify(p.output)}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
                <Subtitle2 style={{ marginTop: tokens.spacingVerticalS }}>Final output</Subtitle2>
                <pre className={s.monaco} style={{ minHeight: 80 }}>{JSON.stringify(finalOutput, null, 2)}</pre>
              </div>
            ) : <ErrorBar msg={runResult.error} hint={runResult.hint} notDeployed={runResult.notDeployed} />
          )}
        </>
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
  // Load the evaluation detail whenever one is selected. With a Foundry project
  // bound we pass it (live results); without one we still request the route so a
  // bundle-installed evaluation opens from its stamped metric definitions.
  const detailUrl = selected
    ? `/api/items/evaluation/${encodeURIComponent(selected)}${project ? `?project=${encodeURIComponent(project)}&results=1` : ''}`
    : null;
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
        <div className={s.toolbar} style={{ marginTop: tokens.spacingVerticalS }}>
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

// Azure AI Content Safety harm categories + the RAI content-filter source
// dimensions, grounded in the raiPolicies ARM schema (RaiPolicyContentFilter):
// each (category, source) pair carries an independent severity threshold.
const RAI_HARM_CATEGORIES = ['Hate', 'Sexual', 'Violence', 'Selfharm'] as const;
const RAI_SEVERITY: Array<'Low' | 'Medium' | 'High'> = ['Low', 'Medium', 'High'];
const RAI_SOURCES: Array<'Prompt' | 'Completion'> = ['Prompt', 'Completion'];

interface RaiFilterRow { name: string; source: 'Prompt' | 'Completion'; enabled: boolean; blocking: boolean; severityThreshold?: 'Low' | 'Medium' | 'High' }

/** Seed the four harm categories × {Prompt, Completion} at Medium/blocking. */
function defaultFilterRows(): RaiFilterRow[] {
  const rows: RaiFilterRow[] = [];
  for (const c of RAI_HARM_CATEGORIES) {
    for (const src of RAI_SOURCES) {
      rows.push({ name: c, source: src, enabled: true, blocking: true, severityThreshold: 'Medium' });
    }
  }
  return rows;
}

export function ContentSafetyEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const [tab, setTab] = useState<'moderation' | 'filters' | 'blocklists'>('moderation');

  // ---- Moderation (live text/image analyze) ----
  const [gate, reloadGate] = useApi<{ policies: any[] }>('/api/items/content-safety');
  const [text, setText] = useState('');
  const [result, setResult] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [imgB64, setImgB64] = useState('');

  // ---- RAI content-filter policies (ARM) ----
  const [policies, reloadPolicies] = useApi<{ policies: any[] }>('/api/items/content-safety/rai-policies');
  const [polName, setPolName] = useState('');
  const [polBase, setPolBase] = useState('Microsoft.DefaultV2');
  const [filterRows, setFilterRows] = useState<RaiFilterRow[]>(defaultFilterRows());
  const [polBusy, setPolBusy] = useState(false);
  const [polMsg, setPolMsg] = useState<{ error?: string; hint?: string; notDeployed?: boolean; ok?: string } | null>(null);

  // ---- Custom blocklists (data-plane) ----
  const [blocklists, reloadBlocklists] = useApi<{ blocklists: any[] }>('/api/items/content-safety/blocklists');
  const [blName, setBlName] = useState('');
  const [blDesc, setBlDesc] = useState('');
  const [blBusy, setBlBusy] = useState(false);
  const [blMsg, setBlMsg] = useState<{ error?: string; hint?: string; notDeployed?: boolean; ok?: string } | null>(null);
  const [selectedBl, setSelectedBl] = useState<string | null>(null);
  const [items, setItems] = useState<{ loading: boolean; rows: any[]; error?: string }>({ loading: false, rows: [] });
  const [itemText, setItemText] = useState('');
  const [itemDesc, setItemDesc] = useState('');
  const [itemRegex, setItemRegex] = useState(false);

  // Content Safety is a tenant-level Azure AI Content Safety resource; the most
  // useful deep-link is the Content Safety Studio app at contentsafety.azure.com.
  const ribbon = useMemo(
    () => buildBaseRibbon(() => { reloadGate(); reloadPolicies(); reloadBlocklists(); }, 'https://contentsafety.cognitive.azure.com/'),
    [reloadGate, reloadPolicies, reloadBlocklists],
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

  const setRow = (i: number, patch: Partial<RaiFilterRow>) =>
    setFilterRows((rows) => rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  // Load an existing policy into the editor form. System-managed (Microsoft
  // default) policies are read-only, so clear the name to force a clone under a
  // new user-managed name rather than attempting to overwrite the system policy.
  const editPolicy = (p: any) => {
    const readOnly = String(p.type || '').toLowerCase() === 'systemmanaged';
    setPolName(readOnly ? '' : (p.name || ''));
    setPolBase(p.basePolicyName || (readOnly ? p.name : '') || '');
    const rows: RaiFilterRow[] = (p.contentFilters || []).map((f: any) => ({
      name: f.name, source: f.source || 'Prompt', enabled: f.enabled !== false,
      blocking: f.blocking !== false, severityThreshold: f.severityThreshold,
    }));
    setFilterRows(rows.length ? rows : defaultFilterRows());
    setPolMsg(null);
    setTab('filters');
  };

  const savePolicy = async () => {
    if (!polName.trim()) { setPolMsg({ error: 'Policy name is required.' }); return; }
    setPolBusy(true); setPolMsg(null);
    const j = await postJson('/api/items/content-safety/rai-policies', {
      name: polName.trim(),
      basePolicyName: polBase.trim() || undefined,
      contentFilters: filterRows,
    });
    setPolBusy(false);
    if (j.ok) { setPolMsg({ ok: `Saved policy "${polName.trim()}".` }); reloadPolicies(); }
    else setPolMsg({ error: j.error, hint: j.hint, notDeployed: j.notDeployed });
  };

  const deletePolicy = async (name: string) => {
    setPolBusy(true); setPolMsg(null);
    const r = await fetch(`/api/items/content-safety/rai-policies?name=${encodeURIComponent(name)}`, { method: 'DELETE' });
    const j = await r.json();
    setPolBusy(false);
    if (j.ok) { setPolMsg({ ok: `Deleted policy "${name}".` }); reloadPolicies(); }
    else setPolMsg({ error: j.error, hint: j.hint, notDeployed: j.notDeployed });
  };

  const loadItems = useCallback(async (name: string) => {
    setItems({ loading: true, rows: [] });
    const r = await fetch(`/api/items/content-safety/blocklists/items?name=${encodeURIComponent(name)}`);
    const j = await r.json();
    if (j.ok) setItems({ loading: false, rows: j.items || [] });
    else setItems({ loading: false, rows: [], error: j.error });
  }, []);

  useEffect(() => { if (selectedBl) loadItems(selectedBl); }, [selectedBl, loadItems]);

  const saveBlocklist = async () => {
    if (!blName.trim()) { setBlMsg({ error: 'Blocklist name is required.' }); return; }
    setBlBusy(true); setBlMsg(null);
    const j = await postJson('/api/items/content-safety/blocklists', { name: blName.trim(), description: blDesc.trim() || undefined });
    setBlBusy(false);
    if (j.ok) { setBlMsg({ ok: `Saved blocklist "${blName.trim()}".` }); setBlName(''); setBlDesc(''); reloadBlocklists(); }
    else setBlMsg({ error: j.error, hint: j.hint, notDeployed: j.notDeployed });
  };

  const deleteBlocklist = async (name: string) => {
    setBlBusy(true); setBlMsg(null);
    const r = await fetch(`/api/items/content-safety/blocklists?name=${encodeURIComponent(name)}`, { method: 'DELETE' });
    const j = await r.json();
    setBlBusy(false);
    if (j.ok) { setBlMsg({ ok: `Deleted blocklist "${name}".` }); if (selectedBl === name) setSelectedBl(null); reloadBlocklists(); }
    else setBlMsg({ error: j.error, hint: j.hint, notDeployed: j.notDeployed });
  };

  const addItem = async () => {
    if (!selectedBl || !itemText.trim()) return;
    setBlBusy(true); setBlMsg(null);
    const j = await postJson(`/api/items/content-safety/blocklists/items?name=${encodeURIComponent(selectedBl)}`, {
      items: [{ text: itemText.trim(), description: itemDesc.trim() || undefined, isRegex: itemRegex }],
    });
    setBlBusy(false);
    if (j.ok) { setItemText(''); setItemDesc(''); setItemRegex(false); loadItems(selectedBl); }
    else setBlMsg({ error: j.error, hint: j.hint, notDeployed: j.notDeployed });
  };

  const removeItem = async (itemId: string) => {
    if (!selectedBl) return;
    setBlBusy(true); setBlMsg(null);
    const r = await fetch(`/api/items/content-safety/blocklists/items?name=${encodeURIComponent(selectedBl)}&id=${encodeURIComponent(itemId)}`, { method: 'DELETE' });
    const j = await r.json();
    setBlBusy(false);
    if (j.ok) loadItems(selectedBl);
    else setBlMsg({ error: j.error, hint: j.hint, notDeployed: j.notDeployed });
  };

  return <Shell item={item} id={id} ribbon={ribbon}>
    <div className={s.pad}>
      <Subtitle2>Content Safety</Subtitle2>
      <Caption1>Live text &amp; image moderation, real RAI content-filter policies (per-category severity thresholds), and custom term/regex blocklists against the Azure AI Content Safety harm categories (hate, self-harm, sexual, violence).</Caption1>

      <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as typeof tab)}>
        <Tab value="moderation">Moderation</Tab>
        <Tab value="filters">Content filters</Tab>
        <Tab value="blocklists">Blocklists</Tab>
      </TabList>

      {/* ---- Moderation ---- */}
      {tab === 'moderation' && (
        gate.error
          ? <ErrorBar msg={gate.error} hint={gate.hint} notDeployed={gate.notDeployed} />
          : (
            <>
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
          )
      )}

      {/* ---- RAI content-filter policies ---- */}
      {tab === 'filters' && (
        gate.error
          ? <ErrorBar msg={gate.error} hint={gate.hint} notDeployed={gate.notDeployed} />
          : (
            <>
              <div className={s.card}>
                <div className={s.toolbar}>
                  <Subtitle2>Content-filter policies</Subtitle2>
                  <Button size="small" onClick={reloadPolicies}>Reload</Button>
                </div>
                <Caption1>Responsible-AI content filters on the model-hosting account (Microsoft.CognitiveServices/accounts/raiPolicies). Each category has an independent severity threshold per source — these are the real persisted policy values used by your model deployments.</Caption1>
                {policies.loading ? <Spinner size="small" /> : policies.error ? <ErrorBar msg={policies.error} hint={policies.hint} notDeployed={policies.notDeployed} /> : (
                  <div className={s.tableWrap}>
                    <Table size="small" aria-label="RAI policies">
                      <TableHeader><TableRow>
                        <TableHeaderCell>Name</TableHeaderCell><TableHeaderCell>Type</TableHeaderCell>
                        <TableHeaderCell>Base</TableHeaderCell><TableHeaderCell>Filters</TableHeaderCell>
                        <TableHeaderCell>Blocklists</TableHeaderCell><TableHeaderCell>Actions</TableHeaderCell>
                      </TableRow></TableHeader>
                      <TableBody>
                        {(policies.data?.policies || []).map((p: any) => {
                          const readOnly = String(p.type || '').toLowerCase() === 'systemmanaged';
                          return (
                            <TableRow key={p.name}>
                              <TableCell className={s.cell}>{p.name}</TableCell>
                              <TableCell className={s.cell}>{readOnly ? <Badge color="informative">System</Badge> : <Badge color="brand">User</Badge>}</TableCell>
                              <TableCell className={s.cell}>{p.basePolicyName || '—'}</TableCell>
                              <TableCell className={s.cell}>{(p.contentFilters || []).length}</TableCell>
                              <TableCell className={s.cell}>{(p.customBlocklists || []).length}</TableCell>
                              <TableCell className={s.cell}>
                                <Button size="small" appearance="subtle" onClick={() => editPolicy(p)}>{readOnly ? 'Clone' : 'Edit'}</Button>
                                {!readOnly && <Button size="small" appearance="subtle" disabled={polBusy} onClick={() => deletePolicy(p.name)}>Delete</Button>}
                              </TableCell>
                            </TableRow>
                          );
                        })}
                        {(policies.data?.policies || []).length === 0 && (
                          <TableRow><TableCell className={s.cell}>No content-filter policies yet.</TableCell></TableRow>
                        )}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </div>

              <div className={s.card}>
                <Subtitle2>Create / edit policy</Subtitle2>
                <div className={s.toolbar}>
                  <Field label="Policy name"><Input value={polName} onChange={(_, d) => setPolName(d.value)} placeholder="my-content-filter" /></Field>
                  <Field label="Base policy"><Input value={polBase} onChange={(_, d) => setPolBase(d.value)} placeholder="Microsoft.DefaultV2" /></Field>
                </div>
                <div className={s.tableWrap}>
                  <Table size="small" aria-label="Content filters">
                    <TableHeader><TableRow>
                      <TableHeaderCell>Category</TableHeaderCell><TableHeaderCell>Source</TableHeaderCell>
                      <TableHeaderCell>Enabled</TableHeaderCell><TableHeaderCell>Blocking</TableHeaderCell>
                      <TableHeaderCell>Severity threshold</TableHeaderCell>
                    </TableRow></TableHeader>
                    <TableBody>
                      {filterRows.map((r, i) => (
                        <TableRow key={`${r.name}-${r.source}-${i}`}>
                          <TableCell className={s.cell}>{r.name}</TableCell>
                          <TableCell className={s.cell}>{r.source}</TableCell>
                          <TableCell className={s.cell}><Checkbox checked={r.enabled} onChange={(_, d) => setRow(i, { enabled: !!d.checked })} /></TableCell>
                          <TableCell className={s.cell}><Checkbox checked={r.blocking} onChange={(_, d) => setRow(i, { blocking: !!d.checked })} /></TableCell>
                          <TableCell className={s.cell}>
                            <Dropdown
                              size="small"
                              selectedOptions={r.severityThreshold ? [r.severityThreshold] : []}
                              value={r.severityThreshold || ''}
                              disabled={!r.enabled}
                              onOptionSelect={(_, d) => setRow(i, { severityThreshold: d.optionValue as RaiFilterRow['severityThreshold'] })}
                            >
                              {RAI_SEVERITY.map((sv) => <Option key={sv} value={sv}>{sv}</Option>)}
                            </Dropdown>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
                <div className={s.toolbar}>
                  <Button appearance="primary" disabled={polBusy || !polName.trim()} onClick={savePolicy}>Save policy</Button>
                  <Button disabled={polBusy} onClick={() => { setPolName(''); setPolBase('Microsoft.DefaultV2'); setFilterRows(defaultFilterRows()); setPolMsg(null); }}>Reset</Button>
                </div>
                {polMsg?.ok && <MessageBar intent="success"><MessageBarBody>{polMsg.ok}</MessageBarBody></MessageBar>}
                {polMsg?.error && <ErrorBar msg={polMsg.error} hint={polMsg.hint} notDeployed={polMsg.notDeployed} />}
              </div>
            </>
          )
      )}

      {/* ---- Custom blocklists ---- */}
      {tab === 'blocklists' && (
        <>
          <div className={s.card}>
            <div className={s.toolbar}>
              <Subtitle2>Custom blocklists</Subtitle2>
              <Button size="small" onClick={reloadBlocklists}>Reload</Button>
            </div>
            <Caption1>Custom term / regex blocklists on the Content Safety data-plane. Attach one to a content-filter policy (Content filters tab) to enforce it. Max 10,000 terms total across all lists; 128 chars per term.</Caption1>
            {blocklists.loading ? <Spinner size="small" /> : blocklists.error ? <ErrorBar msg={blocklists.error} hint={blocklists.hint} notDeployed={blocklists.notDeployed} /> : (
              <div className={s.tableWrap}>
                <Table size="small" aria-label="Blocklists">
                  <TableHeader><TableRow>
                    <TableHeaderCell>Name</TableHeaderCell><TableHeaderCell>Description</TableHeaderCell><TableHeaderCell>Actions</TableHeaderCell>
                  </TableRow></TableHeader>
                  <TableBody>
                    {(blocklists.data?.blocklists || []).map((b: any) => (
                      <TableRow key={b.blocklistName} style={{ background: selectedBl === b.blocklistName ? tokens.colorNeutralBackground2 : undefined }}>
                        <TableCell className={s.cell}>{b.blocklistName}</TableCell>
                        <TableCell className={s.cell}>{b.description || '—'}</TableCell>
                        <TableCell className={s.cell}>
                          <Button size="small" appearance="subtle" onClick={() => setSelectedBl(b.blocklistName)}>Items</Button>
                          <Button size="small" appearance="subtle" disabled={blBusy} onClick={() => deleteBlocklist(b.blocklistName)}>Delete</Button>
                        </TableCell>
                      </TableRow>
                    ))}
                    {(blocklists.data?.blocklists || []).length === 0 && (
                      <TableRow><TableCell className={s.cell}>No blocklists yet.</TableCell></TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>

          <div className={s.card}>
            <Subtitle2>Create / update blocklist</Subtitle2>
            <div className={s.toolbar}>
              <Field label="Name"><Input value={blName} onChange={(_, d) => setBlName(d.value)} placeholder="my-blocklist" /></Field>
              <Field label="Description"><Input value={blDesc} onChange={(_, d) => setBlDesc(d.value)} placeholder="(optional)" /></Field>
              <Button appearance="primary" disabled={blBusy || !blName.trim()} onClick={saveBlocklist}>Save blocklist</Button>
            </div>
            {blMsg?.ok && <MessageBar intent="success"><MessageBarBody>{blMsg.ok}</MessageBarBody></MessageBar>}
            {blMsg?.error && <ErrorBar msg={blMsg.error} hint={blMsg.hint} notDeployed={blMsg.notDeployed} />}
          </div>

          {selectedBl && (
            <div className={s.card}>
              <div className={s.toolbar}>
                <Subtitle2>Items · {selectedBl}</Subtitle2>
                <Button size="small" onClick={() => loadItems(selectedBl)}>Reload</Button>
                <Button size="small" appearance="subtle" onClick={() => setSelectedBl(null)}>Close</Button>
              </div>
              <div className={s.toolbar}>
                <Field label="Term / pattern"><Input value={itemText} onChange={(_, d) => setItemText(d.value)} placeholder="term to block" /></Field>
                <Field label="Description"><Input value={itemDesc} onChange={(_, d) => setItemDesc(d.value)} placeholder="(optional)" /></Field>
                <Checkbox label="Regex" checked={itemRegex} onChange={(_, d) => setItemRegex(!!d.checked)} />
                <Button appearance="primary" disabled={blBusy || !itemText.trim()} onClick={addItem}>Add item</Button>
              </div>
              {items.loading ? <Spinner size="small" /> : items.error ? <ErrorBar msg={items.error} /> : (
                <div className={s.tableWrap}>
                  <Table size="small" aria-label="Blocklist items">
                    <TableHeader><TableRow>
                      <TableHeaderCell>Term</TableHeaderCell><TableHeaderCell>Regex</TableHeaderCell>
                      <TableHeaderCell>Description</TableHeaderCell><TableHeaderCell>Actions</TableHeaderCell>
                    </TableRow></TableHeader>
                    <TableBody>
                      {items.rows.map((it: any) => (
                        <TableRow key={it.blocklistItemId}>
                          <TableCell className={s.cell}>{it.text}</TableCell>
                          <TableCell className={s.cell}>{it.isRegex ? <Badge color="warning">regex</Badge> : '—'}</TableCell>
                          <TableCell className={s.cell}>{it.description || '—'}</TableCell>
                          <TableCell className={s.cell}><Button size="small" appearance="subtle" disabled={blBusy} onClick={() => removeItem(it.blocklistItemId)}>Remove</Button></TableCell>
                        </TableRow>
                      ))}
                      {items.rows.length === 0 && (
                        <TableRow><TableCell className={s.cell}>No items in this blocklist.</TableCell></TableRow>
                      )}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  </Shell>;
}

// =====================================================================
// 5. TracingEditor
// =====================================================================

interface TraceSpan { id: string; parentId?: string; name?: string; kind?: string; timestamp?: string; duration?: number; success?: boolean; resultCode?: string; genAiModel?: string; inputTokens?: number; outputTokens?: number }

/** Build an ordered, depth-tagged flat list from a span set keyed by parentId. */
function buildSpanTree(spans: TraceSpan[]): { span: TraceSpan; depth: number }[] {
  const byParent = new Map<string, TraceSpan[]>();
  const ids = new Set(spans.map((s) => s.id));
  for (const sp of spans) {
    const key = sp.parentId && ids.has(sp.parentId) ? sp.parentId : '__root__';
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(sp);
  }
  const out: { span: TraceSpan; depth: number }[] = [];
  const walk = (key: string, depth: number) => {
    const kids = (byParent.get(key) || []).sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
    for (const k of kids) { out.push({ span: k, depth }); walk(k.id, depth + 1); }
  };
  walk('__root__', 0);
  // Any spans whose parent wasn't captured fall under root via the byParent key.
  return out;
}

export function TracingEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const [hours, setHours] = useState(24);
  const [op, setOp] = useState('');
  const url = `/api/items/tracing?hours=${hours}${op ? `&operation=${encodeURIComponent(op)}` : ''}`;
  const [state, reload] = useApi<{ traces: any[] }>(url, [hours, op]);

  // Drill: select a trace (operation_Id) → fetch its full span tree.
  const [traceId, setTraceId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ loading: boolean; spans: TraceSpan[]; error?: string; hint?: string; notDeployed?: boolean }>({ loading: false, spans: [] });

  const loadDetail = useCallback(async (tid: string) => {
    setDetail({ loading: true, spans: [] });
    try {
      const r = await fetch(`/api/items/tracing/${encodeURIComponent(tid)}`);
      const j = await r.json();
      if (!j.ok) { setDetail({ loading: false, spans: [], error: j.error, hint: j.hint, notDeployed: j.notDeployed }); return; }
      setDetail({ loading: false, spans: Array.isArray(j.spans) ? j.spans : [] });
    } catch (e: any) { setDetail({ loading: false, spans: [], error: e?.message || String(e) }); }
  }, []);

  useEffect(() => { if (traceId) loadDetail(traceId); else setDetail({ loading: false, spans: [] }); }, [traceId, loadDetail]);

  const ribbon = useMemo(
    () => buildBaseRibbon(reload, 'https://ai.azure.com/tracing'),
    [reload],
  );

  const tree = useMemo(() => buildSpanTree(detail.spans), [detail.spans]);

  return <Shell item={item} id={id} ribbon={ribbon}>
    <div className={s.pad}>
      <Subtitle2>Foundry traces</Subtitle2>
      <Caption1>GenAI traces from the hub’s Application Insights. Click a trace to drill into its full span tree (model calls, tool calls, token usage).</Caption1>
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
              <TableHeaderCell>Trace</TableHeaderCell>
            </TableRow></TableHeader>
            <TableBody>
              {(state.data?.traces || []).map((t: any, i: number) => (
                <TableRow key={i} style={{ background: traceId && traceId === t.operationId ? tokens.colorNeutralBackground2 : undefined }}>
                  <TableCell className={s.cell}>{t.timestamp}</TableCell>
                  <TableCell className={s.cell}>{t.operationName || '—'}</TableCell>
                  <TableCell className={s.cell}>{t.name || '—'}</TableCell>
                  <TableCell className={s.cell}>{t.duration ?? '—'}</TableCell>
                  <TableCell className={s.cell}>{t.success === false ? <Badge color="danger">false</Badge> : t.success === true ? <Badge color="success">true</Badge> : '—'}</TableCell>
                  <TableCell className={s.cell}>{t.resultCode || '—'}</TableCell>
                  <TableCell className={s.cell}>
                    {t.operationId ? <Button size="small" appearance="subtle" onClick={() => setTraceId(t.operationId)}>View spans</Button> : '—'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {traceId && (
        <>
          <div className={s.toolbar} style={{ marginTop: tokens.spacingVerticalM }}>
            <Subtitle2>Span tree · {traceId.slice(0, 16)}…</Subtitle2>
            <Button size="small" onClick={() => loadDetail(traceId)}>Reload spans</Button>
            <Button size="small" appearance="subtle" onClick={() => setTraceId(null)}>Close</Button>
          </div>
          {detail.loading ? <Spinner size="small" /> : detail.error ? <ErrorBar msg={detail.error} hint={detail.hint} notDeployed={detail.notDeployed} /> : tree.length === 0 ? (
            <div className={s.empty}>No spans found for this trace.</div>
          ) : (
            <div className={s.tableWrap}>
              <Table size="small" aria-label="Span tree">
                <TableHeader><TableRow>
                  <TableHeaderCell>Span</TableHeaderCell><TableHeaderCell>Kind</TableHeaderCell>
                  <TableHeaderCell>Model</TableHeaderCell><TableHeaderCell>Tokens (in/out)</TableHeaderCell>
                  <TableHeaderCell>Duration (ms)</TableHeaderCell><TableHeaderCell>Success</TableHeaderCell>
                </TableRow></TableHeader>
                <TableBody>
                  {tree.map(({ span, depth }) => (
                    <TableRow key={span.id}>
                      <TableCell className={s.cell} style={{ paddingLeft: 8 + depth * 16 }}>
                        {depth > 0 ? '↳ ' : ''}{span.name || span.id}
                      </TableCell>
                      <TableCell className={s.cell}>{span.kind || '—'}</TableCell>
                      <TableCell className={s.cell}>{span.genAiModel || '—'}</TableCell>
                      <TableCell className={s.cell}>{span.inputTokens !== undefined || span.outputTokens !== undefined ? `${span.inputTokens ?? '—'} / ${span.outputTokens ?? '—'}` : '—'}</TableCell>
                      <TableCell className={s.cell}>{span.duration ?? '—'}</TableCell>
                      <TableCell className={s.cell}>{span.success === false ? <Badge color="danger">false</Badge> : span.success === true ? <Badge color="success">true</Badge> : '—'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </>
      )}
    </div>
  </Shell>;
}

// =====================================================================
// 6. AiSearchIndexEditor
// =====================================================================

// Helper: post JSON to a route, content-type-guarded so an HTML error page from
// a proxy never throws an opaque "Unexpected token <" in the editor.
async function postJson(url: string, body?: unknown): Promise<any> {
  const r = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const ct = r.headers.get('content-type') || '';
  if (!ct.includes('json')) {
    const t = await r.text();
    return { ok: false, error: `HTTP ${r.status}: ${t.slice(0, 200) || r.statusText}` };
  }
  return r.json();
}

/**
 * Bind picker — renders whenever the item is unbound (412), AI Search isn't
 * provisioned (notDeployed), or the operator explicitly re-binds. Lists REAL
 * indexes on the service for "bind to existing"; supports "create new + bind".
 * The full editor surface still renders below this; this is an HONEST gate.
 */
function AiSearchBindPicker({ id, onBound }: { id: string; onBound: () => void }) {
  const s = useStyles();
  const [state, reload] = useApi<{ bound: string | null; service: string | null; indexes: { name: string; fieldCount: number }[]; listError?: string; notDeployed?: boolean }>(
    `/api/items/ai-search-index/${encodeURIComponent(id)}/bind`,
  );
  const [pick, setPick] = useState('');
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ intent: 'success' | 'error'; text: string } | null>(null);

  const bindExisting = async () => {
    if (!pick) { setMsg({ intent: 'error', text: 'Pick an index to bind.' }); return; }
    setBusy(true); setMsg(null);
    const j = await postJson(`/api/items/ai-search-index/${encodeURIComponent(id)}/bind`, { indexName: pick });
    setBusy(false);
    if (!j.ok) setMsg({ intent: 'error', text: j.error || 'Bind failed' });
    else { setMsg({ intent: 'success', text: `Bound to index ${pick}` }); onBound(); }
  };

  const createAndBind = async () => {
    if (!newName) { setMsg({ intent: 'error', text: 'Enter a new index name.' }); return; }
    setBusy(true); setMsg(null);
    const j = await postJson(`/api/items/ai-search-index/${encodeURIComponent(id)}/bind`, { create: true, indexName: newName });
    setBusy(false);
    if (!j.ok) setMsg({ intent: 'error', text: j.error || 'Create failed' });
    else { setMsg({ intent: 'success', text: `Created + bound index ${newName}` }); onBound(); }
  };

  const indexes = state.data?.indexes || [];
  return (
    <div className={s.card}>
      <Subtitle2>Bind this item to an Azure AI Search index</Subtitle2>
      <Caption1>
        A Loom AI Search item maps to one real index on your search service
        {state.data?.service ? <> (<code>{state.data.service}</code>)</> : null}. Pick an existing
        index or create a new one — every tab below then manages that real index.
      </Caption1>
      {state.data?.notDeployed && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Azure AI Search not provisioned</MessageBarTitle>
            {state.data.listError || 'Set LOOM_AI_SEARCH_SERVICE to a deployed Microsoft.Search/searchServices name and grant the Loom UAMI the "Search Index Data Contributor" + "Search Service Contributor" roles (bicep: platform/fiab/bicep/modules/admin-plane/ai-search.bicep).'}
          </MessageBarBody>
        </MessageBar>
      )}
      {state.data?.listError && !state.data?.notDeployed && <ErrorBar msg={state.data.listError} />}
      <div className={s.toolbar} style={{ marginTop: tokens.spacingVerticalS }}>
        <Field label="Existing index">
          <Dropdown value={pick} selectedOptions={pick ? [pick] : []}
            placeholder={state.loading ? 'Loading…' : (indexes.length ? 'Select an index' : 'No indexes on service')}
            onOptionSelect={(_, d) => d.optionValue && setPick(d.optionValue)}>
            {indexes.map((i) => (<Option key={i.name} value={i.name}>{i.name} ({i.fieldCount} fields)</Option>))}
          </Dropdown>
        </Field>
        <Button appearance="primary" disabled={busy || !pick} onClick={bindExisting}>Bind</Button>
        <Button onClick={reload} disabled={busy}>Refresh list</Button>
      </div>
      <div className={s.toolbar}>
        <Field label="Or create new index">
          <Input value={newName} onChange={(_, d) => setNewName(d.value)} placeholder="my-index (lowercase, dashes)" />
        </Field>
        <Button disabled={busy || !newName} onClick={createAndBind}>Create + bind</Button>
      </div>
      {msg && <MessageBar intent={msg.intent}><MessageBarBody>{msg.text}</MessageBarBody></MessageBar>}
    </div>
  );
}

/**
 * PUT a patched index definition (merge `patch` onto `idx`) via the index route
 * the editor uses (navigator by-name OR item route). Returns the parsed JSON.
 */
async function putIndexDefinition(indexBase: string, definition: any): Promise<any> {
  const r = await fetch(indexBase, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ definition }),
  });
  const ct = r.headers.get('content-type') || '';
  return ct.includes('json') ? r.json() : { ok: false, error: `HTTP ${r.status}` };
}

/**
 * Semantic configuration designer — the visual builder for
 * index.semantic.configurations[]. Each config prioritizes a title field, up to
 * 3 content fields, and up to 5 keyword fields (constrained to searchable string
 * fields). Save issues a real PUT /indexes/{name} merging the section onto the
 * live definition. Parity with the portal's "Semantic configurations" pane.
 */
function SemanticConfigDesigner({
  idx, indexBase, onSaved,
}: { idx: any; indexBase: string; onSaved: () => void }) {
  const s = useStyles();
  const eligible = useMemo(() => semanticEligibleFieldNames(idx), [idx]);
  const [configs, setConfigs] = useState<SemanticConfig[]>(() => parseSemanticSection(idx));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ intent: 'success' | 'error'; text: string } | null>(null);

  // Re-sync when the underlying index reloads.
  useEffect(() => { setConfigs(parseSemanticSection(idx)); setDirty(false); setMsg(null); }, [idx]);

  const patch = (i: number, next: SemanticConfig) => {
    setConfigs((cs) => cs.map((c, n) => (n === i ? next : c))); setDirty(true);
  };
  const addConfig = () => {
    setConfigs((cs) => [...cs, { name: `semantic-config-${cs.length + 1}`, prioritizedFields: { prioritizedContentFields: [], prioritizedKeywordsFields: [] } }]);
    setDirty(true);
  };
  const removeConfig = (i: number) => { setConfigs((cs) => cs.filter((_, n) => n !== i)); setDirty(true); };

  const setContentField = (ci: number, slot: number, val: string) => {
    const c = configs[ci];
    const arr = [...(c.prioritizedFields.prioritizedContentFields || [])];
    if (val) arr[slot] = { fieldName: val }; else arr.splice(slot, 1);
    patch(ci, { ...c, prioritizedFields: { ...c.prioritizedFields, prioritizedContentFields: arr.filter((x) => x?.fieldName) } });
  };
  const setKeywordField = (ci: number, slot: number, val: string) => {
    const c = configs[ci];
    const arr = [...(c.prioritizedFields.prioritizedKeywordsFields || [])];
    if (val) arr[slot] = { fieldName: val }; else arr.splice(slot, 1);
    patch(ci, { ...c, prioritizedFields: { ...c.prioritizedFields, prioritizedKeywordsFields: arr.filter((x) => x?.fieldName) } });
  };

  const save = async () => {
    if (configs.some((c) => !c.name.trim())) { setMsg({ intent: 'error', text: 'Every semantic configuration needs a name.' }); return; }
    setSaving(true); setMsg(null);
    const definition = { ...idx, semantic: buildSemanticSection(configs) };
    const j = await putIndexDefinition(indexBase, definition);
    setSaving(false);
    if (!j.ok) setMsg({ intent: 'error', text: j.error || 'Save failed' });
    else { setMsg({ intent: 'success', text: 'Semantic configurations saved (PUT /indexes).' }); setDirty(false); onSaved(); }
  };

  const contentPicker = (ci: number, slot: number, value: string) => (
    <Dropdown size="small" value={value} selectedOptions={value ? [value] : []} placeholder="(none)" aria-label={`semantic-${ci}-content-${slot}`}
      onOptionSelect={(_, d) => setContentField(ci, slot, d.optionValue || '')}>
      <Option value="">(none)</Option>
      {eligible.map((f) => (<Option key={f} value={f}>{f}</Option>))}
    </Dropdown>
  );
  const keywordPicker = (ci: number, slot: number, value: string) => (
    <Dropdown size="small" value={value} selectedOptions={value ? [value] : []} placeholder="(none)" aria-label={`semantic-${ci}-keyword-${slot}`}
      onOptionSelect={(_, d) => setKeywordField(ci, slot, d.optionValue || '')}>
      <Option value="">(none)</Option>
      {eligible.map((f) => (<Option key={f} value={f}>{f}</Option>))}
    </Dropdown>
  );

  return (
    <div className={s.card}>
      <div className={s.toolbar}>
        <Subtitle2>Semantic configurations ({configs.length})</Subtitle2>
        <Button size="small" onClick={addConfig} disabled={!eligible.length}>＋ Add configuration</Button>
      </div>
      <Caption1>
        A semantic configuration ranks results by prioritizing a title, content, and keyword fields for the L2
        semantic re-ranker. Fields are constrained to searchable <code>Edm.String</code> fields. Save issues a real
        PUT /indexes/{idx.name}. (The service is provisioned with <code>semanticSearch: standard</code>.)
      </Caption1>
      {!eligible.length && (
        <MessageBar intent="warning"><MessageBarBody>
          <MessageBarTitle>No searchable string fields</MessageBarTitle>
          Add at least one searchable <code>Edm.String</code> field in the Fields designer before authoring a semantic configuration.
        </MessageBarBody></MessageBar>
      )}
      {eligible.length > 0 && configs.length === 0 && (
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
          No semantic configurations yet. Add one to enable the L2 semantic re-ranker on queries.
        </Caption1>
      )}
      {configs.map((c, ci) => (
        <div key={ci} className={s.card} style={{ marginTop: tokens.spacingVerticalS }}>
          <div className={s.toolbar}>
            <Field label="Name" style={{ minWidth: 220 }}>
              <Input size="small" value={c.name} aria-label={`semantic-${ci}-name`}
                onChange={(_, d) => patch(ci, { ...c, name: d.value })} placeholder="my-semantic-config" />
            </Field>
            <Button size="small" appearance="subtle" onClick={() => removeConfig(ci)} aria-label={`semantic-${ci}-delete`}>Delete</Button>
          </div>
          <div className={s.optGrid}>
            <span>Title field</span>
            <Dropdown size="small" value={c.prioritizedFields.titleField?.fieldName || ''} selectedOptions={c.prioritizedFields.titleField?.fieldName ? [c.prioritizedFields.titleField.fieldName] : []}
              placeholder="(none)" aria-label={`semantic-${ci}-title`}
              onOptionSelect={(_, d) => patch(ci, { ...c, prioritizedFields: { ...c.prioritizedFields, titleField: d.optionValue ? { fieldName: d.optionValue } : undefined } })}>
              <Option value="">(none)</Option>
              {eligible.map((f) => (<Option key={f} value={f}>{f}</Option>))}
            </Dropdown>
            <span>Content fields (up to 3)</span>
            <div style={{ display: 'flex', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap' }}>
              {[0, 1, 2].map((slot) => contentPicker(ci, slot, c.prioritizedFields.prioritizedContentFields?.[slot]?.fieldName || ''))}
            </div>
            <span>Keyword fields (up to 5)</span>
            <div style={{ display: 'flex', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap' }}>
              {[0, 1, 2, 3, 4].map((slot) => keywordPicker(ci, slot, c.prioritizedFields.prioritizedKeywordsFields?.[slot]?.fieldName || ''))}
            </div>
          </div>
        </div>
      ))}
      <div className={s.toolbar} style={{ marginTop: tokens.spacingVerticalS }}>
        <Button appearance="primary" disabled={saving || !dirty} onClick={save}>{saving ? 'Saving…' : 'Save semantic configuration'}</Button>
        {dirty && <Caption1 style={{ color: tokens.colorPaletteRedForeground1 }}>Unsaved changes</Caption1>}
      </div>
      {msg && <MessageBar intent={msg.intent}><MessageBarBody>{msg.text}</MessageBarBody></MessageBar>}
    </div>
  );
}

/**
 * Vector search designer — the visual builder for index.vectorSearch
 * (algorithms[] + profiles[]). Algorithms are hnsw (graph, with m /
 * efConstruction / efSearch / metric) or exhaustiveKnn (brute force, metric
 * only). Profiles bind a name to an algorithm. Save issues a real PUT
 * /indexes/{name}. Parity with the portal's vector-profile authoring.
 */
function VectorSearchDesigner({
  idx, indexBase, onSaved,
}: { idx: any; indexBase: string; onSaved: () => void }) {
  const s = useStyles();
  const parsed = useMemo(() => parseVectorSearchSection(idx), [idx]);
  const [algorithms, setAlgorithms] = useState<VectorAlgorithm[]>(parsed.algorithms);
  const [profiles, setProfiles] = useState<VectorProfile[]>(parsed.profiles);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ intent: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    const p = parseVectorSearchSection(idx);
    setAlgorithms(p.algorithms); setProfiles(p.profiles); setDirty(false); setMsg(null);
  }, [idx]);

  const algoNames = useMemo(() => algorithms.map((a) => a.name).filter(Boolean), [algorithms]);

  const patchAlgo = (i: number, patch: Partial<VectorAlgorithm>) => {
    setAlgorithms((as) => as.map((a, n) => (n === i ? { ...a, ...patch } : a))); setDirty(true);
  };
  const patchHnsw = (i: number, patch: Partial<NonNullable<VectorAlgorithm['hnswParameters']>>) => {
    setAlgorithms((as) => as.map((a, n) => (n === i ? { ...a, hnswParameters: { ...(a.hnswParameters || defaultHnswParameters()), ...patch } } : a))); setDirty(true);
  };
  const addAlgo = () => { setAlgorithms((as) => [...as, { name: `hnsw-${as.length + 1}`, kind: 'hnsw', hnswParameters: defaultHnswParameters() }]); setDirty(true); };
  const removeAlgo = (i: number) => { setAlgorithms((as) => as.filter((_, n) => n !== i)); setDirty(true); };

  const patchProfile = (i: number, patch: Partial<VectorProfile>) => {
    setProfiles((ps) => ps.map((p, n) => (n === i ? { ...p, ...patch } : p))); setDirty(true);
  };
  const addProfile = () => { setProfiles((ps) => [...ps, { name: `profile-${ps.length + 1}`, algorithm: algoNames[0] || '' }]); setDirty(true); };
  const removeProfile = (i: number) => { setProfiles((ps) => ps.filter((_, n) => n !== i)); setDirty(true); };

  const save = async () => {
    if (algorithms.some((a) => !a.name.trim())) { setMsg({ intent: 'error', text: 'Every algorithm needs a name.' }); return; }
    if (profiles.some((p) => !p.name.trim() || !p.algorithm)) { setMsg({ intent: 'error', text: 'Every profile needs a name and an algorithm.' }); return; }
    setSaving(true); setMsg(null);
    const definition = { ...idx, vectorSearch: buildVectorSearchSection(algorithms, profiles) };
    const j = await putIndexDefinition(indexBase, definition);
    setSaving(false);
    if (!j.ok) setMsg({ intent: 'error', text: j.error || 'Save failed' });
    else { setMsg({ intent: 'success', text: 'Vector search config saved (PUT /indexes).' }); setDirty(false); onSaved(); }
  };

  return (
    <div className={s.card}>
      <Subtitle2>Vector search</Subtitle2>
      <Caption1>
        Author vector algorithms + profiles that vector fields bind to (a field's <em>Vector profile</em> in the Fields
        designer must name a profile defined here). <strong>HNSW</strong> is the graph index (fast, approximate);{' '}
        <strong>exhaustiveKnn</strong> is brute-force (exact, slower). Save issues a real PUT /indexes/{idx.name}.
      </Caption1>

      {/* Algorithms */}
      <div className={s.toolbar} style={{ marginTop: tokens.spacingVerticalS }}>
        <Subtitle2 style={{ fontSize: tokens.fontSizeBase300 }}>Algorithms ({algorithms.length})</Subtitle2>
        <Button size="small" onClick={addAlgo}>＋ Add algorithm</Button>
      </div>
      <div className={s.tableWrap}>
        <Table size="small" aria-label="Vector algorithms">
          <TableHeader><TableRow>
            <TableHeaderCell>Name</TableHeaderCell><TableHeaderCell>Kind</TableHeaderCell>
            <TableHeaderCell>m</TableHeaderCell><TableHeaderCell>efConstruction</TableHeaderCell>
            <TableHeaderCell>efSearch</TableHeaderCell><TableHeaderCell>Metric</TableHeaderCell><TableHeaderCell></TableHeaderCell>
          </TableRow></TableHeader>
          <TableBody>
            {algorithms.length === 0 && (
              <TableRow><TableCell colSpan={7}><Caption1 style={{ color: tokens.colorNeutralForeground3 }}>No algorithms — add an HNSW or exhaustiveKnn algorithm to define how vectors are compared.</Caption1></TableCell></TableRow>
            )}
            {algorithms.map((a, i) => {
              const isHnsw = a.kind === 'hnsw';
              const hp = a.hnswParameters || defaultHnswParameters();
              const metric = isHnsw ? hp.metric : (a.exhaustiveKnnParameters?.metric || 'cosine');
              return (
                <TableRow key={i}>
                  <TableCell><Input size="small" value={a.name} aria-label={`algo-${i}-name`} onChange={(_, d) => patchAlgo(i, { name: d.value })} className={s.fdInput} /></TableCell>
                  <TableCell>
                    <Dropdown size="small" value={a.kind} selectedOptions={[a.kind]} aria-label={`algo-${i}-kind`}
                      onOptionSelect={(_, d) => {
                        const kind = (d.optionValue as VectorAlgorithm['kind']) || 'hnsw';
                        patchAlgo(i, kind === 'hnsw'
                          ? { kind, hnswParameters: a.hnswParameters || defaultHnswParameters(), exhaustiveKnnParameters: undefined }
                          : { kind, exhaustiveKnnParameters: { metric: metric as VectorMetric }, hnswParameters: undefined });
                      }}>
                      <Option value="hnsw">hnsw</Option>
                      <Option value="exhaustiveKnn">exhaustiveKnn</Option>
                    </Dropdown>
                  </TableCell>
                  <TableCell>{isHnsw ? <Input size="small" type="number" value={String(hp.m ?? 4)} aria-label={`algo-${i}-m`} className={s.fdNum} onChange={(_, d) => patchHnsw(i, { m: Number(d.value) })} /> : '—'}</TableCell>
                  <TableCell>{isHnsw ? <Input size="small" type="number" value={String(hp.efConstruction ?? 400)} aria-label={`algo-${i}-efc`} className={s.fdNum} onChange={(_, d) => patchHnsw(i, { efConstruction: Number(d.value) })} /> : '—'}</TableCell>
                  <TableCell>{isHnsw ? <Input size="small" type="number" value={String(hp.efSearch ?? 500)} aria-label={`algo-${i}-efs`} className={s.fdNum} onChange={(_, d) => patchHnsw(i, { efSearch: Number(d.value) })} /> : '—'}</TableCell>
                  <TableCell>
                    <Dropdown size="small" value={metric || 'cosine'} selectedOptions={[metric || 'cosine']} aria-label={`algo-${i}-metric`}
                      onOptionSelect={(_, d) => {
                        const mv = (d.optionValue as VectorMetric) || 'cosine';
                        if (isHnsw) patchHnsw(i, { metric: mv });
                        else patchAlgo(i, { exhaustiveKnnParameters: { metric: mv } });
                      }}>
                      {VECTOR_METRICS.map((m) => (<Option key={m} value={m}>{m}</Option>))}
                    </Dropdown>
                  </TableCell>
                  <TableCell><Button size="small" appearance="subtle" onClick={() => removeAlgo(i)} aria-label={`algo-${i}-delete`}>Delete</Button></TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {/* Profiles */}
      <div className={s.toolbar} style={{ marginTop: tokens.spacingVerticalM }}>
        <Subtitle2 style={{ fontSize: tokens.fontSizeBase300 }}>Profiles ({profiles.length})</Subtitle2>
        <Button size="small" onClick={addProfile} disabled={!algoNames.length}>＋ Add profile</Button>
      </div>
      <div className={s.tableWrap}>
        <Table size="small" aria-label="Vector profiles">
          <TableHeader><TableRow>
            <TableHeaderCell>Name</TableHeaderCell><TableHeaderCell>Algorithm</TableHeaderCell><TableHeaderCell></TableHeaderCell>
          </TableRow></TableHeader>
          <TableBody>
            {profiles.length === 0 && (
              <TableRow><TableCell colSpan={3}><Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{algoNames.length ? 'No profiles — add a profile so a vector field can reference an algorithm.' : 'Add an algorithm first, then create a profile that binds to it.'}</Caption1></TableCell></TableRow>
            )}
            {profiles.map((p, i) => (
              <TableRow key={i}>
                <TableCell><Input size="small" value={p.name} aria-label={`profile-${i}-name`} onChange={(_, d) => patchProfile(i, { name: d.value })} className={s.fdInput} /></TableCell>
                <TableCell>
                  <Dropdown size="small" value={p.algorithm} selectedOptions={p.algorithm ? [p.algorithm] : []} placeholder="select algorithm" aria-label={`profile-${i}-algo`}
                    onOptionSelect={(_, d) => patchProfile(i, { algorithm: d.optionValue || '' })}>
                    {algoNames.map((n) => (<Option key={n} value={n}>{n}</Option>))}
                  </Dropdown>
                </TableCell>
                <TableCell><Button size="small" appearance="subtle" onClick={() => removeProfile(i)} aria-label={`profile-${i}-delete`}>Delete</Button></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <div className={s.toolbar} style={{ marginTop: tokens.spacingVerticalS }}>
        <Button appearance="primary" disabled={saving || !dirty} onClick={save}>{saving ? 'Saving…' : 'Save vector config'}</Button>
        {dirty && <Caption1 style={{ color: tokens.colorPaletteRedForeground1 }}>Unsaved changes</Caption1>}
      </div>
      {msg && <MessageBar intent={msg.intent}><MessageBarBody>{msg.text}</MessageBarBody></MessageBar>}
    </div>
  );
}

/**
 * Indexer schedule panel — inline editor for one indexer's recurrence
 * (interval + startTime) and disabled flag. Preset dropdown + custom interval
 * input with validation; Save POSTs { action:'setSchedule' } to the indexers
 * route, which PUTs /indexers/{name} preserving every other property.
 */
function IndexerSchedulePanel({
  route, indexer, initialInterval, initialStartTime, initialDisabled, onSaved,
}: {
  route: string; indexer: string;
  initialInterval?: string; initialStartTime?: string; initialDisabled?: boolean;
  onSaved: () => void;
}) {
  const s = useStyles();
  const presetMatch = SCHEDULE_PRESETS.find((p) => p.interval && p.interval === (initialInterval || '').toUpperCase());
  const [preset, setPreset] = useState<string>(initialInterval ? (presetMatch ? presetMatch.label : 'Custom') : '');
  const [interval, setInterval] = useState(initialInterval || '');
  const [startTime, setStartTime] = useState(initialStartTime || '');
  const [disabled, setDisabled] = useState(!!initialDisabled);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ intent: 'success' | 'error'; text: string } | null>(null);

  const isCustom = preset === 'Custom';
  const effectiveInterval = isCustom ? interval : (SCHEDULE_PRESETS.find((p) => p.label === preset)?.interval || '');

  const save = async (remove: boolean) => {
    setSaving(true); setMsg(null);
    let schedule: { interval: string; startTime?: string } | null = null;
    if (!remove) {
      const err = validateScheduleInterval(effectiveInterval);
      if (err) { setMsg({ intent: 'error', text: err }); setSaving(false); return; }
      schedule = { interval: effectiveInterval.toUpperCase(), ...(startTime ? { startTime } : {}) };
    }
    const j = await postJson(route, { action: 'setSchedule', indexer, schedule, disabled });
    setSaving(false);
    if (!j.ok) setMsg({ intent: 'error', text: j.error || 'Save failed' });
    else { setMsg({ intent: 'success', text: remove ? 'Schedule removed.' : 'Schedule saved (PUT /indexers).' }); onSaved(); }
  };

  return (
    <div className={s.card} style={{ marginTop: tokens.spacingVerticalS }}>
      <Subtitle2 style={{ fontSize: tokens.fontSizeBase300 }}>Schedule — {indexer}</Subtitle2>
      <div className={s.optGrid}>
        <span>Recurrence</span>
        <Dropdown size="small" value={preset || '(no schedule)'} selectedOptions={preset ? [preset] : ['']} placeholder="(no schedule)" aria-label={`schedule-${indexer}-preset`}
          onOptionSelect={(_, d) => {
            const label = d.optionValue || '';
            setPreset(label);
            const p = SCHEDULE_PRESETS.find((x) => x.label === label);
            if (p && p.interval) setInterval(p.interval);
            else if (!label) setInterval('');
          }}>
          <Option value="" text="(no schedule)">(no schedule)</Option>
          {SCHEDULE_PRESETS.map((p) => (<Option key={p.label} value={p.label}>{p.label}</Option>))}
        </Dropdown>
        {isCustom && (
          <>
            <span>Custom interval (ISO-8601)</span>
            <Input size="small" value={interval} aria-label={`schedule-${indexer}-interval`} placeholder="PT2H · PT30M · P1D"
              onChange={(_, d) => setInterval(d.value)} />
          </>
        )}
        <span>Start time (UTC, optional)</span>
        <Input size="small" value={startTime} aria-label={`schedule-${indexer}-start`} placeholder="2026-01-01T00:00:00Z"
          onChange={(_, d) => setStartTime(d.value)} />
        <span>Paused</span>
        <Checkbox checked={disabled} aria-label={`schedule-${indexer}-disabled`} label="Disable this indexer (no runs)"
          onChange={(_, d) => setDisabled(!!d.checked)} />
      </div>
      <Caption1>
        Min 5 minutes (PT5M), max 24 hours (P1D). On a schedule the indexer runs automatically; pausing keeps the
        definition but stops runs. Saved via PUT /indexers/{indexer}.
      </Caption1>
      <div className={s.toolbar} style={{ marginTop: tokens.spacingVerticalS }}>
        <Button size="small" appearance="primary" disabled={saving} onClick={() => save(false)}>{saving ? 'Saving…' : 'Save schedule'}</Button>
        <Button size="small" disabled={saving} onClick={() => save(true)}>Remove schedule</Button>
      </div>
      {msg && <MessageBar intent={msg.intent}><MessageBarBody>{msg.text}</MessageBarBody></MessageBar>}
    </div>
  );
}

export function AiSearchIndexEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const isNew = id === 'new' || id === 'create';

  // Navigator-selected index (by real name, service-scoped). When set, the
  // editor surfaces THAT index — independent of any Loom item binding — so the
  // left service navigator behaves like clicking an index in the portal.
  const [navIndex, setNavIndex] = useState<string | null>(null);
  const [treeRefresh, setTreeRefresh] = useState(0);

  // Catalog list mode (no specific item) — list every index on the service.
  const [list, reloadList] = useApi<{ indexes: any[] }>(isNew && !navIndex ? '/api/items/ai-search-index' : null);

  // Navigator detail — resolve the selected index by NAME (def + stats).
  const [navDetail, reloadNavDetail] = useApi<{ index: any; stats?: any }>(
    navIndex ? `/api/ai-search/indexes/${encodeURIComponent(navIndex)}` : null, [navIndex],
  );

  // Item mode — resolve the bound index (def + stats). 412 → unbound → picker.
  const [itemDetail, reloadItemDetail] = useApi<{ index: any; stats?: any; boundTo?: string; code?: string }>(
    isNew || navIndex ? null : `/api/items/ai-search-index/${encodeURIComponent(id)}`, [id],
  );

  // Active detail = navigator selection wins, else the bound item.
  const detail = navIndex ? navDetail : itemDetail;
  const reloadDetail = navIndex ? reloadNavDetail : reloadItemDetail;

  // The route used for index-scoped actions (search/analyze/schema/indexers).
  // Navigator mode hits the by-name service routes; item mode the item routes.
  const indexBase = navIndex
    ? `/api/ai-search/indexes/${encodeURIComponent(navIndex)}`
    : `/api/items/ai-search-index/${encodeURIComponent(id)}`;

  const [tab, setTab] = useState<'schema' | 'search' | 'stats' | 'indexers'>('schema');

  // Search/query state.
  const [search, setSearch] = useState('*');
  const [filter, setFilter] = useState('');
  const [select, setSelect] = useState('');
  const [top, setTop] = useState(25);
  const [hits, setHits] = useState<any>(null);
  const [searching, setSearching] = useState(false);

  // Search Explorer — query options (parity with the portal's search-explorer pane).
  const [queryType, setQueryType] = useState<'simple' | 'full' | 'semantic'>('simple');
  const [semanticConfig, setSemanticConfig] = useState('');
  const [searchFields, setSearchFields] = useState('');
  const [orderby, setOrderby] = useState('');
  const [countOn, setCountOn] = useState(true);
  const [answersOn, setAnswersOn] = useState(false);
  const [captionsOn, setCaptionsOn] = useState(false);
  // Vector-query builder rows.
  const [vectorQueries, setVectorQueries] = useState<VectorQuery[]>([]);
  // Search Explorer — extra portal-parity options.
  const [searchMode, setSearchMode] = useState<'any' | 'all'>('any');
  const [scoringProfile, setScoringProfile] = useState('');
  const [scoringParameters, setScoringParameters] = useState(''); // newline-separated "name-v1,v2"
  const [selectedFacets, setSelectedFacets] = useState<string[]>([]);
  const [highlightFields, setHighlightFields] = useState(''); // comma-separated searchable fields
  const [highlightPreTag, setHighlightPreTag] = useState('<em>');
  const [highlightPostTag, setHighlightPostTag] = useState('</em>');
  // Last request body actually sent (raw-JSON view).
  const [lastQueryBody, setLastQueryBody] = useState<any>(null);

  // Field designer (visual per-field grid) state.
  const [fieldRows, setFieldRows] = useState<FieldRow[]>([]);
  const [fieldsDirty, setFieldsDirty] = useState(false);
  const [savingFields, setSavingFields] = useState(false);
  const [fieldsMsg, setFieldsMsg] = useState<{ intent: 'success' | 'error'; text: string } | null>(null);

  // Analyze state.
  const [analyzeTxt, setAnalyzeTxt] = useState('');
  const [analyzer, setAnalyzer] = useState('standard.lucene');
  const [analyzeRes, setAnalyzeRes] = useState<any>(null);

  // Schema-edit state.
  const [schemaText, setSchemaText] = useState('');
  const [schemaDirty, setSchemaDirty] = useState(false);
  const [savingSchema, setSavingSchema] = useState(false);
  const [schemaMsg, setSchemaMsg] = useState<{ intent: 'success' | 'error'; text: string } | null>(null);

  // Indexers state.
  const [indexerData, setIndexerData] = useState<any>(null);
  const [indexersLoading, setIndexersLoading] = useState(false);
  // Which indexer's schedule panel is expanded (by name).
  const [scheduleEditFor, setScheduleEditFor] = useState<string | null>(null);

  const idx = detail.data?.index;
  const fields: any[] = idx?.fields || [];
  const semanticConfigs = useMemo(() => semanticConfigNames(idx), [idx]);
  const vectorProfiles = useMemo(() => vectorProfileNames(idx), [idx]);
  const scoringProfiles = useMemo(() => scoringProfileNames(idx), [idx]);
  const facetableFields = useMemo(() => facetableFieldNames(idx), [idx]);
  // Searchable, non-vector string fields are the only valid highlight targets.
  const highlightableFields = useMemo(
    () => fields.filter((f) => f.searchable && /Edm\.String/.test(f.type || '') && !isVectorFieldType(f.type)).map((f) => f.name),
    [fields],
  );
  // Vector field names — the only valid targets for a vector query's `fields`.
  const vectorFieldNames = useMemo(
    () => fields.filter((f) => isVectorFieldType(f.type)).map((f) => f.name),
    [fields],
  );

  useEffect(() => {
    if (idx) {
      setSchemaText(JSON.stringify(idx, null, 2));
      setSchemaDirty(false);
      setFieldRows((idx.fields || []).map(apiFieldToRow));
      setFieldsDirty(false);
      setFieldsMsg(null);
    }
  }, [idx]);

  // Default the semantic-config picker to the first config once one is known.
  useEffect(() => {
    if (semanticConfigs.length && !semanticConfig) setSemanticConfig(semanticConfigs[0]);
  }, [semanticConfigs, semanticConfig]);

  // Toggle a facetable field in/out of the selected facets set.
  const toggleFacet = (name: string, on: boolean) =>
    setSelectedFacets((prev) => (on ? [...new Set([...prev, name])] : prev.filter((f) => f !== name)));

  const ribbon = useMemo(() => {
    const armId = idx?.id || idx?.armId;
    const portalUrl = armId
      ? `https://portal.azure.com/#@/resource${armId}/overview`
      : 'https://portal.azure.com/';
    return buildBaseRibbon(isNew ? reloadList : reloadDetail, portalUrl);
  }, [isNew, reloadList, reloadDetail, idx]);

  const runSearch = async () => {
    setSearching(true); setHits(null);
    // Assemble the full query-options payload. Only meaningful fields are sent;
    // semantic params ride along only on a semantic query (the BFF + the client's
    // buildSearchBody enforce the same rule).
    const payload: Record<string, unknown> = {
      search,
      filter: filter || undefined,
      select: select || undefined,
      searchFields: searchFields || undefined,
      orderby: orderby || undefined,
      top,
      queryType,
      searchMode,
      count: countOn,
    };
    if (queryType === 'semantic') {
      if (semanticConfig) payload.semanticConfiguration = semanticConfig;
      if (answersOn) payload.answers = 'extractive';
      if (captionsOn) payload.captions = 'extractive';
    }
    // Faceting — only facetable fields are valid targets (server still validates).
    if (selectedFacets.length) payload.facets = selectedFacets;
    // Scoring profile + its function inputs (one "name-v1,v2" per non-empty line).
    if (scoringProfile) {
      payload.scoringProfile = scoringProfile;
      const params = scoringParameters.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      if (params.length) payload.scoringParameters = params;
    }
    // Hit highlighting (with optional custom tags — only sent when non-default).
    if (highlightFields.trim()) {
      payload.highlight = highlightFields.trim();
      if (highlightPreTag && highlightPreTag !== '<em>') payload.highlightPreTag = highlightPreTag;
      if (highlightPostTag && highlightPostTag !== '</em>') payload.highlightPostTag = highlightPostTag;
    }
    // Only emit vector queries that name a field (k-NN needs a parsed vector; text
    // uses integrated vectorization). Empty/invalid rows are dropped at the wire.
    const vq = vectorQueries
      .filter((v) => v.fields && v.fields.trim())
      .map((v) => {
        const out: VectorQuery = { kind: v.kind, fields: v.fields.trim(), k: v.k };
        if (v.kind === 'text') out.text = v.text || '';
        else out.vector = v.vector || [];
        return out;
      })
      .filter((v) => (v.kind === 'text' ? !!v.text : Array.isArray(v.vector) && v.vector.length > 0));
    if (vq.length) payload.vectorQueries = vq;
    setLastQueryBody(payload);
    const j = await postJson(`${indexBase}/search`, payload);
    setHits(j); setSearching(false);
  };

  // ---- Vector-query builder row helpers ----
  const addVectorQuery = () =>
    setVectorQueries((rows) => [
      ...rows,
      { kind: 'text', fields: vectorFieldNames[0] || '', text: '', k: 5 },
    ]);
  const updateVectorQuery = (i: number, patch: Partial<VectorQuery>) =>
    setVectorQueries((rows) => rows.map((r, n) => (n === i ? { ...r, ...patch } : r)));
  const removeVectorQuery = (i: number) =>
    setVectorQueries((rows) => rows.filter((_, n) => n !== i));

  // ---- Field-designer grid helpers ----
  const patchFieldRow = (i: number, patch: Partial<FieldRow>) => {
    setFieldRows((rows) => rows.map((r, n) => (n === i ? { ...r, ...patch } : r)));
    setFieldsDirty(true);
  };
  const addFieldRow = () => {
    setFieldRows((rows) => [
      ...rows,
      { name: '', type: 'Edm.String', searchable: true, retrievable: true },
    ]);
    setFieldsDirty(true);
  };
  const removeFieldRow = (i: number) => {
    setFieldRows((rows) => rows.filter((_, n) => n !== i));
    setFieldsDirty(true);
  };

  // Save the visual field grid → real PUT /indexes/{name} via the same route the
  // JSON editor uses. We merge the rows onto the live definition so vectorSearch /
  // semantic / scoringProfiles survive the round-trip.
  const saveFields = async () => {
    if (!fieldRows.length) { setFieldsMsg({ intent: 'error', text: 'An index needs at least one field.' }); return; }
    if (!fieldRows.some((f) => f.key)) { setFieldsMsg({ intent: 'error', text: 'Exactly one field must be the key (Edm.String).' }); return; }
    if (fieldRows.some((f) => !f.name.trim())) { setFieldsMsg({ intent: 'error', text: 'Every field needs a name.' }); return; }
    const definition = applyFieldRows(idx, fieldRows);
    setSavingFields(true); setFieldsMsg(null);
    const r = await fetch(indexBase, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ definition }),
    });
    const ct = r.headers.get('content-type') || '';
    const j = ct.includes('json') ? await r.json() : { ok: false, error: `HTTP ${r.status}` };
    setSavingFields(false);
    if (!j.ok) setFieldsMsg({ intent: 'error', text: j.error || `HTTP ${r.status}` });
    else {
      setFieldsMsg({ intent: 'success', text: 'Index fields saved (PUT /indexes).' });
      setFieldsDirty(false); reloadDetail(); setTreeRefresh((n) => n + 1);
    }
  };

  const runAnalyze = async () => {
    setAnalyzeRes(null);
    const j = await postJson(`${indexBase}/analyze`, { text: analyzeTxt, analyzer });
    setAnalyzeRes(j);
  };

  const saveSchema = async () => {
    let definition: any;
    try { definition = JSON.parse(schemaText); } catch (e: any) { setSchemaMsg({ intent: 'error', text: `Invalid JSON: ${e?.message}` }); return; }
    setSavingSchema(true); setSchemaMsg(null);
    // Navigator mode PUTs the by-name index route; item mode PUTs the item route.
    const r = await fetch(indexBase, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ definition }),
    });
    const ct = r.headers.get('content-type') || '';
    const j = ct.includes('json') ? await r.json() : { ok: false, error: `HTTP ${r.status}` };
    setSavingSchema(false);
    if (!j.ok) setSchemaMsg({ intent: 'error', text: j.error || `HTTP ${r.status}` });
    else { setSchemaMsg({ intent: 'success', text: 'Index definition updated.' }); setSchemaDirty(false); reloadDetail(); setTreeRefresh((n) => n + 1); }
  };

  const loadIndexers = useCallback(async () => {
    setIndexersLoading(true);
    // Navigator mode lists the whole service's indexers; item mode scopes to the bound index.
    const url = navIndex ? '/api/ai-search/indexers' : `/api/items/ai-search-index/${encodeURIComponent(id)}/indexers`;
    const r = await fetch(url);
    const ct = r.headers.get('content-type') || '';
    setIndexerData(ct.includes('json') ? await r.json() : { ok: false, error: `HTTP ${r.status}` });
    setIndexersLoading(false);
  }, [id, navIndex]);

  // reload indexers whenever the tab is active and the active index changes
  useEffect(() => { if (tab === 'indexers' && idx) loadIndexers(); }, [tab, idx, loadIndexers]);

  // The route that owns indexer lifecycle + schedule actions for the active index.
  const indexersRoute = navIndex ? '/api/ai-search/indexers' : `/api/items/ai-search-index/${encodeURIComponent(id)}/indexers`;

  const indexerAction = async (action: 'run' | 'reset', indexer: string) => {
    await postJson(indexersRoute, { action, indexer });
    loadIndexers();
  };

  // The AI Search service navigator — always the left pane (parity with the
  // ADF / Synapse / Databricks resource trees). Selecting an index opens it
  // by name in this editor; ＋ New per group creates real objects via REST.
  const serviceTree = (
    <AiSearchServiceTree
      selectedIndex={navIndex}
      refreshKey={treeRefresh}
      onOpenIndex={(name) => { setNavIndex(name); setTab('schema'); setHits(null); setAnalyzeRes(null); setIndexerData(null); }}
      onNewIndex={() => { setNavIndex(null); /* fall back to the create dialog within the tree */ }}
    />
  );
  const chrome = (main: ReactNode) => (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon} leftPanel={serviceTree} main={main} />
  );

  // -------- Catalog list mode (no item, no navigator selection) --------
  if (isNew && !navIndex) {
    return chrome(
      <div className={s.pad}>
        <Subtitle2>Azure AI Search indexes</Subtitle2>
        <Caption1>Pick an index from the service navigator on the left to manage its schema, run queries, and drive its indexers — or use ＋ New to create indexes, indexers, data sources, skillsets, synonym maps and aliases.</Caption1>
        {list.loading ? <Spinner size="small" /> : list.error ? <ErrorBar msg={list.error} hint={list.hint} notDeployed={list.notDeployed} /> : (
          <div className={s.tableWrap}>
            <Table size="small">
              <TableHeader><TableRow><TableHeaderCell>Name</TableHeaderCell><TableHeaderCell>Fields</TableHeaderCell><TableHeaderCell>Vector</TableHeaderCell></TableRow></TableHeader>
              <TableBody>
                {(list.data?.indexes || []).map((i: any) => (
                  <TableRow key={i.name} onClick={() => { setNavIndex(i.name); setTab('schema'); }} style={{ cursor: 'pointer' }}>
                    <TableCell className={s.cell}><strong>{i.name}</strong></TableCell>
                    <TableCell className={s.cell}>{i.fieldCount ?? (i.fields || []).length}</TableCell>
                    <TableCell className={s.cell}>{i.vectorEnabled ? <Badge color="brand">vector</Badge> : ''}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    );
  }

  // -------- Item mode: unbound / not-deployed → bind picker (full UI gate) --------
  // (skipped entirely in navigator mode — the navigator selected a real index by name)
  const unbound = !navIndex && detail.error && (detail as any).data == null && (detail.notDeployed || /not bound|unbound/i.test(detail.error || '') || (detail as any).code === 'unbound');
  if (!navIndex && !detail.loading && (unbound || detail.notDeployed)) {
    return chrome(
      <div className={s.pad}>
        <Subtitle2>{item.displayName} — AI Search index</Subtitle2>
        <AiSearchBindPicker id={id} onBound={reloadDetail} />
      </div>
    );
  }

  const docs: any[] = hits?.ok ? (hits.result?.value || []) : [];
  const facets: Record<string, any[]> = hits?.ok ? (hits.result?.['@search.facets'] || {}) : {};
  const totalCount = hits?.ok ? hits.result?.['@odata.count'] : undefined;
  const answers: any[] = hits?.ok ? (hits.result?.['@search.answers'] || []) : [];
  const hasReranker = docs.some((d) => d?.['@search.rerankerScore'] !== undefined);
  const hasHighlights = docs.some((d) => d?.['@search.highlights'] && Object.keys(d['@search.highlights']).length);
  const retrievable = fields.filter((f) => f.retrievable !== false).slice(0, 6);

  return chrome(
    <div className={s.pad}>
      {detail.loading ? <Spinner size="small" /> : detail.error ? (
        <>
          <ErrorBar msg={detail.error} hint={detail.hint} notDeployed={detail.notDeployed} />
          {!navIndex && <AiSearchBindPicker id={id} onBound={reloadDetail} />}
        </>
      ) : idx && (
        <>
          <div className={s.toolbar}>
            <Subtitle2>Index: {idx.name}</Subtitle2>
            {idx.vectorSearch && <Badge color="brand">vector</Badge>}
            {idx.semantic && <Badge color="success">semantic</Badge>}
            {(detail.data as any)?.source === 'bundle' && <Badge color="warning">bundle template</Badge>}
          </div>

          {/* Bundle-installed index: the full schema renders below from the
              stamped definition. It isn't bound to a real index on the service
              yet — surface the honest bind picker so the operator can create +
              bind it (PUT /indexes) and make search/stats/indexers live. */}
          {(detail.data as any)?.source === 'bundle' && !navIndex && (
            <>
              <MessageBar intent="warning">
                <MessageBarBody>
                  <MessageBarTitle>Template — not yet bound to a live index</MessageBarTitle>
                  This index opens from its installed bundle definition (schema + scoring profiles + vector config below).
                  Create &amp; bind it to a real Azure AI Search index to enable Search, Statistics, and Indexers against live data.
                </MessageBarBody>
              </MessageBar>
              <AiSearchBindPicker id={id} onBound={reloadDetail} />
            </>
          )}

          <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as typeof tab)}>
            <Tab value="schema">Schema ({fields.length})</Tab>
            <Tab value="search">Search</Tab>
            <Tab value="stats">Statistics</Tab>
            <Tab value="indexers">Indexers</Tab>
          </TabList>

          {/* ---- Schema tab: visual field designer (portal per-field grid) ---- */}
          {tab === 'schema' && (
            <>
              <div className={s.card}>
                <div className={s.toolbar}>
                  <Subtitle2>Fields ({fieldRows.length})</Subtitle2>
                  <Button size="small" onClick={addFieldRow}>＋ Add field</Button>
                </div>
                <Caption1>Edit fields visually — add/remove rows, set the type, key, the searchable/filterable/sortable/facetable/retrievable attributes, an analyzer (string fields), or dimensions + vector profile (vector fields). Save issues a real PUT /indexes/{idx.name}. Azure rejects breaking changes on a populated index (add new fields rather than retyping existing ones).</Caption1>
                <div className={s.tableWrap}>
                  <Table size="small" aria-label="Index field designer">
                    <TableHeader>
                      <TableRow>
                        <TableHeaderCell>Name</TableHeaderCell><TableHeaderCell>Type</TableHeaderCell>
                        <TableHeaderCell>Key</TableHeaderCell><TableHeaderCell>Searchable</TableHeaderCell>
                        <TableHeaderCell>Filterable</TableHeaderCell><TableHeaderCell>Sortable</TableHeaderCell>
                        <TableHeaderCell>Facetable</TableHeaderCell><TableHeaderCell>Retrievable</TableHeaderCell>
                        <TableHeaderCell>Analyzer / Vector</TableHeaderCell><TableHeaderCell></TableHeaderCell>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {fieldRows.map((f, i) => {
                        const vector = isVectorFieldType(f.type);
                        return (
                          <TableRow key={i}>
                            <TableCell className={s.cell}>
                              <Input size="small" className={s.fdInput} value={f.name} aria-label={`field-${i}-name`}
                                onChange={(_, d) => patchFieldRow(i, { name: d.value })} placeholder="field name" />
                            </TableCell>
                            <TableCell className={s.cell}>
                              <Dropdown size="small" className={s.fdInput} value={f.type} selectedOptions={[f.type]} aria-label={`field-${i}-type`}
                                onOptionSelect={(_, d) => d.optionValue && patchFieldRow(i, { type: d.optionValue })}>
                                {FIELD_TYPES.map((t) => (<Option key={t} value={t}>{t}</Option>))}
                              </Dropdown>
                            </TableCell>
                            <TableCell className={s.cell}>
                              <Checkbox checked={!!f.key} aria-label={`field-${i}-key`}
                                onChange={(_, d) => patchFieldRow(i, { key: !!d.checked, type: d.checked ? 'Edm.String' : f.type })} />
                            </TableCell>
                            <TableCell className={s.cell}>
                              <Checkbox checked={!!f.searchable} aria-label={`field-${i}-searchable`}
                                onChange={(_, d) => patchFieldRow(i, { searchable: !!d.checked })} />
                            </TableCell>
                            <TableCell className={s.cell}>
                              <Checkbox checked={!vector && !!f.filterable} disabled={vector} aria-label={`field-${i}-filterable`}
                                onChange={(_, d) => patchFieldRow(i, { filterable: !!d.checked })} />
                            </TableCell>
                            <TableCell className={s.cell}>
                              <Checkbox checked={!vector && !!f.sortable} disabled={vector} aria-label={`field-${i}-sortable`}
                                onChange={(_, d) => patchFieldRow(i, { sortable: !!d.checked })} />
                            </TableCell>
                            <TableCell className={s.cell}>
                              <Checkbox checked={!vector && !!f.facetable} disabled={vector} aria-label={`field-${i}-facetable`}
                                onChange={(_, d) => patchFieldRow(i, { facetable: !!d.checked })} />
                            </TableCell>
                            <TableCell className={s.cell}>
                              <Checkbox checked={f.retrievable !== false} disabled={!!f.key} aria-label={`field-${i}-retrievable`}
                                onChange={(_, d) => patchFieldRow(i, { retrievable: !!d.checked })} />
                            </TableCell>
                            <TableCell className={s.cell}>
                              {vector ? (
                                <div className={s.toolbar} style={{ gap: tokens.spacingHorizontalXS }}>
                                  <Input size="small" type="number" className={s.fdNum} aria-label={`field-${i}-dimensions`}
                                    value={f.dimensions != null ? String(f.dimensions) : ''} placeholder="dims"
                                    onChange={(_, d) => patchFieldRow(i, { dimensions: d.value ? Number(d.value) : undefined })} />
                                  <Dropdown size="small" className={s.fdInput} aria-label={`field-${i}-profile`}
                                    value={f.vectorSearchProfile || ''} selectedOptions={f.vectorSearchProfile ? [f.vectorSearchProfile] : []}
                                    placeholder={vectorProfiles.length ? 'profile' : 'no profiles'}
                                    onOptionSelect={(_, d) => d.optionValue && patchFieldRow(i, { vectorSearchProfile: d.optionValue })}>
                                    {vectorProfiles.map((p) => (<Option key={p} value={p}>{p}</Option>))}
                                  </Dropdown>
                                </div>
                              ) : (
                                <Dropdown size="small" className={s.fdInput} aria-label={`field-${i}-analyzer`}
                                  value={f.analyzer || ''} selectedOptions={f.analyzer ? [f.analyzer] : []}
                                  disabled={!f.searchable} placeholder={f.searchable ? '(default)' : 'n/a'}
                                  onOptionSelect={(_, d) => patchFieldRow(i, { analyzer: d.optionValue || undefined })}>
                                  <Option value="">(default)</Option>
                                  {ANALYZERS.map((a) => (<Option key={a} value={a}>{a}</Option>))}
                                </Dropdown>
                              )}
                            </TableCell>
                            <TableCell>
                              <Button size="small" appearance="subtle" onClick={() => removeFieldRow(i)} aria-label={`field-${i}-delete`}>Delete</Button>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
                <div className={s.toolbar} style={{ marginTop: tokens.spacingVerticalS }}>
                  <Button appearance="primary" disabled={savingFields || !fieldsDirty} onClick={saveFields}>{savingFields ? 'Saving…' : 'Save fields'}</Button>
                  <Button disabled={!fieldsDirty} onClick={() => { setFieldRows((idx.fields || []).map(apiFieldToRow)); setFieldsDirty(false); setFieldsMsg(null); }}>Revert</Button>
                  {fieldsDirty && <Caption1 style={{ color: tokens.colorPaletteRedForeground1 }}>Unsaved changes</Caption1>}
                </div>
                {fieldsMsg && <MessageBar intent={fieldsMsg.intent}><MessageBarBody>{fieldsMsg.text}</MessageBarBody></MessageBar>}
              </div>

              {/* Vector search designer — visual builder for index.vectorSearch
                  (algorithms + profiles). Gated on the index having a vector field. */}
              {indexHasVectorField(idx) ? (
                <VectorSearchDesigner idx={idx} indexBase={indexBase} onSaved={() => { reloadDetail(); setTreeRefresh((n) => n + 1); }} />
              ) : (
                <div className={s.card}>
                  <Subtitle2>Vector search</Subtitle2>
                  <MessageBar intent="info"><MessageBarBody>
                    Add a vector field (<code>Collection(Edm.Single)</code> with dimensions) in the Fields designer to author
                    vector algorithms and profiles here.
                  </MessageBarBody></MessageBar>
                </div>
              )}

              {/* Semantic configuration designer — visual builder for index.semantic.configurations[]. */}
              <SemanticConfigDesigner idx={idx} indexBase={indexBase} onSaved={() => { reloadDetail(); setTreeRefresh((n) => n + 1); }} />

              {/* Advanced fallback: full definition JSON (vectorSearch / semantic /
                  scoringProfiles / analyzers authored here, round-trips with the grid). */}
              <div className={s.card}>
                <Subtitle2>Advanced — full definition (JSON)</Subtitle2>
                <Caption1>The complete index definition, including vectorSearch profiles/algorithms, semantic configurations, scoring profiles and custom analyzers. Save issues a real PUT /indexes/{idx.name}.</Caption1>
                <MonacoTextarea value={schemaText} onChange={(v) => { setSchemaText(v); setSchemaDirty(true); }} language="json" minHeight={260} />
                <div className={s.toolbar} style={{ marginTop: tokens.spacingVerticalS }}>
                  <Button appearance="primary" disabled={savingSchema || !schemaDirty} onClick={saveSchema}>{savingSchema ? 'Saving…' : 'Save definition'}</Button>
                  <Button onClick={() => { setSchemaText(JSON.stringify(idx, null, 2)); setSchemaDirty(false); setSchemaMsg(null); }} disabled={!schemaDirty}>Revert</Button>
                  {schemaDirty && <Caption1 style={{ color: tokens.colorPaletteRedForeground1 }}>Unsaved changes</Caption1>}
                </div>
                {schemaMsg && <MessageBar intent={schemaMsg.intent}><MessageBarBody>{schemaMsg.text}</MessageBarBody></MessageBar>}
              </div>
            </>
          )}

          {/* ---- Search tab: full search explorer (query options + vector + raw JSON) ---- */}
          {tab === 'search' && (
            <>
              <div className={s.card}>
                <Subtitle2>Query</Subtitle2>
                <div className={s.optGrid}>
                  <span>Query type</span>
                  <Dropdown value={queryType} selectedOptions={[queryType]} aria-label="queryType"
                    onOptionSelect={(_, d) => d.optionValue && setQueryType(d.optionValue as typeof queryType)}>
                    <Option value="simple">simple</Option>
                    <Option value="full">full (Lucene)</Option>
                    <Option value="semantic">semantic</Option>
                  </Dropdown>

                  <span>Search text</span><Input value={search} onChange={(_, d) => setSearch(d.value)} placeholder="* (match all)" />

                  {queryType === 'semantic' && (
                    <>
                      <span>Semantic config</span>
                      {semanticConfigs.length ? (
                        <Dropdown value={semanticConfig} selectedOptions={semanticConfig ? [semanticConfig] : []} aria-label="semanticConfiguration"
                          placeholder="select a semantic configuration"
                          onOptionSelect={(_, d) => d.optionValue && setSemanticConfig(d.optionValue)}>
                          {semanticConfigs.map((c) => (<Option key={c} value={c}>{c}</Option>))}
                        </Dropdown>
                      ) : (
                        <Input value={semanticConfig} aria-label="semanticConfiguration"
                          onChange={(_, d) => setSemanticConfig(d.value)} placeholder="no semantic config on this index — name one" />
                      )}
                      <span>Answers / Captions</span>
                      <div className={s.toolbar} style={{ gap: tokens.spacingHorizontalL }}>
                        <Checkbox label="answers (extractive)" checked={answersOn} onChange={(_, d) => setAnswersOn(!!d.checked)} />
                        <Checkbox label="captions (extractive)" checked={captionsOn} onChange={(_, d) => setCaptionsOn(!!d.checked)} />
                      </div>
                    </>
                  )}

                  <span>Search mode</span>
                  <Dropdown value={searchMode} selectedOptions={[searchMode]} aria-label="searchMode"
                    onOptionSelect={(_, d) => d.optionValue && setSearchMode(d.optionValue as 'any' | 'all')}>
                    <Option value="any">any (OR terms)</Option>
                    <Option value="all">all (AND terms)</Option>
                  </Dropdown>

                  <span>Search fields</span><Input value={searchFields} onChange={(_, d) => setSearchFields(d.value)} placeholder="comma,separated (blank = all searchable)" />
                  <span>Filter (OData)</span><Input value={filter} onChange={(_, d) => setFilter(d.value)} placeholder="e.g. category eq 'docs'" />
                  <span>Select fields</span><Input value={select} onChange={(_, d) => setSelect(d.value)} placeholder="comma,separated (blank = all)" />
                  <span>Order by</span><Input value={orderby} onChange={(_, d) => setOrderby(d.value)} placeholder="e.g. created desc" />
                  <span>Top</span><Input type="number" value={String(top)} onChange={(_, d) => setTop(Number(d.value) || 25)} />
                  <span>Count</span><Checkbox label="return total match count" checked={countOn} onChange={(_, d) => setCountOn(!!d.checked)} />

                  <span>Scoring profile</span>
                  {scoringProfiles.length ? (
                    <Dropdown value={scoringProfile || '(none)'} selectedOptions={scoringProfile ? [scoringProfile] : ['(none)']} aria-label="scoringProfile"
                      onOptionSelect={(_, d) => setScoringProfile(d.optionValue === '(none)' ? '' : (d.optionValue || ''))}>
                      <Option value="(none)">(default ranking)</Option>
                      {scoringProfiles.map((p) => (<Option key={p} value={p}>{p}</Option>))}
                    </Dropdown>
                  ) : (
                    <Caption1>No scoring profiles on this index (author one in the Schema → Advanced JSON).</Caption1>
                  )}
                  {scoringProfile && (
                    <>
                      <span>Scoring parameters</span>
                      <Textarea value={scoringParameters} onChange={(_, d) => setScoringParameters(d.value)} rows={2}
                        placeholder={'one per line, e.g.\nmylocation--122.2,44.8'} aria-label="scoringParameters" />
                    </>
                  )}

                  <span>Highlight fields</span>
                  <Input value={highlightFields} onChange={(_, d) => setHighlightFields(d.value)} aria-label="highlight"
                    placeholder={highlightableFields.length ? `comma,separated (e.g. ${highlightableFields.slice(0, 2).join(',')}; suffix -N to cap)` : 'no searchable string fields'} />
                  {highlightFields.trim() && (
                    <>
                      <span>Highlight tags</span>
                      <div className={s.toolbar} style={{ gap: tokens.spacingHorizontalS }}>
                        <Input value={highlightPreTag} onChange={(_, d) => setHighlightPreTag(d.value)} aria-label="highlightPreTag" placeholder="<em>" style={{ maxWidth: 120 }} />
                        <Input value={highlightPostTag} onChange={(_, d) => setHighlightPostTag(d.value)} aria-label="highlightPostTag" placeholder="</em>" style={{ maxWidth: 120 }} />
                      </div>
                    </>
                  )}
                </div>

                {/* Faceting — pick facetable fields to bucket results by. */}
                {facetableFields.length > 0 && (
                  <div style={{ marginTop: tokens.spacingVerticalS }}>
                    <Caption1><strong>Facets</strong> — bucket results by a facetable field (returned under <code>@search.facets</code>).</Caption1>
                    <div className={s.toolbar} style={{ gap: tokens.spacingHorizontalM, flexWrap: 'wrap' }}>
                      {facetableFields.map((f) => (
                        <Checkbox key={f} label={f} checked={selectedFacets.includes(f)}
                          aria-label={`facet-${f}`} onChange={(_, d) => toggleFacet(f, !!d.checked)} />
                      ))}
                    </div>
                  </div>
                )}

                {/* Vector-query builder (k-NN / hybrid). */}
                <Subtitle2 style={{ marginTop: tokens.spacingVerticalM }}>Vector queries</Subtitle2>
                <Caption1>
                  Add a vector query for k-NN or hybrid search. <code>text</code> uses integrated
                  vectorization (the service embeds the text via the field's vectorizer);
                  <code> vector</code> takes a raw embedding (comma-separated numbers).
                  {vectorFieldNames.length === 0 && ' This index has no Collection(Edm.Single) vector fields.'}
                </Caption1>
                {vectorQueries.map((v, i) => (
                  <div key={i} className={s.vqRow}>
                    <Field label="Kind">
                      <Dropdown value={v.kind} selectedOptions={[v.kind]} aria-label={`vq-${i}-kind`}
                        onOptionSelect={(_, d) => d.optionValue && updateVectorQuery(i, { kind: d.optionValue as 'text' | 'vector' })}>
                        <Option value="text">text (vectorize)</Option>
                        <Option value="vector">vector (raw)</Option>
                      </Dropdown>
                    </Field>
                    <Field label="Vector field">
                      {vectorFieldNames.length ? (
                        <Dropdown value={v.fields} selectedOptions={v.fields ? [v.fields] : []} aria-label={`vq-${i}-fields`}
                          onOptionSelect={(_, d) => d.optionValue && updateVectorQuery(i, { fields: d.optionValue })}>
                          {vectorFieldNames.map((n) => (<Option key={n} value={n}>{n}</Option>))}
                        </Dropdown>
                      ) : (
                        <Input value={v.fields} aria-label={`vq-${i}-fields`} onChange={(_, d) => updateVectorQuery(i, { fields: d.value })} placeholder="vector field" />
                      )}
                    </Field>
                    {v.kind === 'text' ? (
                      <Field label="Text to vectorize">
                        <Input value={v.text || ''} aria-label={`vq-${i}-text`} onChange={(_, d) => updateVectorQuery(i, { text: d.value })} placeholder="mystery novel set in London" />
                      </Field>
                    ) : (
                      <Field label="Vector (comma-separated)">
                        <Input aria-label={`vq-${i}-vector`}
                          value={(v.vector || []).join(',')}
                          onChange={(_, d) => updateVectorQuery(i, { vector: d.value.split(',').map((x) => Number(x.trim())).filter((x) => !Number.isNaN(x)) })}
                          placeholder="0.12, 0.04, …" />
                      </Field>
                    )}
                    <Field label="k">
                      <Input type="number" className={s.fdNum} aria-label={`vq-${i}-k`}
                        value={v.k != null ? String(v.k) : ''} onChange={(_, d) => updateVectorQuery(i, { k: d.value ? Number(d.value) : undefined })} />
                    </Field>
                    <Button size="small" appearance="subtle" onClick={() => removeVectorQuery(i)} aria-label={`vq-${i}-remove`}>Remove</Button>
                  </div>
                ))}
                <Button size="small" style={{ marginTop: tokens.spacingVerticalS }} onClick={addVectorQuery}>＋ Add vector query</Button>

                <div className={s.toolbar} style={{ marginTop: tokens.spacingVerticalM }}>
                  <Button appearance="primary" onClick={runSearch} disabled={searching}>{searching ? 'Searching…' : 'Run query'}</Button>
                </div>

                {/* Raw request JSON actually posted to /docs/search. */}
                {lastQueryBody && (
                  <div style={{ marginTop: tokens.spacingVerticalS }}>
                    <Caption1>Request body (POST /indexes/{idx.name}/docs/search):</Caption1>
                    <pre className={s.monaco} style={{ minHeight: 0, maxHeight: 200, overflow: 'auto' }}>{JSON.stringify(lastQueryBody, null, 2)}</pre>
                  </div>
                )}
              </div>
              {hits && !hits.ok && <ErrorBar msg={hits.error} hint={hits.hint} notDeployed={hits.notDeployed} />}
              {hits?.ok && (
                <>
                  <Subtitle2>Results ({docs.length}{totalCount !== undefined ? ` of ${totalCount}` : ''})</Subtitle2>
                  {answers.length > 0 && (
                    <div className={s.card}>
                      <Caption1><strong>Semantic answers</strong></Caption1>
                      {answers.map((a, i) => (
                        <Caption1 key={i}>· ({(a.score || 0).toFixed(3)}) {a.text || a.highlights || '—'}</Caption1>
                      ))}
                    </div>
                  )}
                  {Object.keys(facets).length > 0 && (
                    <Caption1>Facets: {Object.entries(facets).map(([k, vs]) => `${k} [${(vs as any[]).map((v) => `${v.value}:${v.count}`).join(', ')}]`).join('  ·  ')}</Caption1>
                  )}
                  {docs.length === 0 ? <Caption1>No documents matched.</Caption1> : (
                    <div className={s.tableWrap}>
                      <Table size="small" aria-label="Search results">
                        <TableHeader>
                          <TableRow>
                            <TableHeaderCell>Score</TableHeaderCell>
                            {hasReranker && <TableHeaderCell>Reranker</TableHeaderCell>}
                            {retrievable.map((f) => (<TableHeaderCell key={f.name}>{f.name}</TableHeaderCell>))}
                            {hasHighlights && <TableHeaderCell>Highlights</TableHeaderCell>}
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {docs.map((d, i) => (
                            <TableRow key={i}>
                              <TableCell className={s.cell}>{(d['@search.score'] || 0).toFixed(3)}</TableCell>
                              {hasReranker && <TableCell className={s.cell}>{d['@search.rerankerScore'] !== undefined ? Number(d['@search.rerankerScore']).toFixed(3) : '—'}</TableCell>}
                              {retrievable.map((f) => (
                                <TableCell key={f.name} className={s.cell}>
                                  {(() => {
                                    const v = d[f.name];
                                    if (v === undefined || v === null) return '—';
                                    const str = typeof v === 'string' ? v : JSON.stringify(v);
                                    return str.length > 80 ? str.slice(0, 80) + '…' : str;
                                  })()}
                                </TableCell>
                              ))}
                              {hasHighlights && (
                                <TableCell className={s.cell} style={{ whiteSpace: 'normal', maxWidth: 360 }}>
                                  {renderHighlights(d['@search.highlights'], highlightPreTag, highlightPostTag)}
                                </TableCell>
                              )}
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                </>
              )}
              <div className={s.card}>
                <Subtitle2>Analyze text</Subtitle2>
                <Caption1>Run text through an analyzer to see the tokens it produces (POST /analyze).</Caption1>
                <div className={s.formRow}>
                  <span>Text</span><Input value={analyzeTxt} onChange={(_, d) => setAnalyzeTxt(d.value)} placeholder="The quick brown fox" />
                  <span>Analyzer</span><Input value={analyzer} onChange={(_, d) => setAnalyzer(d.value)} placeholder="standard.lucene" />
                </div>
                <Button appearance="primary" style={{ marginTop: tokens.spacingVerticalS }} onClick={runAnalyze} disabled={!analyzeTxt}>Analyze</Button>
                {analyzeRes && (analyzeRes.ok
                  ? <Caption1 style={{ marginTop: tokens.spacingVerticalS }}>Tokens: {(analyzeRes.result?.tokens || []).map((t: any) => t.token).join(' · ') || '—'}</Caption1>
                  : <ErrorBar msg={analyzeRes.error} hint={analyzeRes.hint} notDeployed={analyzeRes.notDeployed} />)}
              </div>
            </>
          )}

          {/* ---- Statistics tab ---- */}
          {tab === 'stats' && (
            <div className={s.card}>
              <Subtitle2>Index statistics</Subtitle2>
              {detail.data?.stats ? (
                <div className={s.formRow}>
                  <span>Document count</span><span>{detail.data.stats.documentCount?.toLocaleString?.() ?? detail.data.stats.documentCount}</span>
                  <span>Storage size</span><span>{((detail.data.stats.storageSize || 0) / 1048576).toFixed(2)} MB ({detail.data.stats.storageSize?.toLocaleString?.()} bytes)</span>
                  {detail.data.stats.vectorIndexSize !== undefined && (<>
                    <span>Vector index size</span><span>{((detail.data.stats.vectorIndexSize || 0) / 1048576).toFixed(2)} MB</span>
                  </>)}
                </div>
              ) : <Caption1>Statistics not available (collected every few minutes; reload to refresh).</Caption1>}
              <Button style={{ marginTop: tokens.spacingVerticalS }} onClick={reloadDetail}>Reload statistics</Button>
            </div>
          )}

          {/* ---- Indexers tab ---- */}
          {tab === 'indexers' && (
            <>
              {indexersLoading ? <Spinner size="small" /> : indexerData && !indexerData.ok ? (
                <ErrorBar msg={indexerData.error} hint={indexerData.hint} notDeployed={indexerData.notDeployed} />
              ) : indexerData?.ok ? (
                <>
                  <Subtitle2>Indexers ({(indexerData.indexers || []).length})</Subtitle2>
                  {(indexerData.indexers || []).length === 0 ? <Caption1>No indexers on this service.</Caption1> : (
                    <div className={s.tableWrap}>
                      <Table size="small">
                        <TableHeader><TableRow>
                          <TableHeaderCell>Name</TableHeaderCell><TableHeaderCell>Target index</TableHeaderCell>
                          <TableHeaderCell>Data source</TableHeaderCell><TableHeaderCell>Skillset</TableHeaderCell>
                          <TableHeaderCell>Schedule</TableHeaderCell><TableHeaderCell></TableHeaderCell>
                        </TableRow></TableHeader>
                        <TableBody>
                          {(indexerData.indexers || []).map((ix: any) => (
                            <TableRow key={ix.name}>
                              <TableCell className={s.cell}><strong>{ix.name}</strong>{ix.targetsThisIndex && <Badge color="brand" style={{ marginLeft: tokens.spacingHorizontalXS }}>this index</Badge>}</TableCell>
                              <TableCell className={s.cell}>{ix.targetIndexName || '—'}</TableCell>
                              <TableCell className={s.cell}>{ix.dataSourceName || '—'}</TableCell>
                              <TableCell className={s.cell}>{ix.skillsetName || '—'}</TableCell>
                              <TableCell className={s.cell}>
                                {ix.disabled ? <Badge color="warning">Paused</Badge>
                                  : ix.schedule?.interval ? <Badge color="success">{describeScheduleInterval(ix.schedule.interval)}</Badge>
                                  : <Caption1>On demand</Caption1>}
                              </TableCell>
                              <TableCell>
                                <Button size="small" onClick={() => indexerAction('run', ix.name)}>Run</Button>{' '}
                                <Button size="small" onClick={() => indexerAction('reset', ix.name)}>Reset</Button>{' '}
                                <Button size="small" appearance="primary" onClick={() => setScheduleEditFor((cur) => (cur === ix.name ? null : ix.name))}>
                                  {scheduleEditFor === ix.name ? 'Close' : 'Schedule'}
                                </Button>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                  {scheduleEditFor && (() => {
                    const ix = (indexerData.indexers || []).find((x: any) => x.name === scheduleEditFor);
                    if (!ix) return null;
                    return (
                      <IndexerSchedulePanel
                        route={indexersRoute}
                        indexer={ix.name}
                        initialInterval={ix.schedule?.interval}
                        initialStartTime={ix.schedule?.startTime}
                        initialDisabled={ix.disabled}
                        onSaved={() => { setScheduleEditFor(null); loadIndexers(); }}
                      />
                    );
                  })()}
                  <Subtitle2 style={{ marginTop: tokens.spacingVerticalM }}>Data sources ({(indexerData.dataSources || []).length})</Subtitle2>
                  {(indexerData.dataSources || []).length === 0 ? <Caption1>No data sources.</Caption1> : (
                    <Caption1>{(indexerData.dataSources || []).map((d: any) => `${d.name}${d.type ? ` (${d.type})` : ''}`).join(' · ')}</Caption1>
                  )}
                  <Subtitle2 style={{ marginTop: tokens.spacingVerticalM }}>Skillsets ({(indexerData.skillsets || []).length})</Subtitle2>
                  {(indexerData.skillsets || []).length === 0 ? <Caption1>No skillsets.</Caption1> : (
                    <Caption1>{(indexerData.skillsets || []).map((sk: any) => `${sk.name} (${sk.skillCount} skills)`).join(' · ')}</Caption1>
                  )}
                  <Button style={{ marginTop: tokens.spacingVerticalS }} onClick={loadIndexers}>Reload</Button>
                </>
              ) : <Spinner size="small" />}
            </>
          )}
        </>
      )}
    </div>
  );
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
