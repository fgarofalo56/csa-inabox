'use client';

/**
 * AgentFlowCanvas — the visual multi-agent workflow designer (AIF-6).
 *
 * A canvas-node-kit / React-Flow surface on the data-agent that renders the
 * orchestrator agent + its grounded data sources + its typed tools (AIF-5) +
 * its connected sub-agents (AIF-4) as draggable nodes wired from the agent.
 * A node inspector reuses the AIF-5 / AIF-4 typed forms to add / remove /
 * configure tools and sub-agents; node positions persist to state.flowLayout;
 * and a test-run pane invokes the REAL grounded run route (which delegates to
 * sub-agents when present). Undo/redo is Wave-2's useCanvasHistory.
 *
 * Backend: reuses POST /api/items/data-agent/[id]/chat — pure UI layer, no new
 * route, no bicep. No Microsoft Fabric (no-fabric-dependency).
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow, ReactFlowProvider, Background, BackgroundVariant, MiniMap, Panel,
  Handle, Position, useNodesState, useReactFlow,
  type Node, type Edge, type NodeProps, type NodeChange,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  Subtitle2, Body1, Caption1, Badge, Button, Textarea, Field, Spinner,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Bot24Regular, Database20Regular, BranchFork20Regular, Play20Regular,
  ArrowUndo16Regular, ArrowRedo16Regular, Dismiss16Regular,
} from '@fluentui/react-icons';
import type { JSX } from 'react';
import { clientFetch } from '@/lib/client-fetch';
import {
  CanvasNode, CanvasRightRail, CATEGORY_ACCENT, accentTint, portStyle,
  type CanvasVisual, type CanvasNodeCategory,
} from '@/lib/components/canvas/canvas-node-kit';
import { useCanvasHistory } from '@/lib/components/canvas/use-canvas-history';
import { ResizableCanvasRegion } from '@/lib/components/canvas/resizable-canvas';
import {
  AGENT_TOOL_KINDS, newAgentTool, agentToolKind, toolCanvasCategory,
  type AgentTool, type AgentToolKind,
} from '@/lib/copilot/agent-tool-catalog';
import { AgentToolsEditor, toolIcon } from '@/lib/copilot/agent-tool-catalog-editor';
import { newSubAgentRef, type SubAgentRef } from '@/lib/copilot/connected-agents';
import { ConnectedAgentsEditor } from '@/lib/copilot/connected-agents-editor';
import { safeModelJson } from '../model-fetch';
import { DataAgentResultViz } from '../data-agent-result-viz';
import {
  buildFlowNodes, buildFlowEdges, nodePosition, parseNodeId, type LayoutMap,
} from './agent-flow-layout';

const NODE_WIDTH = 210;

// ---- node visual ---------------------------------------------------------
interface AgentNodeData {
  kind: 'agent' | 'source' | 'tool' | 'subagent';
  label: string;
  subtitle?: string;
  typeLabel: string;
  visual: CanvasVisual;
  incomplete?: boolean;
  [k: string]: unknown;
}

function AgentFlowNodeImpl({ data, selected }: NodeProps) {
  const d = data as AgentNodeData;
  return (
    <CanvasNode
      width={NODE_WIDTH}
      title={d.label}
      visual={d.visual}
      selected={selected}
      typeLabel={d.typeLabel}
      description={d.subtitle}
      error={d.incomplete}
      rootProps={{ 'data-node-kind': d.kind, 'aria-label': `${d.kind} ${d.label}` }}
    >
      {d.kind !== 'agent' && (
        <Handle id="in" type="target" position={Position.Left} style={{ ...portStyle('in', d.visual.accent), left: -6 }} />
      )}
      {d.kind === 'agent' && (
        <Handle id="out" type="source" position={Position.Right} style={{ ...portStyle('out', d.visual.accent), right: -6 }} />
      )}
    </CanvasNode>
  );
}
const AgentFlowNode = memo(AgentFlowNodeImpl);
const nodeTypes = { agentFlow: AgentFlowNode };

function visualFor(category: CanvasNodeCategory, icon: JSX.Element): CanvasVisual {
  return { icon, category, accent: CATEGORY_ACCENT[category] };
}

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minHeight: '0' },
  toolbar: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' },
  body: { display: 'grid', gridTemplateColumns: 'minmax(0, 1.7fr) minmax(300px, 1fr)', gap: tokens.spacingHorizontalM, alignItems: 'stretch' },
  canvasWrap: {
    // Fills the user-resizable ResizableCanvasRegion (default 460px, persisted
    // per-surface, bounded 300px–80vh). React Flow needs this definite height.
    height: '100%', minWidth: '0',
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge,
    overflow: 'hidden', background: tokens.colorNeutralBackground2,
  },
  inspector: {
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge,
    padding: tokens.spacingVerticalM, display: 'flex', flexDirection: 'column',
    gap: tokens.spacingVerticalS, overflow: 'auto', maxHeight: '460px',
  },
  runPane: {
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge,
    padding: tokens.spacingVerticalM, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
  },
  bubble: {
    borderRadius: tokens.borderRadiusMedium, padding: tokens.spacingVerticalS,
    background: tokens.colorNeutralBackground3, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
  },
  source: {
    fontFamily: 'monospace', fontSize: tokens.fontSizeBase200, whiteSpace: 'pre-wrap',
    background: tokens.colorNeutralBackground3, borderRadius: tokens.borderRadiusSmall,
    padding: tokens.spacingVerticalXS, overflowWrap: 'anywhere',
  },
});

// ---- run-pane shapes (mirror the chat route) -----------------------------
interface RunTool { source: string; type?: string; action: string; query?: string; executed?: boolean; rowCount?: number; columns?: string[]; rows?: unknown[][]; gate?: string }
interface RunMsg { role: 'user' | 'assistant'; content: string; error?: boolean; tools?: RunTool[] }

export interface AgentFlowCanvasProps {
  id: string;
  agentName: string;
  sources: { id: string; name: string; type: string }[];
  tools: AgentTool[];
  subAgents: SubAgentRef[];
  layout: LayoutMap;
  onPatch: (patch: { tools?: AgentTool[]; subAgents?: SubAgentRef[]; layout?: LayoutMap }) => void;
  dirty: boolean;
  save: () => Promise<boolean>;
}

interface FlowSnapshot { tools: AgentTool[]; subAgents: SubAgentRef[]; layout: LayoutMap }

function InnerCanvas(props: AgentFlowCanvasProps) {
  const { id, agentName, sources, tools, subAgents, layout, onPatch, dirty, save } = props;
  const s = useStyles();

  // Undo/redo over the canvas snapshot (tools + sub-agents + layout). Re-seeded
  // on mount (the Design tab remounts this component), so external Build-tab
  // edits are always picked up fresh.
  const history = useCanvasHistory<FlowSnapshot>({ tools, subAgents, layout });
  const apply = useCallback((next: FlowSnapshot, commit: boolean) => {
    onPatch({ tools: next.tools, subAgents: next.subAgents, layout: next.layout });
    if (commit) history.commit(next);
  }, [onPatch, history]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [addKind, setAddKind] = useState<AgentToolKind>('warehouse');
  const rf = useReactFlow();
  const [zoom, setZoom] = useState(1);
  const [railCollapsed, setRailCollapsed] = useState(false);

  // ---- derive React-Flow nodes/edges from props + layout ----
  const logical = useMemo(() => buildFlowNodes({
    sourceIds: sources.map((x) => x.id),
    toolIds: tools.map((x) => x.id),
    subAgentIds: subAgents.map((x) => x.id),
  }), [sources, tools, subAgents]);

  const structureSig = logical.map((n) => n.id).join('|');
  const layoutSig = JSON.stringify(layout);

  const rfNodes = useMemo<Node[]>(() => logical.map((ln) => {
    const pos = nodePosition(ln, layout);
    let data: AgentNodeData;
    if (ln.kind === 'agent') {
      data = { kind: 'agent', label: agentName || 'Orchestrator', typeLabel: 'Orchestrator', subtitle: `${sources.length} src · ${tools.length} tools · ${subAgents.length} agents`, visual: visualFor('transform', <Bot24Regular />) };
    } else {
      const { refId } = parseNodeId(ln.id);
      if (ln.kind === 'source') {
        const src = sources.find((x) => x.id === refId);
        data = { kind: 'source', label: src?.name || refId, typeLabel: src?.type || 'source', visual: visualFor('move', <Database20Regular />) };
      } else if (ln.kind === 'tool') {
        const t = tools.find((x) => x.id === refId);
        const meta = t ? agentToolKind(t.kind) : undefined;
        data = { kind: 'tool', label: t?.label || meta?.label || 'Tool', typeLabel: meta?.short || 'Tool', visual: visualFor(t ? toolCanvasCategory(t.kind) : 'external', t ? toolIcon(t.kind) : <Database20Regular />), incomplete: t ? !isToolBound(t) : false };
      } else {
        const sa = subAgents.find((x) => x.id === refId);
        data = { kind: 'subagent', label: sa?.name || refId, typeLabel: sa?.role || 'Sub-agent', subtitle: sa?.description, visual: visualFor('iteration', <BranchFork20Regular />), incomplete: sa ? !sa.itemId : false };
      }
    }
    return { id: ln.id, type: 'agentFlow', position: pos, data, draggable: true };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [structureSig, layoutSig, agentName, sources, tools, subAgents]);

  const rfEdges = useMemo<Edge[]>(() => buildFlowEdges(logical.map((n) => n.id)).map((e) => ({
    ...e, animated: false, style: { stroke: tokens.colorNeutralStroke1 },
  })), [logical]);

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>(rfNodes);
  // Rebuild the stateful node list only when structure or persisted layout
  // changes (never mid-drag — layout persists on drag-stop, so no jump).
  useEffect(() => { setNodes(rfNodes); }, [structureSig, layoutSig]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleNodesChange = useCallback((changes: NodeChange[]) => {
    onNodesChange(changes);
    // Persist + history-commit on drag-stop.
    const dragStop = changes.find((c) => c.type === 'position' && c.dragging === false);
    if (dragStop) {
      setNodes((cur) => {
        const nextLayout: LayoutMap = { ...layout };
        for (const n of cur) nextLayout[n.id] = { x: Math.round(n.position.x), y: Math.round(n.position.y) };
        apply({ tools, subAgents, layout: nextLayout }, true);
        return cur;
      });
    }
  }, [onNodesChange, setNodes, layout, tools, subAgents, apply]);

  // ---- structural edits ----
  const addTool = useCallback(() => {
    const meta = agentToolKind(addKind);
    if (meta?.singleton && tools.some((t) => t.kind === addKind)) return;
    const t = newAgentTool(addKind);
    apply({ tools: [...tools, t], subAgents, layout }, true);
    setSelectedId(`tool:${t.id}`);
  }, [addKind, tools, subAgents, layout, apply]);

  const removeSelected = useCallback(() => {
    if (!selectedId) return;
    const { kind, refId } = parseNodeId(selectedId);
    if (kind === 'tool') apply({ tools: tools.filter((t) => t.id !== refId), subAgents, layout }, true);
    else if (kind === 'subagent') apply({ tools, subAgents: subAgents.filter((r) => r.id !== refId), layout }, true);
    setSelectedId(null);
  }, [selectedId, tools, subAgents, layout, apply]);

  const patchTools = useCallback((next: AgentTool[]) => apply({ tools: next, subAgents, layout }, true), [subAgents, layout, apply]);
  const patchSubAgents = useCallback((next: SubAgentRef[]) => apply({ tools, subAgents: next, layout }, true), [tools, layout, apply]);

  const doUndo = useCallback(() => { const snap = history.undo(); if (snap) apply(snap, false); setSelectedId(null); }, [history, apply]);
  const doRedo = useCallback(() => { const snap = history.redo(); if (snap) apply(snap, false); setSelectedId(null); }, [history, apply]);

  // ---- test run ----
  const [chat, setChat] = useState<RunMsg[]>([]);
  const [question, setQuestion] = useState('');
  const [running, setRunning] = useState(false);
  const threadRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => { const el = threadRef.current; if (el) el.scrollTop = el.scrollHeight; }, [chat, running]);

  const run = useCallback(async () => {
    const q = question.trim();
    if (!q || running) return;
    if (dirty) await save();
    setChat((c) => [...c, { role: 'user', content: q }]);
    setQuestion(''); setRunning(true);
    let asst: RunMsg;
    try {
      const r = await clientFetch(`/api/items/data-agent/${encodeURIComponent(id)}/chat`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: q }),
      });
      const res = await safeModelJson<{ answer?: string; hint?: string; tools?: RunTool[] }>(r);
      const j = res.data;
      if (res.ok && j) asst = { role: 'assistant', content: String(j.answer ?? ''), tools: j.tools };
      else asst = { role: 'assistant', content: `${res.error || j?.error || `HTTP ${res.status}`}${j?.hint ? `\n\n${j.hint}` : ''}`, error: true };
    } catch (e: any) {
      asst = { role: 'assistant', content: e?.message || String(e), error: true };
    } finally { setRunning(false); }
    setChat((c) => [...c, asst]);
  }, [question, running, dirty, save, id]);

  // ---- inspector ----
  const sel = selectedId ? parseNodeId(selectedId) : null;
  const selTool = sel?.kind === 'tool' ? tools.find((t) => t.id === sel.refId) : undefined;

  return (
    <div className={s.root}>
      <div className={s.toolbar}>
        <Subtitle2>Workflow</Subtitle2>
        <Badge appearance="tint" color="brand">canvas</Badge>
        <div style={{ flex: 1 }} />
        <Button size="small" appearance="subtle" icon={<ArrowUndo16Regular />} onClick={doUndo} disabled={!history.canUndo}>Undo</Button>
        <Button size="small" appearance="subtle" icon={<ArrowRedo16Regular />} onClick={doRedo} disabled={!history.canRedo}>Redo</Button>
      </div>

      <div className={s.body}>
        <ResizableCanvasRegion
          storageKey="agent-flow-canvas"
          defaultPx={460}
          minPx={300}
          ariaLabel="Resize agent workflow canvas height"
          className={s.canvasWrap}
        >
          <ReactFlow
            nodes={nodes}
            edges={rfEdges}
            nodeTypes={nodeTypes}
            onNodesChange={handleNodesChange}
            onNodeClick={(_, n) => setSelectedId(n.id)}
            onPaneClick={() => setSelectedId(null)}
            onMove={(_, vp) => setZoom(vp.zoom)}
            fitView
            // maxZoom keeps a small 3-6 node graph filling the canvas readably on open.
            fitViewOptions={{ padding: 0.2, maxZoom: 1.25 }}
            proOptions={{ hideAttribution: true }}
          >
            <Background
              variant={BackgroundVariant.Dots}
              gap={18}
              size={1.5}
              color={accentTint('var(--loom-accent-blue)', 45)}
            />
            <Panel position="bottom-left">
              <CanvasRightRail
                zoom={zoom}
                minZoom={0.25}
                maxZoom={2}
                onZoomChange={(z) => rf.setViewport({ ...rf.getViewport(), zoom: z }, { duration: 120 })}
                onZoomIn={() => rf.zoomIn({ duration: 120 })}
                onZoomOut={() => rf.zoomOut({ duration: 120 })}
                onFit={() => rf.fitView({ padding: 0.2, maxZoom: 1.25, duration: 200 })}
                collapsed={railCollapsed}
                onToggleCollapse={() => setRailCollapsed((v) => !v)}
              />
            </Panel>
            <MiniMap
              pannable
              zoomable
              nodeStrokeColor={tokens.colorNeutralStroke2}
              maskColor={accentTint(tokens.colorNeutralBackground3, 70)}
              style={{ backgroundColor: tokens.colorNeutralBackground1 }}
            />
            <Panel position="top-left">
              <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Click a node to configure it in the inspector →</Caption1>
            </Panel>
          </ReactFlow>
        </ResizableCanvasRegion>

        <div className={s.inspector}>
          {!sel && (
            <>
              <Subtitle2>Add to the workflow</Subtitle2>
              <Field label="Tool kind">
                <select
                  value={addKind}
                  onChange={(e) => setAddKind(e.target.value as AgentToolKind)}
                  style={{ padding: tokens.spacingVerticalXS, borderRadius: tokens.borderRadiusMedium, border: `1px solid ${tokens.colorNeutralStroke1}`, background: tokens.colorNeutralBackground1, color: tokens.colorNeutralForeground1 }}
                >
                  {AGENT_TOOL_KINDS.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}
                </select>
              </Field>
              <Button appearance="primary" onClick={addTool}>Add tool node</Button>
              <div role="separator" style={{ height: 1, background: tokens.colorNeutralStroke2, margin: `${tokens.spacingVerticalS} 0` }} />
              <Subtitle2>Connected sub-agents</Subtitle2>
              <ConnectedAgentsEditor subAgents={subAgents} selfId={id} onChange={patchSubAgents} compact />
            </>
          )}

          {sel?.kind === 'agent' && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS }}>
                <Bot24Regular /><Subtitle2>{agentName || 'Orchestrator'}</Subtitle2>
              </div>
              <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                The orchestrator. It grounds on its {sources.length} data source{sources.length === 1 ? '' : 's'} and delegates to {subAgents.length} connected agent{subAgents.length === 1 ? '' : 's'} at run time. Edit instructions + sources on the Build tab.
              </Caption1>
            </>
          )}

          {sel?.kind === 'source' && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS }}>
                <Database20Regular /><Subtitle2>{sources.find((x) => x.id === sel.refId)?.name || sel.refId}</Subtitle2>
              </div>
              <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Grounded data source. Configure its tables / few-shot examples on the Build tab.</Caption1>
            </>
          )}

          {sel?.kind === 'tool' && selTool && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS }}>
                {toolIcon(selTool.kind)}<Subtitle2>{agentToolKind(selTool.kind)?.label}</Subtitle2>
                <div style={{ flex: 1 }} />
                <Button size="small" appearance="subtle" icon={<Dismiss16Regular />} onClick={removeSelected}>Remove</Button>
              </div>
              <AgentToolsEditor tools={[selTool]} onChange={(next) => patchTools(tools.map((t) => (t.id === selTool.id ? next[0] : t)))} compact />
            </>
          )}

          {sel?.kind === 'subagent' && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS }}>
                <BranchFork20Regular /><Subtitle2>{subAgents.find((x) => x.id === sel.refId)?.name || sel.refId}</Subtitle2>
                <div style={{ flex: 1 }} />
                <Button size="small" appearance="subtle" icon={<Dismiss16Regular />} onClick={removeSelected}>Remove</Button>
              </div>
              <ConnectedAgentsEditor subAgents={subAgents.filter((r) => r.id === sel.refId)} selfId={id} onChange={(next) => patchSubAgents(subAgents.map((r) => (r.id === sel.refId ? (next[0] || r) : r)))} compact />
            </>
          )}
        </div>
      </div>

      {/* ---- Test run pane (real grounded run + delegation) ---- */}
      <div className={s.runPane}>
        <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS }}>
          <Play20Regular /><Subtitle2>Test run</Subtitle2>
          <Badge appearance="tint" color="brand">{subAgents.length ? 'orchestrated' : 'grounded'}</Badge>
          <div style={{ flex: 1 }} />
          <Button size="small" appearance="subtle" onClick={() => setChat([])} disabled={running || chat.length === 0}>Clear</Button>
        </div>
        <div ref={threadRef} style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, maxHeight: '260px', overflow: 'auto' }} aria-live="polite">
          {chat.length === 0 && !running && (
            <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Run the whole workflow — ask a question and the orchestrator grounds + delegates to its connected agents.</Caption1>
          )}
          {chat.map((m, i) => (
            <div key={i} style={{ alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start', maxWidth: '85%' }}>
              <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{m.role === 'user' ? 'You' : m.error ? 'Agent · error' : 'Agent'}</Caption1>
              <div className={s.bubble} style={m.error ? { background: tokens.colorStatusDangerBackground1 } : undefined}>{m.content || (m.error ? 'Unknown error' : '')}</div>
              {m.role === 'assistant' && !m.error && (m.tools || []).length > 0 && (
                <details open={(m.tools || []).some((t) => t.type === 'connected-agent')} style={{ marginTop: tokens.spacingVerticalXXS }}>
                  <summary style={{ cursor: 'pointer', fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground2 }}>Trace ({(m.tools || []).length})</summary>
                  {(m.tools || []).map((t, ti) => (
                    <div key={ti} style={{ marginTop: tokens.spacingVerticalXS }}>
                      <Caption1 style={{ color: tokens.colorNeutralForeground2 }}>
                        <strong>{t.source}</strong>{t.type ? ` · ${t.type}` : ''} · {t.action}
                        {t.executed && <Badge appearance="tint" color="success" size="extra-small" style={{ marginLeft: tokens.spacingHorizontalSNudge }}>✓ {t.rowCount ?? 0} rows</Badge>}
                      </Caption1>
                      {t.query && <pre className={s.source}>{t.query}</pre>}
                      {t.executed && t.columns && t.columns.length > 0 && t.rows && t.rows.length > 0 && <DataAgentResultViz tool={t} />}
                      {!t.executed && t.gate && <Caption1 style={{ color: tokens.colorPaletteYellowForeground1, display: 'block' }}>⚠ {t.gate}</Caption1>}
                    </div>
                  ))}
                </details>
              )}
            </div>
          ))}
          {running && (
            <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS }}><Spinner size="tiny" /> <Caption1>Running the workflow…</Caption1></div>
          )}
        </div>
        <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'flex-end' }}>
          <Textarea value={question} onChange={(_, d) => setQuestion(d.value)} placeholder="Ask the workflow…  (Enter to run)" resize="none" rows={2}
            style={{ flex: 1 }} disabled={running}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (question.trim() && !running) run(); } }} />
          <Button appearance="primary" icon={<Play20Regular />} onClick={run} disabled={!question.trim() || running}>{running ? 'Running…' : 'Run'}</Button>
        </div>
        {sources.length === 0 && subAgents.length === 0 && (
          <MessageBar intent="warning"><MessageBarBody><MessageBarTitle>Nothing to run yet</MessageBarTitle>Add a data source (Build tab) or a connected agent before running the workflow.</MessageBarBody></MessageBar>
        )}
      </div>
    </div>
  );
}

/** A tool node is "incomplete" when its binding is missing. */
function isToolBound(t: AgentTool): boolean {
  switch (t.kind) {
    case 'warehouse': case 'lakehouse': case 'kql': case 'search-index': case 'knowledge-base': return !!t.itemId;
    case 'mcp': return !!t.serverId;
    case 'openapi': return !!t.specUrl;
    case 'function': return !!(t.functionName && t.functionName.trim());
    default: return true;
  }
}

export function AgentFlowCanvas(props: AgentFlowCanvasProps) {
  return (
    <ReactFlowProvider>
      <InnerCanvas {...props} />
    </ReactFlowProvider>
  );
}
