'use client';

/**
 * ModelStructureCopilot — the "Copilot" pane for the SemanticModelEditor's
 * Model view. It edits the model STRUCTURE over natural language:
 *
 *   - Rename measures      (Copilot proposes clearer names → approve → apply)
 *   - Describe measures    (auto-generate business descriptions → approve → apply)
 *   - Suggest relationships(propose fact→dimension joins → approve → apply)
 *   - Checkpoint / restore (snapshot the model before a bulk change, undo it)
 *
 * Every action calls the real BFF
 * (/api/items/semantic-model/[id]/model-copilot). The "suggest" actions call
 * Azure OpenAI server-side and return PROPOSALS — nothing is written until the
 * operator selects rows and clicks Apply. Per .claude/rules/no-vaporware.md
 * there are no dead controls and no fake toasts; per no-fabric-dependency.md the
 * whole surface works against the Loom-native Cosmos model with NO Power BI /
 * Fabric / Analysis Services bound (XMLA writeback is an honest opt-in badge).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Badge, Button, Caption1, Checkbox, Divider, Input, Spinner, Subtitle2, Text, Tooltip,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle, tokens,
} from '@fluentui/react-components';
import {
  Sparkle20Regular, Rename20Regular, TextDescription20Regular,
  Link20Regular, History20Regular, ArrowUndo16Regular, Save16Regular,
} from '@fluentui/react-icons';

interface MeasureLite { name: string; description: string; expression: string }
interface RelationshipLite {
  id: string; name: string; fromTable: string; fromColumn: string;
  toTable: string; toColumn: string; cardinality: string; active: boolean;
}
interface CheckpointLite {
  id: string; label: string; reason: string; createdAt: string;
  measureCount: number; relationshipCount: number;
}
interface SummaryResponse {
  ok: boolean;
  itemFound?: boolean;
  measures?: MeasureLite[];
  relationships?: RelationshipLite[];
  checkpoints?: CheckpointLite[];
  xmlaWriteback?: boolean;
  note?: string;
  error?: string;
}

interface RenameProposal { from: string; to: string; rationale: string; _sel: boolean }
interface DescProposal { name: string; description: string; _sel: boolean }
interface RelProposal {
  fromTable: string; fromColumn: string; toTable: string; toColumn: string;
  cardinality: string; rationale: string; _sel: boolean;
}

export interface ModelStructureCopilotProps {
  /** Power BI dataset id OR a Loom content id (loom:<cosmosItemId>). */
  datasetId: string;
  /** Optional callback to let the parent panel refresh after a write. */
  onModelChanged?: () => void;
}

function url(datasetId: string): string {
  return `/api/items/semantic-model/${encodeURIComponent(datasetId)}/model-copilot`;
}

async function postAction(datasetId: string, body: Record<string, unknown>): Promise<any> {
  const r = await fetch(url(datasetId), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
}

export function ModelStructureCopilot({ datasetId, onModelChanged }: ModelStructureCopilotProps) {
  const [summary, setSummary] = useState<SummaryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const [renames, setRenames] = useState<RenameProposal[] | null>(null);
  const [descs, setDescs] = useState<DescProposal[] | null>(null);
  const [rels, setRels] = useState<RelProposal[] | null>(null);
  const [checkpointLabel, setCheckpointLabel] = useState('');

  const load = useCallback(async () => {
    if (!datasetId || datasetId === 'new') return;
    setLoading(true); setErr(null);
    try {
      const r = await fetch(url(datasetId));
      const j = (await r.json()) as SummaryResponse;
      if (!j.ok) { setErr(j.error || `HTTP ${r.status}`); return; }
      setSummary(j);
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [datasetId]);

  useEffect(() => { void load(); }, [load]);

  const run = useCallback(async (key: string, body: Record<string, unknown>, onOk: (j: any) => void) => {
    setBusy(key); setErr(null); setInfo(null);
    try {
      const j = await postAction(datasetId, body);
      if (!j.ok) { setErr(j.error || 'request failed'); return; }
      onOk(j);
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setBusy(null);
    }
  }, [datasetId]);

  // ── suggest ──
  const suggestRenames = () => run('suggest-renames', { action: 'suggest-renames' }, (j) => {
    setRenames((j.proposals || []).map((p: any) => ({ ...p, _sel: true })));
    if (!j.proposals?.length) setInfo(j.note || 'No rename suggestions.');
  });
  const suggestDescs = () => run('suggest-descriptions', { action: 'suggest-descriptions' }, (j) => {
    setDescs((j.proposals || []).map((p: any) => ({ ...p, _sel: true })));
    if (!j.proposals?.length) setInfo(j.note || 'No description suggestions.');
  });
  const suggestRels = () => run('suggest-relationships', { action: 'suggest-relationships' }, (j) => {
    setRels((j.proposals || []).map((p: any) => ({ ...p, _sel: true })));
    if (!j.proposals?.length) setInfo(j.note || 'No relationship suggestions.');
  });

  // ── apply ──
  const applyRenames = () => {
    const chosen = (renames || []).filter((p) => p._sel).map((p) => ({ from: p.from, to: p.to }));
    if (!chosen.length) { setErr('Select at least one rename to apply.'); return; }
    run('apply-renames', { action: 'apply-renames', renames: chosen }, (j) => {
      setInfo(`Renamed ${j.applied?.length ?? 0} measure(s)${summary?.xmlaWriteback ? ' (also pushed via XMLA)' : ''}. A checkpoint was taken first.`);
      setRenames(null); void load(); onModelChanged?.();
    });
  };
  const applyDescs = () => {
    const chosen = (descs || []).filter((p) => p._sel).map((p) => ({ name: p.name, description: p.description }));
    if (!chosen.length) { setErr('Select at least one description to apply.'); return; }
    run('apply-descriptions', { action: 'apply-descriptions', descriptions: chosen }, (j) => {
      setInfo(`Saved ${j.updated ?? 0} description(s)${summary?.xmlaWriteback ? ' (also pushed via XMLA)' : ''}.`);
      setDescs(null); void load(); onModelChanged?.();
    });
  };
  const applyRels = () => {
    const chosen = (rels || []).filter((p) => p._sel).map((p) => ({
      fromTable: p.fromTable, fromColumn: p.fromColumn, toTable: p.toTable, toColumn: p.toColumn, cardinality: p.cardinality,
    }));
    if (!chosen.length) { setErr('Select at least one relationship to apply.'); return; }
    run('apply-relationships', { action: 'apply-relationships', relationships: chosen }, (j) => {
      setInfo(`Created ${j.created?.length ?? 0} relationship(s). A checkpoint was taken first.`);
      setRels(null); void load(); onModelChanged?.();
    });
  };

  // ── checkpoints ──
  const takeCheckpoint = () => run('checkpoint', { action: 'checkpoint', label: checkpointLabel.trim() || undefined, reason: 'manual' }, () => {
    setInfo('Checkpoint captured.'); setCheckpointLabel(''); void load();
  });
  const restore = (id: string, label: string) => run('restore', { action: 'restore-checkpoint', checkpointId: id }, (j) => {
    setInfo(`Restored "${label}" — model now has ${j.measures} measure(s), ${j.relationships} relationship(s). (A pre-restore checkpoint was taken so this is undoable.)`);
    void load(); onModelChanged?.();
  });

  const itemFound = summary?.itemFound !== false;
  const measureCount = summary?.measures?.length ?? 0;
  const relCount = summary?.relationships?.length ?? 0;
  const checkpoints = useMemo(() => summary?.checkpoints ?? [], [summary]);

  const toggle = <T extends { _sel: boolean }>(arr: T[] | null, set: (v: T[]) => void, i: number) => {
    if (!arr) return;
    const next = arr.slice(); next[i] = { ...next[i], _sel: !next[i]._sel }; set(next);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Sparkle20Regular style={{ color: tokens.colorBrandForeground1 }} />
        <Subtitle2>Model-structure Copilot</Subtitle2>
        {summary?.xmlaWriteback
          ? <Badge appearance="tint" color="success" size="small">XMLA writeback active</Badge>
          : <Badge appearance="tint" color="informative" size="small">Loom-native (Cosmos)</Badge>}
      </div>
      <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
        Edit the model structure in natural language — rename measures, generate descriptions, suggest relationships, and
        snapshot/restore the model. Suggestions are PROPOSALS; nothing is written until you select rows and Apply.
        Works against the Loom-native model with no Power BI / Fabric / Analysis Services required; when
        <code> LOOM_AAS_XMLA_ENDPOINT</code> is set, applied renames/descriptions are also pushed to the live model.
      </Caption1>

      {loading && <Spinner size="tiny" label="Loading model…" labelPosition="after" />}
      {err && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Copilot error</MessageBarTitle>{err}</MessageBarBody></MessageBar>}
      {info && <MessageBar intent="success"><MessageBarBody>{info}</MessageBarBody></MessageBar>}

      {!itemFound && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Loom-native model required</MessageBarTitle>
            {summary?.note || 'The model-structure Copilot edits Loom-native semantic-model items. This id is a live-only dataset.'}
          </MessageBarBody>
        </MessageBar>
      )}

      {itemFound && (
        <>
          <Caption1 style={{ color: tokens.colorNeutralForeground2 }}>
            Model: <b>{measureCount}</b> measure(s), <b>{relCount}</b> relationship(s).
          </Caption1>

          {/* ── Rename measures ── */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <Rename20Regular />
              <Subtitle2>Rename measures</Subtitle2>
              <Button size="small" appearance="primary" icon={<Sparkle20Regular />} disabled={busy === 'suggest-renames' || !measureCount}
                onClick={suggestRenames}>{busy === 'suggest-renames' ? 'Thinking…' : 'Suggest renames'}</Button>
            </div>
            {renames && renames.length > 0 && (
              <>
                <Table size="small" aria-label="Proposed renames">
                  <TableHeader><TableRow>
                    <TableHeaderCell />
                    <TableHeaderCell>Current</TableHeaderCell>
                    <TableHeaderCell>Proposed</TableHeaderCell>
                    <TableHeaderCell>Why</TableHeaderCell>
                  </TableRow></TableHeader>
                  <TableBody>
                    {renames.map((p, i) => (
                      <TableRow key={`${p.from}-${i}`}>
                        <TableCell><Checkbox checked={p._sel} onChange={() => toggle(renames, setRenames, i)} aria-label={`Select rename ${p.from}`} /></TableCell>
                        <TableCell><Text size={200}>{p.from}</Text></TableCell>
                        <TableCell><Text size={200} weight="semibold">{p.to}</Text></TableCell>
                        <TableCell><Caption1>{p.rationale}</Caption1></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <Button size="small" appearance="primary" icon={<Save16Regular />} style={{ marginTop: 6 }}
                  disabled={busy === 'apply-renames'} onClick={applyRenames}>
                  {busy === 'apply-renames' ? 'Applying…' : 'Apply selected renames'}
                </Button>
              </>
            )}
            {renames && renames.length === 0 && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>No rename suggestions — the measure names look good.</Caption1>}
          </div>

          <Divider />

          {/* ── Describe measures ── */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <TextDescription20Regular />
              <Subtitle2>Generate descriptions</Subtitle2>
              <Button size="small" appearance="primary" icon={<Sparkle20Regular />} disabled={busy === 'suggest-descriptions' || !measureCount}
                onClick={suggestDescs}>{busy === 'suggest-descriptions' ? 'Thinking…' : 'Auto-describe measures'}</Button>
            </div>
            {descs && descs.length > 0 && (
              <>
                <Table size="small" aria-label="Proposed descriptions">
                  <TableHeader><TableRow>
                    <TableHeaderCell />
                    <TableHeaderCell>Measure</TableHeaderCell>
                    <TableHeaderCell>Description</TableHeaderCell>
                  </TableRow></TableHeader>
                  <TableBody>
                    {descs.map((p, i) => (
                      <TableRow key={`${p.name}-${i}`}>
                        <TableCell><Checkbox checked={p._sel} onChange={() => toggle(descs, setDescs, i)} aria-label={`Select description ${p.name}`} /></TableCell>
                        <TableCell><Text size={200} weight="semibold">{p.name}</Text></TableCell>
                        <TableCell><Caption1>{p.description}</Caption1></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <Button size="small" appearance="primary" icon={<Save16Regular />} style={{ marginTop: 6 }}
                  disabled={busy === 'apply-descriptions'} onClick={applyDescs}>
                  {busy === 'apply-descriptions' ? 'Applying…' : 'Apply selected descriptions'}
                </Button>
              </>
            )}
            {descs && descs.length === 0 && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>No description suggestions.</Caption1>}
          </div>

          <Divider />

          {/* ── Suggest relationships ── */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <Link20Regular />
              <Subtitle2>Suggest relationships</Subtitle2>
              <Button size="small" appearance="primary" icon={<Sparkle20Regular />} disabled={busy === 'suggest-relationships'}
                onClick={suggestRels}>{busy === 'suggest-relationships' ? 'Thinking…' : 'Suggest relationships'}</Button>
            </div>
            {rels && rels.length > 0 && (
              <>
                <Table size="small" aria-label="Proposed relationships">
                  <TableHeader><TableRow>
                    <TableHeaderCell />
                    <TableHeaderCell>From</TableHeaderCell>
                    <TableHeaderCell>To</TableHeaderCell>
                    <TableHeaderCell>Cardinality</TableHeaderCell>
                    <TableHeaderCell>Why</TableHeaderCell>
                  </TableRow></TableHeader>
                  <TableBody>
                    {rels.map((p, i) => (
                      <TableRow key={`${p.fromTable}-${p.fromColumn}-${i}`}>
                        <TableCell><Checkbox checked={p._sel} onChange={() => toggle(rels, setRels, i)} aria-label={`Select relationship ${i}`} /></TableCell>
                        <TableCell><Text size={200}>{p.fromTable}[{p.fromColumn}]</Text></TableCell>
                        <TableCell><Text size={200}>{p.toTable}[{p.toColumn}]</Text></TableCell>
                        <TableCell><Badge size="small" appearance="outline">{p.cardinality}</Badge></TableCell>
                        <TableCell><Caption1>{p.rationale}</Caption1></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <Button size="small" appearance="primary" icon={<Save16Regular />} style={{ marginTop: 6 }}
                  disabled={busy === 'apply-relationships'} onClick={applyRels}>
                  {busy === 'apply-relationships' ? 'Applying…' : 'Apply selected relationships'}
                </Button>
              </>
            )}
            {rels && rels.length === 0 && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>No relationship suggestions for the visible schema.</Caption1>}
          </div>

          <Divider />

          {/* ── Checkpoints ── */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <History20Regular />
              <Subtitle2>Checkpoints</Subtitle2>
            </div>
            <Caption1 style={{ color: tokens.colorNeutralForeground3, display: 'block', marginBottom: 6 }}>
              Snapshot the model structure (measures + relationships) before a bulk change. Restore any checkpoint to roll
              back — a pre-restore checkpoint is taken automatically so a restore is itself undoable. Up to 20 are kept.
            </Caption1>
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginBottom: 8 }}>
              <Input size="small" placeholder="Checkpoint label (optional)" value={checkpointLabel}
                onChange={(_e, d) => setCheckpointLabel(d.value)} style={{ minWidth: 240 }} aria-label="Checkpoint label" />
              <Button size="small" icon={<Save16Regular />} disabled={busy === 'checkpoint'} onClick={takeCheckpoint}>
                {busy === 'checkpoint' ? 'Capturing…' : 'Take checkpoint'}
              </Button>
            </div>
            <div style={{ overflow: 'auto', maxHeight: 240, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 4 }}>
              <Table size="small" aria-label="Model checkpoints">
                <TableHeader><TableRow>
                  <TableHeaderCell>Label</TableHeaderCell>
                  <TableHeaderCell>Created</TableHeaderCell>
                  <TableHeaderCell>Measures</TableHeaderCell>
                  <TableHeaderCell>Rels</TableHeaderCell>
                  <TableHeaderCell>Restore</TableHeaderCell>
                </TableRow></TableHeader>
                <TableBody>
                  {checkpoints.length === 0 && (
                    <TableRow><TableCell colSpan={5}><Caption1>No checkpoints yet. Take one before editing the model.</Caption1></TableCell></TableRow>
                  )}
                  {checkpoints.map((c) => (
                    <TableRow key={c.id}>
                      <TableCell><Text size={200}>{c.label}</Text> {c.reason !== 'manual' && <Badge size="extra-small" appearance="outline">{c.reason}</Badge>}</TableCell>
                      <TableCell><Caption1>{new Date(c.createdAt).toLocaleString()}</Caption1></TableCell>
                      <TableCell><Caption1>{c.measureCount}</Caption1></TableCell>
                      <TableCell><Caption1>{c.relationshipCount}</Caption1></TableCell>
                      <TableCell>
                        <Tooltip content="Restore this checkpoint" relationship="label">
                          <Button size="small" appearance="subtle" icon={<ArrowUndo16Regular />} aria-label={`Restore ${c.label}`}
                            disabled={busy === 'restore'} onClick={() => restore(c.id, c.label)} />
                        </Tooltip>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
