'use client';

/**
 * RayfinAppEditor — the Fabric-Apps (Rayfin) surface in CSA Loom. Three modes:
 *
 *  1. Backend definition — entities/services/auth (the general Rayfin case):
 *     Loom emits a real @microsoft/rayfin-core model.ts + the `npx rayfin`
 *     command sequence (the honest generate-artifact pattern; the Rayfin CLI
 *     runs on the dev machine).
 *  2. Model binding (Build 2026 #28) — bind the app to a REAL semantic model.
 *     The Azure-native DEFAULT backend is Azure Analysis Services (per
 *     no-fabric-dependency.md — no Fabric/Power BI workspace required): pick a
 *     bindable model, introspect measures + fields, select + live-preview the
 *     read view, and emit a typed model-bound connector.
 *  3. App builder (audit-T145) — a Loom-native LOW-CODE VISUAL BUILDER: pages →
 *     components (table / metric / chart / form / text) → data bindings to the
 *     bound model. A create WIZARD scaffolds a starter app; "Run app preview"
 *     executes every component's read view live over XMLA (real runtime via
 *     /api/items/rayfin-app/<id>/render); Loom emits a typed rayfin/app.config.ts.
 *
 * Decision (audit-T145): the visual builder lives **standalone in this
 * Rayfin/Fabric-Apps surface**, not under Weave/Atelier — the Azure-native build
 * has no separate Atelier item type, and the real Fabric-Apps app-building flow
 * is itself code-first + Copilot codegen, so a Loom-hosted visual builder with a
 * real Azure runtime is the honest home. See docs/fiab/parity/rayfin-app.md.
 *
 * Everything renders with an honest Fluent MessageBar when AAS is unset — never
 * an empty picker (no-vaporware.md).
 *
 * Refs (preview): https://learn.microsoft.com/fabric/apps/overview ·
 *   https://github.com/microsoft/rayfin · npm @microsoft/rayfin-cli
 */

import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import {
  makeStyles, tokens, Button, Input, Field, Switch, Subtitle2, Body1, Caption1,
  Badge, MessageBar, MessageBarBody, MessageBarTitle, Dropdown, Option, Divider,
  Spinner, Tooltip, useId, useToastController, Toast, ToastTitle, Toaster,
  Checkbox, SpinButton, Table, TableHeader, TableHeaderCell, TableRow, TableBody, TableCell,
  TabList, Tab, Textarea,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions, DialogTrigger,
} from '@fluentui/react-components';
import {
  Add20Regular, Delete20Regular, Copy20Regular, Checkmark20Regular, Save20Regular,
  Rocket20Regular, Open20Regular, Database20Regular, Play20Regular, ArrowSync20Regular,
  Apps20Regular, Table20Regular, Gauge20Regular, DataBarVertical20Regular,
  Form20Regular, TextT20Regular, Wand20Regular, DocumentAdd20Regular,
} from '@fluentui/react-icons';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';
import {
  DEFAULT_SPEC, DEFAULT_BINDING, COMPONENT_KINDS,
  gbParse, gbKey, buildBindingDax, buildComponentDax,
  generateModel, generateConnector, generateCommands, generateAppConfig,
  emptyPage, emptyComponent, scaffoldAppDefinition, validateAppDefinition, isDataComponent,
  type FieldType, type RayfinEntity, type ModelBinding, type RayfinSpec,
  type RayfinAppDefinition, type RayfinPage, type RayfinComponent, type ComponentKind,
} from './rayfin-app-model';

// --- model-binding API shapes (from /model-objects, /preview) ---
interface BindableModel { name: string; storageMode?: string; state?: string; compatibilityLevel?: number }
interface ModelMeasure { name: string; table?: string; description?: string }
interface ModelColumn { table: string; name: string; dataType?: string }
interface ModelObjects { measures: ModelMeasure[]; columns: ModelColumn[] }
interface PreviewResult { dax: string; columns: string[]; rows: unknown[][]; rowCount: number; executionMs: number; truncated: boolean }
interface GateInfo { missing: string; detail: string }

// --- runtime render shapes (from /<id>/render) ---
interface RenderedComponent {
  id: string; kind: string; title: string; ok: boolean; dax?: string;
  columns?: string[]; rows?: unknown[][]; rowCount?: number; executionMs?: number;
  truncated?: boolean; entity?: string; text?: string; error?: string;
}
interface RenderedPage { id: string; name: string; components: RenderedComponent[] }
interface RenderResult { ok: boolean; model: string; pages: RenderedPage[] }

const KIND_ICON: Record<ComponentKind, ReactElement> = {
  table: <Table20Regular />, metric: <Gauge20Regular />, chart: <DataBarVertical20Regular />,
  form: <Form20Regular />, text: <TextT20Regular />,
};
const KIND_LABEL: Record<ComponentKind, string> = {
  table: 'Table', metric: 'Metric', chart: 'Chart', form: 'Form', text: 'Text',
};

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '12px', padding: '12px', minWidth: 0, maxWidth: '100%' },
  row: { display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'flex-end' },
  cols: { display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: '16px', minWidth: 0 },
  builderCols: { display: 'grid', gridTemplateColumns: '260px minmax(0,1fr)', gap: '16px', minWidth: 0 },
  card: {
    padding: '16px', border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge, backgroundColor: tokens.colorNeutralBackground1,
    display: 'flex', flexDirection: 'column', gap: '10px', minWidth: 0,
  },
  entity: {
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium,
    padding: '10px', display: 'flex', flexDirection: 'column', gap: '6px',
    backgroundColor: tokens.colorNeutralBackground2,
  },
  fieldRow: { display: 'flex', gap: '8px', alignItems: 'center', minWidth: 0 },
  fieldRowNested: { paddingLeft: '16px' },
  fieldName: { flex: 1, minWidth: 0 },
  code: {
    fontFamily: tokens.fontFamilyMonospace, fontSize: '12px', whiteSpace: 'pre', overflowX: 'auto',
    backgroundColor: tokens.colorNeutralBackground3, border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium, padding: '12px', margin: 0,
  },
  head: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
  spacer: { marginLeft: 'auto' },
  headActions: { marginLeft: 'auto', display: 'flex', gap: '8px' },
  pickList: {
    maxHeight: '160px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '2px',
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium, padding: '8px',
    backgroundColor: tokens.colorNeutralBackground1,
    '& .fui-Checkbox': { borderRadius: tokens.borderRadiusSmall, paddingInline: '4px' },
    '& .fui-Checkbox:hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
  },
  previewWrap: {
    maxHeight: '260px', overflow: 'auto', border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    '& thead th': { position: 'sticky', top: 0, zIndex: 1, backgroundColor: tokens.colorNeutralBackground2 },
  },
  metaRow: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', color: tokens.colorNeutralForeground3 },
  // builder
  palette: { display: 'flex', flexDirection: 'column', gap: '6px' },
  pageRow: {
    display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 8px',
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium, cursor: 'pointer',
  },
  pageRowActive: {
    display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 8px',
    border: `2px solid ${tokens.colorBrandStroke1}`, borderRadius: tokens.borderRadiusMedium,
    background: tokens.colorBrandBackground2, cursor: 'pointer',
  },
  canvas: { display: 'flex', flexDirection: 'column', gap: '12px', minWidth: 0 },
  compCard: {
    padding: '12px', border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium, backgroundColor: tokens.colorNeutralBackground2,
    display: 'flex', flexDirection: 'column', gap: '8px', minWidth: 0,
  },
  metricValue: { fontSize: '28px', fontWeight: 700, color: tokens.colorBrandForeground1, lineHeight: '32px' },
  barRow: { display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 },
  barLabel: { width: '140px', flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  barTrack: { flex: 1, height: '14px', background: tokens.colorNeutralBackground3, borderRadius: '7px', overflow: 'hidden' },
  barFill: { height: '100%', background: tokens.colorBrandBackground, borderRadius: '7px', transition: 'width 240ms ease' },
  barValue: { width: '70px', textAlign: 'right', flexShrink: 0, fontVariantNumeric: 'tabular-nums' },
  // shared layout helpers
  vstack: { display: 'flex', flexDirection: 'column', gap: '6px', minWidth: 0 },
  wizForm: { display: 'flex', flexDirection: 'column', gap: '12px', minWidth: 0 },
  pageName: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  compTitle: { flex: 1, minWidth: 0 },
});

function CopyBtn({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button size="small" appearance="outline" icon={done ? <Checkmark20Regular /> : <Copy20Regular />}
      onClick={async () => { try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1600); } catch { /* manual */ } }}>
      {done ? 'Copied' : 'Copy'}
    </Button>
  );
}

function fmtCell(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(2);
  return String(v);
}

export function RayfinAppEditor({ id }: { item?: unknown; id: string }) {
  const s = useStyles();
  const toasterId = useId('rayfin-toaster');
  const { dispatchToast } = useToastController(toasterId);
  const [spec, setSpec] = useState<RayfinSpec>(DEFAULT_SPEC);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<'backend' | 'binding' | 'app'>('backend');

  // model-binding live state
  const [models, setModels] = useState<BindableModel[] | null>(null);
  const [modelsGate, setModelsGate] = useState<GateInfo | null>(null);
  const [modelsErr, setModelsErr] = useState<string | null>(null);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [objects, setObjects] = useState<ModelObjects | null>(null);
  const [objErr, setObjErr] = useState<string | null>(null);
  const [objLoading, setObjLoading] = useState(false);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);

  // app-builder state
  const [activePageId, setActivePageId] = useState<string | null>(null);
  const [appRender, setAppRender] = useState<RenderResult | null>(null);
  const [rendering, setRendering] = useState(false);
  const [renderErr, setRenderErr] = useState<string | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizMeasure, setWizMeasure] = useState('');
  const [wizGroupBy, setWizGroupBy] = useState('');

  const binding = spec.binding ?? DEFAULT_BINDING;
  const appPages: RayfinPage[] = spec.app?.pages ?? [];
  const appDef: RayfinAppDefinition = useMemo(() => ({ model: binding.model, pages: appPages }), [binding.model, appPages]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch(`/api/items/rayfin-app/${encodeURIComponent(id)}`);
        const j = await r.json().catch(() => ({}));
        const saved = (j?.state?.spec || j?.item?.state?.spec || j?.definition?.state?.spec) as RayfinSpec | undefined;
        if (alive && saved && Array.isArray(saved.entities)) {
          setSpec({
            ...DEFAULT_SPEC, ...saved,
            binding: { ...DEFAULT_BINDING, ...(saved.binding || {}) },
            app: saved.app && Array.isArray(saved.app.pages) ? saved.app : undefined,
          });
        }
      } catch { /* keep default */ }
      finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; };
  }, [id]);

  const loadModels = useCallback(async () => {
    setModelsLoading(true); setModelsErr(null); setModelsGate(null);
    try {
      const r = await fetch('/api/items/rayfin-app/models');
      const j = await r.json().catch(() => ({}));
      if (j?.ok) { setModels(j.models || []); }
      else if (j?.gate) { setModelsGate(j.gate); setModels([]); }
      else { setModelsErr(j?.error || `HTTP ${r.status}`); setModels([]); }
    } catch (e: any) { setModelsErr(e?.message || String(e)); setModels([]); }
    finally { setModelsLoading(false); }
  }, []);

  useEffect(() => {
    if ((tab === 'binding' || tab === 'app') && models === null && !modelsLoading) void loadModels();
  }, [tab, models, modelsLoading, loadModels]);

  const loadObjects = useCallback(async (m: string) => {
    if (!m) { setObjects(null); return; }
    setObjLoading(true); setObjErr(null);
    try {
      const r = await fetch(`/api/items/rayfin-app/model-objects?model=${encodeURIComponent(m)}`);
      const j = await r.json().catch(() => ({}));
      if (j?.ok) setObjects({ measures: j.measures || [], columns: j.columns || [] });
      else { setObjErr(j?.error || `HTTP ${r.status}`); setObjects(null); }
    } catch (e: any) { setObjErr(e?.message || String(e)); setObjects(null); }
    finally { setObjLoading(false); }
  }, []);

  useEffect(() => {
    if ((tab === 'binding' || tab === 'app') && binding.model) void loadObjects(binding.model);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, binding.model]);

  // Keep an active page selected.
  useEffect(() => {
    if (appPages.length === 0) { setActivePageId(null); return; }
    if (!activePageId || !appPages.some((p) => p.id === activePageId)) setActivePageId(appPages[0].id);
  }, [appPages, activePageId]);

  const modelTs = useMemo(() => generateModel(spec), [spec]);
  const connector = useMemo(() => generateConnector(spec), [spec]);
  const commands = useMemo(() => generateCommands(spec), [spec]);
  const bindingDax = useMemo(() => buildBindingDax(binding), [binding]);
  const appConfigTs = useMemo(() => generateAppConfig(appDef), [appDef]);
  const appIssues = useMemo(() => validateAppDefinition(appDef), [appDef]);

  const save = useCallback(async () => {
    setSaving(true);
    try {
      const r = await fetch(`/api/items/rayfin-app/${encodeURIComponent(id)}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ state: { spec } }),
      });
      dispatchToast(<Toast><ToastTitle>{r.ok ? 'Saved' : 'Save failed'}</ToastTitle></Toast>, { intent: r.ok ? 'success' : 'error' });
    } catch (e: any) {
      dispatchToast(<Toast><ToastTitle>Save failed: {e?.message || String(e)}</ToastTitle></Toast>, { intent: 'error' });
    } finally { setSaving(false); }
  }, [id, spec, dispatchToast]);

  const runPreview = useCallback(async () => {
    if (!binding.model) return;
    setPreviewing(true); setPreviewErr(null); setPreview(null);
    try {
      const groupBy = binding.groupBy.map((k) => gbParse(k));
      const r = await fetch('/api/items/rayfin-app/preview', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: binding.model, measures: binding.measures, groupBy, topN: binding.topN }),
      });
      const j = await r.json().catch(() => ({}));
      if (j?.ok) setPreview(j as PreviewResult);
      else setPreviewErr(j?.error || `HTTP ${r.status}`);
    } catch (e: any) { setPreviewErr(e?.message || String(e)); }
    finally { setPreviewing(false); }
  }, [binding]);

  const runAppPreview = useCallback(async () => {
    setRendering(true); setRenderErr(null); setAppRender(null);
    try {
      const r = await fetch(`/api/items/rayfin-app/${encodeURIComponent(id)}/render`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ app: appDef }),
      });
      const j = await r.json().catch(() => ({}));
      if (j?.ok) setAppRender(j as RenderResult);
      else setRenderErr(j?.error || `HTTP ${r.status}`);
    } catch (e: any) { setRenderErr(e?.message || String(e)); }
    finally { setRendering(false); }
  }, [id, appDef]);

  const patch = (p: Partial<RayfinSpec>) => setSpec((prev) => ({ ...prev, ...p }));
  const patchBinding = (p: Partial<ModelBinding>) =>
    setSpec((prev) => ({ ...prev, binding: { ...DEFAULT_BINDING, ...(prev.binding || {}), ...p } }));
  const patchEntity = (i: number, e: Partial<RayfinEntity>) =>
    setSpec((prev) => ({ ...prev, entities: prev.entities.map((x, idx) => idx === i ? { ...x, ...e } : x) }));

  // App-definition mutations
  const setPages = useCallback((pages: RayfinPage[]) =>
    setSpec((prev) => ({ ...prev, app: { model: prev.binding?.model || '', pages } })), []);
  const patchPage = (pageId: string, fn: (p: RayfinPage) => RayfinPage) =>
    setPages(appPages.map((p) => (p.id === pageId ? fn(p) : p)));
  const patchComponent = (pageId: string, compId: string, p: Partial<RayfinComponent>) =>
    patchPage(pageId, (pg) => ({ ...pg, components: pg.components.map((c) => (c.id === compId ? { ...c, ...p } : c)) }));

  const addPage = () => { const np = emptyPage(`Page ${appPages.length + 1}`); setPages([...appPages, np]); setActivePageId(np.id); };
  const deletePage = (pageId: string) => setPages(appPages.filter((p) => p.id !== pageId));
  const addComponent = (kind: ComponentKind) => {
    if (!activePageId) return;
    const c = emptyComponent(kind, spec.entities[0]?.name || '');
    patchPage(activePageId, (pg) => ({ ...pg, components: [...pg.components, c] }));
  };
  const deleteComponent = (pageId: string, compId: string) =>
    patchPage(pageId, (pg) => ({ ...pg, components: pg.components.filter((c) => c.id !== compId) }));

  const toggleMeasure = (name: string) =>
    patchBinding({ measures: binding.measures.includes(name) ? binding.measures.filter((m) => m !== name) : [...binding.measures, name] });
  const toggleGroupBy = (key: string) =>
    patchBinding({ groupBy: binding.groupBy.includes(key) ? binding.groupBy.filter((g) => g !== key) : [...binding.groupBy, key] });

  const scaffold = useCallback((measure: string, groupByKey: string) => {
    const def = scaffoldAppDefinition(binding.model, measure || undefined, groupByKey || undefined);
    setSpec((prev) => ({ ...prev, app: def }));
    setActivePageId(def.pages[0]?.id || null);
    setWizardOpen(false);
  }, [binding.model]);

  if (loading) return <div className={s.root}><Spinner label="Loading Rayfin app…" /></div>;

  const activePage = appPages.find((p) => p.id === activePageId) || null;

  return (
    <div className={s.root}>
      <Toaster toasterId={toasterId} />
      <div className={s.head}>
        <Rocket20Regular />
        <Subtitle2>Rayfin app</Subtitle2>
        <Badge appearance="outline" color="warning">Preview</Badge>
        {binding.model ? <Badge appearance="tint" color="brand" icon={<Database20Regular />}>Bound: {binding.model}</Badge> : null}
        {appPages.length ? <Badge appearance="tint" color="success" icon={<Apps20Regular />}>{appPages.length} page{appPages.length === 1 ? '' : 's'}</Badge> : null}
        <div className={s.headActions}>
          <Button appearance="outline" icon={<Open20Regular />} as="a" href="https://learn.microsoft.com/fabric/apps/overview" target="_blank" rel="noreferrer">Docs</Button>
          <Button appearance="outline" icon={<Open20Regular />} as="a" href="https://github.com/microsoft/rayfin" target="_blank" rel="noreferrer">Repo</Button>
          <Button appearance="primary" icon={<Save20Regular />} onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
        </div>
      </div>

      <MessageBar intent="warning">
        <MessageBarBody>
          <MessageBarTitle>Rayfin is a preview SDK + CLI that runs on your dev machine.</MessageBarTitle>
          Define the backend and bind it to a real semantic model below, then assemble a visual app in the App builder.
          Loom generates the real <code>@microsoft/rayfin-core</code> model, a model-bound connector, a typed
          <code> app.config.ts</code>, and the exact CLI commands. Run them locally (<code>npx rayfin up</code>) to deploy.
        </MessageBarBody>
      </MessageBar>

      <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as 'backend' | 'binding' | 'app')}>
        <Tab value="backend">Backend definition</Tab>
        <Tab value="binding" icon={<Database20Regular />}>Model binding</Tab>
        <Tab value="app" icon={<Apps20Regular />}>App builder</Tab>
      </TabList>

      {tab === 'backend' ? (
        <div className={s.cols}>
          {/* Left — spec */}
          <div className={s.card}>
            <Subtitle2>Backend definition</Subtitle2>
            <div className={s.row}>
              <Field label="App name"><Input value={spec.appName} onChange={(_, d) => patch({ appName: d.value.replace(/\s+/g, '-').toLowerCase() })} /></Field>
              <Field label="Fabric workspace (optional)"><Input value={spec.workspaceName} placeholder="workspace name" onChange={(_, d) => patch({ workspaceName: d.value })} /></Field>
            </div>
            <div className={s.row}>
              <Field label="Database"><Switch checked={spec.services.database} onChange={(_, d) => patch({ services: { ...spec.services, database: !!d.checked } })} /></Field>
              <Field label="Storage"><Switch checked={spec.services.storage} onChange={(_, d) => patch({ services: { ...spec.services, storage: !!d.checked } })} /></Field>
              <Field label="Static hosting"><Switch checked={spec.staticHosting} onChange={(_, d) => patch({ staticHosting: !!d.checked })} /></Field>
              <Field label="Auth"><Input readOnly value="Fabric (Entra SSO)" /></Field>
            </div>

            <Divider />
            <div className={s.head}>
              <Body1><strong>Entities</strong></Body1>
              <Button size="small" appearance="outline" icon={<Add20Regular />}
                onClick={() => patch({ entities: [...spec.entities, { name: `Entity${spec.entities.length + 1}`, fields: [{ name: 'name', type: 'text' }] }] })}>Add entity</Button>
            </div>
            {spec.entities.map((e, i) => (
              <div key={i} className={s.entity}>
                <div className={s.fieldRow}>
                  <Input className={s.fieldName} value={e.name} aria-label={`Entity ${i + 1} name`} onChange={(_, d) => patchEntity(i, { name: d.value })} />
                  <Button size="small" appearance="outline" icon={<Add20Regular />}
                    onClick={() => patchEntity(i, { fields: [...e.fields, { name: 'field', type: 'text' }] })}>Field</Button>
                  <Tooltip content="Remove entity" relationship="label">
                    <Button size="small" appearance="subtle" aria-label={`Remove entity ${e.name || i + 1}`} icon={<Delete20Regular />}
                      onClick={() => patch({ entities: spec.entities.filter((_, idx) => idx !== i) })} />
                  </Tooltip>
                </div>
                {e.fields.map((f, fi) => (
                  <div key={fi} className={`${s.fieldRow} ${s.fieldRowNested}`}>
                    <Input className={s.fieldName} size="small" value={f.name} aria-label="Field name" onChange={(_, d) => patchEntity(i, { fields: e.fields.map((x, xi) => xi === fi ? { ...x, name: d.value } : x) })} />
                    <Dropdown size="small" value={f.type} aria-label="Field type" selectedOptions={[f.type]}
                      onOptionSelect={(_, d) => patchEntity(i, { fields: e.fields.map((x, xi) => xi === fi ? { ...x, type: (d.optionValue as FieldType) } : x) })}>
                      {(['text', 'boolean', 'date', 'number'] as FieldType[]).map((t) => <Option key={t} value={t}>{t}</Option>)}
                    </Dropdown>
                    <Tooltip content="Remove field" relationship="label">
                      <Button size="small" appearance="subtle" aria-label={`Remove field ${f.name || fi + 1}`} icon={<Delete20Regular />}
                        onClick={() => patchEntity(i, { fields: e.fields.filter((_, xi) => xi !== fi) })} />
                    </Tooltip>
                  </div>
                ))}
              </div>
            ))}
          </div>

          {/* Right — generated artifacts */}
          <div className={s.card}>
            <div className={s.head}><Subtitle2>rayfin/model.ts</Subtitle2><div className={s.spacer}><CopyBtn text={modelTs} /></div></div>
            <MonacoTextarea value={modelTs} onChange={() => { /* read-only */ }} language="typescript" height={200} readOnly lineNumbers={false} ariaLabel="Generated Rayfin model" />
            <Caption1>Decorator API per @microsoft/rayfin-core — verify against the current SDK version (preview).</Caption1>

            <Divider />
            <div className={s.head}><Subtitle2>Deploy commands</Subtitle2><div className={s.spacer}><CopyBtn text={commands} /></div></div>
            <pre className={s.code}>{commands}</pre>
          </div>
        </div>
      ) : tab === 'binding' ? (
        <div className={s.cols}>
          {/* Left — bind + select */}
          <div className={s.card}>
            <div className={s.head}>
              <Database20Regular />
              <Subtitle2>Bind a semantic model</Subtitle2>
              <Tooltip content="Reload models" relationship="label">
                <Button size="small" appearance="subtle" icon={<ArrowSync20Regular />} onClick={() => { setModels(null); }} disabled={modelsLoading} />
              </Tooltip>
            </div>
            <Caption1>
              Build 2026 #28 — back your app with a real semantic model. The Azure-native default is Azure Analysis
              Services; no Fabric or Power BI workspace is required.
            </Caption1>

            {modelsLoading ? <Spinner size="tiny" label="Listing models…" /> : null}

            {modelsGate ? (
              <MessageBar intent="warning">
                <MessageBarBody>
                  <MessageBarTitle>Azure Analysis Services not configured</MessageBarTitle>
                  Set <code>{modelsGate.missing}</code> — {modelsGate.detail}. Once an AAS server is bound, its tabular
                  models appear here. The deploy planner ships an AAS module under
                  <code> platform/fiab/bicep/modules</code>.
                </MessageBarBody>
              </MessageBar>
            ) : null}
            {modelsErr ? (
              <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Could not list models</MessageBarTitle>{modelsErr}</MessageBarBody></MessageBar>
            ) : null}

            {models && models.length > 0 ? (
              <Field label="Semantic model">
                <Dropdown
                  placeholder="Select a model to bind"
                  value={binding.model}
                  selectedOptions={binding.model ? [binding.model] : []}
                  onOptionSelect={(_, d) => { patchBinding({ model: d.optionValue || '', measures: [], groupBy: [] }); setPreview(null); }}
                >
                  {models.map((m) => (
                    <Option key={m.name} value={m.name} text={m.name}>
                      {m.name}{m.storageMode ? ` · ${m.storageMode}` : ''}
                    </Option>
                  ))}
                </Dropdown>
              </Field>
            ) : (models && models.length === 0 && !modelsGate && !modelsErr ? (
              <MessageBar intent="info"><MessageBarBody>No tabular models found on the AAS server. Deploy a semantic model first.</MessageBarBody></MessageBar>
            ) : null)}

            {binding.model ? (
              <>
                <Divider />
                {objLoading ? <Spinner size="tiny" label="Introspecting model…" /> : null}
                {objErr ? <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Introspection failed</MessageBarTitle>{objErr}</MessageBarBody></MessageBar> : null}

                {objects ? (
                  <>
                    <Body1><strong>Measures</strong> <Caption1>({binding.measures.length} selected)</Caption1></Body1>
                    {objects.measures.length === 0 ? <Caption1>No measures on this model.</Caption1> : (
                      <div className={s.pickList}>
                        {objects.measures.map((m) => (
                          <Checkbox key={m.name} label={m.table ? `${m.name}  ·  ${m.table}` : m.name}
                            checked={binding.measures.includes(m.name)} onChange={() => toggleMeasure(m.name)} />
                        ))}
                      </div>
                    )}

                    <Body1><strong>Group by</strong> <Caption1>({binding.groupBy.length} selected)</Caption1></Body1>
                    {objects.columns.length === 0 ? <Caption1>No columns on this model.</Caption1> : (
                      <div className={s.pickList}>
                        {objects.columns.map((c) => {
                          const key = gbKey(c.table, c.name);
                          return (
                            <Checkbox key={key} label={`${c.table}[${c.name}]${c.dataType ? `  ·  ${c.dataType}` : ''}`}
                              checked={binding.groupBy.includes(key)} onChange={() => toggleGroupBy(key)} />
                          );
                        })}
                      </div>
                    )}

                    <Field label="Max rows (preview & read view)">
                      <SpinButton min={1} max={1000} value={binding.topN}
                        onChange={(_, d) => patchBinding({ topN: d.value ?? (Number(d.displayValue) || 100) })} />
                    </Field>
                  </>
                ) : null}
              </>
            ) : null}
          </div>

          {/* Right — live preview + connector */}
          <div className={s.card}>
            <div className={s.head}>
              <Subtitle2>Read view preview</Subtitle2>
              <div className={s.headActions}>
                <Button size="small" appearance="primary" icon={<Play20Regular />}
                  onClick={runPreview} disabled={previewing || !binding.model || (binding.measures.length === 0 && binding.groupBy.length === 0)}>
                  {previewing ? 'Running…' : 'Run preview'}
                </Button>
              </div>
            </div>
            <Caption1>Runs the generated DAX against the bound model — the exact data your deployed app would render.</Caption1>

            {!binding.model ? (
              <MessageBar intent="info"><MessageBarBody>Bind a model and pick measures / group-by fields, then run the preview.</MessageBarBody></MessageBar>
            ) : null}
            {previewErr ? <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Preview failed</MessageBarTitle>{previewErr}</MessageBarBody></MessageBar> : null}

            {preview ? (
              <>
                <div className={s.metaRow}>
                  <Badge appearance="tint" color="informative">{preview.rowCount} row{preview.rowCount === 1 ? '' : 's'}</Badge>
                  <Badge appearance="tint" color="brand">{preview.executionMs} ms</Badge>
                  {preview.truncated ? <Badge appearance="tint" color="warning">truncated</Badge> : null}
                </div>
                <div className={s.previewWrap}>
                  <Table size="small" aria-label="Read view preview">
                    <TableHeader>
                      <TableRow>{preview.columns.map((c) => <TableHeaderCell key={c}>{c}</TableHeaderCell>)}</TableRow>
                    </TableHeader>
                    <TableBody>
                      {preview.rows.length === 0 ? (
                        <TableRow>
                          <TableCell><Caption1>The bound model returned no rows for this selection.</Caption1></TableCell>
                        </TableRow>
                      ) : preview.rows.slice(0, 200).map((r, ri) => (
                        <TableRow key={ri}>{r.map((v, ci) => <TableCell key={ci}>{fmtCell(v)}</TableCell>)}</TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </>
            ) : null}

            <Divider />
            <div className={s.head}><Subtitle2>Read-view DAX</Subtitle2><div className={s.spacer}><CopyBtn text={bindingDax} /></div></div>
            <pre className={s.code}>{bindingDax}</pre>

            <Divider />
            <div className={s.head}><Subtitle2>rayfin/data/model-view.ts</Subtitle2><div className={s.spacer}><CopyBtn text={connector} /></div></div>
            <MonacoTextarea value={connector} onChange={() => { /* read-only */ }} language="typescript" height={220} readOnly lineNumbers={false} ariaLabel="Generated model-bound connector" />
          </div>
        </div>
      ) : (
        // ---- App builder tab ----
        <AppBuilder
          s={s}
          binding={binding}
          objects={objects}
          objLoading={objLoading}
          modelsGate={modelsGate}
          appPages={appPages}
          activePage={activePage}
          activePageId={activePageId}
          setActivePageId={setActivePageId}
          addPage={addPage}
          deletePage={deletePage}
          patchPage={patchPage}
          addComponent={addComponent}
          deleteComponent={deleteComponent}
          patchComponent={patchComponent}
          entities={spec.entities}
          appConfigTs={appConfigTs}
          appIssues={appIssues}
          appRender={appRender}
          rendering={rendering}
          renderErr={renderErr}
          runAppPreview={runAppPreview}
          openWizard={() => { setWizMeasure(''); setWizGroupBy(''); setWizardOpen(true); }}
        />
      )}

      {/* Create-app wizard */}
      <Dialog open={wizardOpen} onOpenChange={(_, d) => setWizardOpen(d.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Scaffold an app from your model</DialogTitle>
            <DialogContent>
              <div className={s.wizForm}>
                {!binding.model ? (
                  <MessageBar intent="warning"><MessageBarBody>
                    <MessageBarTitle>No model bound</MessageBarTitle>
                    Bind a semantic model in the Model binding tab first — the wizard scaffolds pages from its measures and columns.
                  </MessageBarBody></MessageBar>
                ) : !objects ? (
                  <Spinner size="tiny" label="Introspecting model…" />
                ) : (
                  <>
                    <Body1>Pick a measure and a category to scaffold an Overview page with a metric, a details table, and a chart.</Body1>
                    <Field label="Metric (measure)">
                      <Dropdown placeholder="Select a measure" value={wizMeasure} selectedOptions={wizMeasure ? [wizMeasure] : []}
                        onOptionSelect={(_, d) => setWizMeasure(d.optionValue || '')}>
                        {objects.measures.map((m) => <Option key={m.name} value={m.name}>{m.name}</Option>)}
                      </Dropdown>
                    </Field>
                    <Field label="Category (group by)">
                      <Dropdown placeholder="Select a column" value={wizGroupBy ? gbParse(wizGroupBy).column : ''} selectedOptions={wizGroupBy ? [wizGroupBy] : []}
                        onOptionSelect={(_, d) => setWizGroupBy(d.optionValue || '')}>
                        {objects.columns.map((c) => { const k = gbKey(c.table, c.name); return <Option key={k} value={k}>{`${c.table}[${c.name}]`}</Option>; })}
                      </Dropdown>
                    </Field>
                  </>
                )}
              </div>
            </DialogContent>
            <DialogActions>
              <DialogTrigger disableButtonEnhancement><Button appearance="secondary">Cancel</Button></DialogTrigger>
              <Button appearance="primary" icon={<Wand20Regular />} disabled={!binding.model || !objects}
                onClick={() => scaffold(wizMeasure, wizGroupBy)}>Scaffold app</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// App builder sub-surface
// ---------------------------------------------------------------------------

interface AppBuilderProps {
  s: ReturnType<typeof useStyles>;
  binding: ModelBinding;
  objects: ModelObjects | null;
  objLoading: boolean;
  modelsGate: GateInfo | null;
  appPages: RayfinPage[];
  activePage: RayfinPage | null;
  activePageId: string | null;
  setActivePageId: (id: string) => void;
  addPage: () => void;
  deletePage: (id: string) => void;
  patchPage: (id: string, fn: (p: RayfinPage) => RayfinPage) => void;
  addComponent: (kind: ComponentKind) => void;
  deleteComponent: (pageId: string, compId: string) => void;
  patchComponent: (pageId: string, compId: string, p: Partial<RayfinComponent>) => void;
  entities: RayfinEntity[];
  appConfigTs: string;
  appIssues: { level: 'error' | 'warn'; message: string }[];
  appRender: RenderResult | null;
  rendering: boolean;
  renderErr: string | null;
  runAppPreview: () => void;
  openWizard: () => void;
}

function AppBuilder(props: AppBuilderProps) {
  const {
    s, binding, objects, objLoading, modelsGate, appPages, activePage, activePageId, setActivePageId,
    addPage, deletePage, patchPage, addComponent, deleteComponent, patchComponent,
    entities, appConfigTs, appIssues, appRender, rendering, renderErr, runAppPreview, openWizard,
  } = props;

  const renderedById = useMemo(() => {
    const m = new Map<string, RenderedComponent>();
    appRender?.pages.forEach((p) => p.components.forEach((c) => m.set(c.id, c)));
    return m;
  }, [appRender]);

  if (!binding.model) {
    return (
      <div className={s.card}>
        <div className={s.head}><Apps20Regular /><Subtitle2>App builder</Subtitle2></div>
        <MessageBar intent={modelsGate ? 'warning' : 'info'}>
          <MessageBarBody>
            <MessageBarTitle>Bind a semantic model first</MessageBarTitle>
            The visual builder binds components to a real model. Go to the <strong>Model binding</strong> tab, pick a
            model{modelsGate ? ` (set ${modelsGate.missing} to enable Azure Analysis Services)` : ''}, then return here to
            assemble pages. You can also use the scaffold wizard once a model is bound.
          </MessageBarBody>
        </MessageBar>
      </div>
    );
  }

  return (
    <div className={s.builderCols}>
      {/* Left rail — pages + palette */}
      <div className={s.card}>
        <div className={s.head}>
          <Subtitle2>Pages</Subtitle2>
          <div className={s.spacer}>
            <Tooltip content="Add page" relationship="label">
              <Button size="small" appearance="outline" icon={<DocumentAdd20Regular />} onClick={addPage} aria-label="Add page" />
            </Tooltip>
          </div>
        </div>
        <div className={s.palette}>
          {appPages.length === 0 ? <Caption1>No pages yet. Add a page or use the wizard.</Caption1> : null}
          {appPages.map((p) => (
            <div key={p.id} className={p.id === activePageId ? s.pageRowActive : s.pageRow}
              role="button" tabIndex={0} aria-pressed={p.id === activePageId} aria-label={`Page ${p.name}`}
              onClick={() => setActivePageId(p.id)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setActivePageId(p.id); } }}>
              <Apps20Regular />
              <span className={s.pageName}>{p.name}</span>
              <Badge size="small" appearance="tint">{p.components.length}</Badge>
              <Tooltip content="Delete page" relationship="label">
                <Button size="small" appearance="subtle" icon={<Delete20Regular />} aria-label={`Delete page ${p.name}`}
                  onClick={(e) => { e.stopPropagation(); deletePage(p.id); }} />
              </Tooltip>
            </div>
          ))}
        </div>

        <Divider />
        <Subtitle2>Add component</Subtitle2>
        <Caption1>Adds to the selected page.</Caption1>
        <div className={s.palette}>
          {COMPONENT_KINDS.map((k) => (
            <Button key={k} size="small" appearance="outline" icon={KIND_ICON[k]} disabled={!activePageId}
              onClick={() => addComponent(k)}>{KIND_LABEL[k]}</Button>
          ))}
        </div>

        <Divider />
        <Button appearance="outline" icon={<Wand20Regular />} onClick={openWizard}>Scaffold from model…</Button>
      </div>

      {/* Canvas + runtime + codegen */}
      <div className={s.canvas}>
        <div className={s.card}>
          <div className={s.head}>
            <Subtitle2>{activePage ? activePage.name : 'Canvas'}</Subtitle2>
            <div className={s.headActions}>
              <Button size="small" appearance="primary" icon={<Play20Regular />} onClick={runAppPreview}
                disabled={rendering || appPages.length === 0}>{rendering ? 'Rendering…' : 'Run app preview'}</Button>
            </div>
          </div>
          {objLoading ? <Spinner size="tiny" label="Loading model objects…" /> : null}
          {appIssues.length ? (
            <MessageBar intent={appIssues.some((i) => i.level === 'error') ? 'error' : 'info'}>
              <MessageBarBody>{appIssues.map((i, idx) => <div key={idx}>{i.message}</div>)}</MessageBarBody>
            </MessageBar>
          ) : null}
          {renderErr ? <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Render failed</MessageBarTitle>{renderErr}</MessageBarBody></MessageBar> : null}

          {!activePage ? (
            <MessageBar intent="info"><MessageBarBody>Select or add a page, then add components from the palette.</MessageBarBody></MessageBar>
          ) : activePage.components.length === 0 ? (
            <MessageBar intent="info"><MessageBarBody>This page has no components. Add a Table, Metric, Chart, Form, or Text from the palette.</MessageBarBody></MessageBar>
          ) : (
            activePage.components.map((c) => (
              <ComponentEditor key={c.id} s={s} comp={c} objects={objects} entities={entities}
                rendered={renderedById.get(c.id)}
                onChange={(p) => patchComponent(activePage.id, c.id, p)}
                onDelete={() => deleteComponent(activePage.id, c.id)} />
            ))
          )}
        </div>

        {/* Generated app.config.ts */}
        <div className={s.card}>
          <div className={s.head}><Subtitle2>rayfin/app.config.ts</Subtitle2><div className={s.spacer}><CopyBtn text={appConfigTs} /></div></div>
          <Caption1>Typed serialization of your pages → components → DAX read views. Consumed by the deployed Rayfin app's UI layer.</Caption1>
          <MonacoTextarea value={appConfigTs} onChange={() => { /* read-only */ }} language="typescript" height={220} readOnly lineNumbers={false} ariaLabel="Generated app config" />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-component editor + live render
// ---------------------------------------------------------------------------

interface ComponentEditorProps {
  s: ReturnType<typeof useStyles>;
  comp: RayfinComponent;
  objects: ModelObjects | null;
  entities: RayfinEntity[];
  rendered?: RenderedComponent;
  onChange: (p: Partial<RayfinComponent>) => void;
  onDelete: () => void;
}

function MetricView({ s, rendered }: { s: ReturnType<typeof useStyles>; rendered: RenderedComponent }) {
  const row = rendered.rows?.[0] || [];
  // First numeric value in the row, else first cell.
  let value: unknown = row.find((v) => typeof v === 'number');
  if (value === undefined) value = row[0];
  return <div className={s.metricValue}>{fmtCell(value)}</div>;
}

function ChartView({ s, rendered }: { s: ReturnType<typeof useStyles>; rendered: RenderedComponent }) {
  const cols = rendered.columns || [];
  const rows = rendered.rows || [];
  if (cols.length < 2 || rows.length === 0) {
    return <Caption1>Chart needs a category column and a measure column.</Caption1>;
  }
  const catIdx = 0;
  // value = last numeric column
  let valIdx = cols.length - 1;
  for (let i = cols.length - 1; i >= 1; i -= 1) { if (typeof rows[0][i] === 'number') { valIdx = i; break; } }
  const values = rows.map((r) => Number(r[valIdx]) || 0);
  const max = Math.max(...values, 0) || 1;
  return (
    <div className={s.vstack}>
      {rows.slice(0, 20).map((r, i) => (
        <div key={i} className={s.barRow}>
          <Caption1 className={s.barLabel}>{fmtCell(r[catIdx])}</Caption1>
          <div className={s.barTrack}><div className={s.barFill} style={{ width: `${Math.round((values[i] / max) * 100)}%` }} /></div>
          <Caption1 className={s.barValue}>{fmtCell(r[valIdx])}</Caption1>
        </div>
      ))}
    </div>
  );
}

function TableView({ s, rendered }: { s: ReturnType<typeof useStyles>; rendered: RenderedComponent }) {
  const cols = rendered.columns || [];
  const rows = rendered.rows || [];
  return (
    <div className={s.previewWrap}>
      <Table size="small" aria-label="Component data">
        <TableHeader><TableRow>{cols.map((c) => <TableHeaderCell key={c}>{c}</TableHeaderCell>)}</TableRow></TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow><TableCell><Caption1>No rows.</Caption1></TableCell></TableRow>
          ) : rows.slice(0, 100).map((r, ri) => (
            <TableRow key={ri}>{r.map((v, ci) => <TableCell key={ci}>{fmtCell(v)}</TableCell>)}</TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function ComponentEditor({ s, comp, objects, entities, rendered, onChange, onDelete }: ComponentEditorProps) {
  const kind = comp.kind;
  const b = comp.binding || { measures: [], groupBy: [], topN: kind === 'metric' ? 1 : 50 };

  const setBinding = (p: Partial<typeof b>) => onChange({ binding: { ...b, ...p } });
  const toggleMeasure = (name: string) =>
    setBinding({ measures: b.measures.includes(name) ? b.measures.filter((m) => m !== name) : [...b.measures, name] });
  const toggleGroupBy = (key: string) =>
    setBinding({ groupBy: b.groupBy.includes(key) ? b.groupBy.filter((g) => g !== key) : [...b.groupBy, key] });

  const dax = isDataComponent(kind) ? buildComponentDax(comp) : '';

  return (
    <div className={s.compCard}>
      <div className={s.head}>
        {KIND_ICON[kind]}
        <Input value={comp.title} aria-label="Component title" className={s.compTitle}
          onChange={(_, d) => onChange({ title: d.value })} />
        <Badge appearance="tint">{KIND_LABEL[kind]}</Badge>
        <Tooltip content="Remove component" relationship="label">
          <Button size="small" appearance="subtle" icon={<Delete20Regular />} aria-label={`Remove ${comp.title}`} onClick={onDelete} />
        </Tooltip>
      </div>

      {isDataComponent(kind) ? (
        <>
          <div className={s.cols}>
            <div>
              <Body1><strong>Measures</strong> <Caption1>({b.measures.length})</Caption1></Body1>
              {!objects || objects.measures.length === 0 ? <Caption1>No measures available.</Caption1> : (
                <div className={s.pickList}>
                  {objects.measures.map((m) => (
                    <Checkbox key={m.name} label={m.name} checked={b.measures.includes(m.name)} onChange={() => toggleMeasure(m.name)} />
                  ))}
                </div>
              )}
            </div>
            <div>
              <Body1><strong>{kind === 'chart' ? 'Category (group by)' : 'Group by'}</strong> <Caption1>({b.groupBy.length})</Caption1></Body1>
              {!objects || objects.columns.length === 0 ? <Caption1>No columns available.</Caption1> : (
                <div className={s.pickList}>
                  {objects.columns.map((c) => {
                    const key = gbKey(c.table, c.name);
                    return <Checkbox key={key} label={`${c.table}[${c.name}]`} checked={b.groupBy.includes(key)} onChange={() => toggleGroupBy(key)} />;
                  })}
                </div>
              )}
            </div>
          </div>
          {kind !== 'metric' ? (
            <Field label="Max rows"><SpinButton min={1} max={1000} value={b.topN}
              onChange={(_, d) => setBinding({ topN: d.value ?? (Number(d.displayValue) || 50) })} /></Field>
          ) : null}
          <details>
            <summary><Caption1>Read-view DAX</Caption1></summary>
            <pre className={s.code}>{dax}</pre>
          </details>
        </>
      ) : kind === 'form' ? (
        <>
          <Field label="Bound entity">
            <Dropdown placeholder="Select an entity" value={comp.entity || ''} selectedOptions={comp.entity ? [comp.entity] : []}
              onOptionSelect={(_, d) => onChange({ entity: d.optionValue || '' })}>
              {entities.map((e) => <Option key={e.name} value={e.name}>{e.name}</Option>)}
            </Dropdown>
          </Field>
          <Caption1>The deployed Rayfin app renders a create/edit form for this entity (write-back runs in the app, not in Loom).</Caption1>
        </>
      ) : (
        <Field label="Text">
          <Textarea value={comp.text || ''} onChange={(_, d) => onChange({ text: d.value })} resize="vertical" />
        </Field>
      )}

      {/* Live render */}
      {rendered ? (
        rendered.ok === false ? (
          <MessageBar intent="error"><MessageBarBody>{rendered.error || 'Render failed.'}</MessageBarBody></MessageBar>
        ) : isDataComponent(kind) ? (
          <div className={s.vstack}>
            <div className={s.metaRow}>
              <Badge appearance="tint" color="informative">{rendered.rowCount ?? 0} row{(rendered.rowCount ?? 0) === 1 ? '' : 's'}</Badge>
              {typeof rendered.executionMs === 'number' ? <Badge appearance="tint" color="brand">{rendered.executionMs} ms</Badge> : null}
            </div>
            {kind === 'metric' ? <MetricView s={s} rendered={rendered} />
              : kind === 'chart' ? <ChartView s={s} rendered={rendered} />
              : <TableView s={s} rendered={rendered} />}
          </div>
        ) : kind === 'text' ? (
          <Body1>{comp.text}</Body1>
        ) : (
          <Caption1>Form preview — bound to entity “{comp.entity || '(none)'}”.</Caption1>
        )
      ) : null}
    </div>
  );
}
