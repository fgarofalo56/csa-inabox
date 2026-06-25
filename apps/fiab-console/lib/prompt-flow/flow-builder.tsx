'use client';

/**
 * PromptFlowBuilder — the visual LLM-flow designer for the Prompt Flow editor.
 *
 * One-for-one with the Azure AI Foundry / Azure ML prompt flow authoring UI:
 *   - DAG canvas (Inputs → tool nodes → Outputs) with edges derived from
 *     `${node.output}` / `${inputs.x}` references, exactly like Foundry's
 *     Graph view.
 *   - Tool palette: add LLM / Prompt / Python nodes (the three core tools).
 *   - Node config panel: per-node editor (LLM → connection + deployment + api
 *     + prompt template + parameters; Python → code; Prompt → template;
 *     inputs map with ${...} reference helper).
 *   - Inputs / Outputs panels showing the flow's typed I/O as JSON.
 *   - Raw flow.dag.yaml view (round-trips through the same model).
 *
 * The component is controlled: it takes a `FlowDag` value + onChange. The
 * parent (PromptFlowEditor) owns persistence (PUT serialized YAML to Foundry's
 * prompt-flow REST) and run (POST to the run route). No mock data lives here.
 */

import {
  useCallback, useEffect, useMemo, useRef, useState,
  type ReactNode, type PointerEvent as ReactPointerEvent, type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import {
  Subtitle2, Body1, Caption1, Badge, Button, Input, Field, Dropdown, Option,
  Tab, TabList, makeStyles, mergeClasses, tokens,
  Tooltip,
} from '@fluentui/react-components';
import { ResizableCanvasRegion } from '@/lib/components/canvas/resizable-canvas';
import {
  Add20Regular, Delete20Regular, BrainCircuit20Regular,
  Code20Regular, DocumentText20Regular, ArrowEnterLeft20Regular, ArrowExportLtr20Regular,
} from '@fluentui/react-icons';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';
import {
  type FlowDag, type FlowNode, type FlowNodeType, type FlowInput, type FlowOutput,
  flowToGraph, serializeFlowDag, parseFlowDag, INPUTS_NODE, OUTPUTS_NODE,
} from './flow-dag';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingHorizontalS, flex: 1, minHeight: 0 },
  toolbar: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap', padding: '4px 0' },
  // The canvas column (1fr) is wrapped in <ResizableCanvasRegion> which owns the
  // user-set height; the 360px side panel stretches to match. `minHeight:0` keeps
  // both columns from blowing out the grid track.
  body: { display: 'grid', gridTemplateColumns: '1fr 360px', gap: tokens.spacingHorizontalS, alignItems: 'stretch', minHeight: 0 },
  canvasWrap: {
    position: 'relative', height: '100%', minHeight: 0, overflow: 'hidden',
    backgroundColor: tokens.colorNeutralBackground3,
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge,
    backgroundImage: `radial-gradient(${tokens.colorNeutralStroke2} 1px, transparent 1px)`,
    backgroundSize: '20px 20px',
  },
  inner: { position: 'absolute', top: 0, left: 0, width: '3000px', height: '2200px', transformOrigin: '0 0' },
  svg: { position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'visible' },
  node: {
    position: 'absolute', width: '180px', minHeight: '64px', padding: tokens.spacingHorizontalMNudge, borderRadius: tokens.borderRadiusXLarge,
    border: `1px solid ${tokens.colorNeutralStroke1}`, backgroundColor: tokens.colorNeutralBackground1,
    cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: tokens.spacingHorizontalXS, userSelect: 'none',
    boxShadow: tokens.shadow4,
  },
  nodeSel: { outline: `2px solid ${tokens.colorBrandStroke1}`, outlineOffset: '1px' },
  nodeHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalSNudge },
  ioNode: { backgroundColor: tokens.colorNeutralBackground4 },
  panel: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingHorizontalS, minHeight: 0, overflow: 'auto',
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge, padding: tokens.spacingHorizontalMNudge,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  formRow: { display: 'grid', gridTemplateColumns: '110px 1fr', gap: '6px 10px', alignItems: 'center' },
  kvRow: { display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: tokens.spacingHorizontalSNudge, alignItems: 'center' },
  mono: {
    width: '100%', fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase200, padding: tokens.spacingHorizontalS,
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground3, color: tokens.colorNeutralForeground1,
    minHeight: '80px', resize: 'vertical',
  },
  legend: { display: 'flex', gap: tokens.spacingHorizontalMNudge, flexWrap: 'wrap', alignItems: 'center' },
});

const NODE_W = 180;
const NODE_H = 72;
const COL_GAP = 90;
const ROW_GAP = 28;

interface Pos { x: number; y: number; }

/** Deterministic rank/column layout from the derived graph edges. */
function layout(nodeIds: string[], edges: { from: string; to: string }[]): Map<string, Pos> {
  const rank = new Map<string, number>();
  for (const id of nodeIds) rank.set(id, id === INPUTS_NODE ? 0 : 1);
  rank.set(OUTPUTS_NODE, Math.max(2, nodeIds.length));
  // longest-path ranking
  for (let pass = 0; pass < nodeIds.length + 2; pass++) {
    let changed = false;
    for (const e of edges) {
      const fr = rank.get(e.from) ?? 0;
      if ((rank.get(e.to) ?? 0) < fr + 1 && e.to !== OUTPUTS_NODE) { rank.set(e.to, fr + 1); changed = true; }
    }
    if (!changed) break;
  }
  // outputs sits one past the max non-output rank
  let maxR = 0;
  for (const id of nodeIds) if (id !== OUTPUTS_NODE) maxR = Math.max(maxR, rank.get(id) ?? 0);
  rank.set(OUTPUTS_NODE, maxR + 1);

  const cols = new Map<number, string[]>();
  for (const id of nodeIds) {
    const r = rank.get(id) ?? 0;
    if (!cols.has(r)) cols.set(r, []);
    cols.get(r)!.push(id);
  }
  const pos = new Map<string, Pos>();
  for (const [r, ids] of [...cols.entries()].sort((a, b) => a[0] - b[0])) {
    ids.forEach((id, i) => pos.set(id, { x: 30 + r * (NODE_W + COL_GAP), y: 30 + i * (NODE_H + ROW_GAP) }));
  }
  return pos;
}

const NODE_ICON: Record<string, ReactNode> = {
  inputs: <ArrowEnterLeft20Regular />,
  outputs: <ArrowExportLtr20Regular />,
  llm: <BrainCircuit20Regular />,
  python: <Code20Regular />,
  prompt: <DocumentText20Regular />,
};

export interface PromptFlowBuilderProps {
  dag: FlowDag;
  onChange: (next: FlowDag) => void;
  /** Foundry connection names for the LLM node connection picker. */
  connections: string[];
  connectionsLoading?: boolean;
  /** Whether at least one LLM connection exists; gate is shown by the parent. */
  readOnly?: boolean;
}

export function PromptFlowBuilder({ dag, onChange, connections, connectionsLoading, readOnly }: PromptFlowBuilderProps) {
  const s = useStyles();
  const [selected, setSelected] = useState<string | null>(null);
  const [panelTab, setPanelTab] = useState<'node' | 'inputs' | 'outputs' | 'yaml'>('node');

  const { nodes: gNodes, edges } = useMemo(() => flowToGraph(dag), [dag]);
  const positions = useMemo(() => layout(gNodes.map((n) => n.id), edges), [gNodes, edges]);

  const selectedNode = dag.nodes.find((n) => n.name === selected) || null;

  const update = (mutate: (d: FlowDag) => FlowDag) => onChange(mutate(structuredCloneSafe(dag)));

  const addNode = (type: FlowNodeType) => {
    if (readOnly) return;
    const base = type === 'python' ? 'py_node' : type === 'prompt' ? 'prompt_node' : 'llm_node';
    let name = base; let i = 1;
    const existing = new Set(dag.nodes.map((n) => n.name));
    while (existing.has(name)) { name = `${base}_${i++}`; }
    const node: FlowNode = type === 'llm'
      ? {
          name, type: 'llm', api: 'chat', provider: 'AzureOpenAI', module: 'promptflow.tools.aoai',
          connection: '', deploymentName: '',
          source: { type: 'code', path: `${name}.jinja2`, code: 'system:\nYou are a helpful assistant.\n\nuser:\n{{question}}' },
          inputs: { temperature: 0.7, max_tokens: 256 },
        }
      : type === 'prompt'
      ? { name, type: 'prompt', source: { type: 'code', path: `${name}.jinja2`, code: '{{text}}' }, inputs: {} }
      : { name, type: 'python', source: { type: 'code', path: `${name}.py`, code: 'from promptflow import tool\n\n@tool\ndef my_python_tool(input1: str) -> str:\n    return input1' }, inputs: {} };
    update((d) => { d.nodes.push(node); return d; });
    setSelected(name);
    setPanelTab('node');
  };

  const removeNode = (name: string) => {
    update((d) => { d.nodes = d.nodes.filter((n) => n.name !== name); return d; });
    if (selected === name) setSelected(null);
  };

  const patchNode = (name: string, patch: Partial<FlowNode>) =>
    update((d) => { d.nodes = d.nodes.map((n) => (n.name === name ? { ...n, ...patch } : n)); return d; });

  const renameNode = (oldName: string, newName: string) => {
    if (!newName || newName === oldName || dag.nodes.some((n) => n.name === newName)) return;
    update((d) => {
      d.nodes = d.nodes.map((n) => (n.name === oldName ? { ...n, name: newName } : n));
      // rewrite references ${oldName.output...} → ${newName.output...}
      const rewrite = (v: unknown): unknown => {
        if (typeof v === 'string') return v.replace(new RegExp(`\\$\\{${escapeRe(oldName)}\\.output`, 'g'), `\${${newName}.output`);
        if (Array.isArray(v)) return v.map(rewrite);
        if (v && typeof v === 'object') { const o: any = {}; for (const [k, vv] of Object.entries(v)) o[k] = rewrite(vv); return o; }
        return v;
      };
      d.nodes = d.nodes.map((n) => ({ ...n, inputs: rewrite(n.inputs) as Record<string, unknown> }));
      d.outputs = d.outputs.map((o) => ({ ...o, reference: rewrite(o.reference) as string }));
      return d;
    });
    setSelected(newName);
  };

  return (
    <div className={s.root}>
      <div className={s.toolbar}>
        <Caption1 style={{ marginRight: 4 }}>Add tool node:</Caption1>
        <Button size="small" icon={<BrainCircuit20Regular />} appearance="secondary" disabled={readOnly} onClick={() => addNode('llm')}>LLM</Button>
        <Button size="small" icon={<DocumentText20Regular />} appearance="secondary" disabled={readOnly} onClick={() => addNode('prompt')}>Prompt</Button>
        <Button size="small" icon={<Code20Regular />} appearance="secondary" disabled={readOnly} onClick={() => addNode('python')}>Python</Button>
        <div style={{ flex: 1 }} />
        <div className={s.legend}>
          <Badge appearance="tint" icon={<BrainCircuit20Regular />}>LLM</Badge>
          <Badge appearance="tint" icon={<DocumentText20Regular />}>Prompt</Badge>
          <Badge appearance="tint" icon={<Code20Regular />}>Python</Badge>
        </div>
      </div>

      <div className={s.body}>
        {/* ---- Graph canvas (drag the bottom grip to resize the canvas height) ---- */}
        <ResizableCanvasRegion storageKey="prompt-flow" defaultPx={420} minPx={280} ariaLabel="Resize prompt flow canvas height">
        <div className={s.canvasWrap} data-testid="prompt-flow-canvas" aria-label="Prompt flow graph">
          <div className={s.inner}>
            <svg className={s.svg} width="100%" height="100%" aria-hidden="true">
              <defs>
                <marker id="pf-arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">
                  <path d="M0,0 L8,3 L0,6 Z" fill={tokens.colorBrandStroke1} />
                </marker>
              </defs>
              {edges.map((e) => {
                const f = positions.get(e.from); const t = positions.get(e.to);
                if (!f || !t) return null;
                const sx = f.x + NODE_W, sy = f.y + NODE_H / 2;
                const ex = t.x, ey = t.y + NODE_H / 2;
                const mx = (sx + ex) / 2;
                return (
                  <path key={`${e.from}->${e.to}`} d={`M${sx},${sy} C${mx},${sy} ${mx},${ey} ${ex},${ey}`}
                    fill="none" stroke={tokens.colorBrandStroke1} strokeWidth={2} markerEnd="url(#pf-arrow)" />
                );
              })}
            </svg>
            {gNodes.map((gn) => {
              const p = positions.get(gn.id); if (!p) return null;
              const isIO = gn.kind === 'inputs' || gn.kind === 'outputs';
              return (
                <div
                  key={gn.id}
                  className={`${s.node} ${isIO ? s.ioNode : ''} ${selected === gn.id ? s.nodeSel : ''}`}
                  style={{ left: p.x, top: p.y }}
                  data-node={gn.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => {
                    if (gn.id === INPUTS_NODE) { setPanelTab('inputs'); setSelected(null); }
                    else if (gn.id === OUTPUTS_NODE) { setPanelTab('outputs'); setSelected(null); }
                    else { setSelected(gn.id); setPanelTab('node'); }
                  }}
                  onKeyDown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') (ev.currentTarget as HTMLDivElement).click(); }}
                >
                  <div className={s.nodeHead}>
                    {NODE_ICON[gn.kind]}
                    <Body1 style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{gn.label}</Body1>
                  </div>
                  {!isIO && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{gn.kind.toUpperCase()}</Caption1>}
                  {gn.kind === 'inputs' && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{dag.inputs.length} input(s)</Caption1>}
                  {gn.kind === 'outputs' && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{dag.outputs.length} output(s)</Caption1>}
                </div>
              );
            })}
            {dag.nodes.length === 0 && (
              <div style={{ position: 'absolute', left: 30, top: 130, maxWidth: 360 }}>
                <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                  Empty flow. Add an LLM / Prompt / Python tool node above, then wire it by
                  referencing <code>{'${inputs.x}'}</code> or <code>{'${nodeName.output}'}</code> in its inputs.
                </Caption1>
              </div>
            )}
          </div>
        </div>
        </ResizableCanvasRegion>

        {/* ---- Side panel ---- */}
        <div className={s.panel}>
          <TabList selectedValue={panelTab} onTabSelect={(_, d) => setPanelTab(d.value as any)} size="small">
            <Tab value="node">Node</Tab>
            <Tab value="inputs">Inputs</Tab>
            <Tab value="outputs">Outputs</Tab>
            <Tab value="yaml">YAML</Tab>
          </TabList>

          {panelTab === 'node' && (
            selectedNode ? (
              <NodeConfig
                node={selectedNode}
                connections={connections}
                connectionsLoading={connectionsLoading}
                readOnly={readOnly}
                onRename={(nn) => renameNode(selectedNode.name, nn)}
                onPatch={(p) => patchNode(selectedNode.name, p)}
                onRemove={() => removeNode(selectedNode.name)}
              />
            ) : <Caption1>Select a tool node on the canvas to edit its configuration.</Caption1>
          )}

          {panelTab === 'inputs' && (
            <InputsPanel inputs={dag.inputs} readOnly={readOnly}
              onChange={(inputs) => update((d) => { d.inputs = inputs; return d; })} />
          )}

          {panelTab === 'outputs' && (
            <OutputsPanel outputs={dag.outputs} nodeNames={dag.nodes.map((n) => n.name)} readOnly={readOnly}
              onChange={(outputs) => update((d) => { d.outputs = outputs; return d; })} />
          )}

          {panelTab === 'yaml' && (
            <RawYaml dag={dag} readOnly={readOnly} onChange={onChange} />
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Node config
// ---------------------------------------------------------------------------

function NodeConfig({ node, connections, connectionsLoading, readOnly, onRename, onPatch, onRemove }: {
  node: FlowNode; connections: string[]; connectionsLoading?: boolean; readOnly?: boolean;
  onRename: (n: string) => void; onPatch: (p: Partial<FlowNode>) => void; onRemove: () => void;
}) {
  const s = useStyles();
  const [nameDraft, setNameDraft] = useState(node.name);

  const setInput = (k: string, v: unknown) => {
    const inputs = { ...node.inputs, [k]: v };
    onPatch({ inputs });
  };
  const renameInput = (oldK: string, newK: string) => {
    if (!newK || newK === oldK || newK in node.inputs) return;
    const inputs: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node.inputs)) inputs[k === oldK ? newK : k] = v;
    onPatch({ inputs });
  };
  const removeInput = (k: string) => {
    const inputs = { ...node.inputs }; delete inputs[k]; onPatch({ inputs });
  };
  const addInput = () => {
    let k = 'input'; let i = 1; while (k in node.inputs) k = `input${i++}`;
    setInput(k, '');
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {NODE_ICON[node.type]}
        <Subtitle2 style={{ flex: 1 }}>{node.type.toUpperCase()} node</Subtitle2>
        <Tooltip content="Delete node" relationship="label">
          <Button size="small" appearance="subtle" icon={<Delete20Regular />} disabled={readOnly} onClick={onRemove} aria-label="Delete node" />
        </Tooltip>
      </div>

      <div className={s.formRow}>
        <span>Name</span>
        <Input value={nameDraft} data-node-name="1" disabled={readOnly}
          onChange={(_, d) => setNameDraft(d.value)}
          onBlur={() => onRename(nameDraft)}
          onKeyDown={(e) => { if (e.key === 'Enter') onRename(nameDraft); }} />
      </div>

      {node.type === 'llm' && (
        <>
          <div className={s.formRow}>
            <span>Connection</span>
            <Dropdown disabled={readOnly} value={node.connection || ''} selectedOptions={node.connection ? [node.connection] : []}
              placeholder={connectionsLoading ? 'Loading…' : (connections.length ? 'Select connection' : 'No connections')}
              onOptionSelect={(_, d) => d.optionValue && onPatch({ connection: d.optionValue })}>
              {connections.map((c) => <Option key={c} value={c}>{c}</Option>)}
            </Dropdown>
          </div>
          <div className={s.formRow}>
            <span>API</span>
            <Dropdown disabled={readOnly} value={node.api || 'chat'} selectedOptions={[node.api || 'chat']}
              onOptionSelect={(_, d) => d.optionValue && onPatch({ api: d.optionValue })}>
              <Option value="chat">chat</Option>
              <Option value="completion">completion</Option>
            </Dropdown>
          </div>
          <div className={s.formRow}>
            <span>Deployment</span>
            <Input disabled={readOnly} value={node.deploymentName || ''} placeholder="gpt-4o-mini"
              onChange={(_, d) => onPatch({ deploymentName: d.value })} />
          </div>
          <Field label="Prompt template (Jinja2)">
            <MonacoTextarea value={node.source?.code || ''} language="plaintext" height={180} minHeight={120}
              readOnly={readOnly}
              onChange={(v) => onPatch({ source: { ...(node.source || { type: 'code' }), code: v } })}
              ariaLabel="LLM prompt template" />
          </Field>
        </>
      )}

      {node.type === 'prompt' && (
        <Field label="Prompt template (Jinja2)">
          <MonacoTextarea value={node.source?.code || ''} language="plaintext" height={200} minHeight={120}
            readOnly={readOnly}
            onChange={(v) => onPatch({ source: { ...(node.source || { type: 'code' }), code: v } })}
            ariaLabel="Prompt template" />
        </Field>
      )}

      {node.type === 'python' && (
        <Field label="Python code">
          <MonacoTextarea value={node.source?.code || ''} language="python" height={220} minHeight={140}
            readOnly={readOnly}
            onChange={(v) => onPatch({ source: { ...(node.source || { type: 'code' }), code: v } })}
            ariaLabel="Python tool code" />
        </Field>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
        <Subtitle2 style={{ flex: 1 }}>Inputs</Subtitle2>
        <Button size="small" icon={<Add20Regular />} appearance="subtle" disabled={readOnly} onClick={addInput}>Add</Button>
      </div>
      <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
        Use <code>{'${inputs.x}'}</code> to reference a flow input or <code>{'${node.output}'}</code> to chain a node.
      </Caption1>
      {Object.entries(node.inputs).length === 0 && <Caption1>No inputs.</Caption1>}
      {Object.entries(node.inputs).map(([k, v]) => (
        <div className={s.kvRow} key={k}>
          <Input size="small" value={k} disabled={readOnly} aria-label={`Input name ${k}`}
            onBlur={(e) => renameInput(k, e.target.value)}
            onChange={() => { /* committed on blur to avoid focus thrash */ }}
            defaultValue={k} />
          <Input size="small" value={String(v ?? '')} disabled={readOnly} aria-label={`Input value ${k}`}
            placeholder="value or ${ref}"
            onChange={(_, d) => setInput(k, coerce(d.value))} />
          <Button size="small" appearance="subtle" icon={<Delete20Regular />} disabled={readOnly}
            onClick={() => removeInput(k)} aria-label={`Remove input ${k}`} />
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inputs panel
// ---------------------------------------------------------------------------

function InputsPanel({ inputs, onChange, readOnly }: { inputs: FlowInput[]; onChange: (i: FlowInput[]) => void; readOnly?: boolean }) {
  const s = useStyles();
  const add = () => {
    let name = 'input'; let i = 1; const ex = new Set(inputs.map((x) => x.name));
    while (ex.has(name)) name = `input${i++}`;
    onChange([...inputs, { name, type: 'string', default: '' }]);
  };
  const patch = (idx: number, p: Partial<FlowInput>) => onChange(inputs.map((x, i) => (i === idx ? { ...x, ...p } : x)));
  const remove = (idx: number) => onChange(inputs.filter((_, i) => i !== idx));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <Subtitle2 style={{ flex: 1 }}>Flow inputs</Subtitle2>
        <Button size="small" icon={<Add20Regular />} appearance="subtle" disabled={readOnly} onClick={add}>Add</Button>
      </div>
      <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Typed inputs to the flow. Reference as <code>{'${inputs.<name>}'}</code>.</Caption1>
      {inputs.length === 0 && <Caption1>No inputs defined.</Caption1>}
      {inputs.map((inp, idx) => (
        <div key={idx} style={{ display: 'grid', gridTemplateColumns: '1fr 90px auto', gap: 6, alignItems: 'center' }}>
          <Input size="small" defaultValue={inp.name} disabled={readOnly} aria-label="Input name"
            onBlur={(e) => patch(idx, { name: e.target.value })} />
          <Dropdown size="small" value={inp.type} selectedOptions={[inp.type]} disabled={readOnly}
            onOptionSelect={(_, d) => d.optionValue && patch(idx, { type: d.optionValue })}>
            {['string', 'int', 'double', 'bool', 'list', 'object'].map((t) => <Option key={t} value={t}>{t}</Option>)}
          </Dropdown>
          <Button size="small" appearance="subtle" icon={<Delete20Regular />} disabled={readOnly}
            onClick={() => remove(idx)} aria-label="Remove input" />
          <Input size="small" style={{ gridColumn: '1 / span 3' }} value={String(inp.default ?? '')} disabled={readOnly}
            placeholder="default value" aria-label="Input default"
            onChange={(_, d) => patch(idx, { default: coerceTyped(d.value, inp.type) })} />
        </div>
      ))}
      <Subtitle2 style={{ marginTop: 6 }}>JSON</Subtitle2>
      <pre className={s.mono}>{JSON.stringify(inputsToJson(inputs), null, 2)}</pre>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Outputs panel
// ---------------------------------------------------------------------------

function OutputsPanel({ outputs, nodeNames, onChange, readOnly }: {
  outputs: FlowOutput[]; nodeNames: string[]; onChange: (o: FlowOutput[]) => void; readOnly?: boolean;
}) {
  const s = useStyles();
  const add = () => {
    let name = 'output'; let i = 1; const ex = new Set(outputs.map((x) => x.name));
    while (ex.has(name)) name = `output${i++}`;
    onChange([...outputs, { name, type: 'string', reference: nodeNames.length ? `\${${nodeNames[nodeNames.length - 1]}.output}` : '' }]);
  };
  const patch = (idx: number, p: Partial<FlowOutput>) => onChange(outputs.map((x, i) => (i === idx ? { ...x, ...p } : x)));
  const remove = (idx: number) => onChange(outputs.filter((_, i) => i !== idx));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <Subtitle2 style={{ flex: 1 }}>Flow outputs</Subtitle2>
        <Button size="small" icon={<Add20Regular />} appearance="subtle" disabled={readOnly} onClick={add}>Add</Button>
      </div>
      <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Each output references a node output: <code>{'${node.output}'}</code> or <code>{'${node.output.field}'}</code>.</Caption1>
      {outputs.length === 0 && <Caption1>No outputs defined.</Caption1>}
      {outputs.map((out, idx) => (
        <div key={idx} style={{ display: 'grid', gridTemplateColumns: '1fr 80px auto', gap: 6, alignItems: 'center' }}>
          <Input size="small" defaultValue={out.name} disabled={readOnly} aria-label="Output name"
            onBlur={(e) => patch(idx, { name: e.target.value })} />
          <Dropdown size="small" value={out.type} selectedOptions={[out.type]} disabled={readOnly}
            onOptionSelect={(_, d) => d.optionValue && patch(idx, { type: d.optionValue })}>
            {['string', 'int', 'double', 'bool', 'list', 'object'].map((t) => <Option key={t} value={t}>{t}</Option>)}
          </Dropdown>
          <Button size="small" appearance="subtle" icon={<Delete20Regular />} disabled={readOnly}
            onClick={() => remove(idx)} aria-label="Remove output" />
          <Input size="small" style={{ gridColumn: '1 / span 3' }} value={out.reference} disabled={readOnly}
            placeholder="${node.output}" aria-label="Output reference"
            onChange={(_, d) => patch(idx, { reference: d.value })} />
        </div>
      ))}
      <Subtitle2 style={{ marginTop: 6 }}>JSON</Subtitle2>
      <pre className={s.mono}>{JSON.stringify(outputsToJson(outputs), null, 2)}</pre>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Raw YAML
// ---------------------------------------------------------------------------

function RawYaml({ dag, onChange, readOnly }: { dag: FlowDag; onChange: (d: FlowDag) => void; readOnly?: boolean }) {
  const yaml = useMemo(() => serializeFlowDag(dag), [dag]);
  const [draft, setDraft] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <Subtitle2>flow.dag.yaml</Subtitle2>
      <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Round-trips with the visual builder. Edit + Apply to push back to the graph.</Caption1>
      <MonacoTextarea value={draft ?? yaml} language="yaml" height={320} minHeight={200}
        readOnly={readOnly}
        onChange={(v) => { setDraft(v); setErr(null); }}
        ariaLabel="flow.dag.yaml" />
      {err && <Caption1 style={{ color: tokens.colorPaletteRedForeground1 }}>{err}</Caption1>}
      <div style={{ display: 'flex', gap: 8 }}>
        <Button size="small" appearance="primary" disabled={readOnly || draft === null}
          onClick={() => {
            try { const parsed = parseFlowDag(draft ?? yaml); onChange(parsed); setDraft(null); }
            catch (e: any) { setErr(`Parse error: ${e?.message || String(e)}`); }
          }}>Apply to graph</Button>
        <Button size="small" disabled={draft === null} onClick={() => { setDraft(null); setErr(null); }}>Revert</Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function escapeRe(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function coerce(v: string): unknown {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+$/.test(v)) return parseInt(v, 10);
  if (/^-?\d*\.\d+$/.test(v)) return parseFloat(v);
  return v;
}

function coerceTyped(v: string, type: string): unknown {
  if (type === 'int') return parseInt(v, 10) || 0;
  if (type === 'double') return parseFloat(v) || 0;
  if (type === 'bool') return v === 'true';
  return v;
}

function inputsToJson(inputs: FlowInput[]): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const i of inputs) o[i.name] = { type: i.type, ...(i.default !== undefined ? { default: i.default } : {}) };
  return o;
}
function outputsToJson(outputs: FlowOutput[]): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const out of outputs) o[out.name] = { type: out.type, reference: out.reference };
  return o;
}

/** structuredClone with a fallback for older runtimes. */
function structuredCloneSafe<T>(v: T): T {
  if (typeof structuredClone === 'function') return structuredClone(v);
  return JSON.parse(JSON.stringify(v));
}

export { INPUTS_NODE, OUTPUTS_NODE };
