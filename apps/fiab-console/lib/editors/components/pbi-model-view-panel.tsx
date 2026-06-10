'use client';

/**
 * PbiModelViewPanel — the "Model view" tab body for the SemanticModelEditor.
 *
 * Wires the shared ModelViewCanvas (relationship diagram) + the
 * SemanticModelHierarchyEditor (drill hierarchies) + a read-only TMSL
 * (`model.bim`) preview to the semantic-model model BFF route
 * (/api/items/semantic-model/[id]/model). It owns the data fetch and the
 * create / toggle-active / delete callbacks.
 *
 * NO-FABRIC-DEPENDENCY: the canvas + hierarchy editor render and persist fully
 * with NO Power BI / Fabric workspace and NO Analysis Services server. The
 * MessageBars below honestly disclose which OPTIONAL write backend (Azure
 * Analysis Services XMLA or — opt-in — Fabric REST) is active so the operator
 * knows what a save actually does (no-vaporware).
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Badge, Button, Caption1, Spinner, Subtitle2, Switch, Text, Tooltip,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle, makeStyles, tokens,
} from '@fluentui/react-components';
import { Delete16Regular, Database20Regular } from '@fluentui/react-icons';

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    rowGap: tokens.spacingVerticalM,
  },
  section: {
    display: 'flex',
    flexDirection: 'column',
    rowGap: tokens.spacingVerticalXS,
  },
  hint: { color: tokens.colorNeutralForeground3, display: 'block' },
  tableScroll: {
    overflow: 'auto',
    maxHeight: '220px',
    borderRadius: tokens.borderRadiusMedium,
    boxShadow: `0 0 0 1px ${tokens.colorNeutralStroke2}`,
    marginTop: tokens.spacingVerticalXS,
  },
  copilotCard: {
    borderRadius: tokens.borderRadiusLarge,
    boxShadow: `0 0 0 1px ${tokens.colorNeutralStroke2}`,
    padding: tokens.spacingHorizontalM,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  tmslHead: {
    display: 'flex',
    alignItems: 'center',
    columnGap: tokens.spacingHorizontalS,
  },
  tmslEditor: { marginTop: tokens.spacingVerticalXS },
});
import {
  ModelViewCanvas, type ModelTable, type ModelRelationship,
} from './model-view-canvas';
import {
  SemanticModelHierarchyEditor, type ModelHierarchy,
} from './semantic-model-hierarchy-editor';
import { ModelStructureCopilot } from './model-structure-copilot';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';

interface CanvasRelationship extends ModelRelationship { editable?: boolean }

interface ModelResponse {
  ok: boolean;
  modelName?: string;
  tables?: ModelTable[];
  relationships?: CanvasRelationship[];
  hierarchies?: ModelHierarchy[];
  tmslPreview?: string;
  notice?: string;
  error?: string;
  xmlaAvailable?: boolean;
  fabricAvailable?: boolean;
  backend?: { target: string; ok: boolean; error?: string };
}

export interface PbiModelViewPanelProps {
  /** Power BI groupId — appended to all calls; absent for Loom-native models. */
  workspaceId?: string;
  /** Power BI dataset id OR a Loom content id (loom:<cosmosItemId>). */
  datasetId: string;
}

function buildUrl(datasetId: string, workspaceId?: string, extra?: Record<string, string>): string {
  const params = new URLSearchParams();
  if (workspaceId) params.set('workspaceId', workspaceId);
  for (const [k, v] of Object.entries(extra || {})) if (v) params.set(k, v);
  const qs = params.toString();
  return `/api/items/semantic-model/${encodeURIComponent(datasetId)}/model${qs ? `?${qs}` : ''}`;
}

export function PbiModelViewPanel({ workspaceId, datasetId }: PbiModelViewPanelProps) {
  const s = useStyles();
  const [data, setData] = useState<{ tables: ModelTable[]; relationships: CanvasRelationship[]; hierarchies: ModelHierarchy[]; tmsl: string; modelName: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [xmla, setXmla] = useState(false);
  const [fabric, setFabric] = useState(false);
  const [backendMsg, setBackendMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const applyResponse = useCallback((j: ModelResponse) => {
    if (j.tmslPreview !== undefined || j.relationships) {
      setData((prev) => ({
        tables: j.tables ?? prev?.tables ?? [],
        relationships: j.relationships ?? prev?.relationships ?? [],
        hierarchies: j.hierarchies ?? prev?.hierarchies ?? [],
        tmsl: j.tmslPreview ?? prev?.tmsl ?? '',
        modelName: j.modelName ?? prev?.modelName ?? 'Semantic model',
      }));
    }
    if (j.xmlaAvailable !== undefined) setXmla(j.xmlaAvailable);
    if (j.fabricAvailable !== undefined) setFabric(j.fabricAvailable);
    if (j.backend) {
      setBackendMsg(j.backend.ok
        ? { ok: true, text: `Written to ${j.backend.target}.` }
        : { ok: false, text: `${j.backend.target} write failed: ${j.backend.error || 'unknown error'} (saved in Loom; the TMSL preview reflects your change).` });
    } else {
      setBackendMsg(null);
    }
  }, []);

  const load = useCallback(async () => {
    if (!datasetId || datasetId === 'new') return;
    setLoading(true); setLoadErr(null); setNotice(null);
    try {
      const r = await fetch(buildUrl(datasetId, workspaceId));
      const j = (await r.json()) as ModelResponse;
      if (!j.ok) { setLoadErr(j.error || `HTTP ${r.status}`); return; }
      applyResponse(j);
      setNotice(j.notice || null);
    } catch (e: any) {
      setLoadErr(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [datasetId, workspaceId, applyResponse]);

  useEffect(() => { void load(); }, [load]);

  const createRel = useCallback(async (rel: Omit<ModelRelationship, 'id'>) => {
    const r = await fetch(buildUrl(datasetId, workspaceId), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ relationship: rel }),
    });
    const j = (await r.json()) as ModelResponse;
    if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
    applyResponse(j);
  }, [datasetId, workspaceId, applyResponse]);

  const deleteRel = useCallback(async (rel: ModelRelationship) => {
    const r = await fetch(buildUrl(datasetId, workspaceId, { relId: rel.id }), { method: 'DELETE' });
    const j = (await r.json()) as ModelResponse;
    if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
    applyResponse(j);
  }, [datasetId, workspaceId, applyResponse]);

  const toggleActive = useCallback(async (rel: CanvasRelationship) => {
    setTogglingId(rel.id);
    try {
      const r = await fetch(buildUrl(datasetId, workspaceId), {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ relId: rel.id, active: !rel.active }),
      });
      const j = (await r.json()) as ModelResponse;
      if (!j.ok) { setLoadErr(j.error || `HTTP ${r.status}`); return; }
      applyResponse(j);
    } finally {
      setTogglingId(null);
    }
  }, [datasetId, workspaceId, applyResponse]);

  const createHierarchy = useCallback(async (h: Omit<ModelHierarchy, 'id'>) => {
    const r = await fetch(buildUrl(datasetId, workspaceId), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hierarchy: h }),
    });
    const j = (await r.json()) as ModelResponse;
    if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
    applyResponse(j);
  }, [datasetId, workspaceId, applyResponse]);

  const deleteHierarchy = useCallback(async (hierarchyId: string) => {
    const r = await fetch(buildUrl(datasetId, workspaceId, { hierarchyId }), { method: 'DELETE' });
    const j = (await r.json()) as ModelResponse;
    if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
    applyResponse(j);
  }, [datasetId, workspaceId, applyResponse]);

  const tables = data?.tables ?? [];
  const relationships = data?.relationships ?? [];
  const hierarchies = data?.hierarchies ?? [];
  const editableRels = relationships.filter((r) => r.editable !== false);

  return (
    <div className={s.root}>
      {loading && <Spinner size="tiny" label="Loading model…" labelPosition="after" />}
      {loadErr && (
        <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Model load failed</MessageBarTitle>{loadErr}</MessageBarBody></MessageBar>
      )}
      {notice && (
        <MessageBar intent="warning"><MessageBarBody>{notice}</MessageBarBody></MessageBar>
      )}

      {/* Honest write-backend disclosure (no-vaporware). */}
      <MessageBar intent={xmla || fabric ? 'success' : 'info'}>
        <MessageBarBody>
          <MessageBarTitle>
            {xmla ? 'Azure Analysis Services XMLA write: active' : fabric ? 'Fabric REST write: active (opt-in)' : 'Loom-native model (Cosmos) — default'}
          </MessageBarTitle>
          {xmla
            ? 'Relationship + hierarchy changes are written to the Analysis Services model via XMLA AND persisted in Loom.'
            : fabric
              ? 'Relationship + hierarchy changes overwrite the Fabric semantic model’s model.bim AND are persisted in Loom.'
              : 'Relationship + hierarchy changes are persisted Azure-native (Cosmos) and reflected in the TMSL preview below. To also push to a tabular engine, set LOOM_AAS_XMLA_ENDPOINT (Azure Analysis Services) or opt into Fabric with LOOM_SEMANTIC_MODEL_BACKEND=fabric.'}
        </MessageBarBody>
      </MessageBar>
      {backendMsg && (
        <MessageBar intent={backendMsg.ok ? 'success' : 'warning'}><MessageBarBody>{backendMsg.text}</MessageBarBody></MessageBar>
      )}

      {/* Relationship diagram — drag column-key → column-key to create. */}
      <ModelViewCanvas
        tables={tables}
        relationships={relationships}
        onCreateRelationship={createRel}
        onDeleteRelationship={deleteRel}
        emptyMessage="No tables loaded. For a Loom-native model this opens after the model is built; for a live Power BI dataset, select its workspace."
      />

      {/* Authored relationships — toggle active / inactive (USERELATIONSHIP). */}
      <div className={s.section}>
        <Subtitle2>Authored relationships ({editableRels.length})</Subtitle2>
        <Caption1 className={s.hint}>
          Mark a relationship inactive to make it a role-playing relationship usable via DAX <code>USERELATIONSHIP</code>.
          Source-derived relationships are read-only here; redraw them on the canvas to author an editable copy.
        </Caption1>
        <div className={s.tableScroll}>
          <Table aria-label="Authored relationships" size="small">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Name</TableHeaderCell>
                <TableHeaderCell>From</TableHeaderCell>
                <TableHeaderCell>To</TableHeaderCell>
                <TableHeaderCell>Cardinality</TableHeaderCell>
                <TableHeaderCell>Cross-filter</TableHeaderCell>
                <TableHeaderCell>Active</TableHeaderCell>
                <TableHeaderCell>Delete</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {editableRels.length === 0 && (
                <TableRow><TableCell colSpan={7}><Caption1>No authored relationships yet. Drag from a column key on one table card to a column key on another.</Caption1></TableCell></TableRow>
              )}
              {editableRels.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>{r.name}</TableCell>
                  <TableCell><Text size={200}>{r.fromTable}[{r.fromColumn}]</Text></TableCell>
                  <TableCell><Text size={200}>{r.toTable}[{r.toColumn}]</Text></TableCell>
                  <TableCell><Badge size="small" appearance="outline">{r.cardinality}</Badge></TableCell>
                  <TableCell>{r.crossFilter === 'both' ? 'both' : 'single'}</TableCell>
                  <TableCell>
                    <Switch
                      checked={r.active}
                      disabled={togglingId === r.id}
                      onChange={() => toggleActive(r)}
                      aria-label={`Toggle ${r.name} active`}
                    />
                  </TableCell>
                  <TableCell>
                    <Tooltip content="Delete relationship" relationship="label">
                      <Button size="small" appearance="subtle" icon={<Delete16Regular />} aria-label={`Delete ${r.name}`} onClick={() => deleteRel(r)} />
                    </Tooltip>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* Drill hierarchies. */}
      <SemanticModelHierarchyEditor
        tables={tables}
        hierarchies={hierarchies}
        onCreateHierarchy={createHierarchy}
        onDeleteHierarchy={deleteHierarchy}
      />

      {/* Model-structure Copilot — NL rename / describe / suggest-relationships
          + checkpoint/restore. Works on the Loom-native model (no Power BI /
          Fabric required); reloads the canvas after a structural write. */}
      <div className={s.copilotCard}>
        <ModelStructureCopilot datasetId={datasetId} onModelChanged={() => { void load(); }} />
      </div>

      {/* Read-only TMSL (model.bim) preview — the receipt of what is written. */}
      <div className={s.section}>
        <div className={s.tmslHead}>
          <Database20Regular />
          <Subtitle2>TMSL preview (model.bim)</Subtitle2>
        </div>
        <Caption1 className={s.hint}>
          The full tabular model definition built from your relationships + hierarchies. Inactive relationships show
          <code> isActive: false</code>; each hierarchy emits an ordered <code>levels</code> array.
        </Caption1>
        <div className={s.tmslEditor}>
          <MonacoTextarea
            value={data?.tmsl || '{}'}
            onChange={() => { /* read-only */ }}
            language="json"
            height={220}
            minHeight={160}
            readOnly
            ariaLabel="TMSL model.bim preview"
          />
        </div>
      </div>
    </div>
  );
}
