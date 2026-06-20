'use client';

/**
 * Governance → Master data management (MDM + reference data).
 *
 * Azure-native, self-built match-merge — no Microsoft Fabric and no partner MDM
 * SaaS (Purview MDM is partner-only). The match/merge engine runs on the
 * workspace's Azure Databricks SQL Warehouse (real Spark SQL); see the Match +
 * merge note below. Tabs:
 *   - Models          : define entity match attributes + survivorship rules
 *   - Reference data  : managed code lists / domains (RDM), versioned
 *   - Match           : run scored candidate-duplicate matching for steward review
 *   - Golden records  : browse the survivorship output table (with source lineage)
 *   - Runs            : match/merge run history
 *
 * Match + merge execute real Spark SQL (levenshtein/soundex, CREATE OR REPLACE
 * TABLE) on the workspace Databricks SQL Warehouse. Honest MessageBar gate when
 * Databricks isn't wired.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Spinner, Button, Badge, Body1, Caption1, Subtitle2, Text,
  TabList, Tab, Field, Input, Dropdown, Option, Textarea,
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Add24Regular, ArrowSync24Regular, Delete20Regular, Edit20Regular, Play20Regular, CheckmarkCircle20Regular } from '@fluentui/react-icons';
import { GovernanceShell } from '@/lib/components/governance-shell';
import { Section } from '@/lib/components/ui/section';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';

type MatchType = 'exact' | 'fuzzy';
type Strategy = 'most-recent' | 'most-complete' | 'source-priority' | 'max' | 'min';
interface MatchAttr { column: string; matchType: MatchType; threshold?: number }
interface SurvRule { column: string; strategy: Strategy }
interface MdmModel {
  id: string; name: string; entity: string; sourceTable: string; catalog?: string; schema?: string;
  recordIdColumn: string; sourceSystemColumn?: string; timestampColumn?: string;
  matchAttributes: MatchAttr[]; survivorship: SurvRule[]; sourcePriority?: string[]; goldenTable: string;
}
interface RefSet { id: string; name: string; domain: string; description?: string; version: number; entries: { code: string; label: string; description?: string; active?: boolean }[]; updatedAt: string }
interface MatchCandidate { idA: string; idB: string; sourceA?: string; sourceB?: string; score: number }
interface MdmRun { id: string; modelId: string; modelName: string; kind: string; ranAt: string; ranBy: string; count: number | null; detail?: string; goldenTable?: string }

const STRATEGIES: { value: Strategy; label: string }[] = [
  { value: 'most-recent', label: 'Most recent' }, { value: 'most-complete', label: 'Most complete' },
  { value: 'source-priority', label: 'Source priority' }, { value: 'max', label: 'Max' }, { value: 'min', label: 'Min' },
];

const useStyles = makeStyles({
  intro: { display: 'block', color: tokens.colorNeutralForeground3, marginBottom: 16, maxWidth: 760 },
  row: { display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' },
  fields: { display: 'flex', flexDirection: 'column', gap: 12, minWidth: 520, maxHeight: '64vh', overflowY: 'auto' },
  attrRow: { display: 'flex', gap: 8, alignItems: 'flex-end' },
  sub: { display: 'block', marginTop: 12, marginBottom: 6 },
  bar: { flex: 1, minWidth: 60, maxWidth: 140, height: 6, backgroundColor: tokens.colorNeutralBackground3, borderRadius: tokens.borderRadiusCircular, overflow: 'hidden' },
  barFill: { height: '100%', display: 'block' },
  pctCell: { display: 'flex', alignItems: 'center', gap: 8 },
});

export default function GovernanceMdmPage() {
  const s = useStyles();
  const [tab, setTab] = useState<'models' | 'refdata' | 'match' | 'golden' | 'runs'>('models');
  const [models, setModels] = useState<MdmModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const loadModels = useCallback(async () => {
    setModelsLoading(true);
    try { const r = await fetch('/api/mdm/models'); const j = await r.json(); if (j.ok) setModels(j.models || []); }
    catch { /* */ } finally { setModelsLoading(false); }
  }, []);
  useEffect(() => { loadModels(); }, [loadModels]);

  return (
    <GovernanceShell sectionTitle="Master data management" sectionBadge="Azure-native">
      <Caption1 className={s.intro}>
        Define golden-record match + survivorship models, manage reference-data code lists, run match/merge on your workspace
        Databricks SQL Warehouse, and steward the resulting golden records. Self-built on Azure — no Microsoft Fabric, no partner MDM SaaS.
      </Caption1>
      <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as any)} style={{ marginBottom: 16 }}>
        <Tab value="models">Models</Tab>
        <Tab value="refdata">Reference data</Tab>
        <Tab value="match">Match</Tab>
        <Tab value="golden">Golden records</Tab>
        <Tab value="runs">Runs</Tab>
      </TabList>
      {tab === 'models' && <ModelsTab models={models} loading={modelsLoading} reload={loadModels} />}
      {tab === 'refdata' && <RefDataTab />}
      {tab === 'match' && <MatchTab models={models} />}
      {tab === 'golden' && <GoldenTab models={models} />}
      {tab === 'runs' && <RunsTab />}
    </GovernanceShell>
  );
}

// ----------------------------- Models -----------------------------
function ModelsTab({ models, loading, reload }: { models: MdmModel[]; loading: boolean; reload: () => void }) {
  const s = useStyles();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<MdmModel | null>(null);
  const [busy, setBusy] = useState(false);
  const [errs, setErrs] = useState<string[] | null>(null);
  const [m, setM] = useState<MdmModel>(blankModel());

  function blankModel(): MdmModel {
    return { id: '', name: '', entity: '', sourceTable: '', recordIdColumn: '', goldenTable: '',
      matchAttributes: [{ column: '', matchType: 'exact' }], survivorship: [], sourcePriority: [] };
  }
  function openNew() { setEditing(null); setM(blankModel()); setErrs(null); setOpen(true); }
  function openEdit(x: MdmModel) { setEditing(x); setM({ ...x, sourcePriority: x.sourcePriority || [] }); setErrs(null); setOpen(true); }

  async function save() {
    setBusy(true); setErrs(null);
    const payload = { ...m, ...(editing ? { id: editing.id } : {}) };
    try {
      const r = await fetch('/api/mdm/models', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      const j = await r.json();
      if (!j.ok) { setErrs(Array.isArray(j.errors) ? j.errors : [j.error || 'Error']); return; }
      setOpen(false); reload();
    } catch (e: any) { setErrs([e?.message || String(e)]); } finally { setBusy(false); }
  }
  async function del(id: string) { await fetch(`/api/mdm/models?id=${encodeURIComponent(id)}`, { method: 'DELETE' }); reload(); }

  const cols: LoomColumn<MdmModel>[] = [
    { key: 'name', label: 'Model', sortable: true, filterable: true, getValue: (x) => x.name, render: (x) => <Body1><strong>{x.name}</strong></Body1> },
    { key: 'entity', label: 'Entity', sortable: true, filterable: true, width: 140, getValue: (x) => x.entity, render: (x) => <Badge appearance="tint" size="small">{x.entity}</Badge> },
    { key: 'source', label: 'Source table', sortable: true, filterable: true, getValue: (x) => x.sourceTable, render: (x) => <Caption1>{x.sourceTable}</Caption1> },
    { key: 'golden', label: 'Golden table', sortable: true, filterable: true, getValue: (x) => x.goldenTable, render: (x) => <Caption1>{x.goldenTable}</Caption1> },
    { key: 'attrs', label: 'Match / Surv.', width: 120, getValue: (x) => x.matchAttributes.length, render: (x) => <Caption1>{x.matchAttributes.length} / {x.survivorship.length}</Caption1> },
    { key: 'actions', label: 'Actions', width: 96, render: (x) => (
      <span style={{ display: 'flex', gap: 8 }} onClick={(e) => e.stopPropagation()}>
        <Button size="small" appearance="transparent" icon={<Edit20Regular />} onClick={() => openEdit(x)} aria-label="Edit" />
        <Button size="small" appearance="transparent" icon={<Delete20Regular />} onClick={() => del(x.id)} aria-label="Delete" />
      </span>) },
  ];

  function setAttr(i: number, patch: Partial<MatchAttr>) { setM((p) => ({ ...p, matchAttributes: p.matchAttributes.map((a, j) => j === i ? { ...a, ...patch } : a) })); }
  function setSurv(i: number, patch: Partial<SurvRule>) { setM((p) => ({ ...p, survivorship: p.survivorship.map((a, j) => j === i ? { ...a, ...patch } : a) })); }

  return (
    <Section title="MDM models" actions={
      <span style={{ display: 'flex', gap: 8 }}>
        <Button icon={<ArrowSync24Regular />} onClick={reload}>Refresh</Button>
        <Button appearance="primary" icon={<Add24Regular />} onClick={openNew}>New model</Button>
      </span>}>
      <LoomDataTable<MdmModel> columns={cols} rows={models} getRowId={(x) => x.id} loading={loading} empty="No MDM models yet. Create one to define match + survivorship for an entity." />

      <Dialog open={open} onOpenChange={(_, d) => { if (!d.open) setOpen(false); }}>
        <DialogSurface style={{ maxWidth: 640 }}>
          <DialogBody>
            <DialogTitle>{editing ? 'Edit model' : 'New MDM model'}</DialogTitle>
            <DialogContent>
              {errs && <MessageBar intent="error" style={{ marginBottom: 12 }}><MessageBarBody>{errs.map((e, i) => <div key={i}>{e}</div>)}</MessageBarBody></MessageBar>}
              <div className={s.fields}>
                <div className={s.row}>
                  <Field label="Model name" required style={{ flex: 1 }}><Input value={m.name} onChange={(_, d) => setM({ ...m, name: d.value })} placeholder="Customer golden" /></Field>
                  <Field label="Entity" required style={{ flex: 1 }}><Input value={m.entity} onChange={(_, d) => setM({ ...m, entity: d.value })} placeholder="Customer" /></Field>
                </div>
                <div className={s.row}>
                  <Field label="Catalog" style={{ flex: 1 }}><Input value={m.catalog || ''} onChange={(_, d) => setM({ ...m, catalog: d.value })} placeholder="main" /></Field>
                  <Field label="Schema" style={{ flex: 1 }}><Input value={m.schema || ''} onChange={(_, d) => setM({ ...m, schema: d.value })} placeholder="mdm" /></Field>
                </div>
                <div className={s.row}>
                  <Field label="Source table" required style={{ flex: 1 }}><Input value={m.sourceTable} onChange={(_, d) => setM({ ...m, sourceTable: d.value })} placeholder="customers_raw" /></Field>
                  <Field label="Golden table" required style={{ flex: 1 }}><Input value={m.goldenTable} onChange={(_, d) => setM({ ...m, goldenTable: d.value })} placeholder="customers_golden" /></Field>
                </div>
                <div className={s.row}>
                  <Field label="Record id column" required style={{ flex: 1 }}><Input value={m.recordIdColumn} onChange={(_, d) => setM({ ...m, recordIdColumn: d.value })} placeholder="record_id" /></Field>
                  <Field label="Source system column" style={{ flex: 1 }}><Input value={m.sourceSystemColumn || ''} onChange={(_, d) => setM({ ...m, sourceSystemColumn: d.value })} placeholder="source_system" /></Field>
                </div>
                <div className={s.row}>
                  <Field label="Timestamp column (most-recent)" style={{ flex: 1 }}><Input value={m.timestampColumn || ''} onChange={(_, d) => setM({ ...m, timestampColumn: d.value })} placeholder="updated_at" /></Field>
                  <Field label="Source priority (comma, highest first)" style={{ flex: 1 }}><Input value={(m.sourcePriority || []).join(', ')} onChange={(_, d) => setM({ ...m, sourcePriority: d.value.split(',').map((x) => x.trim()).filter(Boolean) })} placeholder="CRM, ERP" /></Field>
                </div>

                <Subtitle2 className={s.sub}>Match attributes</Subtitle2>
                {m.matchAttributes.map((a, i) => (
                  <div key={i} className={s.attrRow}>
                    <Field label="Column" style={{ flex: 2 }}><Input value={a.column} onChange={(_, d) => setAttr(i, { column: d.value })} placeholder="email" /></Field>
                    <Field label="Type" style={{ flex: 1 }}>
                      <Dropdown selectedOptions={[a.matchType]} value={a.matchType === 'exact' ? 'Exact' : 'Fuzzy'} onOptionSelect={(_, d) => setAttr(i, { matchType: (d.optionValue as MatchType) || 'exact' })}>
                        <Option value="exact">Exact</Option><Option value="fuzzy">Fuzzy</Option>
                      </Dropdown>
                    </Field>
                    {a.matchType === 'fuzzy' && <Field label="Threshold %" style={{ flex: 1 }}><Input type="number" value={String(a.threshold ?? 80)} onChange={(_, d) => setAttr(i, { threshold: parseInt(d.value, 10) })} /></Field>}
                    <Button size="small" appearance="transparent" icon={<Delete20Regular />} onClick={() => setM((p) => ({ ...p, matchAttributes: p.matchAttributes.filter((_, j) => j !== i) }))} aria-label="Remove" />
                  </div>
                ))}
                <Button size="small" icon={<Add24Regular />} onClick={() => setM((p) => ({ ...p, matchAttributes: [...p.matchAttributes, { column: '', matchType: 'exact' }] }))}>Add match attribute</Button>

                <Subtitle2 className={s.sub}>Survivorship rules</Subtitle2>
                {m.survivorship.map((r, i) => (
                  <div key={i} className={s.attrRow}>
                    <Field label="Column" style={{ flex: 2 }}><Input value={r.column} onChange={(_, d) => setSurv(i, { column: d.value })} placeholder="full_name" /></Field>
                    <Field label="Strategy" style={{ flex: 2 }}>
                      <Dropdown selectedOptions={[r.strategy]} value={STRATEGIES.find((x) => x.value === r.strategy)?.label} onOptionSelect={(_, d) => setSurv(i, { strategy: (d.optionValue as Strategy) || 'most-complete' })}>
                        {STRATEGIES.map((x) => <Option key={x.value} value={x.value}>{x.label}</Option>)}
                      </Dropdown>
                    </Field>
                    <Button size="small" appearance="transparent" icon={<Delete20Regular />} onClick={() => setM((p) => ({ ...p, survivorship: p.survivorship.filter((_, j) => j !== i) }))} aria-label="Remove" />
                  </div>
                ))}
                <Button size="small" icon={<Add24Regular />} onClick={() => setM((p) => ({ ...p, survivorship: [...p.survivorship, { column: '', strategy: 'most-complete' }] }))}>Add survivorship rule</Button>
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
              <Button appearance="primary" onClick={save} disabled={busy}>{editing ? 'Update' : 'Create'}</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </Section>
  );
}

// -------------------------- Reference data --------------------------
function RefDataTab() {
  const s = useStyles();
  const [sets, setSets] = useState<RefSet[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<RefSet | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState(''); const [domain, setDomain] = useState(''); const [desc, setDesc] = useState('');
  const [entriesText, setEntriesText] = useState('');

  const load = useCallback(async () => {
    setError(null);
    try { const r = await fetch('/api/mdm/reference-data'); const j = await r.json(); if (!j.ok) { setError(j.error || 'Failed'); return; } setSets(j.sets || []); }
    catch (e: any) { setError(e?.message || String(e)); }
  }, []);
  useEffect(() => { load(); }, [load]);

  function openNew() { setEditing(null); setName(''); setDomain(''); setDesc(''); setEntriesText(''); setOpen(true); }
  function openEdit(x: RefSet) {
    setEditing(x); setName(x.name); setDomain(x.domain); setDesc(x.description || '');
    setEntriesText(x.entries.map((e) => `${e.code}, ${e.label}`).join('\n')); setOpen(true);
  }
  async function save() {
    setBusy(true);
    const entries = entriesText.split('\n').map((line) => { const [code, ...rest] = line.split(','); return { code: (code || '').trim(), label: rest.join(',').trim() || (code || '').trim() }; }).filter((e) => e.code);
    const payload: any = { name: name.trim(), domain: domain.trim(), description: desc.trim() || undefined, entries };
    if (editing) payload.id = editing.id;
    try { const r = await fetch('/api/mdm/reference-data', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }); const j = await r.json(); if (j.ok) { setOpen(false); load(); } else setError(Array.isArray(j.errors) ? j.errors.join('; ') : j.error); }
    catch (e: any) { setError(e?.message || String(e)); } finally { setBusy(false); }
  }
  async function del(id: string) { await fetch(`/api/mdm/reference-data?id=${encodeURIComponent(id)}`, { method: 'DELETE' }); load(); }

  const cols: LoomColumn<RefSet>[] = [
    { key: 'name', label: 'Set', sortable: true, filterable: true, getValue: (x) => x.name, render: (x) => <Body1><strong>{x.name}</strong></Body1> },
    { key: 'domain', label: 'Domain', sortable: true, filterable: true, width: 160, getValue: (x) => x.domain, render: (x) => <Badge appearance="tint" size="small">{x.domain}</Badge> },
    { key: 'entries', label: 'Entries', sortable: true, width: 100, getValue: (x) => x.entries.length, render: (x) => <Caption1>{x.entries.length}</Caption1> },
    { key: 'version', label: 'Version', sortable: true, width: 100, getValue: (x) => x.version, render: (x) => <Badge appearance="outline" size="small">v{x.version}</Badge> },
    { key: 'actions', label: 'Actions', width: 96, render: (x) => (
      <span style={{ display: 'flex', gap: 8 }} onClick={(e) => e.stopPropagation()}>
        <Button size="small" appearance="transparent" icon={<Edit20Regular />} onClick={() => openEdit(x)} aria-label="Edit" />
        <Button size="small" appearance="transparent" icon={<Delete20Regular />} onClick={() => del(x.id)} aria-label="Delete" />
      </span>) },
  ];

  return (
    <Section title="Reference data" actions={
      <span style={{ display: 'flex', gap: 8 }}>
        <Button icon={<ArrowSync24Regular />} onClick={load}>Refresh</Button>
        <Button appearance="primary" icon={<Add24Regular />} onClick={openNew}>New set</Button>
      </span>}>
      {error && <MessageBar intent="error" style={{ marginBottom: 12 }}><MessageBarBody>{error}</MessageBarBody></MessageBar>}
      {!sets ? <Spinner label="Loading reference data…" /> : (
        <LoomDataTable<RefSet> columns={cols} rows={sets} getRowId={(x) => x.id} empty="No reference-data sets yet. Create a managed code list (e.g. Country, Currency, Status)." />
      )}
      <Dialog open={open} onOpenChange={(_, d) => { if (!d.open) setOpen(false); }}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{editing ? `Edit ${name} (v${(editing?.version || 0) + 1})` : 'New reference-data set'}</DialogTitle>
            <DialogContent>
              <div className={s.fields} style={{ minWidth: 420 }}>
                <div className={s.row}>
                  <Field label="Name" required style={{ flex: 1 }}><Input value={name} onChange={(_, d) => setName(d.value)} placeholder="Country" /></Field>
                  <Field label="Domain" required style={{ flex: 1 }}><Input value={domain} onChange={(_, d) => setDomain(d.value)} placeholder="Geography" /></Field>
                </div>
                <Field label="Description"><Input value={desc} onChange={(_, d) => setDesc(d.value)} /></Field>
                <Field label="Entries (one per line: code, label)" hint="Saving bumps the version.">
                  <Textarea value={entriesText} onChange={(_, d) => setEntriesText(d.value)} rows={8} resize="vertical" placeholder={'US, United States\nGB, United Kingdom'} textarea={{ style: { fontFamily: 'monospace' } }} />
                </Field>
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
              <Button appearance="primary" onClick={save} disabled={busy || !name.trim() || !domain.trim()}>{editing ? 'Save new version' : 'Create'}</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </Section>
  );
}

// ----------------------------- Match -----------------------------
const pairKey = (a: string, b: string) => [a, b].sort().join('|');

function MatchTab({ models }: { models: MdmModel[] }) {
  const s = useStyles();
  const [modelId, setModelId] = useState('');
  const [minScore, setMinScore] = useState('80');
  const [busy, setBusy] = useState(false);
  const [candidates, setCandidates] = useState<MatchCandidate[] | null>(null);
  const [approved, setApproved] = useState<Set<string>>(new Set());
  const [gate, setGate] = useState<{ missing: string; error: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadApproved = useCallback(async (id: string) => {
    if (!id) { setApproved(new Set()); return; }
    try {
      const r = await fetch(`/api/mdm/match/approve?modelId=${encodeURIComponent(id)}`);
      const j = await r.json();
      if (j.ok) setApproved(new Set((j.pairs || []).map((p: any) => pairKey(String(p.idA), String(p.idB)))));
    } catch { /* */ }
  }, []);
  useEffect(() => { loadApproved(modelId); }, [modelId, loadApproved]);

  async function run() {
    setBusy(true); setError(null); setGate(null); setCandidates(null);
    try {
      const r = await fetch('/api/mdm/match', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ modelId, minScore: parseInt(minScore, 10) }) });
      const j = await r.json();
      if (r.status === 503 && j.code === 'not_configured') { setGate({ missing: j.missing, error: j.error }); return; }
      if (!j.ok) { setError(j.error || 'Match failed'); return; }
      setCandidates(j.candidates || []);
    } catch (e: any) { setError(e?.message || String(e)); } finally { setBusy(false); }
  }

  async function approve(c: MatchCandidate) {
    const key = pairKey(c.idA, c.idB);
    setApproved((prev) => new Set(prev).add(key)); // optimistic
    try {
      const r = await fetch('/api/mdm/match/approve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ modelId, pairs: [{ idA: c.idA, idB: c.idB }] }) });
      const j = await r.json();
      if (!j.ok) { setError(j.error || 'Approve failed'); setApproved((prev) => { const n = new Set(prev); n.delete(key); return n; }); }
    } catch (e: any) { setError(e?.message || String(e)); setApproved((prev) => { const n = new Set(prev); n.delete(key); return n; }); }
  }
  async function revoke(c: MatchCandidate) {
    const key = pairKey(c.idA, c.idB);
    setApproved((prev) => { const n = new Set(prev); n.delete(key); return n; }); // optimistic
    try {
      await fetch(`/api/mdm/match/approve?modelId=${encodeURIComponent(modelId)}&idA=${encodeURIComponent(c.idA)}&idB=${encodeURIComponent(c.idB)}`, { method: 'DELETE' });
    } catch (e: any) { setError(e?.message || String(e)); }
  }

  const cols: LoomColumn<MatchCandidate>[] = [
    { key: 'a', label: 'Record A', sortable: true, filterable: true, getValue: (c) => c.idA, render: (c) => <Caption1>{c.idA}{c.sourceA ? ` (${c.sourceA})` : ''}</Caption1> },
    { key: 'b', label: 'Record B', sortable: true, filterable: true, getValue: (c) => c.idB, render: (c) => <Caption1>{c.idB}{c.sourceB ? ` (${c.sourceB})` : ''}</Caption1> },
    { key: 'score', label: 'Match score', sortable: true, width: 200, getValue: (c) => c.score, render: (c) => (
      <span className={s.pctCell}><span className={s.bar}><span className={s.barFill} style={{ width: `${c.score}%`, backgroundColor: c.score >= 95 ? 'var(--loom-accent-green)' : 'var(--loom-accent-amber)' }} /></span><Text size={200}>{c.score.toFixed(1)}%</Text></span>) },
    { key: 'steward', label: 'Stewardship', width: 150, getValue: (c) => (approved.has(pairKey(c.idA, c.idB)) ? 1 : 0), render: (c) => {
      const isApproved = approved.has(pairKey(c.idA, c.idB));
      return (
        <span onClick={(e) => e.stopPropagation()} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {isApproved
            ? <><Badge appearance="filled" color="success" size="small">Approved</Badge><Button size="small" appearance="transparent" onClick={() => revoke(c)} aria-label="Revoke approval">Revoke</Button></>
            : <Button size="small" icon={<CheckmarkCircle20Regular />} onClick={() => approve(c)}>Approve merge</Button>}
        </span>
      );
    } },
  ];

  return (
    <Section title="Match candidates" actions={<Button appearance="primary" icon={<Play20Regular />} onClick={run} disabled={busy || !modelId}>{busy ? 'Matching…' : 'Run match'}</Button>}>
      <div className={s.row} style={{ marginBottom: 16 }}>
        <Field label="Model" style={{ minWidth: 260 }}>
          <Dropdown selectedOptions={modelId ? [modelId] : []} value={models.find((m) => m.id === modelId)?.name || ''} onOptionSelect={(_, d) => setModelId(d.optionValue || '')} placeholder="Pick a model">
            {models.map((m) => <Option key={m.id} value={m.id}>{m.name}</Option>)}
          </Dropdown>
        </Field>
        <Field label="Min score %" style={{ minWidth: 140 }}><Input type="number" value={minScore} onChange={(_, d) => setMinScore(d.value)} /></Field>
      </div>
      {gate && <MessageBar intent="warning" style={{ marginBottom: 12 }}><MessageBarBody><MessageBarTitle>Databricks not configured</MessageBarTitle>{gate.error} Set <code>{gate.missing}</code> on the Console (admin-plane bicep).</MessageBarBody></MessageBar>}
      {error && <MessageBar intent="error" style={{ marginBottom: 12 }}><MessageBarBody>{error}</MessageBarBody></MessageBar>}
      {candidates && <>
        <MessageBar intent="info" style={{ marginBottom: 12 }}><MessageBarBody>
          Approving a pair is an explicit stewardship action — approved pairs are unioned into the golden cluster on the next merge, so fuzzy duplicates that don’t share every exact attribute still survive into one golden record. {approved.size} pair(s) approved for this model.
        </MessageBarBody></MessageBar>
        <LoomDataTable<MatchCandidate> columns={cols} rows={candidates} getRowId={(c) => `${c.idA}|${c.idB}`} empty="No candidate pairs at or above the threshold." />
      </>}
    </Section>
  );
}

// -------------------------- Golden records --------------------------
function GoldenTab({ models }: { models: MdmModel[] }) {
  const s = useStyles();
  const [modelId, setModelId] = useState('');
  const [busy, setBusy] = useState(false);
  const [merging, setMerging] = useState(false);
  const [data, setData] = useState<{ columns: string[]; rows: unknown[][]; goldenTable?: string } | null>(null);
  const [gate, setGate] = useState<{ missing: string; error: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  async function load() {
    if (!modelId) return;
    setBusy(true); setError(null); setGate(null); setData(null);
    try {
      const r = await fetch(`/api/mdm/golden-records?modelId=${encodeURIComponent(modelId)}&limit=200`); const j = await r.json();
      if (r.status === 503 && j.code === 'not_configured') { setGate({ missing: j.missing, error: j.error }); return; }
      if (!j.ok) { setError(`${j.error || 'Failed'}${j.hint ? ` — ${j.hint}` : ''}`); return; }
      setData({ columns: j.columns || [], rows: j.rows || [], goldenTable: j.goldenTable });
    } catch (e: any) { setError(e?.message || String(e)); } finally { setBusy(false); }
  }
  async function merge() {
    if (!modelId) return;
    setMerging(true); setError(null); setGate(null); setInfo(null);
    try {
      const r = await fetch('/api/mdm/merge', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ modelId }) });
      const j = await r.json();
      if (r.status === 503 && j.code === 'not_configured') { setGate({ missing: j.missing, error: j.error }); return; }
      if (!j.ok) { setError(j.error || 'Merge failed'); return; }
      setInfo(j.run?.detail || 'Merge complete.');
      await load();
    } catch (e: any) { setError(e?.message || String(e)); } finally { setMerging(false); }
  }

  const cols: LoomColumn<unknown[]>[] = (data?.columns || []).map((c, i) => ({
    key: c, label: c, sortable: true, filterable: true,
    getValue: (row) => { const v = (row as unknown[])[i]; return v == null ? '' : String(v); },
    render: (row) => <Caption1>{(() => { const v = (row as unknown[])[i]; return v == null ? '—' : Array.isArray(v) ? v.join(', ') : String(v); })()}</Caption1>,
  }));
  const goldenIdIdx = (data?.columns || []).findIndex((c) => c.toLowerCase() === 'golden_id');
  const rowId = (row: unknown[]) => (goldenIdIdx >= 0 ? String(row[goldenIdIdx]) : JSON.stringify(row));

  return (
    <Section title="Golden records" actions={
      <span style={{ display: 'flex', gap: 8 }}>
        <Button onClick={load} disabled={busy || !modelId} icon={<ArrowSync24Regular />}>Load</Button>
        <Button appearance="primary" onClick={merge} disabled={merging || !modelId} icon={<Play20Regular />}>{merging ? 'Merging…' : 'Run merge'}</Button>
      </span>}>
      <div className={s.row} style={{ marginBottom: 16 }}>
        <Field label="Model" style={{ minWidth: 260 }}>
          <Dropdown selectedOptions={modelId ? [modelId] : []} value={models.find((m) => m.id === modelId)?.name || ''} onOptionSelect={(_, d) => setModelId(d.optionValue || '')} placeholder="Pick a model">
            {models.map((m) => <Option key={m.id} value={m.id}>{m.name}</Option>)}
          </Dropdown>
        </Field>
      </div>
      {gate && <MessageBar intent="warning" style={{ marginBottom: 12 }}><MessageBarBody><MessageBarTitle>Databricks not configured</MessageBarTitle>{gate.error} Set <code>{gate.missing}</code> on the Console (admin-plane bicep).</MessageBarBody></MessageBar>}
      {info && <MessageBar intent="success" style={{ marginBottom: 12 }}><MessageBarBody>{info}</MessageBarBody></MessageBar>}
      {error && <MessageBar intent="error" style={{ marginBottom: 12 }}><MessageBarBody>{error}</MessageBarBody></MessageBar>}
      {data && <>
        {data.goldenTable && <Caption1 style={{ display: 'block', marginBottom: 8 }}>Table: <strong>{data.goldenTable}</strong> · {data.rows.length} record(s) shown</Caption1>}
        <LoomDataTable<unknown[]> columns={cols} rows={data.rows} getRowId={rowId} empty="No golden records. Run a merge to produce them." />
      </>}
    </Section>
  );
}

// ------------------------------ Runs ------------------------------
function RunsTab() {
  const [runs, setRuns] = useState<MdmRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setError(null);
    try { const r = await fetch('/api/mdm/golden-records'); const j = await r.json(); if (!j.ok) { setError(j.error || 'Failed'); return; } setRuns(j.runs || []); }
    catch (e: any) { setError(e?.message || String(e)); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const cols: LoomColumn<MdmRun>[] = [
    { key: 'ranAt', label: 'Run at', sortable: true, width: 200, getValue: (r) => r.ranAt, render: (r) => <Caption1>{new Date(r.ranAt).toLocaleString()}</Caption1> },
    { key: 'model', label: 'Model', sortable: true, filterable: true, getValue: (r) => r.modelName, render: (r) => <Body1>{r.modelName}</Body1> },
    { key: 'kind', label: 'Type', sortable: true, width: 110, getValue: (r) => r.kind, render: (r) => <Badge appearance="tint" size="small">{r.kind}</Badge> },
    { key: 'count', label: 'Count', sortable: true, width: 100, getValue: (r) => r.count ?? -1, render: (r) => <Caption1>{r.count ?? '—'}</Caption1> },
    { key: 'detail', label: 'Detail', filterable: true, getValue: (r) => r.detail || '', render: (r) => <Caption1>{r.detail}</Caption1> },
    { key: 'by', label: 'Run by', sortable: true, filterable: true, getValue: (r) => r.ranBy, render: (r) => <Caption1>{r.ranBy}</Caption1> },
  ];
  return (
    <Section title="MDM run history" actions={<Button icon={<ArrowSync24Regular />} onClick={load}>Refresh</Button>}>
      {error && <MessageBar intent="error" style={{ marginBottom: 12 }}><MessageBarBody>{error}</MessageBarBody></MessageBar>}
      {!runs ? <Spinner label="Loading runs…" /> : (
        <LoomDataTable<MdmRun> columns={cols} rows={runs} getRowId={(r) => r.id} empty="No match/merge runs yet." />
      )}
    </Section>
  );
}
