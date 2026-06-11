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
  Tab, TabList, Field, Dropdown, Option, Checkbox, Tooltip,
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
import {
  type AppDefinition, type AppPage, type AppComponent, type ComponentKind,
  migrateWorkshopState, newId, summarizeAppDef,
} from '@/lib/apps/app-definition';

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
    minWidth: 0,
  },
  rowActive: {
    borderColor: tokens.colorBrandStroke1,
    backgroundColor: tokens.colorBrandBackground2,
  },
  spacer: { flex: 1 },
  grid2: {
    display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: tokens.spacingHorizontalM,
    alignItems: 'start',
    '@media (max-width: 900px)': { gridTemplateColumns: 'minmax(0, 1fr)' },
  },
  metricCard: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS,
    padding: tokens.spacingVerticalL, borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground2,
  },
  metricValue: {
    fontSize: tokens.fontSizeHero700, fontWeight: tokens.fontWeightSemibold,
    lineHeight: tokens.lineHeightHero700, color: tokens.colorBrandForeground1,
  },
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
// The visual, multi-page low-code app BUILDER (audit-T145). Pages hold a palette
// of components (table / metric / text); each data component binds either an
// ontology entity type (read/written via Synapse) or an Azure Analysis Services
// semantic model (the same model a Rayfin app binds — DAX over XMLA). All real
// backend, dropdown-driven config, Azure-native default. See lib/apps/app-definition.ts.
interface WorkshopState {
  boundOntologyId?: string; boundOntologyName?: string;
  /** New format. */ appDef?: AppDefinition;
  /** Legacy v0 (migrated on load). */ objectViews?: string[]; actions?: unknown[];
  [k: string]: unknown;
}

interface BindableModelLite { name: string; storageMode?: string }
interface ModelObjectsLite { measures: { name: string; table?: string }[]; columns: { table: string; name: string; dataType?: string }[] }
interface PreviewState { busy?: boolean; columns?: string[]; rows?: unknown[][]; error?: string; gate?: boolean }

function gbParseKey(k: string): { table: string; column: string } { const i = k.indexOf('|'); return i < 0 ? { table: '', column: k } : { table: k.slice(0, i), column: k.slice(i + 1) }; }
function gbMakeKey(t: string, c: string): string { return `${t}|${c}`; }
function fmtCellW(v: unknown): string { return v === null || v === undefined ? '' : String(v); }

export function WorkshopAppEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const { state, setState, loading, saving, error, savedAt, save, dirty } = useItemState<WorkshopState>('workshop-app', id, {});
  const onto = useOntologyBinding('workshop-app', id);
  const [pickOnto, setPickOnto] = useState('');
  const classes = onto.surface?.classes || [];

  // Migrated, always-current app definition (reads state.appDef, else legacy v0).
  const appDef = useMemo(() => migrateWorkshopState(state), [state]);
  const updateDef = useCallback((next: AppDefinition) => setState((p) => ({ ...p, appDef: next })), [setState]);
  const counts = summarizeAppDef(appDef);

  // ── Page selection ──
  const [activePageId, setActivePageId] = useState('');
  useEffect(() => {
    if (appDef.pages.length && !appDef.pages.some((p) => p.id === activePageId)) setActivePageId(appDef.pages[0].id);
  }, [appDef, activePageId]);
  const activePage = appDef.pages.find((p) => p.id === activePageId) || null;
  const [editingId, setEditingId] = useState('');
  const editing = activePage?.components.find((c) => c.id === editingId) || null;

  // ── Page / component mutators ──
  const addPage = useCallback(() => {
    const pg: AppPage = { id: newId('pg'), name: `Page ${appDef.pages.length + 1}`, components: [] };
    updateDef({ ...appDef, pages: [...appDef.pages, pg] }); setActivePageId(pg.id);
  }, [appDef, updateDef]);
  const renamePage = useCallback((pid: string, name: string) => updateDef({ ...appDef, pages: appDef.pages.map((p) => p.id === pid ? { ...p, name } : p) }), [appDef, updateDef]);
  const removePage = useCallback((pid: string) => updateDef({ ...appDef, pages: appDef.pages.filter((p) => p.id !== pid) }), [appDef, updateDef]);
  const addComponent = useCallback((kind: ComponentKind) => {
    if (!activePage) return;
    const comp: AppComponent = { id: newId('cmp'), kind, title: `${kind[0].toUpperCase()}${kind.slice(1)} ${activePage.components.length + 1}`, ...(kind === 'text' ? { text: '' } : { binding: { source: 'ontology-entity', entity: '', top: 50 } }) };
    updateDef({ ...appDef, pages: appDef.pages.map((p) => p.id === activePage.id ? { ...p, components: [...p.components, comp] } : p) });
    setEditingId(comp.id);
  }, [appDef, activePage, updateDef]);
  const updateComponent = useCallback((cid: string, patch: Partial<AppComponent>) => updateDef({ ...appDef, pages: appDef.pages.map((p) => p.id === activePageId ? { ...p, components: p.components.map((c) => c.id === cid ? { ...c, ...patch } : c) } : p) }), [appDef, activePageId, updateDef]);
  const removeComponent = useCallback((cid: string) => { updateDef({ ...appDef, pages: appDef.pages.map((p) => p.id === activePageId ? { ...p, components: p.components.filter((c) => c.id !== cid) } : p) }); if (editingId === cid) setEditingId(''); }, [appDef, activePageId, updateDef, editingId]);

  // ── Actions ──
  const [actLabel, setActLabel] = useState('');
  const [actKind, setActKind] = useState<'create' | 'update'>('create');
  const [actEntity, setActEntity] = useState('');
  const addAction = useCallback(() => {
    const label = actLabel.trim(); if (!label || !actEntity) return;
    updateDef({ ...appDef, actions: [...appDef.actions, { id: newId('act'), label, kind: actKind, entity: actEntity }] });
    setActLabel(''); setActEntity('');
  }, [actLabel, actKind, actEntity, appDef, updateDef]);
  const removeAction = useCallback((aid: string) => updateDef({ ...appDef, actions: appDef.actions.filter((a) => a.id !== aid) }), [appDef, updateDef]);

  // ── New-app wizard (inline stepper) ──
  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizardPick, setWizardPick] = useState<string[]>([]);
  const generateFromOntology = useCallback(() => {
    const chosen = wizardPick.filter((n) => classes.some((c) => c.name === n));
    if (chosen.length === 0) return;
    const pages: AppPage[] = chosen.map((entity) => ({
      id: newId('pg'), name: entity,
      components: [{ id: newId('cmp'), kind: 'table' as ComponentKind, title: `${entity} list`, binding: { source: 'ontology-entity', entity, top: 50 } }],
    }));
    const actions = chosen.map((entity) => ({ id: newId('act'), label: `New ${entity}`, kind: 'create' as const, entity }));
    updateDef({ ...appDef, pages: [...appDef.pages, ...pages], actions: [...appDef.actions, ...actions] });
    if (pages[0]) setActivePageId(pages[0].id);
    setWizardOpen(false); setWizardPick([]);
  }, [wizardPick, classes, appDef, updateDef]);

  // ── AAS model catalogue (shared; reuses the Rayfin model-binding routes) ──
  const [models, setModels] = useState<BindableModelLite[] | null>(null);
  const [modelsBusy, setModelsBusy] = useState(false);
  const [modelsGate, setModelsGate] = useState<string | null>(null);
  const [modelObjects, setModelObjects] = useState<Record<string, ModelObjectsLite>>({});
  const loadModels = useCallback(async () => {
    setModelsBusy(true); setModelsGate(null);
    try {
      const r = await fetch('/api/items/rayfin-app/models');
      const j = await r.json().catch(() => ({}));
      if (j?.ok) setModels(Array.isArray(j.models) ? j.models : []);
      else if (j?.gate) { setModels([]); setModelsGate(`${j.error || 'Azure Analysis Services not configured'} — set ${j.gate.missing}.`); }
      else { setModels([]); setModelsGate(j?.error || `HTTP ${r.status}`); }
    } catch (e: any) { setModels([]); setModelsGate(e?.message || String(e)); }
    finally { setModelsBusy(false); }
  }, []);
  const loadModelObjects = useCallback(async (model: string) => {
    if (!model || modelObjects[model]) return;
    try {
      const r = await fetch(`/api/items/rayfin-app/model-objects?model=${encodeURIComponent(model)}`);
      const j = await r.json().catch(() => ({}));
      if (j?.ok) setModelObjects((p) => ({ ...p, [model]: { measures: j.measures || [], columns: j.columns || [] } }));
    } catch { /* surfaced when previewing */ }
  }, [modelObjects]);
  useEffect(() => {
    if (editing?.binding?.source === 'aas-model') {
      if (models === null && !modelsBusy) void loadModels();
      if (editing.binding.model) void loadModelObjects(editing.binding.model);
    }
  }, [editing, models, modelsBusy, loadModels, loadModelObjects]);

  // ── Live preview (per component) ──
  const [previews, setPreviews] = useState<Record<string, PreviewState>>({});
  const previewComponent = useCallback(async (comp: AppComponent) => {
    const b = comp.binding; if (!b) return;
    setPreviews((p) => ({ ...p, [comp.id]: { busy: true } }));
    try {
      let j: any;
      if (b.source === 'ontology-entity') {
        if (!b.entity) { setPreviews((p) => ({ ...p, [comp.id]: { error: 'Pick an ontology entity to bind.' } })); return; }
        const op = b.groupBy && b.groupBy.length ? 'aggregate' : 'list';
        const r = await fetch(`/api/items/workshop-app/${encodeURIComponent(id)}/data`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ entityType: b.entity, op, top: b.top || 50, groupBy: b.groupBy, columns: b.columns }),
        });
        j = await r.json().catch(() => ({}));
      } else {
        if (!b.model) { setPreviews((p) => ({ ...p, [comp.id]: { error: 'Pick a semantic model to bind.' } })); return; }
        const groupBy = b.groupBy.map((k) => gbParseKey(k));
        const r = await fetch('/api/items/rayfin-app/preview', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: b.model, measures: b.measures, groupBy, topN: b.topN }),
        });
        j = await r.json().catch(() => ({}));
      }
      if (!j?.ok) {
        const gateTxt = j?.gate ? ` ${j.gate.remediation || j.gate.detail || ''}` : '';
        setPreviews((p) => ({ ...p, [comp.id]: { error: `${j?.error || 'Preview failed'}${gateTxt}`, gate: !!j?.gate } }));
        return;
      }
      setPreviews((p) => ({ ...p, [comp.id]: { columns: Array.isArray(j.columns) ? j.columns : [], rows: Array.isArray(j.rows) ? j.rows : [] } }));
    } catch (e: any) { setPreviews((p) => ({ ...p, [comp.id]: { error: e?.message || String(e) } })); }
  }, [id]);

  // ── Action runner (real write-back over Synapse) ──
  const [runActionId, setRunActionId] = useState('');
  const [runCols, setRunCols] = useState<string[]>([]);
  const [runVals, setRunVals] = useState<Record<string, string>>({});
  const [runKeyCol, setRunKeyCol] = useState('');
  const [runKeyVal, setRunKeyVal] = useState('');
  const [runBusy, setRunBusy] = useState(false);
  const [runMsg, setRunMsg] = useState<{ intent: 'success' | 'error' | 'warning'; text: string } | null>(null);
  const openRunner = useCallback(async (action: { id: string; entity: string }) => {
    setRunActionId(action.id); setRunVals({}); setRunKeyCol(''); setRunKeyVal(''); setRunMsg(null); setRunCols([]); setRunBusy(true);
    try {
      const r = await fetch(`/api/items/workshop-app/${encodeURIComponent(id)}/data`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ entityType: action.entity, op: 'list', top: 1 }),
      });
      const j = await r.json().catch(() => ({}));
      if (!j?.ok) { const g = j?.gate ? ` ${j.gate.remediation || ''}` : ''; setRunMsg({ intent: j?.gate ? 'warning' : 'error', text: `${j?.error || `HTTP ${r.status}`}${g}` }); return; }
      setRunCols(Array.isArray(j.columns) ? j.columns : []);
    } catch (e: any) { setRunMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setRunBusy(false); }
  }, [id]);
  const submitRunner = useCallback(async (action: { kind: 'create' | 'update'; entity: string }) => {
    const values: Record<string, string> = {};
    for (const [k, v] of Object.entries(runVals)) if (v !== '') values[k] = v;
    if (Object.keys(values).length === 0) { setRunMsg({ intent: 'error', text: 'Enter at least one column value.' }); return; }
    if (action.kind === 'update' && !runKeyCol) { setRunMsg({ intent: 'error', text: 'Pick a key column for the update.' }); return; }
    setRunBusy(true); setRunMsg(null);
    try {
      const body: Record<string, unknown> = { entityType: action.entity, op: action.kind, values };
      if (action.kind === 'update') body.key = { column: runKeyCol, value: runKeyVal };
      const r = await fetch(`/api/items/workshop-app/${encodeURIComponent(id)}/run-action`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (!j?.ok) { const g = j?.gate ? ` ${j.gate.remediation || ''}` : ''; setRunMsg({ intent: j?.gate ? 'warning' : 'error', text: `${j?.error || `HTTP ${r.status}`}${g}` }); return; }
      setRunMsg({ intent: 'success', text: `${action.kind === 'create' ? 'Inserted' : 'Updated'} ${j.recordsAffected ?? 0} row(s) in ${action.entity}.` });
    } catch (e: any) { setRunMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setRunBusy(false); }
  }, [id, runVals, runKeyCol, runKeyVal]);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'App', actions: [
        { label: saving ? 'Saving…' : 'Save', onClick: () => save(), disabled: saving || !dirty },
        { label: 'Add page', onClick: addPage },
      ]},
    ]},
  ], [save, saving, dirty, addPage]);

  if (id === 'new') return <NewItemCreateGate item={item} createLabel="Create Atelier app" intro="A visual, multi-page low-code app bound to a Loom Ontology and/or Azure Analysis Services semantic models. Pages hold table / metric / text components with real data bindings, plus write-back actions. Runs on the Azure-native backend (Synapse + AAS) — no Microsoft Fabric required." />;

  const bindingEditor = (comp: AppComponent) => {
    const b = comp.binding;
    if (comp.kind === 'text') {
      return <Field label="Text content"><Textarea value={comp.text || ''} onChange={(_, d) => updateComponent(comp.id, { text: d.value })} rows={4} placeholder="Markdown-free static copy shown on the page." /></Field>;
    }
    if (!b) return null;
    const objs = b.source === 'aas-model' ? modelObjects[b.model] : undefined;
    const prev = previews[comp.id];
    return (
      <div className={s.pad} style={{ padding: 0, gap: tokens.spacingVerticalM }}>
        <Field label="Data source">
          <Dropdown value={b.source === 'aas-model' ? 'Semantic model (Azure Analysis Services)' : 'Ontology entity (Synapse)'} selectedOptions={[b.source]}
            onOptionSelect={(_, d) => updateComponent(comp.id, { binding: d.optionValue === 'aas-model'
              ? { source: 'aas-model', model: '', measures: [], groupBy: [], topN: 100 }
              : { source: 'ontology-entity', entity: '', top: 50 } })}>
            <Option value="ontology-entity">Ontology entity (Synapse)</Option>
            <Option value="aas-model">Semantic model (Azure Analysis Services)</Option>
          </Dropdown>
        </Field>

        {b.source === 'ontology-entity' ? (
          <>
            <Field label="Ontology entity">
              <Dropdown value={b.entity} selectedOptions={b.entity ? [b.entity] : []} placeholder={classes.length ? 'Select an object type' : 'Bind an ontology first'}
                onOptionSelect={(_, d) => updateComponent(comp.id, { binding: { ...b, entity: d.optionValue || '' } })}>
                {classes.map((c) => <Option key={c.name} value={c.name}>{c.name}</Option>)}
              </Dropdown>
            </Field>
            <Field label="Max rows"><Input type="number" value={String(b.top ?? 50)} onChange={(_, d) => updateComponent(comp.id, { binding: { ...b, top: Math.min(Math.max(Number(d.value) || 50, 1), 1000) } })} /></Field>
            {prev?.columns && prev.columns.length > 0 && (
              <Field label="Group by (count) — optional" hint="Selecting columns switches this component to an aggregate view.">
                <div className={s.addBar} style={{ gap: tokens.spacingHorizontalXS }}>
                  {prev.columns.filter((c) => c !== 'count').map((col) => (
                    <Checkbox key={col} label={col} checked={(b.groupBy || []).includes(col)}
                      onChange={() => updateComponent(comp.id, { binding: { ...b, groupBy: (b.groupBy || []).includes(col) ? (b.groupBy || []).filter((g) => g !== col) : [...(b.groupBy || []), col] } })} />
                  ))}
                </div>
              </Field>
            )}
          </>
        ) : (
          <>
            {modelsGate && <MessageBar intent="warning"><MessageBarBody><MessageBarTitle>Azure Analysis Services not configured</MessageBarTitle>{modelsGate}</MessageBarBody></MessageBar>}
            <Field label="Semantic model">
              <Dropdown value={b.model} selectedOptions={b.model ? [b.model] : []} placeholder={modelsBusy ? 'Listing models…' : 'Select a model'}
                onOptionSelect={(_, d) => updateComponent(comp.id, { binding: { ...b, model: d.optionValue || '', measures: [], groupBy: [] } })}>
                {(models || []).map((m) => <Option key={m.name} value={m.name}>{m.storageMode ? `${m.name} · ${m.storageMode}` : m.name}</Option>)}
              </Dropdown>
            </Field>
            {b.model && objs && (
              <>
                <Field label={`Measures (${b.measures.length} selected)`}>
                  <div className={s.addBar} style={{ gap: tokens.spacingHorizontalXS }}>
                    {objs.measures.length === 0 ? <Caption1 className={s.hint}>No measures on this model.</Caption1> : objs.measures.map((m) => (
                      <Checkbox key={m.name} label={m.table ? `${m.name} · ${m.table}` : m.name} checked={b.measures.includes(m.name)}
                        onChange={() => updateComponent(comp.id, { binding: { ...b, measures: b.measures.includes(m.name) ? b.measures.filter((x) => x !== m.name) : [...b.measures, m.name] } })} />
                    ))}
                  </div>
                </Field>
                <Field label={`Group by (${b.groupBy.length} selected)`}>
                  <div className={s.addBar} style={{ gap: tokens.spacingHorizontalXS }}>
                    {objs.columns.length === 0 ? <Caption1 className={s.hint}>No columns on this model.</Caption1> : objs.columns.map((c) => {
                      const key = gbMakeKey(c.table, c.name);
                      return <Checkbox key={key} label={`${c.table}[${c.name}]`} checked={b.groupBy.includes(key)}
                        onChange={() => updateComponent(comp.id, { binding: { ...b, groupBy: b.groupBy.includes(key) ? b.groupBy.filter((x) => x !== key) : [...b.groupBy, key] } })} />;
                    })}
                  </div>
                </Field>
                <Field label="Max rows"><Input type="number" value={String(b.topN)} onChange={(_, d) => updateComponent(comp.id, { binding: { ...b, topN: Math.min(Math.max(Number(d.value) || 100, 1), 1000) } })} /></Field>
              </>
            )}
          </>
        )}

        <div className={s.addBar} style={{ backgroundColor: 'transparent', padding: 0 }}>
          <Button appearance="primary" icon={<Play20Regular />} disabled={prev?.busy} onClick={() => previewComponent(comp)}>{prev?.busy ? 'Running…' : 'Preview data'}</Button>
        </div>
        {prev?.error && <MessageBar intent={prev.gate ? 'warning' : 'error'}><MessageBarBody>{prev.error}</MessageBarBody></MessageBar>}
        {prev?.columns && (
          comp.kind === 'metric' && prev.rows && prev.rows.length > 0 ? (
            <div className={s.metricCard}>
              <span className={s.metricValue}>{fmtCellW(prev.rows[0][prev.rows[0].length - 1])}</span>
              <Caption1 className={s.hint}>{prev.columns[prev.columns.length - 1]}</Caption1>
            </div>
          ) : (
            <div className={s.tableWrap}>
              <Table size="small" aria-label={`${comp.title} preview`}>
                <TableHeader><TableRow>{prev.columns.map((col) => <TableHeaderCell key={col}>{col}</TableHeaderCell>)}</TableRow></TableHeader>
                <TableBody>
                  {(prev.rows || []).length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={prev.columns.length}><Caption1 className={s.hint}>No rows returned for this binding.</Caption1></TableCell>
                    </TableRow>
                  ) : (prev.rows || []).slice(0, 50).map((row, ri) => (
                    <TableRow key={ri}>{(Array.isArray(row) ? row : []).map((cell, ci) => <TableCell key={ci}>{fmtCellW(cell)}</TableCell>)}</TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )
        )}
      </div>
    );
  };

  const runnerAction = appDef.actions.find((a) => a.id === runActionId) || null;

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={
      <div className={s.pad}>
        {loading && <Spinner size="small" label="Loading…" labelPosition="after" />}
        <MessageBar intent="info"><MessageBarBody>
          <MessageBarTitle>Atelier — visual low-code app builder (Palantir Workshop)</MessageBarTitle>
          Bind a Loom Ontology and/or Azure Analysis Services semantic models, design pages with table / metric / text components, preview live data, and define write-back actions. Runs on the Azure-native backend (Synapse + AAS) — no Microsoft Fabric required. {counts.pages} page(s), {counts.components} component(s), {counts.actions} action(s).
        </MessageBarBody></MessageBar>

        <div className={s.section}>
          <SectionHead icon={<Link20Regular />} title="Bound ontology" hint="Pick a saved Ontology; its object types become bindable data for ontology-entity components and write-back actions." />
          {!onto.loaded ? <div className={s.empty}><Spinner size="tiny" /></div> : onto.ontologies.length === 0 ? (
            <MessageBar intent="warning"><MessageBarBody>No ontologies found. Create an Ontology item first, then bind it here. (Semantic-model components work without an ontology.)</MessageBarBody></MessageBar>
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
              <span className={s.spacer} />
              <Button appearance="outline" icon={<Add20Regular />} disabled={classes.length === 0} onClick={() => { setWizardOpen((v) => !v); setWizardPick([]); }}>
                {wizardOpen ? 'Close wizard' : 'New app wizard'}
              </Button>
            </div>
          )}
          {onto.msg && <MessageBar intent={onto.msg.intent}><MessageBarBody>{onto.msg.text}</MessageBarBody></MessageBar>}
        </div>

        {wizardOpen && classes.length > 0 && (
          <div className={s.section}>
            <SectionHead icon={<Flash20Regular />} title="New app wizard" hint="Pick object types — Loom generates one page per type (a live table) plus a create action for each." />
            <div className={s.addBar} style={{ gap: tokens.spacingHorizontalXS }}>
              {classes.map((c) => (
                <Checkbox key={c.name} label={c.name} checked={wizardPick.includes(c.name)}
                  onChange={() => setWizardPick((p) => p.includes(c.name) ? p.filter((x) => x !== c.name) : [...p, c.name])} />
              ))}
            </div>
            <div className={s.addBar} style={{ backgroundColor: 'transparent', padding: 0 }}>
              <Button appearance="primary" icon={<Add20Regular />} disabled={wizardPick.length === 0} onClick={generateFromOntology}>Generate {wizardPick.length || ''} page(s)</Button>
            </div>
          </div>
        )}

        <div className={s.grid2}>
          {/* Pages + component tree */}
          <div className={s.section}>
            <SectionHead icon={<Database20Regular />} title="Pages" hint="Each page is a screen in the app. Select a page to edit its components." />
            <div className={s.addBar} style={{ backgroundColor: 'transparent', padding: 0 }}>
              <Button size="small" appearance="outline" icon={<Add20Regular />} onClick={addPage}>Add page</Button>
            </div>
            {appDef.pages.length === 0 ? <div className={s.empty}><Caption1>No pages yet. Add a page or run the New app wizard.</Caption1></div> : appDef.pages.map((p) => (
              <div key={p.id} className={`${s.row}${p.id === activePageId ? ` ${s.rowActive}` : ''}`}>
                <Button size="small" appearance={p.id === activePageId ? 'primary' : 'subtle'} onClick={() => { setActivePageId(p.id); setEditingId(''); }}>{p.id === activePageId ? 'Editing' : 'Open'}</Button>
                <Input value={p.name} aria-label={`Page ${p.name} name`} onChange={(_, d) => renamePage(p.id, d.value)} />
                <Caption1 className={s.hint}>{p.components.length} cmp</Caption1>
                <span className={s.spacer} />
                <Tooltip content="Remove page" relationship="label">
                  <Button size="small" appearance="subtle" icon={<Dismiss16Regular />} aria-label={`Remove page ${p.name}`} onClick={() => removePage(p.id)} />
                </Tooltip>
              </div>
            ))}

            {activePage && (
              <>
                <div className={s.sectionHead} style={{ marginTop: tokens.spacingVerticalS }}>
                  <Body1><strong>Components on “{activePage.name}”</strong></Body1>
                </div>
                <div className={s.addBar} style={{ backgroundColor: 'transparent', padding: 0 }}>
                  <Button size="small" appearance="outline" icon={<Add20Regular />} onClick={() => addComponent('table')}>Table</Button>
                  <Button size="small" appearance="outline" icon={<Add20Regular />} onClick={() => addComponent('metric')}>Metric</Button>
                  <Button size="small" appearance="outline" icon={<Add20Regular />} onClick={() => addComponent('text')}>Text</Button>
                </div>
                {activePage.components.length === 0 ? <div className={s.empty}><Caption1>No components. Add a table, metric, or text block.</Caption1></div> : activePage.components.map((c) => (
                  <div key={c.id} className={`${s.row}${c.id === editingId ? ` ${s.rowActive}` : ''}`}>
                    <Badge appearance="tint" color="brand">{c.kind}</Badge>
                    <Input value={c.title} aria-label={`Component ${c.title} title`} onChange={(_, d) => updateComponent(c.id, { title: d.value })} />
                    <span className={s.spacer} />
                    <Button size="small" appearance={c.id === editingId ? 'primary' : 'subtle'} onClick={() => setEditingId(c.id === editingId ? '' : c.id)}>{c.id === editingId ? 'Editing' : 'Configure'}</Button>
                    <Tooltip content="Remove component" relationship="label">
                      <Button size="small" appearance="subtle" icon={<Dismiss16Regular />} aria-label={`Remove ${c.title}`} onClick={() => removeComponent(c.id)} />
                    </Tooltip>
                  </div>
                ))}
              </>
            )}
          </div>

          {/* Component inspector + preview */}
          <div className={s.section}>
            <SectionHead icon={<Play20Regular />} title="Component inspector" hint="Configure the selected component's data binding and preview its real data." />
            {!editing ? <div className={s.empty}><Caption1>Select a component to configure its binding and preview live data.</Caption1></div> : bindingEditor(editing)}
          </div>
        </div>

        <div className={s.section}>
          <SectionHead icon={<Flash20Regular />} title="Write-back actions" hint="Define create / update actions over the bound object types, then run them against the live Synapse backend." />
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
          {appDef.actions.length === 0 ? <div className={s.empty}><Caption1>No actions yet.</Caption1></div> : appDef.actions.map((a) => (
            <div key={a.id}>
              <div className={s.row}>
                <Badge appearance="tint" color={a.kind === 'create' ? 'success' : 'brand'}>{a.kind}</Badge>
                <Body1><strong>{a.label}</strong></Body1>
                <Caption1 className={s.hint}>→ {a.entity}</Caption1>
                <span className={s.spacer} />
                <Button size="small" appearance="outline" icon={<Play20Regular />} disabled={runBusy && runActionId === a.id} onClick={() => openRunner(a)}>{runActionId === a.id && runBusy ? 'Loading…' : 'Run'}</Button>
                <Button size="small" appearance="subtle" icon={<Dismiss16Regular />} aria-label={`Remove ${a.label}`} onClick={() => removeAction(a.id)}>Remove</Button>
              </div>
              {runActionId === a.id && runnerAction && (
                <div className={s.section} style={{ marginTop: tokens.spacingVerticalXS }}>
                  {runCols.length === 0 && !runMsg ? <Caption1 className={s.hint}>Loading the target table's columns…</Caption1> : (
                    <>
                      {runCols.map((col) => (
                        <Field key={col} label={col}><Input value={runVals[col] || ''} onChange={(_, d) => setRunVals((p) => ({ ...p, [col]: d.value }))} placeholder="value (leave blank to skip)" /></Field>
                      ))}
                      {a.kind === 'update' && (
                        <div className={s.addBar}>
                          <Field label="Key column" style={{ minWidth: 180 }}>
                            <Dropdown value={runKeyCol} selectedOptions={runKeyCol ? [runKeyCol] : []} placeholder="match on…" onOptionSelect={(_, d) => setRunKeyCol(d.optionValue || '')}>
                              {runCols.map((col) => <Option key={col} value={col}>{col}</Option>)}
                            </Dropdown>
                          </Field>
                          <Field label="Key value"><Input value={runKeyVal} onChange={(_, d) => setRunKeyVal(d.value)} /></Field>
                        </div>
                      )}
                      <div className={s.addBar} style={{ backgroundColor: 'transparent', padding: 0 }}>
                        <Button appearance="primary" icon={<Flash20Regular />} disabled={runBusy} onClick={() => submitRunner(a)}>{runBusy ? 'Running…' : `Run ${a.kind}`}</Button>
                        <Button appearance="subtle" onClick={() => { setRunActionId(''); setRunMsg(null); }}>Close</Button>
                      </div>
                    </>
                  )}
                  {runMsg && <MessageBar intent={runMsg.intent}><MessageBarBody>{runMsg.text}</MessageBarBody></MessageBar>}
                </div>
              )}
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
