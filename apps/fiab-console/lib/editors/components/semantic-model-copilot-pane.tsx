'use client';

/**
 * SemanticModelCopilotPane — the Copilot "model structure" pane for the
 * SemanticModelEditor's Model view (Fabric Build 2026 #26 — Copilot modifies
 * semantic models).
 *
 * Natural-language prompt -> structured edit proposals (rename measures, write
 * descriptions, suggest relationships) -> review + apply with an AUTO-CHECKPOINT,
 * plus a checkpoint timeline with one-click restore. Wires to
 * /api/items/semantic-model/[id]/copilot-structure.
 *
 * NO-FABRIC-DEPENDENCY: the structure + checkpoints are Loom-native (Cosmos)
 * and the pane works with NO Power BI / Fabric workspace. When an XMLA backend
 * is opted in, applied edits also write to the live model — disclosed in a
 * Badge. NO-VAPORWARE: an unconfigured Azure OpenAI account renders an honest
 * MessageBar (the rest of the pane — manual checkpoints, restore — stays live).
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Badge, Body1, Button, Caption1, Card, Checkbox, Spinner, Subtitle2, Text, Textarea,
  Tooltip, MessageBar, MessageBarBody, MessageBarTitle, Divider, tokens,
} from '@fluentui/react-components';
import {
  SparkleRegular, ArrowUndo16Regular, BookmarkRegular, Delete16Regular,
  CheckmarkCircle16Filled, Warning16Regular,
} from '@fluentui/react-icons';

// ── Shapes (kept in sync with the BFF route) ────────────────────────────────

type EditKind = 'rename-measure' | 'set-description' | 'add-relationship';

interface StructureEdit {
  kind: EditKind;
  table?: string;
  from?: string; to?: string;
  target?: 'measure' | 'column' | 'table';
  name?: string; description?: string;
  fromTable?: string; fromColumn?: string; toTable?: string; toColumn?: string;
  cardinality?: string; crossFilter?: string;
  reason?: string;
}

interface Proposal { edit: StructureEdit; valid: boolean; validationError?: string }
interface CheckpointMeta { id: string; label: string; createdAt: string; source: 'copilot' | 'manual' }
interface StructureSnapshot {
  tables: { name: string; columns: { name: string }[] }[];
  measures: { table: string; name: string }[];
  relationships: { fromTable: string; fromColumn: string; toTable: string; toColumn: string }[];
}

export interface SemanticModelCopilotPaneProps {
  /** Power BI dataset id OR a Loom content id (loom:<cosmosItemId>). */
  datasetId: string;
  /** Called after an apply / restore so the host can refresh the canvas. */
  onChanged?: () => void;
}

function describeEdit(e: StructureEdit): string {
  switch (e.kind) {
    case 'rename-measure':
      return `Rename measure ${e.table}[${e.from}] → [${e.to}]`;
    case 'set-description':
      return e.target === 'table'
        ? `Describe table ${e.table}: "${e.description}"`
        : `Describe ${e.target} ${e.table}[${e.name}]: "${e.description}"`;
    case 'add-relationship':
      return `Add relationship ${e.fromTable}[${e.fromColumn}] → ${e.toTable}[${e.toColumn}] (${e.cardinality || 'many:one'})`;
    default:
      return JSON.stringify(e);
  }
}

function editBadge(kind: EditKind): string {
  switch (kind) {
    case 'rename-measure': return 'Rename';
    case 'set-description': return 'Describe';
    case 'add-relationship': return 'Relationship';
  }
}

export function SemanticModelCopilotPane({ datasetId, onChanged }: SemanticModelCopilotPaneProps) {
  const [loading, setLoading] = useState(true);
  const [aoaiAvailable, setAoaiAvailable] = useState(true);
  const [aoaiHint, setAoaiHint] = useState<string | null>(null);
  const [xmla, setXmla] = useState<{ available: boolean; backend?: string; database?: string }>({ available: false });
  const [structure, setStructure] = useState<StructureSnapshot | null>(null);
  const [checkpoints, setCheckpoints] = useState<CheckpointMeta[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  const [prompt, setPrompt] = useState('');
  const [proposing, setProposing] = useState(false);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [selected, setSelected] = useState<Record<number, boolean>>({});
  const [applying, setApplying] = useState(false);
  const [busyCp, setBusyCp] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const base = `/api/items/semantic-model/${encodeURIComponent(datasetId)}/copilot-structure`;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(base);
      const j = await res.json();
      if (!j.ok) throw new Error(j.error || `Load failed (${res.status})`);
      setStructure(j.structure || null);
      setCheckpoints(j.checkpoints || []);
      setAoaiAvailable(!!j.aoaiAvailable);
      setXmla(j.xmla || { available: false });
      setNotice(j.notice || null);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [base]);

  useEffect(() => { void load(); }, [load]);

  const propose = useCallback(async () => {
    if (!prompt.trim()) return;
    setProposing(true);
    setError(null);
    setSuccess(null);
    setProposals([]);
    setSelected({});
    try {
      const res = await fetch(base, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: prompt.trim() }),
      });
      const j = await res.json();
      if (res.status === 503 && j.code === 'no_aoai') {
        setAoaiAvailable(false);
        setAoaiHint(j.hint || null);
        return;
      }
      if (!j.ok) throw new Error(j.error || `Propose failed (${res.status})`);
      const list: Proposal[] = j.proposals || [];
      setProposals(list);
      const initial: Record<number, boolean> = {};
      list.forEach((p, i) => { if (p.valid) initial[i] = true; });
      setSelected(initial);
      if (list.length === 0) setSuccess('Copilot returned no applicable structure edits for that request.');
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setProposing(false);
    }
  }, [base, prompt]);

  const apply = useCallback(async () => {
    const edits = proposals.filter((_, i) => selected[i]).map((p) => p.edit);
    if (edits.length === 0) return;
    setApplying(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await fetch(base, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ edits, label: prompt.trim().slice(0, 80) }),
      });
      const j = await res.json();
      if (!j.ok) throw new Error(j.error || `Apply failed (${res.status})`);
      setStructure(j.structure || null);
      setCheckpoints(j.checkpoints || []);
      const backendNotes = (j.appliedEdits || [])
        .filter((a: any) => a.backend && !a.backend.ok)
        .map((a: any) => a.backend.error);
      let msg = `Applied ${j.applied} change${j.applied === 1 ? '' : 's'}. A checkpoint was saved — restore it below to undo.`;
      if (j.skipped?.length) msg += ` ${j.skipped.length} skipped (no longer valid).`;
      if (backendNotes.length) msg += ` Live model write had issues: ${backendNotes[0]}`;
      setSuccess(msg);
      setProposals([]);
      setSelected({});
      onChanged?.();
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setApplying(false);
    }
  }, [base, proposals, selected, prompt, onChanged]);

  const checkpoint = useCallback(async () => {
    setBusyCp('new');
    setError(null);
    try {
      const res = await fetch(base, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'checkpoint', label: 'Manual checkpoint' }),
      });
      const j = await res.json();
      if (!j.ok) throw new Error(j.error || 'Checkpoint failed');
      setCheckpoints(j.checkpoints || []);
      setSuccess('Saved a checkpoint of the current model structure.');
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setBusyCp(null);
    }
  }, [base]);

  const restore = useCallback(async (cpId: string) => {
    setBusyCp(cpId);
    setError(null);
    setSuccess(null);
    try {
      const res = await fetch(base, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'restore', checkpointId: cpId }),
      });
      const j = await res.json();
      if (!j.ok) throw new Error(j.error || 'Restore failed');
      setStructure(j.structure || null);
      setCheckpoints(j.checkpoints || []);
      setSuccess('Restored the model structure to the selected checkpoint. (A checkpoint of the prior state was saved too.)');
      onChanged?.();
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setBusyCp(null);
    }
  }, [base, onChanged]);

  const deleteCp = useCallback(async (cpId: string) => {
    setBusyCp(cpId);
    setError(null);
    try {
      const res = await fetch(`${base}?checkpointId=${encodeURIComponent(cpId)}`, { method: 'DELETE' });
      const j = await res.json();
      if (!j.ok) throw new Error(j.error || 'Delete failed');
      setCheckpoints(j.checkpoints || []);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setBusyCp(null);
    }
  }, [base]);

  if (loading) {
    return <div style={{ padding: tokens.spacingVerticalL }}><Spinner label="Loading model structure…" /></div>;
  }

  const selectedCount = proposals.filter((_, i) => selected[i]).length;
  const measureCount = structure?.measures.length ?? 0;
  const tableCount = structure?.tables.length ?? 0;
  const relCount = structure?.relationships.length ?? 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, padding: tokens.spacingVerticalM, maxWidth: 760 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS }}>
        <SparkleRegular fontSize={20} />
        <Subtitle2>Copilot · model structure</Subtitle2>
        <Badge appearance="tint" color="brand">Preview</Badge>
        {xmla.available
          ? <Tooltip content={`Applied edits also write to the live ${xmla.backend === 'powerbi' ? 'Power BI' : 'Azure Analysis Services'} model (${xmla.database || 'XMLA'}).`} relationship="label">
              <Badge appearance="tint" color="success">Live XMLA</Badge>
            </Tooltip>
          : <Tooltip content="Edits are saved to the Loom-native model (Cosmos). Set LOOM_AAS_SERVER_URL to also write the live tabular model." relationship="label">
              <Badge appearance="tint" color="informative">Loom-native</Badge>
            </Tooltip>}
      </div>
      <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
        {tableCount} table{tableCount === 1 ? '' : 's'} · {measureCount} measure{measureCount === 1 ? '' : 's'} · {relCount} relationship{relCount === 1 ? '' : 's'}.
        Describe a change in plain language — Copilot proposes structured edits (rename measures, write descriptions, suggest relationships) you review before applying. Every apply is checkpointed.
      </Caption1>

      {notice && (
        <MessageBar intent="info"><MessageBarBody>{notice}</MessageBarBody></MessageBar>
      )}
      {error && (
        <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Error</MessageBarTitle>{error}</MessageBarBody></MessageBar>
      )}
      {success && (
        <MessageBar intent="success"><MessageBarBody>{success}</MessageBarBody></MessageBar>
      )}

      {!aoaiAvailable && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Azure OpenAI not configured</MessageBarTitle>
            {aoaiHint || 'Natural-language proposals require an Azure OpenAI chat deployment. Set LOOM_AZURE_OPENAI_ENDPOINT + LOOM_AOAI_DEPLOYMENT and grant the console UAMI "Cognitive Services OpenAI User". Manual checkpoints and restore below still work.'}
          </MessageBarBody>
        </MessageBar>
      )}

      {/* Prompt + propose */}
      <Card style={{ padding: tokens.spacingVerticalM, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS }}>
        <Textarea
          placeholder='e.g. "Rename Sales Amt to Total Sales and add a one-line description to every measure" or "Suggest a relationship between Sales and Date"'
          value={prompt}
          onChange={(_, d) => setPrompt(d.value)}
          rows={3}
          disabled={!aoaiAvailable || proposing}
          resize="vertical"
        />
        <div style={{ display: 'flex', gap: tokens.spacingHorizontalS }}>
          <Button
            appearance="primary"
            icon={proposing ? <Spinner size="tiny" /> : <SparkleRegular />}
            disabled={!aoaiAvailable || proposing || !prompt.trim()}
            onClick={() => void propose()}
          >
            {proposing ? 'Asking Copilot…' : 'Propose edits'}
          </Button>
          <Button
            appearance="secondary"
            icon={busyCp === 'new' ? <Spinner size="tiny" /> : <BookmarkRegular />}
            disabled={busyCp === 'new'}
            onClick={() => void checkpoint()}
          >
            Checkpoint now
          </Button>
        </div>
      </Card>

      {/* Proposals */}
      {proposals.length > 0 && (
        <Card style={{ padding: tokens.spacingVerticalM, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS }}>
          <Subtitle2>Proposed edits ({proposals.length})</Subtitle2>
          {proposals.map((p, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: tokens.spacingHorizontalS, opacity: p.valid ? 1 : 0.7 }}>
              <Checkbox
                checked={!!selected[i]}
                disabled={!p.valid}
                onChange={(_, d) => setSelected((s) => ({ ...s, [i]: !!d.checked }))}
              />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS }}>
                  <Badge size="small" appearance="outline">{editBadge(p.edit.kind)}</Badge>
                  <Body1>{describeEdit(p.edit)}</Body1>
                </div>
                {p.edit.reason && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{p.edit.reason}</Caption1>}
                {!p.valid && (
                  <Caption1 style={{ color: tokens.colorPaletteRedForeground1, display: 'flex', alignItems: 'center', gap: 4 }}>
                    <Warning16Regular /> {p.validationError}
                  </Caption1>
                )}
              </div>
            </div>
          ))}
          <Divider />
          <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center' }}>
            <Button
              appearance="primary"
              icon={applying ? <Spinner size="tiny" /> : <CheckmarkCircle16Filled />}
              disabled={applying || selectedCount === 0}
              onClick={() => void apply()}
            >
              {applying ? 'Applying…' : `Apply ${selectedCount} selected`}
            </Button>
            <Button appearance="subtle" disabled={applying} onClick={() => { setProposals([]); setSelected({}); }}>
              Discard
            </Button>
            <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>A checkpoint is saved automatically before applying.</Caption1>
          </div>
        </Card>
      )}

      {/* Checkpoints */}
      <Card style={{ padding: tokens.spacingVerticalM, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS }}>
        <Subtitle2>Checkpoints ({checkpoints.length})</Subtitle2>
        {checkpoints.length === 0 ? (
          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
            No checkpoints yet. One is saved automatically before each Copilot apply, or use “Checkpoint now”.
          </Caption1>
        ) : (
          checkpoints.map((cp) => (
            <div key={cp.id} style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS }}>
              <Badge size="small" appearance="tint" color={cp.source === 'copilot' ? 'brand' : 'informative'}>
                {cp.source === 'copilot' ? 'Copilot' : 'Manual'}
              </Badge>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                <Text>{cp.label}</Text>
                <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{new Date(cp.createdAt).toLocaleString()}</Caption1>
              </div>
              <Tooltip content="Restore the model structure to this checkpoint" relationship="label">
                <Button
                  size="small" appearance="secondary"
                  icon={busyCp === cp.id ? <Spinner size="tiny" /> : <ArrowUndo16Regular />}
                  disabled={busyCp === cp.id}
                  onClick={() => void restore(cp.id)}
                >
                  Restore
                </Button>
              </Tooltip>
              <Tooltip content="Delete this checkpoint" relationship="label">
                <Button
                  size="small" appearance="subtle" icon={<Delete16Regular />}
                  disabled={busyCp === cp.id}
                  onClick={() => void deleteCp(cp.id)}
                  aria-label={`Delete checkpoint ${cp.label}`}
                />
              </Tooltip>
            </div>
          ))
        )}
      </Card>
    </div>
  );
}
