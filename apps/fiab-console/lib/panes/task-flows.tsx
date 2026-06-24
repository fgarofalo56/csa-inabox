'use client';

/**
 * TaskFlowsPane (F11) — visual task-flow step-sequence canvas, Fabric-parity
 * with the Fabric workspace "task flow" feature, on @xyflow/react (the same
 * canvas engine the pipeline designer uses). Loom-native — backed entirely by
 * the Cosmos `task-flows` container via the BFF (lib/api/workspaces.ts). No
 * Fabric dependency.
 *
 * Two views toggled by a TabList:
 *   - "Flows": a list of task flows in the workspace (name / steps / updated)
 *     with create + open + delete. Real GET/POST/DELETE to the BFF.
 *   - "Canvas": the React Flow editor for one flow. Drag nodes to reposition,
 *     connect steps with edges, add/edit steps (each step optionally links a
 *     real WorkspaceItem). Position + edge changes are debounced and saved via
 *     PUT — real Cosmos persistence (per no-vaporware.md).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ReactFlow, ReactFlowProvider, Background, BackgroundVariant, Controls, MiniMap, Panel,
  Handle, Position, useNodesState, useEdgesState, addEdge,
  type Node, type Edge, type Connection, type NodeProps, type NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  Body1, Button, Caption1, Spinner, Badge, Text, Card,
  TabList, Tab,
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  Input, Field, Textarea, Dropdown, Option,
  DataGrid, DataGridHeader, DataGridHeaderCell, DataGridRow, DataGridBody, DataGridCell,
  createTableColumn, type TableColumnDefinition,
  MessageBar, MessageBarBody,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Add20Regular, Delete20Regular, Open20Regular, Save20Regular,
  Flowchart20Regular, ArrowLeft20Regular,
} from '@fluentui/react-icons';
import {
  listItems,
  listTaskFlows, createTaskFlow, getTaskFlow, saveTaskFlow, deleteTaskFlow,
  type WorkspaceItem, type TaskFlow, type TaskFlowStep, type TaskFlowEdge,
} from '@/lib/api/workspaces';
import { findItemType } from '@/lib/catalog/fabric-item-types';
import { getItemTypeIcon } from '@/lib/components/item-type-icon';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '12px' },
  toolbar: { display: 'flex', alignItems: 'center', gap: '8px' },
  spacer: { flex: 1 },
  canvasShell: {
    position: 'relative', height: '560px', minHeight: '400px',
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: '8px',
    overflow: 'hidden', backgroundColor: tokens.colorNeutralBackground3,
  },
  node: {
    minWidth: '160px', maxWidth: '220px',
    padding: '8px 12px', borderRadius: '8px',
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    boxShadow: tokens.shadow4,
  },
  nodeSelected: { border: `2px solid ${tokens.colorBrandStroke1}` },
  nodeRow: { display: 'flex', alignItems: 'center', gap: '6px' },
  empty: {
    padding: '32px', textAlign: 'center', color: tokens.colorNeutralForeground3,
    border: `1px dashed ${tokens.colorNeutralStroke2}`, borderRadius: '12px', lineHeight: 1.6,
  },
});

// --- Custom node ----------------------------------------------------------

interface StepNodeData extends Record<string, unknown> {
  label: string;
  itemId?: string | null;
  itemType?: string | null;
  note?: string;
}

function TaskFlowStepNode({ data, selected }: NodeProps) {
  const s = useStyles();
  const d = data as StepNodeData;
  const meta = d.itemType ? findItemType(d.itemType) : undefined;
  const icon = d.itemType ? getItemTypeIcon(d.itemType, meta?.category) : <Flowchart20Regular />;
  return (
    <div className={`${s.node} ${selected ? s.nodeSelected : ''}`}>
      <Handle type="target" position={Position.Left} />
      <div className={s.nodeRow}>
        <span style={{ display: 'flex' }}>{icon}</span>
        <Text weight="semibold" size={300}>{d.label}</Text>
      </div>
      {d.itemId && meta && (
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{meta.displayName}</Caption1>
      )}
      {d.note && (
        <Caption1 style={{ color: tokens.colorNeutralForeground3, display: 'block', marginTop: 2 }}>{d.note}</Caption1>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const nodeTypes: NodeTypes = { step: TaskFlowStepNode };

// --- Canvas (inner — must be inside ReactFlowProvider) --------------------

interface CanvasProps {
  workspaceId: string;
  flow: TaskFlow;
  items: WorkspaceItem[];
  onBack: () => void;
}

function uid(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function flowToNodes(flow: TaskFlow): Node[] {
  return (flow.steps || []).map((st) => ({
    id: st.id,
    type: 'step',
    position: { x: st.x ?? 0, y: st.y ?? 0 },
    data: { label: st.label, itemId: st.itemId ?? null, itemType: st.itemType ?? null, note: st.note ?? '' } as StepNodeData,
  }));
}
function flowToEdges(flow: TaskFlow): Edge[] {
  return (flow.edges || []).map((e) => ({
    id: e.id, source: e.source, target: e.target, label: e.label, type: 'smoothstep',
  }));
}

function TaskFlowCanvasInner({ workspaceId, flow, items, onBack }: CanvasProps) {
  const s = useStyles();
  const qc = useQueryClient();
  const [nodes, setNodes, onNodesChange] = useNodesState(flowToNodes(flow));
  const [edges, setEdges, onEdgesChange] = useEdgesState(flowToEdges(flow));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Add / edit step dialog state.
  const [stepDialog, setStepDialog] = useState<{ mode: 'add' } | { mode: 'edit'; id: string } | null>(null);
  const [stepLabel, setStepLabel] = useState('');
  const [stepItemId, setStepItemId] = useState<string>('');
  const [stepNote, setStepNote] = useState('');

  const serialize = useCallback((): { steps: TaskFlowStep[]; edges: TaskFlowEdge[] } => {
    const steps: TaskFlowStep[] = nodes.map((n) => {
      const d = n.data as StepNodeData;
      return {
        id: n.id,
        label: d.label,
        itemId: d.itemId ?? null,
        itemType: d.itemType ?? null,
        note: d.note || undefined,
        x: Math.round(n.position.x),
        y: Math.round(n.position.y),
      };
    });
    const eds: TaskFlowEdge[] = edges.map((e) => ({
      id: e.id, source: e.source, target: e.target, label: typeof e.label === 'string' ? e.label : undefined,
    }));
    return { steps, edges: eds };
  }, [nodes, edges]);

  const doSave = useCallback(async () => {
    setSaving(true); setError(null);
    try {
      const { steps, edges: eds } = serialize();
      await saveTaskFlow(workspaceId, flow.id, { steps, edges: eds });
      setDirty(false);
      setSavedAt(new Date().toLocaleTimeString());
      void qc.invalidateQueries({ queryKey: ['task-flows', workspaceId] });
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setSaving(false);
    }
  }, [serialize, workspaceId, flow.id, qc]);

  // Debounced autosave whenever the canvas becomes dirty.
  useEffect(() => {
    if (!dirty) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { void doSave(); }, 1200);
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, [dirty, doSave]);

  const markDirty = useCallback(() => setDirty(true), []);

  const handleNodesChange = useCallback((changes: Parameters<typeof onNodesChange>[0]) => {
    onNodesChange(changes);
    // Position / removal changes are persistable mutations.
    if (changes.some((c: any) => c.type === 'position' || c.type === 'remove')) markDirty();
  }, [onNodesChange, markDirty]);

  const handleEdgesChange = useCallback((changes: Parameters<typeof onEdgesChange>[0]) => {
    onEdgesChange(changes);
    if (changes.some((c: any) => c.type === 'remove')) markDirty();
  }, [onEdgesChange, markDirty]);

  const onConnect = useCallback((conn: Connection) => {
    setEdges((eds) => addEdge({ ...conn, id: uid('e'), type: 'smoothstep' }, eds));
    markDirty();
  }, [setEdges, markDirty]);

  function openAddStep() {
    setStepDialog({ mode: 'add' }); setStepLabel(''); setStepItemId(''); setStepNote('');
  }
  function openEditStep(id: string) {
    const n = nodes.find((x) => x.id === id);
    if (!n) return;
    const d = n.data as StepNodeData;
    setStepDialog({ mode: 'edit', id });
    setStepLabel(d.label); setStepItemId(d.itemId || ''); setStepNote(d.note || '');
  }
  function submitStep() {
    if (!stepDialog) return;
    const label = stepLabel.trim();
    if (!label) return;
    const linked = stepItemId ? items.find((i) => i.id === stepItemId) : undefined;
    const data: StepNodeData = {
      label,
      itemId: linked?.id ?? null,
      itemType: linked?.itemType ?? null,
      note: stepNote.trim() || undefined,
    };
    if (stepDialog.mode === 'add') {
      const n: Node = {
        id: uid('s'), type: 'step',
        position: { x: 80 + nodes.length * 40, y: 80 + (nodes.length % 5) * 30 },
        data: data as Record<string, unknown>,
      };
      setNodes((prev) => [...prev, n]);
    } else {
      const id = stepDialog.id;
      setNodes((prev) => prev.map((n) => (n.id === id ? { ...n, data: data as Record<string, unknown> } : n)));
    }
    setStepDialog(null);
    markDirty();
  }

  return (
    <div className={s.root}>
      <div className={s.toolbar}>
        <Button appearance="subtle" icon={<ArrowLeft20Regular />} onClick={onBack}>Flows</Button>
        <Text weight="semibold">{flow.displayName}</Text>
        <Badge appearance="tint" color="informative">{nodes.length} step{nodes.length === 1 ? '' : 's'}</Badge>
        <div className={s.spacer} />
        {savedAt && !dirty && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Saved {savedAt}</Caption1>}
        {dirty && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Unsaved changes…</Caption1>}
        <Button appearance="primary" icon={<Save20Regular />} onClick={() => void doSave()} disabled={saving || !dirty}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
      {error && <MessageBar intent="error"><MessageBarBody>{error}</MessageBarBody></MessageBar>}
      <div className={s.canvasShell}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={handleNodesChange}
          onEdgesChange={handleEdgesChange}
          onConnect={onConnect}
          onNodeDoubleClick={(_e, n) => openEditStep(n.id)}
          fitView
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
          <Controls />
          <MiniMap pannable zoomable />
          <Panel position="top-left">
            <Button size="small" appearance="primary" icon={<Add20Regular />} onClick={openAddStep}>Add step</Button>
          </Panel>
        </ReactFlow>
      </div>
      <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
        Drag steps to arrange them. Drag from a step&apos;s right edge to another step&apos;s left edge to connect them.
        Double-click a step to edit it.
      </Caption1>

      {/* Add / edit step */}
      <Dialog open={!!stepDialog} onOpenChange={(_e, d) => { if (!d.open) setStepDialog(null); }}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{stepDialog?.mode === 'edit' ? 'Edit step' : 'Add step'}</DialogTitle>
            <DialogContent>
              <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
                <Field label="Step label" required>
                  <Input value={stepLabel} onChange={(_e, d) => setStepLabel(d.value)} placeholder="Ingest raw data" autoFocus />
                </Field>
                <Field label="Linked item" hint="Optionally attach a real workspace item to this step.">
                  <Dropdown
                    value={stepItemId ? (items.find((i) => i.id === stepItemId)?.displayName || 'Item') : 'None'}
                    selectedOptions={[stepItemId || '__none__']}
                    onOptionSelect={(_, d) => setStepItemId(d.optionValue === '__none__' ? '' : (d.optionValue || ''))}>
                    <Option value="__none__">None</Option>
                    {items.map((it) => (
                      <Option key={it.id} value={it.id} text={it.displayName}>
                        {it.displayName} ({findItemType(it.itemType)?.displayName ?? it.itemType})
                      </Option>
                    ))}
                  </Dropdown>
                </Field>
                <Field label="Note">
                  <Textarea value={stepNote} onChange={(_e, d) => setStepNote(d.value)} placeholder="What happens at this step…" />
                </Field>
              </div>
            </DialogContent>
            <DialogActions>
              {stepDialog?.mode === 'edit' && (
                <Button appearance="secondary" icon={<Delete20Regular />}
                  onClick={() => {
                    const id = (stepDialog as { mode: 'edit'; id: string }).id;
                    setNodes((prev) => prev.filter((n) => n.id !== id));
                    setEdges((prev) => prev.filter((e) => e.source !== id && e.target !== id));
                    setStepDialog(null); markDirty();
                  }}>
                  Remove step
                </Button>
              )}
              <Button appearance="secondary" onClick={() => setStepDialog(null)}>Cancel</Button>
              <Button appearance="primary" disabled={!stepLabel.trim()} onClick={submitStep}>
                {stepDialog?.mode === 'edit' ? 'Save step' : 'Add'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}

// --- Flows list -----------------------------------------------------------

export interface TaskFlowsPaneProps {
  workspaceId: string;
}

export function TaskFlowsPane({ workspaceId }: TaskFlowsPaneProps): JSX.Element {
  const s = useStyles();
  const qc = useQueryClient();
  const [view, setView] = useState<'flows' | 'canvas'>('flows');
  const [openFlow, setOpenFlow] = useState<TaskFlow | null>(null);
  const [error, setError] = useState<string | null>(null);

  const flowsQ = useQuery<TaskFlow[]>({
    queryKey: ['task-flows', workspaceId],
    queryFn: () => listTaskFlows(workspaceId),
  });
  const itemsQ = useQuery<WorkspaceItem[]>({
    queryKey: ['items', workspaceId],
    queryFn: () => listItems(workspaceId),
  });
  const flows = flowsQ.data ?? [];
  const items = itemsQ.data ?? [];

  // create flow dialog
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<TaskFlow | null>(null);

  const refresh = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['task-flows', workspaceId] });
  }, [qc, workspaceId]);

  async function createNew() {
    const name = newName.trim();
    if (!name) return;
    setBusy(true); setError(null);
    try {
      const flow = await createTaskFlow(workspaceId, { displayName: name, description: newDesc.trim() || undefined });
      setCreateOpen(false); setNewName(''); setNewDesc('');
      refresh();
      // Open the new flow straight into the canvas.
      setOpenFlow(flow); setView('canvas');
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setBusy(false); }
  }

  async function openInCanvas(id: string) {
    setError(null);
    try {
      const flow = await getTaskFlow(workspaceId, id);
      setOpenFlow(flow); setView('canvas');
    } catch (e: any) { setError(e?.message || String(e)); }
  }

  async function doDelete(flow: TaskFlow) {
    setBusy(true); setError(null);
    try {
      await deleteTaskFlow(workspaceId, flow.id);
      setConfirmDelete(null); refresh();
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setBusy(false); }
  }

  const columns: TableColumnDefinition<TaskFlow>[] = useMemo(() => [
    createTableColumn<TaskFlow>({
      columnId: 'name',
      renderHeaderCell: () => 'Name',
      renderCell: (f) => (
        <div className={s.nodeRow}>
          <Flowchart20Regular />
          <Text weight="semibold">{f.displayName}</Text>
        </div>
      ),
    }),
    createTableColumn<TaskFlow>({
      columnId: 'steps',
      renderHeaderCell: () => 'Steps',
      renderCell: (f) => <Badge appearance="tint" color="informative">{(f.steps || []).length}</Badge>,
    }),
    createTableColumn<TaskFlow>({
      columnId: 'updated',
      renderHeaderCell: () => 'Updated',
      renderCell: (f) => (
        <Caption1>{f.updatedAt ? new Date(f.updatedAt).toLocaleString() : '—'}</Caption1>
      ),
    }),
    createTableColumn<TaskFlow>({
      columnId: 'actions',
      renderHeaderCell: () => 'Actions',
      renderCell: (f) => (
        <div className={s.toolbar}>
          <Button size="small" appearance="secondary" icon={<Open20Regular />} onClick={() => void openInCanvas(f.id)}>Open</Button>
          <Button size="small" appearance="subtle" icon={<Delete20Regular />} onClick={() => setConfirmDelete(f)}>Delete</Button>
        </div>
      ),
    }),
  ], [s]);

  if (view === 'canvas' && openFlow) {
    return (
      <ReactFlowProvider>
        <TaskFlowCanvasInner
          workspaceId={workspaceId}
          flow={openFlow}
          items={items}
          onBack={() => { setView('flows'); setOpenFlow(null); refresh(); }}
        />
      </ReactFlowProvider>
    );
  }

  return (
    <div className={s.root}>
      <TabList selectedValue="flows">
        <Tab value="flows" icon={<Flowchart20Regular />}>Task flows</Tab>
      </TabList>

      <div className={s.toolbar}>
        <Button appearance="primary" icon={<Add20Regular />} onClick={() => setCreateOpen(true)}>New task flow</Button>
        <div className={s.spacer} />
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
          {flows.length} flow{flows.length === 1 ? '' : 's'}
        </Caption1>
      </div>

      {error && <MessageBar intent="error"><MessageBarBody>{error}</MessageBarBody></MessageBar>}
      {flowsQ.isLoading && <Spinner label="Loading task flows…" />}
      {flowsQ.error && (
        <MessageBar intent="error"><MessageBarBody>Failed to load task flows: {(flowsQ.error as Error).message}</MessageBarBody></MessageBar>
      )}

      {!flowsQ.isLoading && flows.length === 0 && (
        <div className={s.empty}>
          <Body1>No task flows yet. A task flow is a visual canvas that maps the steps of a process and links each step to a real item in this workspace.</Body1>
          <div style={{ marginTop: 12 }}>
            <Button appearance="primary" icon={<Add20Regular />} onClick={() => setCreateOpen(true)}>New task flow</Button>
          </div>
        </div>
      )}

      {flows.length > 0 && (
        <Card>
          <DataGrid items={flows} columns={columns} getRowId={(f) => f.id} focusMode="cell">
            <DataGridHeader>
              <DataGridRow>
                {({ renderHeaderCell }) => <DataGridHeaderCell>{renderHeaderCell()}</DataGridHeaderCell>}
              </DataGridRow>
            </DataGridHeader>
            <DataGridBody<TaskFlow>>
              {({ item, rowId }) => (
                <DataGridRow<TaskFlow> key={rowId}>
                  {({ renderCell }) => <DataGridCell>{renderCell(item)}</DataGridCell>}
                </DataGridRow>
              )}
            </DataGridBody>
          </DataGrid>
        </Card>
      )}

      {/* Create flow dialog */}
      <Dialog open={createOpen} onOpenChange={(_e, d) => { if (!d.open) setCreateOpen(false); }}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>New task flow</DialogTitle>
            <DialogContent>
              <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
                <Field label="Name" required>
                  <Input value={newName} onChange={(_e, d) => setNewName(d.value)} placeholder="Bronze → Silver → Gold" autoFocus
                    onKeyDown={(e) => { if (e.key === 'Enter') void createNew(); }} />
                </Field>
                <Field label="Description">
                  <Textarea value={newDesc} onChange={(_e, d) => setNewDesc(d.value)} placeholder="What this flow describes…" />
                </Field>
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setCreateOpen(false)} disabled={busy}>Cancel</Button>
              <Button appearance="primary" onClick={() => void createNew()} disabled={!newName.trim() || busy}>
                {busy ? 'Creating…' : 'Create'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* Confirm delete */}
      <Dialog open={!!confirmDelete} onOpenChange={(_e, d) => { if (!d.open) setConfirmDelete(null); }}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Delete task flow</DialogTitle>
            <DialogContent>
              <Body1>Delete &quot;{confirmDelete?.displayName}&quot;? This removes the flow and its step layout. Linked items are not affected.</Body1>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setConfirmDelete(null)} disabled={busy}>Cancel</Button>
              <Button appearance="primary" onClick={() => confirmDelete && void doDelete(confirmDelete)} disabled={busy}>
                {busy ? 'Deleting…' : 'Delete'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}
