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
import { useRouter } from 'next/navigation';
import {
  Subtitle2, Body1, Caption1, Badge, Button, Input, Textarea, Spinner, Switch, Divider,
  Tab, TabList, Field, Dropdown, Option, Checkbox, SearchBox,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  Accordion, AccordionItem, AccordionHeader, AccordionPanel,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Add20Regular, Dismiss16Regular, Link20Regular, Code20Regular,
  Flash20Regular, Rocket20Regular, Play20Regular, Database20Regular,
  Copy16Regular, Checkmark16Regular, BrainCircuit20Regular,
  History20Regular, Bug20Regular,
  ArrowSwap20Regular, People20Regular, Tag20Regular, ChevronRight20Regular,
  CheckmarkCircle20Regular, DismissCircle20Regular, Cloud20Regular, Branch20Regular,
} from '@fluentui/react-icons';
import { ItemEditorChrome } from './item-editor-chrome';
import { NewItemCreateGate } from './new-item-gate';
import { SlateAppBuilder, type SlateQueryDef, type SlateWidgetDef } from './slate/slate-app-builder';
import { WorkshopAppBuilder, type WorkshopWidget, type WorkshopVariable } from './workshop/workshop-app-builder';
import { deriveObjectProperties } from './_palantir-codegen';
import type { OntologyEntityBinding } from './_family-utils';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';

const useStyles = makeStyles({
  pad: { padding: tokens.spacingVerticalL, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, minWidth: 0 },
  section: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: 0,
    padding: tokens.spacingVerticalL, borderRadius: tokens.borderRadiusXLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
    transitionProperty: 'box-shadow, transform', transitionDuration: tokens.durationNormal,
    transitionTimingFunction: tokens.curveEasyEase,
    ':hover': { boxShadow: tokens.shadow16, transform: 'translateY(-1px)' },
  },
  sectionHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  sectionIcon: {
    display: 'flex', alignItems: 'center', justifyContent: 'center', width: '32px', height: '32px',
    borderRadius: tokens.borderRadiusMedium, backgroundColor: tokens.colorBrandBackground2, color: tokens.colorBrandForeground1,
  },
  hint: { color: tokens.colorNeutralForeground3, minWidth: 0, overflowWrap: 'anywhere', wordBreak: 'break-word' },
  addBar: {
    display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'flex-end', flexWrap: 'wrap',
    padding: tokens.spacingVerticalM, borderRadius: tokens.borderRadiusLarge, backgroundColor: tokens.colorNeutralBackground2,
  },
  row: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', minWidth: 0,
    padding: tokens.spacingVerticalS, borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground1,
  },
  spacer: { flex: 1 },
  grid2: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(280px, 100%), 1fr))', gap: tokens.spacingHorizontalM },
  modeBar: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM, flexWrap: 'wrap',
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    borderRadius: tokens.borderRadiusLarge, backgroundColor: tokens.colorNeutralBackground2,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  trace: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS,
    padding: tokens.spacingVerticalM, borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2, border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  traceHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', minWidth: 0 },
  codeWrap: {
    display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0,
    borderRadius: tokens.borderRadiusMedium, border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  codeHead: {
    display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
    backgroundColor: tokens.colorNeutralBackground3, borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  code: {
    fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase200, lineHeight: '18px',
    whiteSpace: 'pre', overflow: 'auto', minHeight: '120px', maxHeight: '60vh', margin: 0,
    resize: 'vertical', boxSizing: 'border-box',
    padding: tokens.spacingVerticalM, backgroundColor: tokens.colorNeutralBackground2,
  },
  tableWrap: { overflowX: 'auto', minWidth: 0, borderRadius: tokens.borderRadiusLarge, border: `1px solid ${tokens.colorNeutralStroke2}`, boxShadow: tokens.shadow4 },
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
  fieldWide: { minWidth: '280px' },
  fieldStep: { minWidth: '260px' },
  fieldMed: { minWidth: '200px' },
  fieldNarrow: { minWidth: '140px' },
  mutedCaption: { color: tokens.colorNeutralForeground3 },
  errorCaption: { color: tokens.colorPaletteRedForeground1 },
  dialogForm: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: 'min(420px, 100%)', maxWidth: '100%' },
  dialogScroll: { maxHeight: '52vh', overflowY: 'auto', paddingRight: tokens.spacingHorizontalXS },
  scopeBar: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', minWidth: 0 },
  scopeScroll: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS,
    maxHeight: '40vh', overflowY: 'auto', paddingRight: tokens.spacingHorizontalXS, minWidth: 0,
  },
  chipBar: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalXS, alignItems: 'center', minWidth: 0 },
  rowText: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, minWidth: 0 },
  tabStrip: { paddingBottom: tokens.spacingVerticalXS },
  pipelineLane: { display: 'flex', alignItems: 'stretch', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap', overflowX: 'auto', paddingBottom: tokens.spacingVerticalS, minWidth: 0 },
  stageCard: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, minWidth: '200px', maxWidth: '320px',
    padding: tokens.spacingVerticalM, borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground1, boxShadow: tokens.shadow4,
  },
  connector: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    gap: tokens.spacingVerticalXXS, color: tokens.colorNeutralForeground3, alignSelf: 'center', minWidth: '44px',
  },
  cardHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, minWidth: 0, flexWrap: 'wrap' },
  cardActions: { display: 'flex', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap', alignItems: 'center' },
  kv: { display: 'flex', justifyContent: 'space-between', gap: tokens.spacingHorizontalS, minWidth: 0 },
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
interface OntologyActionLite { name: string; objectType: string; kind: 'create' | 'update' | 'delete'; params?: string[] }
interface OntologySurface {
  id: string; displayName: string; classes: OntologyClassLite[];
  links: Array<{ from: string; to: string; kind: string }>;
  bindings: OntologyEntityBinding[];
  actionTypes?: OntologyActionLite[];
}

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
interface WorkshopAction { id: string; label: string; kind: 'create' | 'update' | 'delete'; entity: string }
interface WorkshopState {
  boundOntologyId?: string; boundOntologyName?: string;
  objectViews?: string[]; actions?: WorkshopAction[];
  // New app-builder model (canvas widgets + typed variables), persisted to Cosmos.
  widgets?: WorkshopWidget[]; variables?: WorkshopVariable[];
  // Set by the slate-workshop-app demote-to-template scaffold: the backing
  // Data API Builder item this Workshop app was wired to (proves the template
  // created REAL, navigable sibling items — no placeholder).
  dataApiItemId?: string; dataApiBaseUrl?: string;
  [k: string]: unknown;
}

export function WorkshopAppEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const router = useRouter();
  const { state, setState, loading, saving, error, savedAt, save, dirty } = useItemState<WorkshopState>('workshop-app', id, { widgets: [], variables: [] });
  const onto = useOntologyBinding('workshop-app', id);
  const [pickOnto, setPickOnto] = useState('');

  const classes = onto.surface?.classes || [];
  const entityTypes = useMemo(() => classes.map((c) => c.name), [classes]);
  const widgets = Array.isArray(state.widgets) ? state.widgets : [];
  const variables = Array.isArray(state.variables) ? state.variables : [];

  const onWidgetsChange = useCallback((next: WorkshopWidget[]) => setState((p) => ({ ...p, widgets: next })), [setState]);
  const onVariablesChange = useCallback((next: WorkshopVariable[]) => setState((p) => ({ ...p, variables: next })), [setState]);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'App', actions: [
        { label: saving ? 'Saving…' : 'Save', onClick: () => save(), disabled: saving || !dirty },
      ]},
    ]},
  ], [save, saving, dirty]);

  if (id === 'new') return <NewItemCreateGate item={item} createLabel="Create Workshop app" intro="An operational low-code app builder bound to a Loom Ontology. Place widgets — object tables, charts, KPIs, filters, forms and buttons — on a drag-resize canvas, drive them with typed variables, and wire events, all over the ontology's Azure-native Synapse warehouse. No Fabric required." />;

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={
      <div className={s.pad}>
        {loading && <Spinner size="small" label="Loading…" labelPosition="after" />}
        <MessageBar intent="info"><MessageBarBody>
          <MessageBarTitle>Workshop app (Palantir Workshop → Atelier)</MessageBarTitle>
          Bind a Loom Ontology, then build an operational low-code app on the canvas — object tables, charts, KPIs, filters, forms and buttons over the ontology's entity types, driven by typed variables and event wiring. Runs on Azure Container Apps over the ontology's bound Synapse warehouse — no Microsoft Fabric required.
        </MessageBarBody></MessageBar>

        {state.dataApiItemId && (
          <MessageBar intent="success"><MessageBarBody>
            <MessageBarTitle>Wired to a Data API</MessageBarTitle>
            This app was scaffolded with a backing Data API Builder item as its query surface{state.dataApiBaseUrl ? <> at <strong>{String(state.dataApiBaseUrl)}</strong></> : ''}.
            <Button appearance="transparent" size="small" icon={<Link20Regular />}
              onClick={() => router.push(`/items/data-api-builder/${encodeURIComponent(String(state.dataApiItemId))}`)}>
              Open Data API
            </Button>
          </MessageBarBody></MessageBar>
        )}

        <div className={s.section}>
          <SectionHead icon={<Link20Regular />} title="Bound ontology" hint="Pick a saved Ontology; its object types become the app's data sources (widgets bind to them)." />
          {!onto.loaded ? <div className={s.empty}><Spinner size="tiny" /></div> : onto.ontologies.length === 0 ? (
            <MessageBar intent="warning"><MessageBarBody>No ontologies found. Create an Ontology item first, then bind it here.</MessageBarBody></MessageBar>
          ) : (
            <div className={s.addBar}>
              <Field label="Ontology" className={s.fieldWide}>
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

        <WorkshopAppBuilder id={id} entityTypes={entityTypes} widgets={widgets} variables={variables}
          onWidgetsChange={onWidgetsChange} onVariablesChange={onVariablesChange} />

        <SaveStrip saving={saving} savedAt={savedAt} error={error} dirty={dirty} onSave={() => save()} />
      </div>
    } />
  );
}

// ───────────────────────── Ontology SDK (OSDK) ─────────────────────────
interface OsdkState {
  boundOntologyId?: string; boundOntologyName?: string;
  objectCount?: number; linkCount?: number; actionCount?: number; lastGeneratedAt?: string;
  selectedObjectTypes?: string[]; selectedLinkTypes?: string[]; selectedActionTypes?: string[];
  [k: string]: unknown;
}
interface GeneratedSdk { typescript: string; python: string; dabConfig: unknown; actions: string; objectCount: number; linkCount: number; actionCount: number; propertyCount: number }

/** Stable identity for a link in the scope selector (kind + endpoints). */
function osdkLinkKey(l: { from: string; to: string; kind: string }): string { return `${l.kind}:${l.from}->${l.to}`; }
function osdkLinkLabel(l: { from: string; to: string; kind: string }): string { return `${l.from} —${l.kind}→ ${l.to}`; }

export function OntologySdkEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const { state, setState, loading, saving, error, savedAt, save, dirty } = useItemState<OsdkState>('ontology-sdk', id, {});
  const onto = useOntologyBinding('ontology-sdk', id);
  const [pickOnto, setPickOnto] = useState('');
  const [genBusy, setGenBusy] = useState(false);
  const [genErr, setGenErr] = useState<string | null>(null);
  const [gen, setGen] = useState<GeneratedSdk | null>(null);
  const [tab, setTab] = useState<'ts' | 'py' | 'actions' | 'dab'>('ts');
  const [pubBusy, setPubBusy] = useState(false);
  const [pubMsg, setPubMsg] = useState<{ intent: 'success' | 'error' | 'warning'; text: string } | null>(null);

  // Scope selector state.
  const [scopeTab, setScopeTab] = useState<'objects' | 'links' | 'actions'>('objects');
  const [filter, setFilter] = useState('');
  const [selObj, setSelObj] = useState<Set<string>>(new Set());
  const [selLink, setSelLink] = useState<Set<string>>(new Set());
  const [selAct, setSelAct] = useState<Set<string>>(new Set());
  const seededFor = useRef<string>('');

  const classes = onto.surface?.classes || [];
  const links = onto.surface?.links || [];
  const actionTypes = onto.surface?.actionTypes || [];
  const bindings = onto.surface?.bindings || [];
  const surfaceId = onto.surface?.id || '';

  // Real typed-property derivation (same pure fn the codegen route uses) so the
  // selector can show each object type's declared members.
  const propsByType = useMemo(
    () => deriveObjectProperties(classes, bindings, actionTypes.map((a) => ({ name: a.name, objectType: a.objectType, kind: a.kind, params: a.params }))),
    [classes, bindings, actionTypes],
  );

  // Seed the selection from persisted state (else "all") whenever the bound
  // surface changes. Guarded by surface id so binding a new ontology re-seeds.
  useEffect(() => {
    if (!onto.loaded || loading || !onto.surface) return;
    if (seededFor.current === surfaceId) return;
    const allObj = classes.map((c) => c.name);
    const allLink = links.map(osdkLinkKey);
    const allAct = actionTypes.map((a) => a.name);
    const so = Array.isArray(state.selectedObjectTypes) ? state.selectedObjectTypes.filter((n) => allObj.includes(n)) : allObj;
    const sl = Array.isArray(state.selectedLinkTypes) ? state.selectedLinkTypes.filter((n) => allLink.includes(n)) : allLink;
    const sa = Array.isArray(state.selectedActionTypes) ? state.selectedActionTypes.filter((n) => allAct.includes(n)) : allAct;
    setSelObj(new Set(so)); setSelLink(new Set(sl)); setSelAct(new Set(sa));
    seededFor.current = surfaceId;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surfaceId, onto.loaded, loading]);

  // Mirror a selection change into persisted item state (deferred out of the set
  // updater) so Save (Ctrl+S) persists the chosen scope to Cosmos.
  const persist = useCallback((patch: Partial<OsdkState>) => {
    queueMicrotask(() => setState((p) => ({ ...p, ...patch })));
  }, [setState]);
  const applyObj = useCallback((next: Set<string>) => { setSelObj(next); persist({ selectedObjectTypes: [...next] }); }, [persist]);
  const applyLink = useCallback((next: Set<string>) => { setSelLink(next); persist({ selectedLinkTypes: [...next] }); }, [persist]);
  const applyAct = useCallback((next: Set<string>) => { setSelAct(next); persist({ selectedActionTypes: [...next] }); }, [persist]);
  const toggle = (set: Set<string>, key: string) => { const n = new Set(set); n.has(key) ? n.delete(key) : n.add(key); return n; };

  const generate = useCallback(async () => {
    setGenBusy(true); setGenErr(null);
    try {
      const r = await fetch(`/api/items/ontology-sdk/${encodeURIComponent(id)}/generate`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ selectedObjectTypes: [...selObj], selectedLinkTypes: [...selLink], selectedActionTypes: [...selAct] }),
      });
      const j = await r.json().catch(() => ({}));
      if (!j?.ok) { setGenErr(j?.error || `HTTP ${r.status}`); return; }
      const next: GeneratedSdk = {
        typescript: j.typescript, python: j.python, dabConfig: j.dabConfig, actions: j.actions || '',
        objectCount: j.objectCount || 0, linkCount: j.linkCount || 0, actionCount: j.actionCount || 0, propertyCount: j.propertyCount || 0,
      };
      setGen(next);
      setTab((t) => (t === 'actions' && !next.actions) ? 'ts' : t);
    } catch (e: any) { setGenErr(e?.message || String(e)); }
    finally { setGenBusy(false); }
  }, [id, selObj, selLink, selAct]);

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

  const canGenerate = !!onto.boundOntologyId && selObj.size > 0;

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'SDK', actions: [
        { label: saving ? 'Saving…' : 'Save scope', onClick: () => save(), disabled: saving || !dirty },
        { label: genBusy ? 'Generating…' : 'Generate SDK', onClick: generate, disabled: genBusy || !canGenerate },
        { label: pubBusy ? 'Publishing…' : 'Publish to APIM', onClick: publish, disabled: pubBusy || !onto.boundOntologyId },
      ]},
    ]},
  ], [save, saving, dirty, generate, genBusy, canGenerate, onto.boundOntologyId, publish, pubBusy]);

  if (id === 'new') return <NewItemCreateGate item={item} createLabel="Create Ontology SDK" intro="A typed TypeScript / Python client + REST Data API over an Ontology's object, link, and action types. Scope it to the types you need, generate typed write-back actions, and publish through APIM — via Microsoft Data API Builder on Azure Container Apps. No Fabric required." />;

  // Filtered rows for the active scope tab.
  const f = filter.trim().toLowerCase();
  const objRows = classes.filter((c) => !f || c.name.toLowerCase().includes(f) || (c.description || '').toLowerCase().includes(f));
  const linkRows = links.filter((l) => !f || osdkLinkLabel(l).toLowerCase().includes(f));
  const actRows = actionTypes.filter((a) => !f || a.name.toLowerCase().includes(f) || a.objectType.toLowerCase().includes(f));

  const selectAllCurrent = () => {
    if (scopeTab === 'objects') applyObj(new Set(classes.map((c) => c.name)));
    else if (scopeTab === 'links') applyLink(new Set(links.map(osdkLinkKey)));
    else applyAct(new Set(actionTypes.map((a) => a.name)));
  };
  const clearCurrent = () => {
    if (scopeTab === 'objects') applyObj(new Set());
    else if (scopeTab === 'links') applyLink(new Set());
    else applyAct(new Set());
  };

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={
      <div className={s.pad}>
        {loading && <Spinner size="small" label="Loading…" labelPosition="after" />}
        <MessageBar intent="info"><MessageBarBody>
          <MessageBarTitle>Ontology SDK (Palantir OSDK)</MessageBarTitle>
          Bind an Ontology, scope the SDK to the object / link / action types you need, then generate typed TypeScript + Python clients (with <strong>applyCreate / applyUpdate / applyDelete</strong> write-back methods) and a real dab-config.json. The Data API runs on Microsoft Data API Builder (Azure Container Apps) and publishes through APIM — no Fabric required.
        </MessageBarBody></MessageBar>

        <div className={s.section}>
          <SectionHead icon={<Link20Regular />} title="Bound ontology" hint="Its object / link / action types define the typed SDK surface." />
          {!onto.loaded ? <div className={s.empty}><Spinner size="tiny" /></div> : onto.ontologies.length === 0 ? (
            <MessageBar intent="warning"><MessageBarBody>No ontologies found. Create an Ontology item first, then bind it here.</MessageBarBody></MessageBar>
          ) : (
            <div className={s.addBar}>
              <Field label="Ontology" className={s.fieldWide}>
                <Dropdown value={onto.ontologies.find((o) => o.id === (pickOnto || onto.boundOntologyId))?.displayName || ''}
                  selectedOptions={[(pickOnto || onto.boundOntologyId)]} onOptionSelect={(_, d) => setPickOnto(d.optionValue || '')} placeholder="Select an ontology">
                  {onto.ontologies.map((o) => <Option key={o.id} value={o.id} text={o.displayName}>{`${o.displayName} (${o.classCount} objects)`}</Option>)}
                </Dropdown>
              </Field>
              <Button appearance="primary" icon={<Database20Regular />} disabled={onto.busy || !(pickOnto || onto.boundOntologyId)} onClick={() => onto.bind(pickOnto || onto.boundOntologyId)}>
                {onto.busy ? 'Binding…' : 'Bind ontology'}
              </Button>
              <Button appearance="outline" icon={<Code20Regular />} disabled={genBusy || !canGenerate} onClick={generate}>
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

        {/* Ontology scope selector — choose which object / link / action types the
            SDK includes. Persisted to Cosmos; the /generate route filters by it. */}
        <div className={s.section}>
          <SectionHead icon={<Database20Regular />} title="SDK scope" hint="Choose which object, link, and action types the generated SDK includes. The token and generated client are scoped to exactly these entities." />
          {!onto.boundOntologyId ? (
            <div className={s.empty}><Caption1>Bind an ontology to choose the SDK scope.</Caption1></div>
          ) : classes.length === 0 ? (
            <MessageBar intent="warning"><MessageBarBody>The bound ontology has no object types yet. Add entities to it, then re-bind.</MessageBarBody></MessageBar>
          ) : (
            <>
              <TabList selectedValue={scopeTab} onTabSelect={(_, d) => { setScopeTab(d.value as 'objects' | 'links' | 'actions'); setFilter(''); }}>
                <Tab value="objects">Objects · {selObj.size}/{classes.length}</Tab>
                <Tab value="links">Links · {selLink.size}/{links.length}</Tab>
                <Tab value="actions">Actions · {selAct.size}/{actionTypes.length}</Tab>
              </TabList>
              <div className={s.scopeBar}>
                <SearchBox value={filter} onChange={(_, d) => setFilter(d.value)} placeholder={`Filter ${scopeTab}…`} className={s.fieldMed} />
                <span className={s.spacer} />
                <Button size="small" appearance="subtle" onClick={selectAllCurrent}>Select all</Button>
                <Button size="small" appearance="subtle" onClick={clearCurrent}>Clear</Button>
              </div>

              {scopeTab === 'objects' && (
                <div className={s.scopeScroll}>
                  {objRows.length === 0 ? <div className={s.empty}><Caption1>No matching object types.</Caption1></div> : objRows.map((c) => {
                    const props = propsByType[c.name];
                    const keyProp = props?.find((p) => p.isKey);
                    return (
                      <div key={c.name} className={s.row}>
                        <Checkbox checked={selObj.has(c.name)} onChange={() => applyObj(toggle(selObj, c.name))} aria-label={`Include ${c.name}`} />
                        <div className={s.rowText}>
                          <Body1><strong>{c.name}</strong>{c.parent ? <Caption1 as="span" className={s.hint}> : {c.parent}</Caption1> : null}</Body1>
                          {c.description && <Caption1 className={s.hint}>{c.description}</Caption1>}
                          <div className={s.chipBar}>
                            {keyProp && <Badge appearance="tint" color="brand">key: {keyProp.name}</Badge>}
                            {props ? props.filter((p) => !p.isKey).slice(0, 10).map((p) => <Badge key={p.name} appearance="outline">{p.name}: {p.tsType}</Badge>)
                              : <Caption1 className={s.mutedCaption}>untyped (no column bindings)</Caption1>}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {scopeTab === 'links' && (
                <div className={s.scopeScroll}>
                  {links.length === 0 ? <div className={s.empty}><Caption1>This ontology declares no link types.</Caption1></div>
                    : linkRows.length === 0 ? <div className={s.empty}><Caption1>No matching link types.</Caption1></div>
                    : linkRows.map((l) => {
                      const k = osdkLinkKey(l); const endpointsIncluded = selObj.has(l.from) && selObj.has(l.to);
                      return (
                        <div key={k} className={s.row}>
                          <Checkbox checked={selLink.has(k)} onChange={() => applyLink(toggle(selLink, k))} aria-label={`Include ${osdkLinkLabel(l)}`} />
                          <Body1>{l.from} <Badge appearance="tint">{l.kind}</Badge> {l.to}</Body1>
                          <span className={s.spacer} />
                          {!endpointsIncluded && <Badge appearance="tint" color="warning">endpoint excluded</Badge>}
                        </div>
                      );
                    })}
                </div>
              )}

              {scopeTab === 'actions' && (
                <div className={s.scopeScroll}>
                  {actionTypes.length === 0 ? (
                    <MessageBar intent="info"><MessageBarBody>This ontology declares no write-back action types. Add create / update / delete actions on the Ontology to generate typed applyAction methods here.</MessageBarBody></MessageBar>
                  ) : actRows.length === 0 ? <div className={s.empty}><Caption1>No matching action types.</Caption1></div> : actRows.map((a) => {
                    const targetIncluded = selObj.has(a.objectType);
                    return (
                      <div key={a.name} className={s.row}>
                        <Checkbox checked={selAct.has(a.name)} onChange={() => applyAct(toggle(selAct, a.name))} aria-label={`Include ${a.name}`} />
                        <Badge appearance="tint" color={a.kind === 'create' ? 'success' : a.kind === 'delete' ? 'danger' : 'brand'}>{a.kind}</Badge>
                        <div className={s.rowText}>
                          <Body1><strong>{a.name}</strong> <Caption1 as="span" className={s.hint}>→ {a.objectType}</Caption1></Body1>
                          {a.params && a.params.length > 0 && <Caption1 className={s.hint}>params: {a.params.join(', ')}</Caption1>}
                        </div>
                        <span className={s.spacer} />
                        {!targetIncluded && <Badge appearance="tint" color="warning">object excluded</Badge>}
                      </div>
                    );
                  })}
                </div>
              )}
              <Caption1 className={s.mutedCaption}>
                Generating includes <strong>{selObj.size}</strong> object type{selObj.size === 1 ? '' : 's'}
                {selLink.size > 0 ? <>, {selLink.size} link{selLink.size === 1 ? '' : 's'}</> : null}
                {selAct.size > 0 ? <>, {selAct.size} action{selAct.size === 1 ? '' : 's'}</> : null}. Links / actions to excluded object types are skipped.
              </Caption1>
            </>
          )}
          <SaveStrip saving={saving} savedAt={savedAt} error={error} dirty={dirty} onSave={() => save()} />
        </div>

        {gen && (
          <div className={s.section}>
            <SectionHead icon={<Code20Regular />} title="Generated SDK" hint={`${gen.objectCount} object type${gen.objectCount === 1 ? '' : 's'} · ${gen.actionCount} action${gen.actionCount === 1 ? '' : 's'} · ${gen.propertyCount} typed propert${gen.propertyCount === 1 ? 'y' : 'ies'}. Real typed clients + dab-config.json — copy into your project.`} />
            {gen.propertyCount === 0 && (
              <MessageBar intent="info"><MessageBarBody>
                <MessageBarTitle>Untyped object properties</MessageBarTitle>
                No column bindings are declared on this ontology yet, so the interfaces use an untyped property bag. Bind a Lakehouse / Warehouse source on the Ontology (with key + writable columns) to emit typed members. Precise scalar typing (int / decimal / datetime / bool) is introspected from the source schema in a later pass.
              </MessageBarBody></MessageBar>
            )}
            <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as 'ts' | 'py' | 'actions' | 'dab')}>
              <Tab value="ts">TypeScript</Tab>
              <Tab value="py">Python</Tab>
              {gen.actions ? <Tab value="actions">Actions</Tab> : null}
              <Tab value="dab">dab-config.json</Tab>
            </TabList>
            <CodeBlock ariaLabel="Generated SDK source" content={
              tab === 'ts' ? gen.typescript
                : tab === 'py' ? gen.python
                : tab === 'actions' ? gen.actions
                : JSON.stringify(gen.dabConfig, null, 2)
            } />
          </div>
        )}
      </div>
    } />
  );
}

// ───────────────────────── Slate app ─────────────────────────
interface SlateState {
  apiBaseUrl?: string; widgets?: SlateWidgetDef[]; queries?: SlateQueryDef[]; lastGeneratedAt?: string;
  // Set by the rayfin-azure-stack demote-to-template scaffold: the backing
  // Azure Functions API item this SWA web tier calls (apiBaseUrl is seeded to
  // its route). Proves the template wired a REAL Functions sibling.
  functionItemId?: string;
  [k: string]: unknown;
}

export function SlateAppEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const router = useRouter();
  const { state, setState, loading, saving, error, savedAt, save, dirty } = useItemState<SlateState>('slate-app', id, { apiBaseUrl: '/api', widgets: [], queries: [] });
  const [genBusy, setGenBusy] = useState(false);
  const [genErr, setGenErr] = useState<string | null>(null);
  const [files, setFiles] = useState<Array<{ name: string; content: string }>>([]);
  const [fileTab, setFileTab] = useState('index.html');

  const widgets = Array.isArray(state.widgets) ? state.widgets : [];
  const queries = Array.isArray(state.queries) ? state.queries : [];

  // Map the builder's typed widgets back onto the static-SWA codegen contract
  // ({id,title,kind,query}). REST-bound widgets carry a real path so the
  // generated bundle stays deployable; KQL/SQL/text/container widgets (which a
  // static SWA can't execute) are simply omitted from the bundle.
  const widgetsForCodegen = useMemo(() => {
    const byId = new Map(queries.map((q) => [q.id, q]));
    return widgets.map((w) => {
      let query = '';
      if (w.queryId) { const q = byId.get(w.queryId); if (q?.type === 'rest-dab') query = q.path || ''; }
      else if (w.query) query = w.query;
      const kind: 'table' | 'chart' | 'metric' = w.kind === 'chart' || w.kind === 'metric' ? w.kind : 'table';
      return { id: w.id, title: w.title, kind, query };
    }).filter((w) => w.query);
  }, [widgets, queries]);

  const setApiBaseUrl = useCallback((v: string) => setState((p) => ({ ...p, apiBaseUrl: v })), [setState]);
  const onQueriesChange = useCallback((next: SlateQueryDef[]) => setState((p) => ({ ...p, queries: next })), [setState]);
  const onWidgetsChange = useCallback((next: SlateWidgetDef[]) => setState((p) => ({ ...p, widgets: next })), [setState]);

  const generate = useCallback(async () => {
    setGenBusy(true); setGenErr(null);
    try {
      const r = await fetch(`/api/items/slate-app/${encodeURIComponent(id)}/generate`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ apiBaseUrl: state.apiBaseUrl || '/api', widgets: widgetsForCodegen }),
      });
      const j = await r.json().catch(() => ({}));
      if (!j?.ok) { setGenErr(j?.error || `HTTP ${r.status}`); return; }
      setFiles(Array.isArray(j.files) ? j.files : []);
      setFileTab((j.files?.[0]?.name) || 'index.html');
    } catch (e: any) { setGenErr(e?.message || String(e)); }
    finally { setGenBusy(false); }
  }, [id, state.apiBaseUrl, widgetsForCodegen]);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'App', actions: [
        { label: saving ? 'Saving…' : 'Save', onClick: () => save(), disabled: saving || !dirty },
        { label: genBusy ? 'Generating…' : 'Generate bundle', onClick: generate, disabled: genBusy || widgetsForCodegen.length === 0 },
      ]},
    ]},
  ], [save, saving, dirty, generate, genBusy, widgetsForCodegen.length]);

  if (id === 'new') return <NewItemCreateGate item={item} createLabel="Create Slate app" intro="A live dashboard / app builder over Azure-native data (ADX, Synapse serverless, DAB REST). Compose queries + widgets on a drag-resize canvas, preview them live, then generate a deployable Azure Static Web Apps bundle — no Fabric required." />;

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={
      <div className={s.pad}>
        {loading && <Spinner size="small" label="Loading…" labelPosition="after" />}
        <MessageBar intent="info"><MessageBarBody>
          <MessageBarTitle>Slate app (Palantir Slate)</MessageBarTitle>
          Build a live app: define queries (REST / KQL / SQL over Azure-native backends), place widgets on the drag-resize canvas, and preview them bound to real data. Generate a deployable Azure Static Web Apps bundle when ready. No Microsoft Fabric required.
        </MessageBarBody></MessageBar>

        <div className={s.section}>
          <SectionHead icon={<Database20Regular />} title="Data API base" hint="The DAB / Ontology-SDK REST base that REST queries resolve against (e.g. /api or an APIM URL). KQL / SQL queries hit ADX / Synapse directly." />
          <Field label="API base URL"><Input value={String(state.apiBaseUrl || '/api')} onChange={(_, d) => setApiBaseUrl(d.value)} placeholder="/api" /></Field>
          {state.functionItemId && (
            <Caption1 className={s.hint}>
              Backed by an Azure Functions API scaffolded with this app — the base URL above points at its route.
              <Button appearance="transparent" size="small" icon={<Link20Regular />}
                onClick={() => router.push(`/items/user-data-function/${encodeURIComponent(String(state.functionItemId))}`)}>
                Open Functions API
              </Button>
            </Caption1>
          )}
        </div>

        <SlateAppBuilder
          id={id}
          apiBaseUrl={String(state.apiBaseUrl || '/api')}
          queries={queries}
          widgets={widgets}
          onQueriesChange={onQueriesChange}
          onWidgetsChange={onWidgetsChange}
        />

        {genErr && <MessageBar intent="error"><MessageBarBody>{genErr}</MessageBarBody></MessageBar>}

        {files.length > 0 && (
          <div className={s.section}>
            <SectionHead icon={<Code20Regular />} title="Generated Static Web Apps bundle" hint="Copy these files into your SWA repo, or wire them through a release-environment promotion. REST-bound widgets are embedded; KQL / SQL widgets run live in Preview but aren't part of the static bundle." />
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
type EnvType = 'dev' | 'test' | 'staging' | 'preprod' | 'prod' | 'custom';
type TargetKind = 'workspace' | 'appservice' | 'ade';
const ENV_TYPES: EnvType[] = ['dev', 'test', 'staging', 'preprod', 'prod', 'custom'];
function envTypeColor(t?: EnvType): 'brand' | 'informative' | 'warning' | 'severe' | 'success' | 'subtle' {
  switch (t) {
    case 'dev': return 'informative';
    case 'test': return 'brand';
    case 'staging': return 'warning';
    case 'preprod': return 'severe';
    case 'prod': return 'success';
    default: return 'subtle';
  }
}
interface ReleaseStage { id: string; name: string; workspace?: string }
interface ReleaseEnvironment {
  id: string; name: string; type: EnvType; order: number; targetKind: TargetKind;
  workspace?: string; subscriptionId?: string; resourceGroup?: string; site?: string; slot?: string;
  region?: string; deploymentIdentity?: string; tags?: string; currentVersion?: string;
}
interface PipelineEdge { id: string; from: string; to: string; mode: 'manual' | 'auto'; approvalsRequired: number; approvers?: string }
interface ReleaseVersion { id: string; version: string; buildId?: string; commit?: string; image?: string; notes?: string; createdAt: string }
interface ApprovalRecord { by: string; at: string; decision: 'approve' | 'reject'; comment?: string }
interface Promotion {
  id: string; fromStage: string; toStage: string; note?: string; environmentDefinition?: string; version?: string;
  status?: 'completed' | 'pending' | 'rejected'; approvalsRequired?: number; approvals?: ApprovalRecord[];
  promotedAt: string; promotedBy?: string; deployedEnvironment?: { name: string; provisioningState: string };
}
interface SwapRecord { id: string; site: string; resourceGroup: string; sourceSlot?: string; targetSlot: string; action: string; status: number; at: string; by?: string }
interface ReleaseState {
  environments?: ReleaseEnvironment[]; pipeline?: PipelineEdge[]; versions?: ReleaseVersion[];
  promotions?: Promotion[]; swaps?: SwapRecord[]; stages?: ReleaseStage[]; [k: string]: unknown;
}
interface ArmDeploymentLite { name: string; resourceGroup?: string; provisioningState?: string; timestamp?: string }
interface SlotLite { name: string; state?: string; defaultHostName?: string }

/** Migrate legacy flat `stages` into the rich environment model so existing items aren't empty. */
function migrateEnvs(p: ReleaseState): ReleaseEnvironment[] {
  const envs = Array.isArray(p.environments) ? p.environments : [];
  if (envs.length) return envs;
  const legacy = Array.isArray(p.stages) ? p.stages : [];
  return legacy.map((st, i) => ({ id: st.id, name: st.name, type: 'custom' as EnvType, order: i, targetKind: 'workspace' as TargetKind, workspace: st.workspace }));
}

export function ReleaseEnvironmentEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const { state, setState, loading, saving, error, savedAt, save, dirty } = useItemState<ReleaseState>('release-environment', id, { environments: [], pipeline: [], versions: [], promotions: [] });
  const [tab, setTab] = useState('environments');

  // Route-managed logs (real Cosmos via the promote/approve/swap/arm routes).
  const [promotions, setPromotions] = useState<Promotion[]>([]);
  const [devCenter, setDevCenter] = useState(false);

  // Environment add-form.
  const [envName, setEnvName] = useState('');
  const [envType, setEnvType] = useState<EnvType>('dev');
  const [targetKind, setTargetKind] = useState<TargetKind>('workspace');
  const [envWorkspace, setEnvWorkspace] = useState('');
  const [envSub, setEnvSub] = useState('');
  const [envRg, setEnvRg] = useState('');
  const [envSite, setEnvSite] = useState('');
  const [envSlot, setEnvSlot] = useState('');
  const [envRegion, setEnvRegion] = useState('');
  const [envIdentity, setEnvIdentity] = useState('');
  const [envTags, setEnvTags] = useState('');

  // Pipeline edge add-form.
  const [edgeFrom, setEdgeFrom] = useState('');
  const [edgeTo, setEdgeTo] = useState('');
  const [edgeMode, setEdgeMode] = useState<'manual' | 'auto'>('manual');
  const [edgeApprovals, setEdgeApprovals] = useState('0');
  const [edgeApprovers, setEdgeApprovers] = useState('');

  // Version add-form.
  const [verName, setVerName] = useState('');
  const [verBuild, setVerBuild] = useState('');
  const [verCommit, setVerCommit] = useState('');
  const [verImage, setVerImage] = useState('');
  const [verNotes, setVerNotes] = useState('');

  // Promote form.
  const [fromStage, setFromStage] = useState('');
  const [toStage, setToStage] = useState('');
  const [promoVersion, setPromoVersion] = useState('');
  const [promoNote, setPromoNote] = useState('');
  const [envDef, setEnvDef] = useState('');
  const [promoMsg, setPromoMsg] = useState<{ intent: 'success' | 'error' | 'warning'; text: string } | null>(null);
  const [promoBusy, setPromoBusy] = useState(false);

  // Approvals.
  const [apprComment, setApprComment] = useState<Record<string, string>>({});
  const [apprBusy, setApprBusy] = useState(false);
  const [apprMsg, setApprMsg] = useState<{ intent: 'success' | 'error' | 'warning'; text: string } | null>(null);

  // Slot swap.
  const [swapEnvId, setSwapEnvId] = useState('');
  const [slots, setSlots] = useState<SlotLite[] | null>(null);
  const [swapSource, setSwapSource] = useState('');
  const [swapTarget, setSwapTarget] = useState('');
  const [swapAction, setSwapAction] = useState<'swap' | 'apply' | 'complete' | 'cancel'>('swap');
  const [swapGate, setSwapGate] = useState<string | null>(null);
  const [swapMsg, setSwapMsg] = useState<{ intent: 'success' | 'error' | 'warning'; text: string } | null>(null);
  const [swapBusy, setSwapBusy] = useState(false);

  // ARM history.
  const [arm, setArm] = useState<ArmDeploymentLite[] | null>(null);
  const [armGate, setArmGate] = useState<string | null>(null);
  const [armBusy, setArmBusy] = useState(false);

  const environments = useMemo<ReleaseEnvironment[]>(
    () => [...migrateEnvs(state)].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
    [state],
  );
  const pipeline = Array.isArray(state.pipeline) ? state.pipeline : [];
  const versions = Array.isArray(state.versions) ? state.versions : [];
  const swaps = Array.isArray(state.swaps) ? state.swaps : [];
  const appserviceEnvs = environments.filter((e) => e.targetKind === 'appservice');
  const pending = promotions.filter((p) => p.status === 'pending');

  const loadPromotions = useCallback(async () => {
    try {
      const r = await fetch(`/api/items/release-environment/${encodeURIComponent(id)}/promote`);
      const j = await r.json().catch(() => ({}));
      if (j?.ok) { setPromotions(Array.isArray(j.promotions) ? j.promotions : []); setDevCenter(!!j.devCenterConfigured); }
    } catch { /* ignore */ }
  }, [id]);
  useEffect(() => { if (id && id !== 'new') void loadPromotions(); }, [id, loadPromotions]);

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

  const addEnvironment = useCallback(() => {
    const name = envName.trim(); if (!name) return;
    setState((p) => {
      const cur = migrateEnvs(p);
      const order = cur.reduce((m, e) => Math.max(m, e.order ?? 0), -1) + 1;
      const next: ReleaseEnvironment = {
        id: `env_${Date.now()}`, name, type: envType, order, targetKind,
        workspace: envWorkspace.trim() || undefined, subscriptionId: envSub.trim() || undefined,
        resourceGroup: envRg.trim() || undefined, site: envSite.trim() || undefined, slot: envSlot.trim() || undefined,
        region: envRegion.trim() || undefined, deploymentIdentity: envIdentity.trim() || undefined, tags: envTags.trim() || undefined,
      };
      return { ...p, environments: [...cur, next] };
    });
    setEnvName(''); setEnvWorkspace(''); setEnvSub(''); setEnvRg(''); setEnvSite(''); setEnvSlot(''); setEnvRegion(''); setEnvIdentity(''); setEnvTags('');
  }, [envName, envType, targetKind, envWorkspace, envSub, envRg, envSite, envSlot, envRegion, envIdentity, envTags, setState]);

  const removeEnvironment = useCallback((eid: string) => {
    setState((p) => ({ ...p, environments: migrateEnvs(p).filter((x) => x.id !== eid) }));
  }, [setState]);

  const moveEnvironment = useCallback((eid: string, dir: -1 | 1) => {
    setState((p) => {
      const cur = [...migrateEnvs(p)].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      const i = cur.findIndex((x) => x.id === eid); const j = i + dir;
      if (i < 0 || j < 0 || j >= cur.length) return p;
      [cur[i], cur[j]] = [cur[j], cur[i]];
      return { ...p, environments: cur.map((e, k) => ({ ...e, order: k })) };
    });
  }, [setState]);

  const addEdge = useCallback(() => {
    if (!edgeFrom || !edgeTo || edgeFrom === edgeTo) return;
    setState((p) => ({ ...p, pipeline: [...(Array.isArray(p.pipeline) ? p.pipeline : []), {
      id: `edge_${Date.now()}`, from: edgeFrom, to: edgeTo, mode: edgeMode,
      approvalsRequired: Math.max(0, Number(edgeApprovals) || 0), approvers: edgeApprovers.trim() || undefined,
    }] }));
    setEdgeApprovers('');
  }, [edgeFrom, edgeTo, edgeMode, edgeApprovals, edgeApprovers, setState]);

  const removeEdge = useCallback((edid: string) => {
    setState((p) => ({ ...p, pipeline: (Array.isArray(p.pipeline) ? p.pipeline : []).filter((x) => x.id !== edid) }));
  }, [setState]);

  const addVersion = useCallback(() => {
    const v = verName.trim(); if (!v) return;
    setState((p) => ({ ...p, versions: [{
      id: `ver_${Date.now()}`, version: v, buildId: verBuild.trim() || undefined, commit: verCommit.trim() || undefined,
      image: verImage.trim() || undefined, notes: verNotes.trim() || undefined, createdAt: new Date().toISOString(),
    }, ...(Array.isArray(p.versions) ? p.versions : [])] }));
    setVerName(''); setVerBuild(''); setVerCommit(''); setVerImage(''); setVerNotes('');
  }, [verName, verBuild, verCommit, verImage, verNotes, setState]);

  const removeVersion = useCallback((vid: string) => {
    setState((p) => ({ ...p, versions: (Array.isArray(p.versions) ? p.versions : []).filter((x) => x.id !== vid) }));
  }, [setState]);

  const promote = useCallback(async () => {
    if (!fromStage || !toStage) { setPromoMsg({ intent: 'error', text: 'Pick both environments.' }); return; }
    setPromoBusy(true); setPromoMsg(null);
    try {
      const r = await fetch(`/api/items/release-environment/${encodeURIComponent(id)}/promote`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fromStage, toStage, version: promoVersion.trim() || undefined, note: promoNote.trim() || undefined, environmentDefinition: envDef.trim() || undefined }),
      });
      const j = await r.json().catch(() => ({}));
      if (!j?.ok) {
        const text = j?.gate ? `${j.gate.reason} ${j.gate.remediation}` : (j?.error || `HTTP ${r.status}`);
        setPromoMsg({ intent: j?.gate ? 'warning' : 'error', text });
        return;
      }
      setPromotions(Array.isArray(j.promotions) ? j.promotions : []);
      const dep = j.deployedEnvironment;
      setPromoMsg({
        intent: 'success',
        text: j.pending
          ? `Promotion ${fromStage} → ${toStage} queued for approval — clear it in the Approvals tab.`
          : dep
            ? `Promoted ${fromStage} → ${toStage}. Azure Deployment Environment "${dep.name}" → ${dep.provisioningState}.`
            : `Promoted ${fromStage} → ${toStage}.`,
      });
      setPromoNote('');
    } catch (e: any) { setPromoMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setPromoBusy(false); }
  }, [id, fromStage, toStage, promoVersion, promoNote, envDef]);

  const decide = useCallback(async (promotionId: string, decision: 'approve' | 'reject') => {
    setApprBusy(true); setApprMsg(null);
    try {
      const r = await fetch(`/api/items/release-environment/${encodeURIComponent(id)}/approve`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ promotionId, decision, comment: (apprComment[promotionId] || '').trim() || undefined }),
      });
      const j = await r.json().catch(() => ({}));
      if (Array.isArray(j.promotions)) setPromotions(j.promotions);
      if (!j?.ok) {
        const text = j?.gate ? `${j.gate.reason} ${j.gate.remediation}` : (j?.error || `HTTP ${r.status}`);
        setApprMsg({ intent: 'warning', text });
        return;
      }
      setApprMsg({ intent: 'success', text: `Recorded ${decision}.${j.promotion?.status === 'completed' ? ' Promotion completed + deployed.' : j.promotion?.status === 'rejected' ? ' Promotion rejected.' : ''}` });
      setApprComment((m) => ({ ...m, [promotionId]: '' }));
    } catch (e: any) { setApprMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setApprBusy(false); }
  }, [id, apprComment]);

  const loadSlots = useCallback(async () => {
    const env = environments.find((e) => e.id === swapEnvId);
    setSwapGate(null); setSwapMsg(null); setSlots(null);
    if (!env?.resourceGroup || !env?.site) { setSwapMsg({ intent: 'warning', text: 'Selected environment needs a resource group and App Service site.' }); return; }
    setSwapBusy(true);
    try {
      const r = await fetch(`/api/items/release-environment/${encodeURIComponent(id)}/swap?resourceGroup=${encodeURIComponent(env.resourceGroup)}&site=${encodeURIComponent(env.site)}`);
      const j = await r.json().catch(() => ({}));
      if (j?.ok) setSlots(Array.isArray(j.slots) ? j.slots : []);
      else if (j?.gate) setSwapGate(j.gate.remediation || j.gate.reason);
      else setSwapMsg({ intent: 'error', text: j?.error || `HTTP ${r.status}` });
    } catch (e: any) { setSwapMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setSwapBusy(false); }
  }, [environments, swapEnvId, id]);

  const runSwap = useCallback(async () => {
    const env = environments.find((e) => e.id === swapEnvId);
    if (!env?.resourceGroup || !env?.site) { setSwapMsg({ intent: 'warning', text: 'Selected environment needs a resource group and App Service site.' }); return; }
    if (!swapTarget.trim()) { setSwapMsg({ intent: 'warning', text: 'Pick a target slot.' }); return; }
    setSwapBusy(true); setSwapMsg(null); setSwapGate(null);
    try {
      const r = await fetch(`/api/items/release-environment/${encodeURIComponent(id)}/swap`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ resourceGroup: env.resourceGroup, site: env.site, sourceSlot: swapSource.trim() || undefined, targetSlot: swapTarget.trim(), action: swapAction }),
      });
      const j = await r.json().catch(() => ({}));
      if (!j?.ok) {
        const text = j?.gate ? `${j.gate.reason} ${j.gate.remediation}` : (j?.error || `HTTP ${r.status}`);
        setSwapMsg({ intent: j?.gate ? 'warning' : 'error', text });
        return;
      }
      setSwapMsg({ intent: 'success', text: `Slot ${swapAction} on ${env.site} (${swapSource.trim() || 'production'} ↔ ${swapTarget.trim()}) accepted — ARM HTTP ${j.result?.status}.` });
    } catch (e: any) { setSwapMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setSwapBusy(false); }
  }, [environments, swapEnvId, swapSource, swapTarget, swapAction, id]);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Environment', actions: [
        { label: saving ? 'Saving…' : 'Save', onClick: () => save(), disabled: saving || !dirty },
        { label: armBusy ? 'Loading…' : 'ARM history', onClick: loadArm, disabled: armBusy },
      ]},
    ]},
  ], [save, saving, dirty, loadArm, armBusy]);

  if (id === 'new') return <NewItemCreateGate item={item} createLabel="Create release environment" intro="Promotion / release orchestration across environments (dev → test → prod) with a promotion pipeline, approval gates, release versions, and real App Service slot swaps + Azure Deployment Environments. Azure-native — no Fabric required." />;

  // Pipeline lane: ordered environment cards joined by connectors that surface
  // each consecutive edge's mode + gate (Fabric Deployment Pipelines style).
  const laneNodes: ReactNode[] = [];
  environments.forEach((e, i) => {
    laneNodes.push(
      <div key={e.id} className={s.stageCard}>
        <div className={s.cardHead}><Cloud20Regular /><Subtitle2>{e.name}</Subtitle2><Badge appearance="tint" color={envTypeColor(e.type)}>{e.type}</Badge></div>
        <Caption1 className={s.hint}>{e.targetKind}{e.site ? ` · ${e.site}${e.slot ? `/${e.slot}` : ''}` : e.workspace ? ` · ${e.workspace}` : ''}</Caption1>
        <Badge appearance="outline">{e.currentVersion ? `v ${e.currentVersion}` : 'no version'}</Badge>
      </div>,
    );
    if (i < environments.length - 1) {
      const next = environments[i + 1];
      const edge = pipeline.find((x) => x.from === e.name && x.to === next.name);
      laneNodes.push(
        <div key={`c_${e.id}`} className={s.connector}>
          <ChevronRight20Regular />
          {edge
            ? <Badge size="small" appearance="tint" color={edge.mode === 'auto' ? 'success' : 'informative'}>{edge.mode}</Badge>
            : <Caption1 className={s.hint}>no edge</Caption1>}
          {edge && edge.approvalsRequired > 0 && <Badge size="small" appearance="tint" color="warning">gate {edge.approvalsRequired}</Badge>}
        </div>,
      );
    }
  });

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={
      <div className={s.pad}>
        {loading && <Spinner size="small" label="Loading…" labelPosition="after" />}
        <MessageBar intent="info"><MessageBarBody>
          <MessageBarTitle>Release environment (Palantir Apollo → Shuttle)</MessageBarTitle>
          Model dev → test → prod environments, wire a promotion pipeline with approval gates, track release versions, and execute real Azure promotions — App Service slot swaps and Azure Deployment Environments.{devCenter ? ' Azure Deployment Environments is configured — name a catalog environment definition when promoting.' : ' Set LOOM_DEVCENTER_PROJECT to provision catalog-driven Azure Deployment Environments.'} No Fabric required.
        </MessageBarBody></MessageBar>

        <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as string)} className={s.tabStrip}>
          <Tab value="environments" icon={<Cloud20Regular />}>Environments</Tab>
          <Tab value="pipeline" icon={<Branch20Regular />}>Pipeline</Tab>
          <Tab value="promote" icon={<Rocket20Regular />}>Promote / Swap</Tab>
          <Tab value="approvals" icon={<People20Regular />}>Approvals{pending.length ? ` (${pending.length})` : ''}</Tab>
          <Tab value="versions" icon={<Tag20Regular />}>Versions</Tab>
          <Tab value="history" icon={<History20Regular />}>History</Tab>
        </TabList>

        {/* ───────── Environments ───────── */}
        {tab === 'environments' && (
        <div className={s.section}>
          <SectionHead icon={<Cloud20Regular />} title="Environments" hint="dev → test → prod environments as first-class objects, ordered into a promotion sequence." />
          <div className={s.addBar}>
            <Field label="Name" className={s.fieldNarrow}><Input value={envName} onChange={(_, d) => setEnvName(d.value)} placeholder="prod" /></Field>
            <Field label="Type" className={s.fieldNarrow}><Dropdown value={envType} selectedOptions={[envType]} onOptionSelect={(_, d) => setEnvType((d.optionValue as EnvType) || 'dev')}>
              {ENV_TYPES.map((t) => <Option key={t} value={t}>{t}</Option>)}
            </Dropdown></Field>
            <Field label="Target" className={s.fieldNarrow}><Dropdown value={targetKind} selectedOptions={[targetKind]} onOptionSelect={(_, d) => setTargetKind((d.optionValue as TargetKind) || 'workspace')}>
              <Option value="workspace">Loom workspace</Option><Option value="appservice">App Service + slot</Option><Option value="ade">Deployment env</Option>
            </Dropdown></Field>
            {targetKind === 'workspace' && <Field label="Workspace"><Input value={envWorkspace} onChange={(_, d) => setEnvWorkspace(d.value)} placeholder="workspace id / name" /></Field>}
            {targetKind === 'appservice' && <>
              <Field label="Resource group" className={s.fieldNarrow}><Input value={envRg} onChange={(_, d) => setEnvRg(d.value)} placeholder="rg-loom" /></Field>
              <Field label="Site" className={s.fieldNarrow}><Input value={envSite} onChange={(_, d) => setEnvSite(d.value)} placeholder="loom-app" /></Field>
              <Field label="Slot" className={s.fieldNarrow}><Input value={envSlot} onChange={(_, d) => setEnvSlot(d.value)} placeholder="staging" /></Field>
            </>}
            {targetKind === 'ade' && <Field label="Resource group" className={s.fieldNarrow}><Input value={envRg} onChange={(_, d) => setEnvRg(d.value)} placeholder="rg-loom" /></Field>}
            {targetKind !== 'workspace' && <Field label="Subscription" className={s.fieldNarrow}><Input value={envSub} onChange={(_, d) => setEnvSub(d.value)} placeholder="sub id (optional)" /></Field>}
            <Field label="Region" className={s.fieldNarrow}><Input value={envRegion} onChange={(_, d) => setEnvRegion(d.value)} placeholder="eastus" /></Field>
            <Field label="Identity" className={s.fieldNarrow}><Input value={envIdentity} onChange={(_, d) => setEnvIdentity(d.value)} placeholder="UAMI (optional)" /></Field>
            <Field label="Tags" className={s.fieldNarrow}><Input value={envTags} onChange={(_, d) => setEnvTags(d.value)} placeholder="team=data" /></Field>
            <Button appearance="primary" icon={<Add20Regular />} disabled={!envName.trim()} onClick={addEnvironment}>Add environment</Button>
          </div>
          {environments.length === 0 ? <div className={s.empty}><Caption1>No environments yet — add dev / test / prod above.</Caption1></div> : (
            <div className={s.grid2}>
              {environments.map((e) => (
                <div key={e.id} className={s.stageCard}>
                  <div className={s.cardHead}>
                    <Cloud20Regular /><Subtitle2>{e.name}</Subtitle2>
                    <Badge appearance="tint" color={envTypeColor(e.type)}>{e.type}</Badge>
                    <span className={s.spacer} /><Caption1 className={s.hint}>#{(e.order ?? 0) + 1}</Caption1>
                  </div>
                  <div className={s.kv}><Caption1 className={s.hint}>Target</Caption1><Caption1>{e.targetKind}</Caption1></div>
                  {e.targetKind === 'workspace' && e.workspace && <div className={s.kv}><Caption1 className={s.hint}>Workspace</Caption1><Caption1>{e.workspace}</Caption1></div>}
                  {e.targetKind === 'appservice' && <div className={s.kv}><Caption1 className={s.hint}>Site / slot</Caption1><Caption1>{e.site || '—'}{e.slot ? ` / ${e.slot}` : ''}</Caption1></div>}
                  {e.resourceGroup && <div className={s.kv}><Caption1 className={s.hint}>Resource group</Caption1><Caption1>{e.resourceGroup}</Caption1></div>}
                  {e.region && <div className={s.kv}><Caption1 className={s.hint}>Region</Caption1><Caption1>{e.region}</Caption1></div>}
                  {e.deploymentIdentity && <div className={s.kv}><Caption1 className={s.hint}>Identity</Caption1><Caption1>{e.deploymentIdentity}</Caption1></div>}
                  {e.tags && <div className={s.kv}><Caption1 className={s.hint}>Tags</Caption1><Caption1>{e.tags}</Caption1></div>}
                  <div className={s.kv}><Caption1 className={s.hint}>Installed version</Caption1><Badge appearance="outline">{e.currentVersion || 'none'}</Badge></div>
                  <div className={s.cardActions}>
                    <Button size="small" appearance="subtle" onClick={() => moveEnvironment(e.id, -1)}>↑ Up</Button>
                    <Button size="small" appearance="subtle" onClick={() => moveEnvironment(e.id, 1)}>↓ Down</Button>
                    <span className={s.spacer} />
                    <Button size="small" appearance="subtle" icon={<Dismiss16Regular />} aria-label={`Remove ${e.name}`} onClick={() => removeEnvironment(e.id)}>Remove</Button>
                  </div>
                </div>
              ))}
            </div>
          )}
          <SaveStrip saving={saving} savedAt={savedAt} error={error} dirty={dirty} onSave={() => save()} />
        </div>
        )}

        {/* ───────── Pipeline ───────── */}
        {tab === 'pipeline' && (
        <div className={s.section}>
          <SectionHead icon={<Branch20Regular />} title="Promotion pipeline" hint="Directed promotion paths between environments, each with a manual/auto mode and an optional approval gate." />
          {environments.length === 0 ? <div className={s.empty}><Caption1>Add environments first.</Caption1></div> : <div className={s.pipelineLane}>{laneNodes}</div>}
          <div className={s.addBar}>
            <Field label="From" className={s.fieldNarrow}><Dropdown value={edgeFrom} selectedOptions={edgeFrom ? [edgeFrom] : []} onOptionSelect={(_, d) => setEdgeFrom(d.optionValue || '')} placeholder="from">
              {environments.map((e) => <Option key={e.id} value={e.name}>{e.name}</Option>)}
            </Dropdown></Field>
            <Field label="To" className={s.fieldNarrow}><Dropdown value={edgeTo} selectedOptions={edgeTo ? [edgeTo] : []} onOptionSelect={(_, d) => setEdgeTo(d.optionValue || '')} placeholder="to">
              {environments.map((e) => <Option key={e.id} value={e.name}>{e.name}</Option>)}
            </Dropdown></Field>
            <Field label="Mode" className={s.fieldNarrow}><Dropdown value={edgeMode} selectedOptions={[edgeMode]} onOptionSelect={(_, d) => setEdgeMode((d.optionValue as 'manual' | 'auto') || 'manual')}>
              <Option value="manual">manual</Option><Option value="auto">auto</Option>
            </Dropdown></Field>
            <Field label="Approvals required" className={s.fieldNarrow}><Input type="number" value={edgeApprovals} onChange={(_, d) => setEdgeApprovals(d.value)} /></Field>
            <Field label="Approvers (optional)"><Input value={edgeApprovers} onChange={(_, d) => setEdgeApprovers(d.value)} placeholder="alice@contoso.com, bob@contoso.com" /></Field>
            <Button appearance="primary" icon={<Add20Regular />} disabled={!edgeFrom || !edgeTo || edgeFrom === edgeTo} onClick={addEdge}>Add edge</Button>
          </div>
          {pipeline.length === 0 ? <div className={s.empty}><Caption1>No promotion edges yet.</Caption1></div> : (
            <div className={s.tableWrap}>
            <Table size="small" aria-label="Pipeline edges">
              <TableHeader><TableRow><TableHeaderCell>From</TableHeaderCell><TableHeaderCell>To</TableHeaderCell><TableHeaderCell>Mode</TableHeaderCell><TableHeaderCell>Gate</TableHeaderCell><TableHeaderCell>Approvers</TableHeaderCell><TableHeaderCell /></TableRow></TableHeader>
              <TableBody>
                {pipeline.map((ed) => (
                  <TableRow key={ed.id}>
                    <TableCell>{ed.from}</TableCell><TableCell>{ed.to}</TableCell>
                    <TableCell><Badge appearance="tint" color={ed.mode === 'auto' ? 'success' : 'informative'}>{ed.mode}</Badge></TableCell>
                    <TableCell>{ed.approvalsRequired > 0 ? <Badge appearance="tint" color="warning">{ed.approvalsRequired} approver(s)</Badge> : <Caption1 className={s.hint}>none</Caption1>}</TableCell>
                    <TableCell>{ed.approvers || '—'}</TableCell>
                    <TableCell><Button size="small" appearance="subtle" icon={<Dismiss16Regular />} aria-label="Remove edge" onClick={() => removeEdge(ed.id)} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            </div>
          )}
          <SaveStrip saving={saving} savedAt={savedAt} error={error} dirty={dirty} onSave={() => save()} />
        </div>
        )}

        {/* ───────── Promote / Swap ───────── */}
        {tab === 'promote' && (<>
        <div className={s.section}>
          <SectionHead icon={<Rocket20Regular />} title="Promote" hint="Promote a release version between environments. Gated edges queue for approval; an Azure Deployment Environment is created when a definition is named." />
          <div className={s.addBar}>
            <Field label="From" className={s.fieldNarrow}><Dropdown value={fromStage} selectedOptions={fromStage ? [fromStage] : []} onOptionSelect={(_, d) => setFromStage(d.optionValue || '')} placeholder="from">
              {environments.map((e) => <Option key={e.id} value={e.name}>{e.name}</Option>)}
            </Dropdown></Field>
            <Field label="To" className={s.fieldNarrow}><Dropdown value={toStage} selectedOptions={toStage ? [toStage] : []} onOptionSelect={(_, d) => setToStage(d.optionValue || '')} placeholder="to">
              {environments.map((e) => <Option key={e.id} value={e.name}>{e.name}</Option>)}
            </Dropdown></Field>
            <Field label="Version" className={s.fieldNarrow}><Dropdown value={promoVersion} selectedOptions={promoVersion ? [promoVersion] : []} onOptionSelect={(_, d) => setPromoVersion(d.optionValue || '')} placeholder="version">
              {versions.map((v) => <Option key={v.id} value={v.version}>{v.version}</Option>)}
            </Dropdown></Field>
            {devCenter && <Field label="Environment definition"><Input value={envDef} onChange={(_, d) => setEnvDef(d.value)} placeholder="loom-app-env" /></Field>}
            <Field label="Note"><Input value={promoNote} onChange={(_, d) => setPromoNote(d.value)} placeholder="release notes" /></Field>
            <Button appearance="primary" icon={<Rocket20Regular />} disabled={promoBusy || !fromStage || !toStage} onClick={promote}>{promoBusy ? 'Promoting…' : 'Promote'}</Button>
          </div>
          {promoMsg && <MessageBar intent={promoMsg.intent}><MessageBarBody>{promoMsg.text}</MessageBarBody></MessageBar>}
        </div>

        <div className={s.section}>
          <SectionHead icon={<ArrowSwap20Regular />} title="App Service slot swap" hint="Blue-green promotion + rollback via real Microsoft.Web/sites slot swaps for an App Service-backed environment." />
          {appserviceEnvs.length === 0 ? (
            <div className={s.empty}><Caption1>No App Service environments. Add an environment with target “App Service + slot” (resource group + site) to swap slots.</Caption1></div>
          ) : (<>
            <div className={s.addBar}>
              <Field label="Environment" className={s.fieldStep}><Dropdown value={environments.find((e) => e.id === swapEnvId)?.name || ''} selectedOptions={swapEnvId ? [swapEnvId] : []} onOptionSelect={(_, d) => { setSwapEnvId(d.optionValue || ''); setSlots(null); setSwapGate(null); }} placeholder="App Service env">
                {appserviceEnvs.map((e) => <Option key={e.id} value={e.id}>{e.name} · {e.site}</Option>)}
              </Dropdown></Field>
              <Button appearance="outline" disabled={swapBusy || !swapEnvId} onClick={loadSlots}>{swapBusy ? 'Loading…' : 'Load slots'}</Button>
            </div>
            {swapGate && <MessageBar intent="warning"><MessageBarBody><MessageBarTitle>App Service not configured</MessageBarTitle>{swapGate}</MessageBarBody></MessageBar>}
            {slots && (
              <div className={s.addBar}>
                <Field label="Source slot" className={s.fieldNarrow}><Dropdown value={swapSource} selectedOptions={swapSource ? [swapSource] : []} onOptionSelect={(_, d) => setSwapSource(d.optionValue || '')} placeholder="production">
                  <Option value="production">production</Option>
                  {slots.map((sl) => <Option key={sl.name} value={sl.name}>{sl.name}</Option>)}
                </Dropdown></Field>
                <Field label="Target slot" className={s.fieldNarrow}><Dropdown value={swapTarget} selectedOptions={swapTarget ? [swapTarget] : []} onOptionSelect={(_, d) => setSwapTarget(d.optionValue || '')} placeholder="staging">
                  {slots.map((sl) => <Option key={sl.name} value={sl.name}>{sl.name}</Option>)}
                  <Option value="production">production</Option>
                </Dropdown></Field>
                <Field label="Action" className={s.fieldNarrow}><Dropdown value={swapAction} selectedOptions={[swapAction]} onOptionSelect={(_, d) => setSwapAction((d.optionValue as 'swap' | 'apply' | 'complete' | 'cancel') || 'swap')}>
                  <Option value="swap">swap</Option><Option value="apply">apply (preview)</Option><Option value="complete">complete</Option><Option value="cancel">cancel</Option>
                </Dropdown></Field>
                <Button appearance="primary" icon={<ArrowSwap20Regular />} disabled={swapBusy || !swapTarget} onClick={runSwap}>{swapBusy ? 'Running…' : 'Run'}</Button>
              </div>
            )}
            {slots && slots.length === 0 && !swapGate && <div className={s.empty}><Caption1>Site has no deployment slots — add a staging slot in the portal to enable swaps.</Caption1></div>}
            {swapMsg && <MessageBar intent={swapMsg.intent}><MessageBarBody>{swapMsg.text}</MessageBarBody></MessageBar>}
          </>)}
        </div>
        </>)}

        {/* ───────── Approvals ───────── */}
        {tab === 'approvals' && (
        <div className={s.section}>
          <SectionHead icon={<People20Regular />} title="Pending approvals" hint="Promotions held by an approval gate. Approve or reject with a comment; the deploy runs when the gate clears." />
          {apprMsg && <MessageBar intent={apprMsg.intent}><MessageBarBody>{apprMsg.text}</MessageBarBody></MessageBar>}
          {pending.length === 0 ? <div className={s.empty}><Caption1>No promotions waiting for approval.</Caption1></div> : (
            <div className={s.grid2}>
              {pending.map((p) => {
                const approved = (p.approvals || []).filter((a) => a.decision === 'approve').length;
                return (
                  <div key={p.id} className={s.stageCard}>
                    <div className={s.cardHead}>
                      <Badge appearance="tint" color="informative">{p.fromStage}</Badge><ChevronRight20Regular /><Badge appearance="tint" color="brand">{p.toStage}</Badge>
                      <span className={s.spacer} /><Badge appearance="tint" color="warning">{approved}/{p.approvalsRequired || 1}</Badge>
                    </div>
                    {p.version && <div className={s.kv}><Caption1 className={s.hint}>Version</Caption1><Caption1>{p.version}</Caption1></div>}
                    {p.note && <div className={s.kv}><Caption1 className={s.hint}>Note</Caption1><Caption1>{p.note}</Caption1></div>}
                    <div className={s.kv}><Caption1 className={s.hint}>Requested by</Caption1><Caption1>{p.promotedBy || '—'}</Caption1></div>
                    <Field label="Comment"><Input value={apprComment[p.id] || ''} onChange={(_, d) => setApprComment((m) => ({ ...m, [p.id]: d.value }))} placeholder="optional approval comment" /></Field>
                    <div className={s.cardActions}>
                      <Button size="small" appearance="primary" icon={<CheckmarkCircle20Regular />} disabled={apprBusy} onClick={() => decide(p.id, 'approve')}>Approve</Button>
                      <Button size="small" appearance="subtle" icon={<DismissCircle20Regular />} disabled={apprBusy} onClick={() => decide(p.id, 'reject')}>Reject</Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        )}

        {/* ───────── Versions ───────── */}
        {tab === 'versions' && (
        <div className={s.section}>
          <SectionHead icon={<Tag20Regular />} title="Release versions" hint="The artifact versions promoted between environments — build id, git commit, container tag, notes." />
          <div className={s.addBar}>
            <Field label="Version" className={s.fieldNarrow}><Input value={verName} onChange={(_, d) => setVerName(d.value)} placeholder="1.4.0" /></Field>
            <Field label="Build id" className={s.fieldNarrow}><Input value={verBuild} onChange={(_, d) => setVerBuild(d.value)} placeholder="ci-1234" /></Field>
            <Field label="Commit" className={s.fieldNarrow}><Input value={verCommit} onChange={(_, d) => setVerCommit(d.value)} placeholder="a1b2c3d" /></Field>
            <Field label="Container tag" className={s.fieldNarrow}><Input value={verImage} onChange={(_, d) => setVerImage(d.value)} placeholder="acr.azurecr.io/app:1.4.0" /></Field>
            <Field label="Notes"><Input value={verNotes} onChange={(_, d) => setVerNotes(d.value)} placeholder="changelog" /></Field>
            <Button appearance="primary" icon={<Add20Regular />} disabled={!verName.trim()} onClick={addVersion}>Add version</Button>
          </div>
          {versions.length === 0 ? <div className={s.empty}><Caption1>No versions yet.</Caption1></div> : (
            <div className={s.tableWrap}>
            <Table size="small" aria-label="Versions">
              <TableHeader><TableRow><TableHeaderCell>Version</TableHeaderCell><TableHeaderCell>Build</TableHeaderCell><TableHeaderCell>Commit</TableHeaderCell><TableHeaderCell>Container tag</TableHeaderCell><TableHeaderCell>Notes</TableHeaderCell><TableHeaderCell /></TableRow></TableHeader>
              <TableBody>
                {versions.map((v) => (
                  <TableRow key={v.id}>
                    <TableCell><Badge appearance="tint" color="brand">{v.version}</Badge></TableCell>
                    <TableCell>{v.buildId || '—'}</TableCell><TableCell>{v.commit || '—'}</TableCell>
                    <TableCell>{v.image || '—'}</TableCell><TableCell>{v.notes || '—'}</TableCell>
                    <TableCell><Button size="small" appearance="subtle" icon={<Dismiss16Regular />} aria-label="Remove version" onClick={() => removeVersion(v.id)} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            </div>
          )}
          <SectionHead icon={<Database20Regular />} title="What's where" hint="The release version currently installed in each environment (updated on promotion)." />
          {environments.length === 0 ? <div className={s.empty}><Caption1>Add environments to see the matrix.</Caption1></div> : (
            <div className={s.tableWrap}>
            <Table size="small" aria-label="Version matrix">
              <TableHeader><TableRow><TableHeaderCell>Environment</TableHeaderCell><TableHeaderCell>Type</TableHeaderCell><TableHeaderCell>Installed version</TableHeaderCell></TableRow></TableHeader>
              <TableBody>
                {environments.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell>{e.name}</TableCell>
                    <TableCell><Badge appearance="tint" color={envTypeColor(e.type)}>{e.type}</Badge></TableCell>
                    <TableCell>{e.currentVersion ? <Badge appearance="outline">{e.currentVersion}</Badge> : <Caption1 className={s.hint}>none</Caption1>}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            </div>
          )}
          <SaveStrip saving={saving} savedAt={savedAt} error={error} dirty={dirty} onSave={() => save()} />
        </div>
        )}

        {/* ───────── History ───────── */}
        {tab === 'history' && (<>
        <div className={s.section}>
          <SectionHead icon={<History20Regular />} title="Promotion history" hint="Every recorded promotion, its status, version, and any deployed Azure environment." />
          {promotions.length === 0 ? <div className={s.empty}><Caption1>No promotions yet.</Caption1></div> : (
            <div className={s.tableWrap}>
            <Table size="small" aria-label="Promotions">
              <TableHeader><TableRow><TableHeaderCell>From</TableHeaderCell><TableHeaderCell>To</TableHeaderCell><TableHeaderCell>Status</TableHeaderCell><TableHeaderCell>Version</TableHeaderCell><TableHeaderCell>When</TableHeaderCell><TableHeaderCell>By</TableHeaderCell><TableHeaderCell>Note</TableHeaderCell></TableRow></TableHeader>
              <TableBody>
                {promotions.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell>{p.fromStage}</TableCell><TableCell>{p.toStage}</TableCell>
                    <TableCell><Badge appearance="tint" color={p.status === 'completed' ? 'success' : p.status === 'rejected' ? 'danger' : 'warning'}>{p.status || 'completed'}</Badge></TableCell>
                    <TableCell>{p.version || '—'}</TableCell>
                    <TableCell>{new Date(p.promotedAt).toLocaleString()}</TableCell>
                    <TableCell>{p.promotedBy || '—'}</TableCell><TableCell>{p.note || '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            </div>
          )}
        </div>

        {swaps.length > 0 && (
        <div className={s.section}>
          <SectionHead icon={<ArrowSwap20Regular />} title="Slot swaps" hint="Real App Service slot operations executed from this environment." />
          <div className={s.tableWrap}>
          <Table size="small" aria-label="Slot swaps">
            <TableHeader><TableRow><TableHeaderCell>Site</TableHeaderCell><TableHeaderCell>Action</TableHeaderCell><TableHeaderCell>Slots</TableHeaderCell><TableHeaderCell>Status</TableHeaderCell><TableHeaderCell>When</TableHeaderCell><TableHeaderCell>By</TableHeaderCell></TableRow></TableHeader>
            <TableBody>
              {swaps.map((sw) => (
                <TableRow key={sw.id}>
                  <TableCell>{sw.site}</TableCell><TableCell><Badge appearance="tint" color="informative">{sw.action}</Badge></TableCell>
                  <TableCell>{sw.sourceSlot || 'production'} ↔ {sw.targetSlot}</TableCell>
                  <TableCell>{sw.status}</TableCell>
                  <TableCell>{new Date(sw.at).toLocaleString()}</TableCell><TableCell>{sw.by || '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          </div>
        </div>
        )}

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
        </>)}
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
          {checkType === 'custom' && <Field label="KQL condition (fires when it returns rows)"><Textarea value={customKql} onChange={(_, d) => setCustomKql(d.value)} placeholder={'MyTable\n| where TimeGenerated > ago(1h)\n| summarize n=count()\n| where n == 0'} rows={4} resize="vertical" /></Field>}
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

// ───────────────────────── AIP Logic function (Spindle Studio) ─────────────────────────
// AIP Logic typed-input system (Palantir parity): full type set, with object*
// types bound to a Weave ontology entity type. Values are coerced client-side
// before they hit the real Azure OpenAI invoke route.
const AIP_INPUT_TYPES = [
  'string', 'integer', 'long', 'double', 'float', 'boolean', 'date', 'timestamp',
  'array', 'struct', 'object', 'object list', 'object set', 'model', 'media reference',
] as const;
const AIP_NUMERIC = new Set(['integer', 'long', 'double', 'float', 'number']);
const AIP_OBJECT = new Set(['object', 'object list', 'object set']);
const AIP_JSON = new Set(['array', 'struct']);
function coerceAipValue(type: string, raw: string): unknown {
  if (AIP_NUMERIC.has(type)) return raw.trim() === '' ? null : Number(raw);
  if (type === 'boolean') return /^(true|1|yes|on)$/i.test(raw.trim());
  if (AIP_JSON.has(type)) { try { return raw.trim() ? JSON.parse(raw) : (type === 'array' ? [] : {}); } catch { return raw; } }
  return raw;
}
interface RunStepLite { kind?: string; type?: string; name?: string; callId?: string; content?: string; error?: string; result?: unknown; status?: string; elapsedMs?: number; prompt?: string; model?: string }
function trimStep(st: RunStepLite): RunStepLite {
  const { kind, type, name, callId, content, error, status, elapsedMs } = st;
  return { kind, type, name, callId, content: typeof content === 'string' ? content.slice(0, 600) : content, error, status, elapsedMs };
}
interface AipInputDef { id: string; name: string; type: string; objectType?: string; description?: string; required?: boolean }
interface AipStepDef { id: string; kind: 'llm-prompt' | 'extract' | 'branch'; name: string; prompt: string }
interface AipUsageLite { promptTokens?: number; completionTokens?: number; totalTokens?: number; [k: string]: unknown }
interface AipRunRecord {
  id: string; ts: string; mode: 'logic' | 'agent'; model?: string;
  inputs?: Record<string, unknown>; output?: string; sources?: string[];
  steps?: RunStepLite[]; usage?: AipUsageLite; ok: boolean;
}
interface AipState {
  inputs?: AipInputDef[]; steps?: AipStepDef[]; outputType?: string; outputDescription?: string;
  boundOntologyId?: string; boundOntologyName?: string; ontologyEntityTypes?: string[];
  foundryAgentId?: string; foundryModel?: string; lastDeployedAt?: string;
  runs?: AipRunRecord[];
  [k: string]: unknown;
}

export function AipLogicEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const { state, setState, loading, saving, error, savedAt, save, dirty } = useItemState<AipState>('aip-logic', id, { inputs: [], steps: [], outputType: 'string' });
  const [inName, setInName] = useState('');
  const [inType, setInType] = useState<string>('string');
  const [inObjType, setInObjType] = useState('');
  const [inDesc, setInDesc] = useState('');
  const [inReq, setInReq] = useState(false);
  const [stepKind, setStepKind] = useState<'llm-prompt' | 'extract' | 'branch'>('llm-prompt');
  const [stepName, setStepName] = useState('');
  const [stepPrompt, setStepPrompt] = useState('');
  const [invokeVals, setInvokeVals] = useState<Record<string, string>>({});
  const [invokeBusy, setInvokeBusy] = useState(false);
  const [invokeOut, setInvokeOut] = useState<string | null>(null);
  const [invokeMsg, setInvokeMsg] = useState<{ intent: 'error' | 'warning'; text: string } | null>(null);
  const [agentMode, setAgentMode] = useState(false);
  const [runSteps, setRunSteps] = useState<RunStepLite[]>([]);
  const [sourcesUsed, setSourcesUsed] = useState<string[]>([]);

  // Ontology binding (Spindle grounds on the Weave) — shared hook for parity with
  // Workshop / SDK editors. Avoids divergent local grounding logic.
  const onto = useOntologyBinding('aip-logic', id);

  // Deploy / run-as-Foundry-agent.
  const [deployBusy, setDeployBusy] = useState(false);
  const [deployMsg, setDeployMsg] = useState<{ intent: 'success' | 'error' | 'warning'; text: string } | null>(null);

  const inputs = Array.isArray(state.inputs) ? state.inputs : [];
  const steps = Array.isArray(state.steps) ? state.steps : [];
  const runs = Array.isArray(state.runs) ? state.runs : [];

  // Mirror the hook's bound surface into persisted item state so Invoke / Deploy
  // can read boundOntologyId + ontologyEntityTypes from the saved doc.
  useEffect(() => {
    if (!onto.surface) return;
    setState((p) => {
      const entityTypes = onto.surface!.classes.map((c) => c.name);
      if (p.boundOntologyId === onto.surface!.id
        && p.boundOntologyName === onto.surface!.displayName
        && Array.isArray(p.ontologyEntityTypes)
        && p.ontologyEntityTypes.length === entityTypes.length
        && p.ontologyEntityTypes.every((t, i) => t === entityTypes[i])) return p;
      return { ...p, boundOntologyId: onto.surface!.id, boundOntologyName: onto.surface!.displayName, ontologyEntityTypes: entityTypes };
    });
  }, [onto.surface, setState]);

  const addInput = useCallback(() => {
    const nm = inName.trim(); if (!/^[A-Za-z_][\w]*$/.test(nm)) return;
    const def: AipInputDef = { id: `in_${Date.now()}`, name: nm, type: inType };
    if (AIP_OBJECT.has(inType) && inObjType) def.objectType = inObjType;
    if (inDesc.trim()) def.description = inDesc.trim();
    if (inReq) def.required = true;
    setState((p) => ({ ...p, inputs: [...(Array.isArray(p.inputs) ? p.inputs : []), def] }));
    setInName(''); setInDesc(''); setInReq(false);
  }, [inName, inType, inObjType, inDesc, inReq, setState]);
  const removeInput = useCallback((iid: string) => setState((p) => ({ ...p, inputs: (Array.isArray(p.inputs) ? p.inputs : []).filter((x) => x.id !== iid) })), [setState]);

  // Coerce the raw invoke-form strings into typed values per the input schema.
  const buildTyped = useCallback(() => {
    const typed: Record<string, unknown> = {};
    for (const i of inputs) typed[i.name] = coerceAipValue(i.type, invokeVals[i.name] ?? '');
    return typed;
  }, [inputs, invokeVals]);

  // Run history — persisted to Cosmos through the existing item PATCH (state.runs).
  const persistRun = useCallback((rec: AipRunRecord) => {
    const prev = Array.isArray(state.runs) ? state.runs : [];
    const ns: AipState = { ...state, runs: [rec, ...prev].slice(0, 12) };
    setState(() => ns);
    void save(ns);
  }, [state, setState, save]);
  const loadRun = useCallback((rec: AipRunRecord) => {
    setInvokeOut(rec.output ?? '');
    setRunSteps(Array.isArray(rec.steps) ? rec.steps : []);
    setSourcesUsed(Array.isArray(rec.sources) ? rec.sources : []);
    setAgentMode(rec.mode === 'agent');
    setInvokeMsg(null);
  }, []);

  const addStep = useCallback(() => {
    const nm = stepName.trim() || stepKind;
    setState((p) => ({ ...p, steps: [...(Array.isArray(p.steps) ? p.steps : []), { id: `step_${Date.now()}`, kind: stepKind, name: nm, prompt: stepPrompt.trim() }] }));
    setStepName(''); setStepPrompt('');
  }, [stepKind, stepName, stepPrompt, setState]);
  const removeStep = useCallback((sid: string) => setState((p) => ({ ...p, steps: (Array.isArray(p.steps) ? p.steps : []).filter((x) => x.id !== sid) })), [setState]);

  const invoke = useCallback(async () => {
    setInvokeBusy(true); setInvokeMsg(null); setInvokeOut(null); setRunSteps([]); setSourcesUsed([]);
    const typed = buildTyped();
    try {
      const r = await fetch(`/api/items/aip-logic/${encodeURIComponent(id)}/invoke`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ inputs: typed, mode: agentMode ? 'agent' : 'logic' }),
      });
      const j = await r.json().catch(() => ({}));
      if (!j?.ok) {
        const gate = j?.gate ? ` ${j.gate.remediation || ''}` : '';
        if (Array.isArray(j?.steps)) setRunSteps(j.steps);
        setInvokeMsg({ intent: j?.gate ? 'warning' : 'error', text: `${j?.error || `HTTP ${r.status}`}${gate}` });
        return;
      }
      setInvokeOut(String(j.output ?? ''));
      if (Array.isArray(j?.steps)) setRunSteps(j.steps);
      if (Array.isArray(j?.sourcesUsed)) setSourcesUsed(j.sourcesUsed);
      persistRun({
        id: `run_${Date.now()}`, ts: new Date().toISOString(), mode: agentMode ? 'agent' : 'logic',
        model: j.model, inputs: typed, output: String(j.output ?? '').slice(0, 4000),
        sources: Array.isArray(j.sourcesUsed) ? j.sourcesUsed : undefined,
        steps: Array.isArray(j.steps) ? (j.steps as RunStepLite[]).slice(0, 30).map(trimStep) : undefined,
        usage: (j.usage && typeof j.usage === 'object') ? j.usage : undefined, ok: true,
      });
    } catch (e: any) { setInvokeMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setInvokeBusy(false); }
  }, [id, buildTyped, agentMode, persistRun]);

  const deploy = useCallback(async () => {
    setDeployBusy(true); setDeployMsg(null);
    try {
      const r = await fetch(`/api/items/aip-logic/${encodeURIComponent(id)}/deploy`, { method: 'POST' });
      const j = await r.json().catch(() => ({}));
      if (!j?.ok) {
        const gate = j?.gate ? ` ${j.gate.remediation || ''}` : j?.hint ? ` ${j.hint}` : '';
        setDeployMsg({ intent: j?.gate || j?.deferred ? 'warning' : 'error', text: `${j?.error || `HTTP ${r.status}`}${gate}` });
        return;
      }
      setState((p) => ({ ...p, foundryAgentId: j.agentId, foundryModel: j.model, lastDeployedAt: j.lastDeployedAt }));
      setDeployMsg({ intent: 'success', text: `Published Foundry agent "${j.agentId}" (model ${j.model}).` });
    } catch (e: any) { setDeployMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setDeployBusy(false); }
  }, [id, setState]);

  const runDeployedAgent = useCallback(async () => {
    setInvokeBusy(true); setInvokeMsg(null); setInvokeOut(null); setRunSteps([]);
    const typed = buildTyped();
    try {
      const r = await fetch(`/api/items/aip-logic/${encodeURIComponent(id)}/run-agent`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ inputs: typed }),
      });
      const j = await r.json().catch(() => ({}));
      if (Array.isArray(j?.steps)) setRunSteps(j.steps);
      if (!j?.ok) {
        const gate = j?.gate ? ` ${j.gate.remediation || ''}` : '';
        setInvokeMsg({ intent: j?.gate || j?.deferred ? 'warning' : 'error', text: `${j?.error || `HTTP ${r.status}`}${gate}` });
        return;
      }
      setInvokeOut(String(j.answer ?? ''));
      persistRun({
        id: `run_${Date.now()}`, ts: new Date().toISOString(), mode: 'agent',
        model: j.model || state.foundryModel, inputs: typed, output: String(j.answer ?? '').slice(0, 4000),
        steps: Array.isArray(j.steps) ? (j.steps as RunStepLite[]).slice(0, 30).map(trimStep) : undefined,
        usage: (j.usage && typeof j.usage === 'object') ? j.usage : undefined, ok: true,
      });
    } catch (e: any) { setInvokeMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setInvokeBusy(false); }
  }, [id, buildTyped, persistRun, state.foundryModel]);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Function', actions: [
        { label: saving ? 'Saving…' : 'Save', onClick: () => save(), disabled: saving || !dirty },
        { label: invokeBusy ? 'Running…' : 'Invoke', onClick: invoke, disabled: invokeBusy || steps.length === 0 },
      ]},
      { label: 'Publish', actions: [
        { label: deployBusy ? 'Deploying…' : 'Deploy as agent', onClick: deploy, disabled: deployBusy || steps.length === 0 },
      ]},
    ]},
  ], [save, saving, dirty, invoke, invokeBusy, steps.length, deploy, deployBusy]);

  if (id === 'new') return <NewItemCreateGate item={item} createLabel="Create Spindle logic / agent" intro="Spindle Studio — author a no-code typed AI function or agent: typed inputs → ordered steps → typed output, grounded on the Weave ontology and runnable against Azure OpenAI / Foundry. No Fabric required." />;

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={
      <div className={s.pad}>
        {loading && <Spinner size="small" label="Loading…" labelPosition="after" />}
        <MessageBar intent="info"><MessageBarBody>
          <MessageBarTitle>Spindle Studio (Palantir AIP Logic / AIP equivalent)</MessageBarTitle>
          Author typed inputs and ordered steps (dropdowns, no freeform JSON), ground on a Weave ontology, then invoke as logic or as a tool-calling agent against the live Azure OpenAI deployment. Optionally publish as an Azure AI Foundry agent. No Microsoft Fabric required.
        </MessageBarBody></MessageBar>

        <div className={s.section}>
          <SectionHead icon={<Link20Regular />} title="Ontology grounding" hint="Bind a Weave ontology — Spindle runs against its entity types and Lakehouse/Warehouse data bindings." />
          {!onto.loaded ? <div className={s.empty}><Spinner size="tiny" /></div> : onto.ontologies.length === 0 ? (
            <MessageBar intent="warning"><MessageBarBody>No ontologies found. Create an Ontology item first, then bind it here to ground this function on the Weave.</MessageBarBody></MessageBar>
          ) : (
            <div className={s.addBar}>
              <Field label="Bound ontology" className={s.fieldWide}>
                <Dropdown
                  value={state.boundOntologyName || (onto.boundOntologyId ? '(bound)' : 'None — runs ungrounded')}
                  selectedOptions={[String(onto.boundOntologyId || state.boundOntologyId || '')]}
                  disabled={onto.busy}
                  onOptionSelect={(_, d) => onto.bind(String(d.optionValue || ''))}>
                  <Option value="">None — runs ungrounded</Option>
                  {onto.ontologies.map((o) => <Option key={o.id} value={o.id}>{o.displayName}{typeof o.classCount === 'number' ? ` (${o.classCount} types)` : ''}</Option>)}
                </Dropdown>
              </Field>
              {onto.busy && <Spinner size="tiny" />}
            </div>
          )}
          {Array.isArray(state.ontologyEntityTypes) && state.ontologyEntityTypes.length > 0 && (
            <div className={s.row}><Caption1 className={s.hint}>Entity types:</Caption1>{state.ontologyEntityTypes.slice(0, 12).map((t) => <Badge key={t} appearance="tint">{t}</Badge>)}</div>
          )}
          {onto.msg && <MessageBar intent={onto.msg.intent}><MessageBarBody>{onto.msg.text}</MessageBarBody></MessageBar>}
        </div>

        <div className={s.grid2}>
          <div className={s.section}>
            <SectionHead icon={<Add20Regular />} title="Typed inputs" hint="Named parameters with an AIP Logic type — object types bind to the Weave ontology." />
            <div className={s.addBar}>
              <Field label="Name"><Input value={inName} onChange={(_, d) => setInName(d.value)} placeholder="customerId" /></Field>
              <Field label="Type" className={s.fieldMed}><Dropdown value={inType} selectedOptions={[inType]} onOptionSelect={(_, d) => { const v = String(d.optionValue || 'string'); setInType(v); if (!AIP_OBJECT.has(v)) setInObjType(''); }}>
                {AIP_INPUT_TYPES.map((t) => <Option key={t} value={t}>{t}</Option>)}
              </Dropdown></Field>
              {AIP_OBJECT.has(inType) && (
                <Field label="Object type" className={s.fieldMed}>
                  <Dropdown
                    value={inObjType || (state.ontologyEntityTypes && state.ontologyEntityTypes.length ? 'Pick entity type' : 'Bind an ontology first')}
                    selectedOptions={[inObjType]}
                    disabled={!(state.ontologyEntityTypes && state.ontologyEntityTypes.length)}
                    onOptionSelect={(_, d) => setInObjType(String(d.optionValue || ''))}>
                    {(state.ontologyEntityTypes || []).map((t) => <Option key={t} value={t}>{t}</Option>)}
                  </Dropdown>
                </Field>
              )}
              <Field label="Description" className={s.fieldStep}><Input value={inDesc} onChange={(_, d) => setInDesc(d.value)} placeholder="The customer to assess" /></Field>
              <Checkbox label="Required" checked={inReq} onChange={(_, d) => setInReq(!!d.checked)} />
              <Button appearance="primary" icon={<Add20Regular />} disabled={!/^[A-Za-z_][\w]*$/.test(inName.trim()) || (AIP_OBJECT.has(inType) && !inObjType)} onClick={addInput}>Add</Button>
            </div>
            {inputs.length === 0 ? <div className={s.empty}><Caption1>No inputs yet.</Caption1></div> : inputs.map((i) => (
              <div key={i.id} className={s.row}>
                <Body1><strong>{i.name}</strong></Body1>
                <Badge appearance="tint">{i.type}{i.objectType ? `: ${i.objectType}` : ''}</Badge>
                {i.required && <Badge appearance="outline" color="danger">required</Badge>}
                {i.description && <Caption1 className={s.hint}>{i.description}</Caption1>}
                <span className={s.spacer} />
                <Button size="small" appearance="subtle" icon={<Dismiss16Regular />} aria-label={`Remove ${i.name}`} onClick={() => removeInput(i.id)}>Remove</Button>
              </div>
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
            <Field label="Instruction" className={s.fieldStep}><Input value={stepPrompt} onChange={(_, d) => setStepPrompt(d.value)} placeholder="Summarize {customerId} risk" /></Field>
            <Button appearance="primary" icon={<Add20Regular />} onClick={addStep}>Add step</Button>
          </div>
          {steps.length === 0 ? <div className={s.empty}><Caption1>No steps yet — add at least one to invoke.</Caption1></div> : steps.map((st, n) => (
            <div key={st.id} className={s.row}><Badge appearance="filled" color="brand">{n + 1}</Badge><Badge appearance="tint">{st.kind}</Badge><Body1><strong>{st.name}</strong></Body1>{st.prompt && <Caption1 className={s.hint}>{st.prompt}</Caption1>}<span className={s.spacer} /><Button size="small" appearance="subtle" icon={<Dismiss16Regular />} aria-label={`Remove ${st.name}`} onClick={() => removeStep(st.id)}>Remove</Button></div>
          ))}
        </div>

        <div className={s.section}>
          <SectionHead icon={<Play20Regular />} title="Invoke" hint="Run against the live Azure OpenAI deployment — as typed logic or as a tool-calling agent over the bound ontology." />
          <div className={s.modeBar}>
            <Switch checked={agentMode} onChange={(_, d) => setAgentMode(!!d.checked)} label={agentMode ? 'Agent mode (multi-step, tool-calling)' : 'Logic mode (single grounded turn)'} />
            <span className={s.spacer} />
            <Badge appearance="tint" color={agentMode ? 'brand' : 'informative'} icon={agentMode ? <BrainCircuit20Regular /> : <Flash20Regular />}>{agentMode ? 'Agent' : 'Logic'}</Badge>
          </div>
          {inputs.length === 0 ? <Caption1 className={s.hint}>Add typed inputs to provide values.</Caption1> : inputs.map((i) => (
            <Field key={i.id} label={`${i.name} (${i.type}${i.objectType ? `: ${i.objectType}` : ''})${i.required ? ' *' : ''}`} hint={i.description || undefined}>
              <Input
                value={invokeVals[i.name] || ''}
                onChange={(_, d) => setInvokeVals((p) => ({ ...p, [i.name]: d.value }))}
                placeholder={AIP_JSON.has(i.type) ? (i.type === 'array' ? '["a","b"]' : '{"k":"v"}') : AIP_OBJECT.has(i.type) ? 'object id / primary key' : i.type === 'boolean' ? 'true / false' : ''} />
            </Field>
          ))}
          <Button appearance="primary" icon={<Play20Regular />} disabled={invokeBusy || steps.length === 0} onClick={invoke}>{invokeBusy ? 'Running…' : agentMode ? 'Run agent' : 'Invoke function'}</Button>
          {invokeMsg && <MessageBar intent={invokeMsg.intent}><MessageBarBody>{invokeMsg.text}</MessageBarBody></MessageBar>}
          {sourcesUsed.length > 0 && <div className={s.row}><Caption1 className={s.hint}>Grounded sources:</Caption1>{sourcesUsed.map((src) => <Badge key={src} appearance="tint" color="brand">{src}</Badge>)}</div>}
          {invokeOut !== null && <CodeBlock ariaLabel="Function output" content={invokeOut} />}
          {runSteps.length > 0 && (
            <>
              <Divider />
              <div className={s.sectionHead}>
                <span className={s.sectionIcon}><Bug20Regular /></span>
                <div>
                  <Subtitle2>Debugger</Subtitle2>
                  <Caption1 as="p" block className={s.hint}>{runSteps.length} step{runSteps.length === 1 ? '' : 's'} — expand a card to inspect the prompt, tool calls, output, and timing.</Caption1>
                </div>
              </div>
              <Accordion multiple collapsible>
                {runSteps.map((st, n) => {
                  const label = st.kind || st.type || st.name || 'step';
                  const isErr = st.kind === 'error' || !!st.error;
                  const isFinal = st.kind === 'final';
                  const head = st.kind === 'tool_call' ? `tool · ${st.name || ''}`
                    : st.kind === 'tool_result' ? `result · ${st.name || ''}`
                    : label;
                  const detail = st.error || st.prompt || st.content
                    || (st.result !== undefined ? JSON.stringify(st.result, null, 2) : '')
                    || st.name || '';
                  const key = st.callId || `${label}-${n}`;
                  return (
                    <AccordionItem key={key} value={key}>
                      <AccordionHeader>
                        <div className={s.traceHead}>
                          <Badge appearance="filled" color={isErr ? 'danger' : isFinal ? 'success' : 'brand'}>{n + 1}</Badge>
                          <Badge appearance="tint" color={isErr ? 'danger' : isFinal ? 'success' : 'informative'}>{head}</Badge>
                          {typeof st.elapsedMs === 'number' && <Caption1 className={s.hint}>{st.elapsedMs} ms</Caption1>}
                          {st.status && <Badge appearance="outline">{st.status}</Badge>}
                        </div>
                      </AccordionHeader>
                      <AccordionPanel>
                        {detail ? <CodeBlock ariaLabel={`Step ${n + 1} detail`} content={String(detail).slice(0, 4000)} /> : <Caption1 className={s.hint}>No additional detail for this step.</Caption1>}
                      </AccordionPanel>
                    </AccordionItem>
                  );
                })}
              </Accordion>
            </>
          )}
        </div>

        <div className={s.section}>
          <SectionHead icon={<History20Regular />} title="Run history" hint="Recent invocations persisted to Cosmos with this function — open a run to rehydrate its output and debugger trace." />
          {runs.length === 0 ? <div className={s.empty}><Caption1>No runs yet — Invoke the function to record a run.</Caption1></div> : (
            <div className={s.tableWrap}>
              <Table aria-label="Run history" size="small">
                <TableHeader><TableRow>
                  <TableHeaderCell>When</TableHeaderCell>
                  <TableHeaderCell>Mode</TableHeaderCell>
                  <TableHeaderCell>Model</TableHeaderCell>
                  <TableHeaderCell>Tokens</TableHeaderCell>
                  <TableHeaderCell>Output</TableHeaderCell>
                  <TableHeaderCell aria-label="actions" />
                </TableRow></TableHeader>
                <TableBody>
                  {runs.map((rec) => (
                    <TableRow key={rec.id}>
                      <TableCell><Caption1>{new Date(rec.ts).toLocaleString()}</Caption1></TableCell>
                      <TableCell><Badge appearance="tint" color={rec.mode === 'agent' ? 'brand' : 'informative'}>{rec.mode}</Badge></TableCell>
                      <TableCell><Caption1 className={s.hint}>{rec.model || '—'}</Caption1></TableCell>
                      <TableCell><Caption1 className={s.hint}>{rec.usage?.totalTokens ?? '—'}</Caption1></TableCell>
                      <TableCell><Caption1 className={s.hint}>{String(rec.output || '').slice(0, 60) || '—'}</Caption1></TableCell>
                      <TableCell><Button size="small" appearance="subtle" icon={<Play20Regular />} onClick={() => loadRun(rec)}>Open</Button></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>

        <div className={s.section}>
          <SectionHead icon={<Rocket20Regular />} title="Publish as Azure AI Foundry agent" hint="Deploy this Spindle logic as a real Foundry Agent Service agent, then run + inspect its steps. Unsupported in Azure Government — use Invoke (Azure-native) there." />
          <div className={s.addBar}>
            <Button appearance="primary" icon={<Rocket20Regular />} disabled={deployBusy || steps.length === 0} onClick={deploy}>{deployBusy ? 'Deploying…' : state.foundryAgentId ? 'Re-deploy agent' : 'Deploy as agent'}</Button>
            <Button appearance="secondary" icon={<Play20Regular />} disabled={invokeBusy || !state.foundryAgentId} onClick={runDeployedAgent}>Run deployed agent + inspect</Button>
            {state.foundryAgentId && <Badge appearance="tint" color="success">{state.foundryAgentId}</Badge>}
            {state.foundryModel && <Badge appearance="tint">model: {state.foundryModel}</Badge>}
          </div>
          {deployMsg && <MessageBar intent={deployMsg.intent}><MessageBarBody>{deployMsg.text}</MessageBarBody></MessageBar>}
        </div>

        <SaveStrip saving={saving} savedAt={savedAt} error={error} dirty={dirty} onSave={() => save()} />
      </div>
    } />
  );
}
