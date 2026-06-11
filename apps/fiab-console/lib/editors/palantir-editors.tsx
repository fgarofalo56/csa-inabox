'use client';

/**
 * Palantir-class migration editors (audit-T29 / deep T50-T57).
 *
 * Six Azure-native surfaces that supersede the doc-only mappings in
 * docs/migrations/palantir-foundry/:
 *   - WorkshopAppEditor       (Workshop  → Atelier)  ontology-bound low-code app
 *   - SlateAppEditor          (Slate)               custom HTML/JS app → Azure SWA
 *   - OntologySdkEditor       (OSDK)                typed SDK over an ontology (DAB)
 *   - ReleaseEnvironmentEditor(Apollo    → Shuttle)  promotion + ARM deploy history
 *   - HealthCheckEditor       (Checks)              Azure Monitor scheduledQueryRules
 *   - AipLogicEditor          (AIP-Logic → Spindle)  no-code typed LLM function
 *
 * Every control calls a real BFF route (Cosmos / Azure Monitor / Azure OpenAI /
 * ARM / deterministic codegen) or shows an honest infra-gate MessageBar — no
 * mocks, no dead buttons, no freeform JSON config (per .claude/rules). All
 * default Azure-native; nothing requires Microsoft Fabric or a Power BI
 * workspace (.claude/rules/no-fabric-dependency.md).
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Subtitle2, Body1, Caption1, Badge, Button, Input, Textarea, Spinner,
  Tab, TabList, Field, Dropdown, Option,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Add20Regular, Dismiss16Regular, Link20Regular, Code20Regular,
  Flash20Regular, Rocket20Regular, Play20Regular, Database20Regular,
  Copy16Regular, Checkmark16Regular,
} from '@fluentui/react-icons';
import { ItemEditorChrome } from './item-editor-chrome';
import { NewItemCreateGate } from './new-item-gate';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';

const useStyles = makeStyles({
  pad: { padding: tokens.spacingVerticalL, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL },
  section: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM,
    padding: tokens.spacingVerticalL, borderRadius: tokens.borderRadiusXLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground1,
  },
  sectionHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  sectionIcon: {
    display: 'flex', alignItems: 'center', justifyContent: 'center', width: '32px', height: '32px',
    borderRadius: tokens.borderRadiusMedium, backgroundColor: tokens.colorBrandBackground2, color: tokens.colorBrandForeground1,
  },
  hint: { color: tokens.colorNeutralForeground3 },
  addBar: {
    display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'flex-end', flexWrap: 'wrap',
    padding: tokens.spacingVerticalM, borderRadius: tokens.borderRadiusLarge, backgroundColor: tokens.colorNeutralBackground2,
  },
  row: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS,
    padding: tokens.spacingVerticalS, borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground1,
  },
  spacer: { flex: 1 },
  grid2: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: tokens.spacingHorizontalM },
  codeWrap: {
    display: 'flex', flexDirection: 'column', overflow: 'hidden',
    borderRadius: tokens.borderRadiusMedium, border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  codeHead: {
    display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
    backgroundColor: tokens.colorNeutralBackground3, borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  code: {
    fontFamily: tokens.fontFamilyMonospace, fontSize: '12px', lineHeight: '18px',
    whiteSpace: 'pre', overflow: 'auto', maxHeight: '420px', margin: 0,
    padding: tokens.spacingVerticalM, backgroundColor: tokens.colorNeutralBackground2,
  },
  tableWrap: { overflowX: 'auto', borderRadius: tokens.borderRadiusMedium, border: `1px solid ${tokens.colorNeutralStroke2}` },
  empty: {
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: tokens.spacingHorizontalS,
    padding: tokens.spacingVerticalXL, color: tokens.colorNeutralForeground3, textAlign: 'center',
    borderRadius: tokens.borderRadiusMedium, border: `1px dashed ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  saveStrip: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM,
    paddingTop: tokens.spacingVerticalS, borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  mutedCaption: { color: tokens.colorNeutralForeground3 },
  errorCaption: { color: tokens.colorPaletteRedForeground1 },
});

/** Code/output viewer with a working copy-to-clipboard control. */
function CodeBlock({ content, ariaLabel }: { content: string; ariaLabel?: string }) {
  const s = useStyles();
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    if (!navigator.clipboard) return;
    void navigator.clipboard.writeText(content).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }).catch(() => { /* clipboard blocked; pre is still selectable */ });
  }, [content]);
  return (
    <div className={s.codeWrap}>
      <div className={s.codeHead}>
        <Button size="small" appearance="subtle" icon={copied ? <Checkmark16Regular /> : <Copy16Regular />} onClick={copy} disabled={!content}>
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <pre className={s.code} aria-label={ariaLabel} tabIndex={0}>{content}</pre>
    </div>
  );
}

// ───────────────────────── shared state hook ─────────────────────────
interface ItemDoc { id: string; displayName: string; state?: Record<string, unknown>; updatedAt?: string }

function useItemState<T extends Record<string, unknown>>(slug: string, id: string, fallback: T) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [state, setStateRaw] = useState<T>(fallback);
  const [dirty, setDirty] = useState(false);
  const suppressDirty = useRef(false);

  const setState = useCallback<typeof setStateRaw>((updater) => {
    setStateRaw(updater as any);
    if (!suppressDirty.current) setDirty(true);
  }, []);

  const load = useCallback(async () => {
    if (!id || id === 'new') { setLoading(false); return; }
    setLoading(true); setError(null);
    try {
      const r = await fetch(`/api/items/${slug}/${encodeURIComponent(id)}`);
      const j = await r.json();
      if (!r.ok) { setError(j?.error || `HTTP ${r.status}`); return; }
      const doc = j as ItemDoc;
      if (doc.state && typeof doc.state === 'object') {
        suppressDirty.current = true;
        setStateRaw({ ...fallback, ...(doc.state as T) });
        setDirty(false);
        queueMicrotask(() => { suppressDirty.current = false; });
      }
      setSavedAt(doc.updatedAt || null);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setLoading(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, id]);
  useEffect(() => { load(); }, [load]);

  const save = useCallback(async (next?: T) => {
    setSaving(true); setError(null);
    if (!id || id === 'new') { setError('Save the item first (no id yet).'); setSaving(false); return false; }
    try {
      const r = await fetch(`/api/items/${slug}/${encodeURIComponent(id)}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ state: next ?? state }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setError(j?.error || `HTTP ${r.status}`); return false; }
      setSavedAt(j?.updatedAt || new Date().toISOString());
      setDirty(false);
      return true;
    } catch (e: any) { setError(e?.message || String(e)); return false; }
    finally { setSaving(false); }
  }, [slug, id, state]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); if (dirty && !saving) save(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dirty, saving, save]);

  return { state, setState, loading, saving, error, savedAt, save, reload: load, dirty };
}

function SaveStrip({ saving, savedAt, error, dirty, onSave }: {
  saving: boolean; savedAt: string | null; error: string | null; dirty: boolean; onSave: () => void;
}) {
  const s = useStyles();
  return (
    <div className={s.saveStrip}>
      <Button appearance="primary" onClick={onSave} disabled={saving || !dirty}>
        {saving ? 'Saving…' : !dirty ? 'Saved' : 'Save (Ctrl+S)'}
      </Button>
      {dirty && <Badge appearance="outline" color="warning">unsaved</Badge>}
      {savedAt && !saving && <Caption1 className={s.mutedCaption}>Saved {new Date(savedAt).toLocaleTimeString()}</Caption1>}
      {error && <Caption1 className={s.errorCaption}>{error}</Caption1>}
    </div>
  );
}

function SectionHead({ icon, title, hint }: { icon: ReactNode; title: string; hint: string }) {
  const s = useStyles();
  return (
    <div className={s.sectionHead}>
      <span className={s.sectionIcon}>{icon}</span>
      <div>
        <Subtitle2>{title}</Subtitle2>
        <Caption1 as="p" block className={s.hint}>{hint}</Caption1>
      </div>
    </div>
  );
}

interface OntologySummary { id: string; displayName: string; workspaceId: string; classCount: number }
interface OntologyClassLite { name: string; parent?: string; description?: string }
interface OntologySurface { id: string; displayName: string; classes: OntologyClassLite[]; links: Array<{ from: string; to: string; kind: string }>; bindings: unknown[] }

/** Shared hook: load the bind-ontology surface for an ontology-bound item type. */
function useOntologyBinding(slug: string, id: string) {
  const [ontologies, setOntologies] = useState<OntologySummary[]>([]);
  const [boundOntologyId, setBoundOntologyId] = useState<string>('');
  const [surface, setSurface] = useState<OntologySurface | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ intent: 'success' | 'error'; text: string } | null>(null);

  const reload = useCallback(async () => {
    try {
      const r = await fetch(`/api/items/${slug}/${encodeURIComponent(id)}/bind-ontology`);
      const ct = r.headers.get('content-type') || '';
      if (!ct.includes('application/json')) { setLoaded(true); return; }
      const j = await r.json();
      if (j?.ok) {
        setOntologies(Array.isArray(j.ontologies) ? j.ontologies : []);
        setBoundOntologyId(j.boundOntologyId || '');
        setSurface(j.surface || null);
      }
    } catch { /* surfaced on action */ }
    finally { setLoaded(true); }
  }, [slug, id]);
  useEffect(() => { void reload(); }, [reload]);

  const bind = useCallback(async (ontologyId: string) => {
    if (!ontologyId) { setMsg({ intent: 'error', text: 'Pick an ontology.' }); return; }
    setBusy(true); setMsg(null);
    try {
      const r = await fetch(`/api/items/${slug}/${encodeURIComponent(id)}/bind-ontology`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ontologyId }),
      });
      const j = await r.json().catch(() => ({}));
      if (!j?.ok) { setMsg({ intent: 'error', text: j?.error || `HTTP ${r.status}` }); return; }
      setBoundOntologyId(ontologyId);
      setSurface(j.surface || null);
      setMsg({ intent: 'success', text: `Bound to ontology "${j.surface?.displayName || ontologyId}" (${j.surface?.classes?.length ?? 0} object types).` });
    } catch (e: any) { setMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setBusy(false); }
  }, [slug, id]);

  return { ontologies, boundOntologyId, surface, loaded, busy, msg, bind };
}

// ───────────────────────── Workshop app (Atelier) ─────────────────────────
interface WorkshopAction { id: string; label: string; kind: 'create' | 'update'; entity: string }
interface WorkshopState {
  boundOntologyId?: string; boundOntologyName?: string;
  objectViews?: string[]; actions?: WorkshopAction[]; [k: string]: unknown;
}

export function WorkshopAppEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const { state, setState, loading, saving, error, savedAt, save, dirty } = useItemState<WorkshopState>('workshop-app', id, { objectViews: [], actions: [] });
  const onto = useOntologyBinding('workshop-app', id);
  const [pickOnto, setPickOnto] = useState('');
  const [actLabel, setActLabel] = useState('');
  const [actKind, setActKind] = useState<'create' | 'update'>('create');
  const [actEntity, setActEntity] = useState('');

  const classes = onto.surface?.classes || [];
  const objectViews = Array.isArray(state.objectViews) ? state.objectViews : [];
  const actions = Array.isArray(state.actions) ? state.actions : [];

  const toggleView = useCallback((name: string) => {
    setState((p) => {
      const cur = Array.isArray(p.objectViews) ? p.objectViews : [];
      return { ...p, objectViews: cur.includes(name) ? cur.filter((v) => v !== name) : [...cur, name] };
    });
  }, [setState]);

  const addAction = useCallback(() => {
    const label = actLabel.trim(); if (!label || !actEntity) return;
    setState((p) => ({ ...p, actions: [...(Array.isArray(p.actions) ? p.actions : []), { id: `act_${Date.now()}`, label, kind: actKind, entity: actEntity }] }));
    setActLabel(''); setActEntity('');
  }, [actLabel, actKind, actEntity, setState]);

  const removeAction = useCallback((aid: string) => {
    setState((p) => ({ ...p, actions: (Array.isArray(p.actions) ? p.actions : []).filter((a) => a.id !== aid) }));
  }, [setState]);

  // Run a real "list" data action against the bound ontology's warehouse source
  // (Synapse dedicated SQL pool via /run-action) or surface an honest gate.
  const [runEntity, setRunEntity] = useState('');
  const [runBusy, setRunBusy] = useState(false);
  const [runMsg, setRunMsg] = useState<{ intent: 'error' | 'warning'; text: string } | null>(null);
  const [runResult, setRunResult] = useState<{ entityType: string; columns: string[]; rows: unknown[][] } | null>(null);
  const runActionList = useCallback(async (entityType: string) => {
    setRunBusy(true); setRunMsg(null); setRunResult(null); setRunEntity(entityType);
    try {
      const r = await fetch(`/api/items/workshop-app/${encodeURIComponent(id)}/run-action`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ entityType, op: 'list', top: 50 }),
      });
      const j = await r.json().catch(() => ({}));
      if (!j?.ok) {
        const gate = j?.gate ? ` ${j.gate.remediation || ''}` : '';
        setRunMsg({ intent: j?.gate ? 'warning' : 'error', text: `${j?.error || `HTTP ${r.status}`}${gate}` });
        return;
      }
      setRunResult({ entityType, columns: Array.isArray(j.columns) ? j.columns : [], rows: Array.isArray(j.rows) ? j.rows : [] });
    } catch (e: any) { setRunMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setRunBusy(false); }
  }, [id]);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'App', actions: [
        { label: saving ? 'Saving…' : 'Save', onClick: () => save(), disabled: saving || !dirty },
      ]},
    ]},
  ], [save, saving, dirty]);

  if (id === 'new') return <NewItemCreateGate item={item} createLabel="Create Workshop app" intro="An operational low-code app bound to a Loom Ontology. Object views render the ontology's entity types; actions write back through the bound Lakehouse/Warehouse. Azure-native — no Fabric required." />;

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={
      <div className={s.pad}>
        {loading && <Spinner size="small" label="Loading…" labelPosition="after" />}
        <MessageBar intent="info"><MessageBarBody>
          <MessageBarTitle>Workshop app (Palantir Workshop → Atelier)</MessageBarTitle>
          Bind a Loom Ontology, choose which object types become app pages, and define write-back actions. The app runs on Azure Container Apps over the ontology's bound Lakehouse/Warehouse — no Microsoft Fabric required.
        </MessageBarBody></MessageBar>

        <div className={s.section}>
          <SectionHead icon={<Link20Regular />} title="Bound ontology" hint="Pick a saved Ontology; its object/link types become the app's object views." />
          {!onto.loaded ? <div className={s.empty}><Spinner size="tiny" /></div> : onto.ontologies.length === 0 ? (
            <MessageBar intent="warning"><MessageBarBody>No ontologies found. Create an Ontology item first, then bind it here.</MessageBarBody></MessageBar>
          ) : (
            <div className={s.addBar}>
              <Field label="Ontology" style={{ minWidth: 280 }}>
                <Dropdown value={onto.ontologies.find((o) => o.id === (pickOnto || onto.boundOntologyId))?.displayName || ''}
                  selectedOptions={[(pickOnto || onto.boundOntologyId)]}
                  onOptionSelect={(_, d) => setPickOnto(d.optionValue || '')} placeholder="Select an ontology">
                  {onto.ontologies.map((o) => <Option key={o.id} value={o.id} text={o.displayName}>{`${o.displayName} (${o.classCount} objects)`}</Option>)}
                </Dropdown>
              </Field>
              <Button appearance="primary" icon={<Database20Regular />} disabled={onto.busy || !(pickOnto || onto.boundOntologyId)} onClick={() => onto.bind(pickOnto || onto.boundOntologyId)}>
                {onto.busy ? 'Binding…' : 'Bind ontology'}
              </Button>
            </div>
          )}
          {onto.msg && <MessageBar intent={onto.msg.intent}><MessageBarBody>{onto.msg.text}</MessageBarBody></MessageBar>}
        </div>

        <div className={s.section}>
          <SectionHead icon={<Database20Regular />} title="Object views" hint="Choose which ontology object types render as app pages." />
          {classes.length === 0 ? <div className={s.empty}><Caption1>Bind an ontology with object types to choose views.</Caption1></div> : (
            classes.map((c) => (
              <div key={c.name} className={s.row}>
                <Body1><strong>{c.name}</strong></Body1>
                {c.parent && <Caption1 className={s.hint}>: {c.parent}</Caption1>}
                <span className={s.spacer} />
                <Button size="small" appearance="subtle" icon={<Play20Regular />} disabled={runBusy} onClick={() => runActionList(c.name)} title="List rows from the bound warehouse source">
                  {runBusy && runEntity === c.name ? 'Running…' : 'List rows'}
                </Button>
                <Button size="small" appearance={objectViews.includes(c.name) ? 'primary' : 'outline'} onClick={() => toggleView(c.name)}>
                  {objectViews.includes(c.name) ? 'In app' : 'Add view'}
                </Button>
              </div>
            ))
          )}
          {runMsg && <MessageBar intent={runMsg.intent}><MessageBarBody>{runMsg.text}</MessageBarBody></MessageBar>}
          {runResult && (
            <div className={s.tableWrap}>
            <Table size="small" aria-label={`${runResult.entityType} rows`}>
              <TableHeader><TableRow>{runResult.columns.map((col) => <TableHeaderCell key={col}>{col}</TableHeaderCell>)}</TableRow></TableHeader>
              <TableBody>
                {runResult.rows.slice(0, 50).map((row, ri) => (
                  <TableRow key={ri}>{(Array.isArray(row) ? row : []).map((cell, ci) => <TableCell key={ci}>{cell === null || cell === undefined ? '' : String(cell)}</TableCell>)}</TableRow>
                ))}
              </TableBody>
            </Table>
            </div>
          )}
        </div>

        <div className={s.section}>
          <SectionHead icon={<Flash20Regular />} title="Write-back actions" hint="Define create / update actions over the bound object types." />
          <div className={s.addBar}>
            <Field label="Action label"><Input value={actLabel} onChange={(_, d) => setActLabel(d.value)} placeholder="e.g. Approve order" /></Field>
            <Field label="Kind"><Dropdown value={actKind} selectedOptions={[actKind]} onOptionSelect={(_, d) => setActKind((d.optionValue as 'create' | 'update') || 'create')}>
              <Option value="create">create</Option><Option value="update">update</Option>
            </Dropdown></Field>
            <Field label="Object type" style={{ minWidth: 200 }}>
              <Dropdown value={actEntity} selectedOptions={actEntity ? [actEntity] : []} onOptionSelect={(_, d) => setActEntity(d.optionValue || '')} placeholder={classes.length ? 'Select object' : 'Bind an ontology first'}>
                {classes.map((c) => <Option key={c.name} value={c.name}>{c.name}</Option>)}
              </Dropdown>
            </Field>
            <Button appearance="primary" icon={<Add20Regular />} disabled={!actLabel.trim() || !actEntity} onClick={addAction}>Add action</Button>
          </div>
          {actions.length === 0 ? <div className={s.empty}><Caption1>No actions yet.</Caption1></div> : actions.map((a) => (
            <div key={a.id} className={s.row}>
              <Badge appearance="tint" color={a.kind === 'create' ? 'success' : 'brand'}>{a.kind}</Badge>
              <Body1><strong>{a.label}</strong></Body1>
              <Caption1 className={s.hint}>→ {a.entity}</Caption1>
              <span className={s.spacer} />
              <Button size="small" appearance="subtle" icon={<Dismiss16Regular />} aria-label={`Remove ${a.label}`} onClick={() => removeAction(a.id)}>Remove</Button>
            </div>
          ))}
        </div>

        <SaveStrip saving={saving} savedAt={savedAt} error={error} dirty={dirty} onSave={() => save()} />
      </div>
    } />
  );
}

// ───────────────────────── Ontology SDK (OSDK) ─────────────────────────
interface OsdkState { boundOntologyId?: string; boundOntologyName?: string; objectCount?: number; lastGeneratedAt?: string; [k: string]: unknown }

export function OntologySdkEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const { loading } = useItemState<OsdkState>('ontology-sdk', id, {});
  const onto = useOntologyBinding('ontology-sdk', id);
  const [pickOnto, setPickOnto] = useState('');
  const [genBusy, setGenBusy] = useState(false);
  const [genErr, setGenErr] = useState<string | null>(null);
  const [gen, setGen] = useState<{ typescript: string; python: string; dabConfig: unknown; objectCount: number } | null>(null);
  const [tab, setTab] = useState<'ts' | 'py' | 'dab'>('ts');
  const [pubBusy, setPubBusy] = useState(false);
  const [pubMsg, setPubMsg] = useState<{ intent: 'success' | 'error' | 'warning'; text: string } | null>(null);

  const generate = useCallback(async () => {
    setGenBusy(true); setGenErr(null);
    try {
      const r = await fetch(`/api/items/ontology-sdk/${encodeURIComponent(id)}/generate`, { method: 'POST' });
      const j = await r.json().catch(() => ({}));
      if (!j?.ok) { setGenErr(j?.error || `HTTP ${r.status}`); return; }
      setGen({ typescript: j.typescript, python: j.python, dabConfig: j.dabConfig, objectCount: j.objectCount });
    } catch (e: any) { setGenErr(e?.message || String(e)); }
    finally { setGenBusy(false); }
  }, [id]);

  const publish = useCallback(async () => {
    setPubBusy(true); setPubMsg(null);
    try {
      const r = await fetch(`/api/items/ontology-sdk/${encodeURIComponent(id)}/publish`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
      });
      const j = await r.json().catch(() => ({}));
      if (!j?.ok) {
        const gate = j?.gate ? ` ${j.gate.remediation || ''}` : '';
        setPubMsg({ intent: j?.gate ? 'warning' : 'error', text: `${j?.error || `HTTP ${r.status}`}${gate}` });
        return;
      }
      setPubMsg({ intent: 'success', text: `Published to APIM as "${j.api?.displayName}" at /${j.api?.path}.` });
    } catch (e: any) { setPubMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setPubBusy(false); }
  }, [id]);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'SDK', actions: [
        { label: genBusy ? 'Generating…' : 'Generate SDK', onClick: generate, disabled: genBusy || !onto.boundOntologyId },
        { label: pubBusy ? 'Publishing…' : 'Publish to APIM', onClick: publish, disabled: pubBusy || !onto.boundOntologyId },
      ]},
    ]},
  ], [generate, genBusy, onto.boundOntologyId, publish, pubBusy]);

  if (id === 'new') return <NewItemCreateGate item={item} createLabel="Create Ontology SDK" intro="A typed TypeScript / Python client + REST Data API over an Ontology's object, link, and action types. Generated via Microsoft Data API Builder on Azure Container Apps — no Fabric required." />;

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={
      <div className={s.pad}>
        {loading && <Spinner size="small" label="Loading…" labelPosition="after" />}
        <MessageBar intent="info"><MessageBarBody>
          <MessageBarTitle>Ontology SDK (Palantir OSDK)</MessageBarTitle>
          Bind an Ontology, then generate a typed TypeScript + Python client and a real dab-config.json over its object / link types. The Data API runs on Microsoft Data API Builder (Azure Container Apps) and publishes through APIM — no Fabric required.
        </MessageBarBody></MessageBar>

        <div className={s.section}>
          <SectionHead icon={<Link20Regular />} title="Bound ontology" hint="Its object / link / action types define the typed SDK surface." />
          {!onto.loaded ? <div className={s.empty}><Spinner size="tiny" /></div> : onto.ontologies.length === 0 ? (
            <MessageBar intent="warning"><MessageBarBody>No ontologies found. Create an Ontology item first, then bind it here.</MessageBarBody></MessageBar>
          ) : (
            <div className={s.addBar}>
              <Field label="Ontology" style={{ minWidth: 280 }}>
                <Dropdown value={onto.ontologies.find((o) => o.id === (pickOnto || onto.boundOntologyId))?.displayName || ''}
                  selectedOptions={[(pickOnto || onto.boundOntologyId)]} onOptionSelect={(_, d) => setPickOnto(d.optionValue || '')} placeholder="Select an ontology">
                  {onto.ontologies.map((o) => <Option key={o.id} value={o.id} text={o.displayName}>{`${o.displayName} (${o.classCount} objects)`}</Option>)}
                </Dropdown>
              </Field>
              <Button appearance="primary" icon={<Database20Regular />} disabled={onto.busy || !(pickOnto || onto.boundOntologyId)} onClick={() => onto.bind(pickOnto || onto.boundOntologyId)}>
                {onto.busy ? 'Binding…' : 'Bind ontology'}
              </Button>
              <Button appearance="outline" icon={<Code20Regular />} disabled={genBusy || !onto.boundOntologyId} onClick={generate}>
                {genBusy ? 'Generating…' : 'Generate SDK'}
              </Button>
              <Button appearance="outline" icon={<Rocket20Regular />} disabled={pubBusy || !onto.boundOntologyId} onClick={publish}>
                {pubBusy ? 'Publishing…' : 'Publish to APIM'}
              </Button>
            </div>
          )}
          {onto.msg && <MessageBar intent={onto.msg.intent}><MessageBarBody>{onto.msg.text}</MessageBarBody></MessageBar>}
          {genErr && <MessageBar intent="error"><MessageBarBody>{genErr}</MessageBarBody></MessageBar>}
          {pubMsg && <MessageBar intent={pubMsg.intent}><MessageBarBody>{pubMsg.text}</MessageBarBody></MessageBar>}
        </div>

        {gen && (
          <div className={s.section}>
            <SectionHead icon={<Code20Regular />} title={`Generated SDK (${gen.objectCount} object types)`} hint="Real typed clients + dab-config.json. Copy into your project." />
            <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as 'ts' | 'py' | 'dab')}>
              <Tab value="ts">TypeScript</Tab><Tab value="py">Python</Tab><Tab value="dab">dab-config.json</Tab>
            </TabList>
            <CodeBlock ariaLabel="Generated SDK source" content={tab === 'ts' ? gen.typescript : tab === 'py' ? gen.python : JSON.stringify(gen.dabConfig, null, 2)} />
          </div>
        )}
      </div>
    } />
  );
}

// ───────────────────────── Slate app ─────────────────────────
interface SlateWidgetDef { id: string; title: string; kind: 'table' | 'chart' | 'metric'; query: string }
interface SlateState { apiBaseUrl?: string; widgets?: SlateWidgetDef[]; lastGeneratedAt?: string; [k: string]: unknown }

export function SlateAppEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const { state, setState, loading, saving, error, savedAt, save, dirty } = useItemState<SlateState>('slate-app', id, { apiBaseUrl: '/api', widgets: [] });
  const [wTitle, setWTitle] = useState('');
  const [wKind, setWKind] = useState<'table' | 'chart' | 'metric'>('table');
  const [wQuery, setWQuery] = useState('');
  const [genBusy, setGenBusy] = useState(false);
  const [genErr, setGenErr] = useState<string | null>(null);
  const [files, setFiles] = useState<Array<{ name: string; content: string }>>([]);
  const [fileTab, setFileTab] = useState('index.html');

  const widgets = Array.isArray(state.widgets) ? state.widgets : [];

  const addWidget = useCallback(() => {
    const title = wTitle.trim(); const query = wQuery.trim();
    if (!title || !query) return;
    setState((p) => ({ ...p, widgets: [...(Array.isArray(p.widgets) ? p.widgets : []), { id: `w_${Date.now()}`, title, kind: wKind, query }] }));
    setWTitle(''); setWQuery('');
  }, [wTitle, wKind, wQuery, setState]);

  const removeWidget = useCallback((wid: string) => {
    setState((p) => ({ ...p, widgets: (Array.isArray(p.widgets) ? p.widgets : []).filter((w) => w.id !== wid) }));
  }, [setState]);

  const generate = useCallback(async () => {
    setGenBusy(true); setGenErr(null);
    try {
      const r = await fetch(`/api/items/slate-app/${encodeURIComponent(id)}/generate`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ apiBaseUrl: state.apiBaseUrl || '/api', widgets }),
      });
      const j = await r.json().catch(() => ({}));
      if (!j?.ok) { setGenErr(j?.error || `HTTP ${r.status}`); return; }
      setFiles(Array.isArray(j.files) ? j.files : []);
      setFileTab((j.files?.[0]?.name) || 'index.html');
    } catch (e: any) { setGenErr(e?.message || String(e)); }
    finally { setGenBusy(false); }
  }, [id, state.apiBaseUrl, widgets]);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'App', actions: [
        { label: saving ? 'Saving…' : 'Save', onClick: () => save(), disabled: saving || !dirty },
        { label: genBusy ? 'Generating…' : 'Generate bundle', onClick: generate, disabled: genBusy || widgets.length === 0 },
      ]},
    ]},
  ], [save, saving, dirty, generate, genBusy, widgets.length]);

  if (id === 'new') return <NewItemCreateGate item={item} createLabel="Create Slate app" intro="A custom HTML/JS dashboard app over an Ontology Data API. Loom generates a deployable Azure Static Web Apps bundle — no Fabric required." />;

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={
      <div className={s.pad}>
        {loading && <Spinner size="small" label="Loading…" labelPosition="after" />}
        <MessageBar intent="info"><MessageBarBody>
          <MessageBarTitle>Slate app (Palantir Slate)</MessageBarTitle>
          Compose widgets over an Ontology Data API endpoint, then generate a deployable Azure Static Web Apps bundle (index.html + app.js + config). No Microsoft Fabric required.
        </MessageBarBody></MessageBar>

        <div className={s.section}>
          <SectionHead icon={<Database20Regular />} title="Data API base" hint="The DAB / Ontology-SDK REST base the generated app calls (e.g. /api or an APIM URL)." />
          <Field label="API base URL"><Input value={String(state.apiBaseUrl || '/api')} onChange={(_, d) => setState((p) => ({ ...p, apiBaseUrl: d.value }))} placeholder="/api" /></Field>
        </div>

        <div className={s.section}>
          <SectionHead icon={<Add20Regular />} title="Widgets" hint="Each widget binds a title to a REST query path (e.g. customer)." />
          <div className={s.addBar}>
            <Field label="Title"><Input value={wTitle} onChange={(_, d) => setWTitle(d.value)} placeholder="Open orders" /></Field>
            <Field label="Kind"><Dropdown value={wKind} selectedOptions={[wKind]} onOptionSelect={(_, d) => setWKind((d.optionValue as 'table' | 'chart' | 'metric') || 'table')}>
              <Option value="table">table</Option><Option value="metric">metric</Option><Option value="chart">chart</Option>
            </Dropdown></Field>
            <Field label="Query path" style={{ minWidth: 200 }}><Input value={wQuery} onChange={(_, d) => setWQuery(d.value)} placeholder="order" /></Field>
            <Button appearance="primary" icon={<Add20Regular />} disabled={!wTitle.trim() || !wQuery.trim()} onClick={addWidget}>Add widget</Button>
          </div>
          {widgets.length === 0 ? <div className={s.empty}><Caption1>No widgets yet.</Caption1></div> : widgets.map((w) => (
            <div key={w.id} className={s.row}>
              <Badge appearance="tint">{w.kind}</Badge>
              <Body1><strong>{w.title}</strong></Body1>
              <Caption1 className={s.hint}>→ {w.query}</Caption1>
              <span className={s.spacer} />
              <Button size="small" appearance="subtle" icon={<Dismiss16Regular />} aria-label={`Remove ${w.title}`} onClick={() => removeWidget(w.id)}>Remove</Button>
            </div>
          ))}
          {genErr && <MessageBar intent="error"><MessageBarBody>{genErr}</MessageBarBody></MessageBar>}
        </div>

        {files.length > 0 && (
          <div className={s.section}>
            <SectionHead icon={<Code20Regular />} title="Generated Static Web Apps bundle" hint="Copy these files into your SWA repo, or wire them through a release-environment promotion." />
            <TabList selectedValue={fileTab} onTabSelect={(_, d) => setFileTab(d.value as string)}>
              {files.map((f) => <Tab key={f.name} value={f.name}>{f.name}</Tab>)}
            </TabList>
            <CodeBlock ariaLabel={`${fileTab} source`} content={files.find((f) => f.name === fileTab)?.content || ''} />
          </div>
        )}

        <SaveStrip saving={saving} savedAt={savedAt} error={error} dirty={dirty} onSave={() => save()} />
      </div>
    } />
  );
}

// ───────────────────────── Release environment (Apollo → Shuttle) ─────────────────────────
interface ReleaseStage { id: string; name: string; workspace?: string }
interface Promotion { id: string; fromStage: string; toStage: string; note?: string; environmentDefinition?: string; promotedAt: string; promotedBy?: string }
interface ReleaseState { stages?: ReleaseStage[]; promotions?: Promotion[]; [k: string]: unknown }
interface ArmDeploymentLite { name: string; resourceGroup?: string; provisioningState?: string; timestamp?: string }

export function ReleaseEnvironmentEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const { state, setState, loading, saving, error, savedAt, save, dirty } = useItemState<ReleaseState>('release-environment', id, { stages: [], promotions: [] });
  const [stageName, setStageName] = useState('');
  const [stageWs, setStageWs] = useState('');
  const [fromStage, setFromStage] = useState('');
  const [toStage, setToStage] = useState('');
  const [promoNote, setPromoNote] = useState('');
  const [envDef, setEnvDef] = useState('');
  const [promotions, setPromotions] = useState<Promotion[]>([]);
  const [devCenter, setDevCenter] = useState(false);
  const [promoMsg, setPromoMsg] = useState<{ intent: 'success' | 'error'; text: string } | null>(null);
  const [arm, setArm] = useState<ArmDeploymentLite[] | null>(null);
  const [armGate, setArmGate] = useState<string | null>(null);
  const [armBusy, setArmBusy] = useState(false);

  const stages = Array.isArray(state.stages) ? state.stages : [];

  // Load promotions + devcenter flag from the promote route (real Cosmos).
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(`/api/items/release-environment/${encodeURIComponent(id)}/promote`);
        const j = await r.json().catch(() => ({}));
        if (j?.ok) { setPromotions(Array.isArray(j.promotions) ? j.promotions : []); setDevCenter(!!j.devCenterConfigured); }
      } catch { /* ignore */ }
    })();
  }, [id]);

  const loadArm = useCallback(async () => {
    setArmBusy(true); setArmGate(null);
    try {
      const r = await fetch(`/api/items/release-environment/${encodeURIComponent(id)}/arm`);
      const j = await r.json().catch(() => ({}));
      if (j?.ok) setArm(Array.isArray(j.deployments) ? j.deployments : []);
      else if (j?.gate) setArmGate(j.gate.remediation || j.gate.reason || 'Azure Resource Manager not configured.');
      else setArmGate(j?.error || `HTTP ${r.status}`);
    } catch (e: any) { setArmGate(e?.message || String(e)); }
    finally { setArmBusy(false); }
  }, [id]);

  const addStage = useCallback(() => {
    const name = stageName.trim(); if (!name) return;
    setState((p) => ({ ...p, stages: [...(Array.isArray(p.stages) ? p.stages : []), { id: `st_${Date.now()}`, name, workspace: stageWs.trim() || undefined }] }));
    setStageName(''); setStageWs('');
  }, [stageName, stageWs, setState]);

  const removeStage = useCallback((sid: string) => {
    setState((p) => ({ ...p, stages: (Array.isArray(p.stages) ? p.stages : []).filter((x) => x.id !== sid) }));
  }, [setState]);

  const promote = useCallback(async () => {
    if (!fromStage || !toStage) { setPromoMsg({ intent: 'error', text: 'Pick both stages.' }); return; }
    setPromoMsg(null);
    try {
      const r = await fetch(`/api/items/release-environment/${encodeURIComponent(id)}/promote`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fromStage, toStage, note: promoNote.trim() || undefined, environmentDefinition: envDef.trim() || undefined }),
      });
      const j = await r.json().catch(() => ({}));
      if (!j?.ok) { setPromoMsg({ intent: 'error', text: j?.error || `HTTP ${r.status}` }); return; }
      setPromotions(Array.isArray(j.promotions) ? j.promotions : []);
      setPromoMsg({ intent: 'success', text: `Promoted ${fromStage} → ${toStage}.` });
      setPromoNote('');
    } catch (e: any) { setPromoMsg({ intent: 'error', text: e?.message || String(e) }); }
  }, [id, fromStage, toStage, promoNote, envDef]);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Environment', actions: [
        { label: saving ? 'Saving…' : 'Save', onClick: () => save(), disabled: saving || !dirty },
        { label: armBusy ? 'Loading…' : 'ARM history', onClick: loadArm, disabled: armBusy },
      ]},
    ]},
  ], [save, saving, dirty, loadArm, armBusy]);

  if (id === 'new') return <NewItemCreateGate item={item} createLabel="Create release environment" intro="Promotion / release orchestration across workspaces, with real Azure Resource Manager deployment history and optional Azure Deployment Environments. No Fabric required." />;

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={
      <div className={s.pad}>
        {loading && <Spinner size="small" label="Loading…" labelPosition="after" />}
        <MessageBar intent="info"><MessageBarBody>
          <MessageBarTitle>Release environment (Palantir Apollo → Shuttle)</MessageBarTitle>
          Model dev → test → prod stages over Loom workspaces, review real Azure Resource Manager deployments, and record promotions.{devCenter ? ' Azure Deployment Environments is configured — name a catalog environment definition when promoting.' : ' Set LOOM_DEVCENTER_PROJECT to provision catalog-driven Azure Deployment Environments.'} No Fabric required.
        </MessageBarBody></MessageBar>

        <div className={s.section}>
          <SectionHead icon={<Rocket20Regular />} title="Stages" hint="Promotion stages, each mapped to a Loom workspace." />
          <div className={s.addBar}>
            <Field label="Stage name"><Input value={stageName} onChange={(_, d) => setStageName(d.value)} placeholder="prod" /></Field>
            <Field label="Workspace (optional)"><Input value={stageWs} onChange={(_, d) => setStageWs(d.value)} placeholder="workspace id / name" /></Field>
            <Button appearance="primary" icon={<Add20Regular />} disabled={!stageName.trim()} onClick={addStage}>Add stage</Button>
          </div>
          {stages.length === 0 ? <div className={s.empty}><Caption1>No stages yet.</Caption1></div> : stages.map((st) => (
            <div key={st.id} className={s.row}>
              <Badge appearance="tint" color="brand">{st.name}</Badge>
              {st.workspace && <Caption1 className={s.hint}>↳ {st.workspace}</Caption1>}
              <span className={s.spacer} />
              <Button size="small" appearance="subtle" icon={<Dismiss16Regular />} aria-label={`Remove ${st.name}`} onClick={() => removeStage(st.id)}>Remove</Button>
            </div>
          ))}
        </div>

        <div className={s.section}>
          <SectionHead icon={<Flash20Regular />} title="Promote" hint="Record a promotion between two stages." />
          <div className={s.addBar}>
            <Field label="From" style={{ minWidth: 140 }}><Dropdown value={fromStage} selectedOptions={fromStage ? [fromStage] : []} onOptionSelect={(_, d) => setFromStage(d.optionValue || '')} placeholder="from">
              {stages.map((st) => <Option key={st.id} value={st.name}>{st.name}</Option>)}
            </Dropdown></Field>
            <Field label="To" style={{ minWidth: 140 }}><Dropdown value={toStage} selectedOptions={toStage ? [toStage] : []} onOptionSelect={(_, d) => setToStage(d.optionValue || '')} placeholder="to">
              {stages.map((st) => <Option key={st.id} value={st.name}>{st.name}</Option>)}
            </Dropdown></Field>
            {devCenter && <Field label="Environment definition"><Input value={envDef} onChange={(_, d) => setEnvDef(d.value)} placeholder="loom-app-env" /></Field>}
            <Field label="Note"><Input value={promoNote} onChange={(_, d) => setPromoNote(d.value)} placeholder="release notes" /></Field>
            <Button appearance="primary" icon={<Rocket20Regular />} disabled={!fromStage || !toStage} onClick={promote}>Promote</Button>
          </div>
          {promoMsg && <MessageBar intent={promoMsg.intent}><MessageBarBody>{promoMsg.text}</MessageBarBody></MessageBar>}
          {promotions.length > 0 && (
            <div className={s.tableWrap}>
            <Table size="small" aria-label="Promotions">
              <TableHeader><TableRow><TableHeaderCell>From</TableHeaderCell><TableHeaderCell>To</TableHeaderCell><TableHeaderCell>When</TableHeaderCell><TableHeaderCell>By</TableHeaderCell><TableHeaderCell>Note</TableHeaderCell></TableRow></TableHeader>
              <TableBody>
                {promotions.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell>{p.fromStage}</TableCell><TableCell>{p.toStage}</TableCell>
                    <TableCell>{new Date(p.promotedAt).toLocaleString()}</TableCell>
                    <TableCell>{p.promotedBy || '—'}</TableCell><TableCell>{p.note || '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            </div>
          )}
        </div>

        <div className={s.section}>
          <SectionHead icon={<Database20Regular />} title="Azure Resource Manager deployments" hint="Real ARM deployment history across the Loom resource groups." />
          <Button appearance="outline" disabled={armBusy} onClick={loadArm}>{armBusy ? 'Loading…' : 'Load ARM history'}</Button>
          {armGate && <MessageBar intent="warning"><MessageBarBody><MessageBarTitle>Azure not configured</MessageBarTitle>{armGate}</MessageBarBody></MessageBar>}
          {arm && arm.length === 0 && !armGate && <div className={s.empty}><Caption1>No ARM deployments found in the Loom resource groups.</Caption1></div>}
          {arm && arm.length > 0 && (
            <div className={s.tableWrap}>
            <Table size="small" aria-label="ARM deployments">
              <TableHeader><TableRow><TableHeaderCell>Name</TableHeaderCell><TableHeaderCell>Resource group</TableHeaderCell><TableHeaderCell>State</TableHeaderCell><TableHeaderCell>Timestamp</TableHeaderCell></TableRow></TableHeader>
              <TableBody>
                {arm.map((d, i) => (
                  <TableRow key={`${d.name}_${i}`}>
                    <TableCell>{d.name}</TableCell><TableCell>{d.resourceGroup || '—'}</TableCell>
                    <TableCell>{d.provisioningState || '—'}</TableCell>
                    <TableCell>{d.timestamp ? new Date(d.timestamp).toLocaleString() : '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            </div>
          )}
        </div>

        <SaveStrip saving={saving} savedAt={savedAt} error={error} dirty={dirty} onSave={() => save()} />
      </div>
    } />
  );
}

// ───────────────────────── Health check (Checks) ─────────────────────────
interface MonitorRule { id: string; name: string; query: string; azureRuleName?: string; evaluationFrequency?: string; windowSize?: string; state?: string; checkType?: string }
interface HealthState { rules?: MonitorRule[]; [k: string]: unknown }

export function HealthCheckEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const { loading } = useItemState<HealthState>('health-check', id, { rules: [] });
  const [rules, setRules] = useState<MonitorRule[]>([]);
  const [checkType, setCheckType] = useState<'freshness' | 'rowcount' | 'custom'>('freshness');
  const [name, setName] = useState('');
  const [table, setTable] = useState('');
  const [thresholdMinutes, setThresholdMinutes] = useState('60');
  const [minRows, setMinRows] = useState('1');
  const [customKql, setCustomKql] = useState('');
  const [evalFreq, setEvalFreq] = useState('PT5M');
  const [windowSize, setWindowSize] = useState('PT15M');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ intent: 'success' | 'error' | 'warning'; text: string } | null>(null);

  const loadRules = useCallback(async () => {
    try {
      const r = await fetch(`/api/items/health-check/${encodeURIComponent(id)}/rule`);
      const j = await r.json().catch(() => ({}));
      if (j?.ok) setRules(Array.isArray(j.rules) ? j.rules : []);
    } catch { /* ignore */ }
  }, [id]);
  useEffect(() => { void loadRules(); }, [loadRules]);

  const createRule = useCallback(async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch(`/api/items/health-check/${encodeURIComponent(id)}/rule`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          checkType, name: name.trim() || undefined, table: table.trim() || undefined,
          thresholdMinutes: Number(thresholdMinutes) || undefined, minRows: Number(minRows) || undefined,
          customKql: customKql.trim() || undefined, evaluationFrequency: evalFreq, windowSize, email: email.trim() || undefined,
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!j?.ok) {
        const gate = j?.gate ? ` ${j.gate.remediation || ''}` : '';
        setMsg({ intent: j?.gate ? 'warning' : 'error', text: `${j?.error || `HTTP ${r.status}`}${gate}` });
        return;
      }
      setMsg({ intent: 'success', text: `Created Azure Monitor rule "${j.rule?.name}" (${j.rule?.azureRuleName}).` });
      void loadRules();
    } catch (e: any) { setMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setBusy(false); }
  }, [id, checkType, name, table, thresholdMinutes, minRows, customKql, evalFreq, windowSize, email, loadRules]);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Check', actions: [
        { label: busy ? 'Creating…' : 'Create rule', onClick: createRule, disabled: busy },
      ]},
    ]},
  ], [createRule, busy]);

  if (id === 'new') return <NewItemCreateGate item={item} createLabel="Create health check" intro="Data-freshness / SLA monitoring backed by real Azure Monitor scheduled-query alert rules. Azure-native default — no Fabric required." />;

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={
      <div className={s.pad}>
        {loading && <Spinner size="small" label="Loading…" labelPosition="after" />}
        <MessageBar intent="info"><MessageBarBody>
          <MessageBarTitle>Health check (Palantir Foundry Health Checks)</MessageBarTitle>
          Create real Azure Monitor scheduled-query alert rules for data freshness, row-count, or a custom KQL condition over Log Analytics. Azure-native default (Fabric Reflex is opt-in via LOOM_ACTIVATOR_BACKEND=fabric).
        </MessageBarBody></MessageBar>

        <div className={s.section}>
          <SectionHead icon={<Flash20Regular />} title="New check rule" hint="Pick a check type; Loom creates a real scheduledQueryRule." />
          <div className={s.addBar}>
            <Field label="Check type"><Dropdown value={checkType} selectedOptions={[checkType]} onOptionSelect={(_, d) => setCheckType((d.optionValue as 'freshness' | 'rowcount' | 'custom') || 'freshness')}>
              <Option value="freshness">freshness</Option><Option value="rowcount">row count</Option><Option value="custom">custom KQL</Option>
            </Dropdown></Field>
            <Field label="Rule name"><Input value={name} onChange={(_, d) => setName(d.value)} placeholder="orders-freshness" /></Field>
            {checkType !== 'custom' && <Field label="Table (Log Analytics)"><Input value={table} onChange={(_, d) => setTable(d.value)} placeholder="AppEvents" /></Field>}
            {checkType === 'freshness' && <Field label="Stale after (minutes)"><Input type="number" value={thresholdMinutes} onChange={(_, d) => setThresholdMinutes(d.value)} /></Field>}
            {checkType === 'rowcount' && <Field label="Min rows in window"><Input type="number" value={minRows} onChange={(_, d) => setMinRows(d.value)} /></Field>}
          </div>
          {checkType === 'custom' && <Field label="KQL condition (fires when it returns rows)"><Textarea value={customKql} onChange={(_, d) => setCustomKql(d.value)} placeholder={'MyTable\n| where TimeGenerated > ago(1h)\n| summarize n=count()\n| where n == 0'} rows={4} /></Field>}
          <div className={s.addBar}>
            <Field label="Evaluate every"><Dropdown value={evalFreq} selectedOptions={[evalFreq]} onOptionSelect={(_, d) => setEvalFreq(d.optionValue || 'PT5M')}>
              <Option value="PT5M">5 minutes</Option><Option value="PT15M">15 minutes</Option><Option value="PT1H">1 hour</Option>
            </Dropdown></Field>
            <Field label="Look-back window"><Dropdown value={windowSize} selectedOptions={[windowSize]} onOptionSelect={(_, d) => setWindowSize(d.optionValue || 'PT15M')}>
              <Option value="PT15M">15 minutes</Option><Option value="PT1H">1 hour</Option><Option value="P1D">1 day</Option>
            </Dropdown></Field>
            <Field label="Notify email (optional)"><Input value={email} onChange={(_, d) => setEmail(d.value)} placeholder="oncall@contoso.com" /></Field>
            <Button appearance="primary" icon={<Flash20Regular />} disabled={busy} onClick={createRule}>{busy ? 'Creating…' : 'Create rule'}</Button>
          </div>
          {msg && <MessageBar intent={msg.intent}><MessageBarBody>{msg.text}</MessageBarBody></MessageBar>}
        </div>

        <div className={s.section}>
          <SectionHead icon={<Database20Regular />} title="Active rules" hint="Scheduled-query alert rules backing this health check." />
          {rules.length === 0 ? <div className={s.empty}><Caption1>No rules yet.</Caption1></div> : (
            <div className={s.tableWrap}>
            <Table size="small" aria-label="Rules">
              <TableHeader><TableRow><TableHeaderCell>Name</TableHeaderCell><TableHeaderCell>Type</TableHeaderCell><TableHeaderCell>Azure rule</TableHeaderCell><TableHeaderCell>Frequency</TableHeaderCell><TableHeaderCell>State</TableHeaderCell></TableRow></TableHeader>
              <TableBody>
                {rules.map((rl) => (
                  <TableRow key={rl.id}>
                    <TableCell>{rl.name}</TableCell><TableCell>{rl.checkType || '—'}</TableCell>
                    <TableCell>{rl.azureRuleName || '—'}</TableCell><TableCell>{rl.evaluationFrequency || '—'}</TableCell>
                    <TableCell><Badge appearance="tint" color={rl.state === 'Active' ? 'success' : 'warning'}>{rl.state || 'Active'}</Badge></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            </div>
          )}
        </div>
      </div>
    } />
  );
}

// ───────────────────────── AIP Logic function (Spindle) ─────────────────────────
interface AipInputDef { id: string; name: string; type: 'string' | 'number' | 'boolean' }
interface AipStepDef { id: string; kind: 'llm-prompt' | 'extract' | 'branch'; name: string; prompt: string }
interface AipState { inputs?: AipInputDef[]; steps?: AipStepDef[]; outputType?: string; outputDescription?: string; [k: string]: unknown }

export function AipLogicEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const { state, setState, loading, saving, error, savedAt, save, dirty } = useItemState<AipState>('aip-logic', id, { inputs: [], steps: [], outputType: 'string' });
  const [inName, setInName] = useState('');
  const [inType, setInType] = useState<'string' | 'number' | 'boolean'>('string');
  const [stepKind, setStepKind] = useState<'llm-prompt' | 'extract' | 'branch'>('llm-prompt');
  const [stepName, setStepName] = useState('');
  const [stepPrompt, setStepPrompt] = useState('');
  const [invokeVals, setInvokeVals] = useState<Record<string, string>>({});
  const [invokeBusy, setInvokeBusy] = useState(false);
  const [invokeOut, setInvokeOut] = useState<string | null>(null);
  const [invokeMsg, setInvokeMsg] = useState<{ intent: 'error' | 'warning'; text: string } | null>(null);

  const inputs = Array.isArray(state.inputs) ? state.inputs : [];
  const steps = Array.isArray(state.steps) ? state.steps : [];

  const addInput = useCallback(() => {
    const nm = inName.trim(); if (!/^[A-Za-z_][\w]*$/.test(nm)) return;
    setState((p) => ({ ...p, inputs: [...(Array.isArray(p.inputs) ? p.inputs : []), { id: `in_${Date.now()}`, name: nm, type: inType }] }));
    setInName('');
  }, [inName, inType, setState]);
  const removeInput = useCallback((iid: string) => setState((p) => ({ ...p, inputs: (Array.isArray(p.inputs) ? p.inputs : []).filter((x) => x.id !== iid) })), [setState]);

  const addStep = useCallback(() => {
    const nm = stepName.trim() || stepKind;
    setState((p) => ({ ...p, steps: [...(Array.isArray(p.steps) ? p.steps : []), { id: `step_${Date.now()}`, kind: stepKind, name: nm, prompt: stepPrompt.trim() }] }));
    setStepName(''); setStepPrompt('');
  }, [stepKind, stepName, stepPrompt, setState]);
  const removeStep = useCallback((sid: string) => setState((p) => ({ ...p, steps: (Array.isArray(p.steps) ? p.steps : []).filter((x) => x.id !== sid) })), [setState]);

  const invoke = useCallback(async () => {
    setInvokeBusy(true); setInvokeMsg(null); setInvokeOut(null);
    const typed: Record<string, unknown> = {};
    for (const i of inputs) {
      const raw = invokeVals[i.name] ?? '';
      typed[i.name] = i.type === 'number' ? Number(raw) : i.type === 'boolean' ? /^(true|1|yes)$/i.test(raw) : raw;
    }
    try {
      const r = await fetch(`/api/items/aip-logic/${encodeURIComponent(id)}/invoke`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ inputs: typed }),
      });
      const j = await r.json().catch(() => ({}));
      if (!j?.ok) {
        const gate = j?.gate ? ` ${j.gate.remediation || ''}` : '';
        setInvokeMsg({ intent: j?.gate ? 'warning' : 'error', text: `${j?.error || `HTTP ${r.status}`}${gate}` });
        return;
      }
      setInvokeOut(String(j.output ?? ''));
    } catch (e: any) { setInvokeMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setInvokeBusy(false); }
  }, [id, inputs, invokeVals]);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Function', actions: [
        { label: saving ? 'Saving…' : 'Save', onClick: () => save(), disabled: saving || !dirty },
        { label: invokeBusy ? 'Running…' : 'Invoke', onClick: invoke, disabled: invokeBusy || steps.length === 0 },
      ]},
    ]},
  ], [save, saving, dirty, invoke, invokeBusy, steps.length]);

  if (id === 'new') return <NewItemCreateGate item={item} createLabel="Create AIP Logic function" intro="A no-code typed LLM function: typed inputs → ordered steps → typed output, callable as an endpoint. Runs against Azure OpenAI — no Fabric required." />;

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={
      <div className={s.pad}>
        {loading && <Spinner size="small" label="Loading…" labelPosition="after" />}
        <MessageBar intent="info"><MessageBarBody>
          <MessageBarTitle>AIP Logic function (Palantir AIP Logic → Spindle)</MessageBarTitle>
          Author typed inputs and ordered steps (dropdowns, no freeform JSON), then invoke the function against the live Azure OpenAI deployment. No Microsoft Fabric required.
        </MessageBarBody></MessageBar>

        <div className={s.grid2}>
          <div className={s.section}>
            <SectionHead icon={<Add20Regular />} title="Typed inputs" hint="Named parameters with a type." />
            <div className={s.addBar}>
              <Field label="Name"><Input value={inName} onChange={(_, d) => setInName(d.value)} placeholder="customerId" /></Field>
              <Field label="Type"><Dropdown value={inType} selectedOptions={[inType]} onOptionSelect={(_, d) => setInType((d.optionValue as 'string' | 'number' | 'boolean') || 'string')}>
                <Option value="string">string</Option><Option value="number">number</Option><Option value="boolean">boolean</Option>
              </Dropdown></Field>
              <Button appearance="primary" icon={<Add20Regular />} disabled={!/^[A-Za-z_][\w]*$/.test(inName.trim())} onClick={addInput}>Add</Button>
            </div>
            {inputs.length === 0 ? <div className={s.empty}><Caption1>No inputs yet.</Caption1></div> : inputs.map((i) => (
              <div key={i.id} className={s.row}><Body1><strong>{i.name}</strong></Body1><Badge appearance="tint">{i.type}</Badge><span className={s.spacer} /><Button size="small" appearance="subtle" icon={<Dismiss16Regular />} aria-label={`Remove ${i.name}`} onClick={() => removeInput(i.id)}>Remove</Button></div>
            ))}
          </div>

          <div className={s.section}>
            <SectionHead icon={<Code20Regular />} title="Typed output" hint="The shape the function returns." />
            <Field label="Output type"><Dropdown value={String(state.outputType || 'string')} selectedOptions={[String(state.outputType || 'string')]} onOptionSelect={(_, d) => setState((p) => ({ ...p, outputType: d.optionValue || 'string' }))}>
              <Option value="string">string</Option><Option value="number">number</Option><Option value="boolean">boolean</Option><Option value="object">object (JSON)</Option>
            </Dropdown></Field>
            <Field label="Output description"><Input value={String(state.outputDescription || '')} onChange={(_, d) => setState((p) => ({ ...p, outputDescription: d.value }))} placeholder="A one-line risk summary" /></Field>
          </div>
        </div>

        <div className={s.section}>
          <SectionHead icon={<Flash20Regular />} title="Ordered steps" hint="Each step is an LLM prompt, an extraction, or a branch — no freeform JSON." />
          <div className={s.addBar}>
            <Field label="Step kind"><Dropdown value={stepKind} selectedOptions={[stepKind]} onOptionSelect={(_, d) => setStepKind((d.optionValue as 'llm-prompt' | 'extract' | 'branch') || 'llm-prompt')}>
              <Option value="llm-prompt">LLM prompt</Option><Option value="extract">extract</Option><Option value="branch">branch</Option>
            </Dropdown></Field>
            <Field label="Step name"><Input value={stepName} onChange={(_, d) => setStepName(d.value)} placeholder="Summarize" /></Field>
            <Field label="Instruction" style={{ minWidth: 260 }}><Input value={stepPrompt} onChange={(_, d) => setStepPrompt(d.value)} placeholder="Summarize {customerId} risk" /></Field>
            <Button appearance="primary" icon={<Add20Regular />} onClick={addStep}>Add step</Button>
          </div>
          {steps.length === 0 ? <div className={s.empty}><Caption1>No steps yet — add at least one to invoke.</Caption1></div> : steps.map((st, n) => (
            <div key={st.id} className={s.row}><Badge appearance="filled" color="brand">{n + 1}</Badge><Badge appearance="tint">{st.kind}</Badge><Body1><strong>{st.name}</strong></Body1>{st.prompt && <Caption1 className={s.hint}>{st.prompt}</Caption1>}<span className={s.spacer} /><Button size="small" appearance="subtle" icon={<Dismiss16Regular />} aria-label={`Remove ${st.name}`} onClick={() => removeStep(st.id)}>Remove</Button></div>
          ))}
        </div>

        <div className={s.section}>
          <SectionHead icon={<Play20Regular />} title="Invoke" hint="Run the function against the live Azure OpenAI deployment." />
          {inputs.length === 0 ? <Caption1 className={s.hint}>Add typed inputs to provide values.</Caption1> : inputs.map((i) => (
            <Field key={i.id} label={`${i.name} (${i.type})`}><Input value={invokeVals[i.name] || ''} onChange={(_, d) => setInvokeVals((p) => ({ ...p, [i.name]: d.value }))} /></Field>
          ))}
          <Button appearance="primary" icon={<Play20Regular />} disabled={invokeBusy || steps.length === 0} onClick={invoke}>{invokeBusy ? 'Running…' : 'Invoke function'}</Button>
          {invokeMsg && <MessageBar intent={invokeMsg.intent}><MessageBarBody>{invokeMsg.text}</MessageBarBody></MessageBar>}
          {invokeOut !== null && <CodeBlock ariaLabel="Function output" content={invokeOut} />}
        </div>

        <SaveStrip saving={saving} savedAt={savedAt} error={error} dirty={dirty} onSave={() => save()} />
      </div>
    } />
  );
}
