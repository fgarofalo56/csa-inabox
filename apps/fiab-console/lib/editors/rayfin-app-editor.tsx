'use client';

/**
 * RayfinAppEditor — author a Rayfin app backend (Microsoft Fabric "apps"
 * workload, Build 2026 preview) AND bind it to a real semantic model (Build
 * 2026 #28: "build web apps backed by semantic models"). Generates the real
 * @microsoft/rayfin-core SDK model, a model-bound data connector, and the exact
 * CLI command sequence to deploy it.
 *
 * Two surfaces:
 *  1. Backend definition — entities/services/auth/static-hosting (the general
 *     Rayfin case): Loom emits a model.ts + the `npx rayfin` command sequence.
 *  2. Model binding (Build 2026 #28) — bind the app to a REAL semantic model.
 *     The Azure-native DEFAULT backend is Azure Analysis Services (per
 *     no-fabric-dependency.md — no Fabric/Power BI workspace required):
 *       • pick a bindable model        (GET /api/items/rayfin-app/models)
 *       • introspect measures + fields  (GET …/model-objects?model=)
 *       • select measures + group-by    → live DAX preview (POST …/preview)
 *       • Loom emits a typed connector that issues that exact DAX so the
 *         deployed app reads from the bound model end-to-end.
 *
 * Everything renders with an honest Fluent MessageBar when AAS is unset — never
 * an empty picker (no-vaporware.md). The Rayfin CLI itself runs on the dev
 * machine, so Loom authors the spec + emits the artifacts (the honest
 * generate-artifact pattern, like the deploy planner emitting bicep). The full
 * spec persists on the Cosmos item so it round-trips.
 *
 * Refs (preview): https://learn.microsoft.com/fabric/apps/overview ·
 *   https://github.com/microsoft/rayfin · npm @microsoft/rayfin-cli
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  makeStyles, tokens, Button, Input, Field, Switch, Subtitle2, Body1, Caption1,
  Badge, MessageBar, MessageBarBody, MessageBarTitle, Dropdown, Option, Divider,
  Spinner, Tooltip, useId, useToastController, Toast, ToastTitle, Toaster,
  Checkbox, SpinButton, Table, TableHeader, TableHeaderCell, TableRow, TableBody, TableCell,
  TabList, Tab,
} from '@fluentui/react-components';
import {
  Add20Regular, Delete20Regular, Copy20Regular, Checkmark20Regular, Save20Regular,
  Rocket20Regular, Open20Regular, Database20Regular, Play20Regular, ArrowSync20Regular,
} from '@fluentui/react-icons';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';
import { appDefFromRayfinBinding } from '@/lib/apps/app-definition';

type FieldType = 'text' | 'boolean' | 'date' | 'number';
interface EntityField { name: string; type: FieldType; }
interface RayfinEntity { name: string; fields: EntityField[]; }

/** A bound semantic-model read view: which measures + group-by the app shows. */
interface ModelBinding {
  /** AAS tabular database (semantic model) name; '' = not bound. */
  model: string;
  /** Selected measure names from the bound model. */
  measures: string[];
  /** Selected group-by columns encoded as "table|column". */
  groupBy: string[];
  /** Max rows the read view returns. */
  topN: number;
}

interface RayfinSpec {
  appName: string;
  workspaceName: string;
  services: { database: boolean; storage: boolean };
  auth: 'fabric';
  staticHosting: boolean;
  entities: RayfinEntity[];
  /** Model binding (Build 2026 #28). Optional — the general Rayfin case omits it. */
  binding?: ModelBinding;
}

const DEFAULT_BINDING: ModelBinding = { model: '', measures: [], groupBy: [], topN: 100 };

const DEFAULT_SPEC: RayfinSpec = {
  appName: 'my-app',
  workspaceName: '',
  services: { database: true, storage: false },
  auth: 'fabric',
  staticHosting: true,
  entities: [{ name: 'Todo', fields: [{ name: 'title', type: 'text' }, { name: 'done', type: 'boolean' }, { name: 'dueDate', type: 'date' }] }],
  binding: { ...DEFAULT_BINDING },
};

// --- model-binding API shapes ---
interface BindableModel { name: string; storageMode?: string; state?: string; compatibilityLevel?: number; }
interface ModelMeasure { name: string; table?: string; description?: string; }
interface ModelColumn { table: string; name: string; dataType?: string; }
interface ModelObjects { measures: ModelMeasure[]; columns: ModelColumn[]; }
interface PreviewResult { dax: string; columns: string[]; rows: unknown[][]; rowCount: number; executionMs: number; truncated: boolean; }
interface GateInfo { missing: string; detail: string; }

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '12px', padding: '12px', minWidth: 0, maxWidth: '100%' },
  row: { display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'flex-end' },
  cols: { display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: '16px', minWidth: 0 },
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
    maxHeight: '180px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '2px',
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium, padding: '8px',
    backgroundColor: tokens.colorNeutralBackground1,
    '& .fui-Checkbox': { borderRadius: tokens.borderRadiusSmall, paddingInline: '4px' },
    '& .fui-Checkbox:hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
  },
  previewWrap: {
    maxHeight: '260px', overflow: 'auto', border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    '& thead th': {
      position: 'sticky', top: 0, zIndex: 1,
      backgroundColor: tokens.colorNeutralBackground2,
    },
  },
  metaRow: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', color: tokens.colorNeutralForeground3 },
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

const DECO: Record<FieldType, string> = { text: 'text', boolean: 'boolean', date: 'date', number: 'number' };
const TS_TYPE: Record<FieldType, string> = { text: 'string', boolean: 'boolean', date: 'Date', number: 'number' };

function pascal(s: string): string {
  return (s || 'Entity').replace(/[^A-Za-z0-9]+/g, ' ').trim().split(' ').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('') || 'Entity';
}

/** Decode the "table|column" group-by key. */
function gbParse(key: string): { table: string; column: string } {
  const i = key.indexOf('|');
  return i < 0 ? { table: '', column: key } : { table: key.slice(0, i), column: key.slice(i + 1) };
}
function gbKey(table: string, column: string): string { return `${table}|${column}`; }

/** Build the same DAX the BFF builds (so the connector code matches the preview). */
function buildBindingDax(b: ModelBinding): string {
  const groupRefs = b.groupBy.map((k) => { const { table, column } = gbParse(k); return `'${table.replace(/'/g, "''")}'[${column.replace(/]/g, '')}]`; });
  const measureProj = b.measures.map((m) => `"${m.replace(/"/g, '""')}", [${m.replace(/]/g, '')}]`);
  if (groupRefs.length === 0 && measureProj.length === 0) return '// select measures or group-by fields to bind';
  if (groupRefs.length === 0) return `EVALUATE\nROW(${measureProj.join(', ')})`;
  const topN = b.topN > 0 ? Math.min(b.topN, 1000) : 100;
  const inner = measureProj.length
    ? `SUMMARIZECOLUMNS(\n  ${groupRefs.join(',\n  ')},\n  ${measureProj.join(',\n  ')}\n)`
    : `SUMMARIZECOLUMNS(\n  ${groupRefs.join(',\n  ')}\n)`;
  return `EVALUATE\nTOPN(\n  ${topN},\n  ${inner}\n)`;
}

function generateModel(spec: RayfinSpec): string {
  const used = Array.from(new Set(spec.entities.flatMap((e) => e.fields.map((f) => DECO[f.type])))).sort();
  const imports = ['entity', ...used].join(', ');
  const blocks = spec.entities.map((e) => {
    const cls = pascal(e.name);
    const props = e.fields.map((f) => `  @${DECO[f.type]}() ${f.name || 'field'}!: ${TS_TYPE[f.type]};`).join('\n');
    return `@entity()\nexport class ${cls} {\n${props || '  // add fields'}\n}`;
  }).join('\n\n');
  return `// rayfin/model.ts — generated by CSA Loom (verify against the current @microsoft/rayfin-core API)\nimport { ${imports} } from '@microsoft/rayfin-core';\n\n${blocks}\n`;
}

/**
 * Generate the model-bound data connector: a typed service the deployed app
 * calls to read from the bound semantic model. It issues the exact DAX the
 * preview validated, over the same Azure Analysis Services data-plane endpoint
 * Loom queries (no Fabric/Power BI dependency). The CLI runs this on the dev
 * machine; Loom emits it so the app is wired to the model end-to-end.
 */
function generateConnector(spec: RayfinSpec): string {
  const b = spec.binding;
  if (!b || !b.model) {
    return '// No semantic model bound — bind one in the "Model binding" panel to generate this connector.';
  }
  const dax = buildBindingDax(b);
  const daxLiteral = dax.split('\n').map((l) => `  ${JSON.stringify(l)}`).join(',\n');
  return [
    `// rayfin/data/model-view.ts — generated by CSA Loom`,
    `// Reads from the bound semantic model "${b.model}" via DAX (Azure Analysis`,
    `// Services data-plane; AAS_SERVER = "<region>.asazure.windows.net/<server>").`,
    `// Auth: the app's managed identity / Entra SSO (server admin on the AAS server).`,
    `import { aasExecuteDax } from './aas-xmla'; // thin XMLA-over-HTTP helper (mirrors Loom's lib/azure/aas-xmla)`,
    ``,
    `export const BOUND_MODEL = ${JSON.stringify(b.model)};`,
    ``,
    `// The exact DAX validated in CSA Loom's live preview for this read view.`,
    `export const MODEL_VIEW_DAX = [`,
    daxLiteral,
    `].join('\\n');`,
    ``,
    `/** Returns the read view's rows ({ column: value }[]) from the bound model. */`,
    `export async function readModelView(): Promise<Record<string, unknown>[]> {`,
    `  const { columns, rows } = await aasExecuteDax(process.env.AAS_SERVER!, BOUND_MODEL, MODEL_VIEW_DAX);`,
    `  return rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i]])));`,
    `}`,
    ``,
  ].join('\n');
}

function generateCommands(spec: RayfinSpec): string {
  const services = [spec.services.database ? 'db' : '', spec.services.storage ? 'storage' : ''].filter(Boolean).join(',') || 'db';
  const ws = spec.workspaceName?.trim();
  const bound = spec.binding?.model;
  const lines = [
    '# 1) Scaffold a Rayfin app (creates the project + Fabric workspace binding)',
    `npm create @microsoft/rayfin@latest ${spec.appName}${ws ? ` --workspace "${ws}"` : ''}`,
    `cd ${spec.appName}`,
    '',
    '# 2) (or, in an existing project) initialize Rayfin with the services above',
    `npx rayfin init ${spec.appName} --services ${services} --auth-methods ${spec.auth}${spec.staticHosting ? ' --static-hosting' : ''}`,
    '',
    '# 3) Paste the generated entities into rayfin/model.ts',
  ];
  if (bound) {
    lines.push(
      '',
      '# 4) Add the model-bound read view (paste rayfin/data/model-view.ts) and set the',
      `#    AAS data-plane address for the bound model "${bound}":`,
      'export AAS_SERVER="<region>.asazure.windows.net/<server>"   # the same model CSA Loom queried',
      '',
      '# 5) Deploy to Fabric',
      'npx rayfin up',
    );
  } else {
    lines.push('', '# 4) Deploy to Fabric', 'npx rayfin up');
  }
  return lines.join('\n');
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
  const [tab, setTab] = useState<'backend' | 'binding'>('backend');

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

  // audit-T145 alignment — lift this binding into a visual Atelier app.
  const [wsId, setWsId] = useState('');
  const [atelierBusy, setAtelierBusy] = useState(false);
  const [atelierMsg, setAtelierMsg] = useState<{ intent: 'success' | 'error'; text: string; itemId?: string } | null>(null);

  const binding = spec.binding ?? DEFAULT_BINDING;

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch(`/api/items/rayfin-app/${encodeURIComponent(id)}`);
        const j = await r.json().catch(() => ({}));
        if (alive && typeof j?.workspaceId === 'string') setWsId(j.workspaceId);
        const saved = (j?.state?.spec || j?.item?.state?.spec || j?.definition?.state?.spec) as RayfinSpec | undefined;
        if (alive && saved && Array.isArray(saved.entities)) {
          setSpec({ ...DEFAULT_SPEC, ...saved, binding: { ...DEFAULT_BINDING, ...(saved.binding || {}) } });
        }
      } catch { /* keep default */ }
      finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; };
  }, [id]);

  // Create a visual Atelier (workshop-app) app seeded with this model binding as
  // a page — the concrete code-first (Rayfin) → visual (Atelier) bridge. Both
  // builders share the AppDefinition schema + read the SAME Azure Analysis
  // Services model (no-fabric-dependency / no-vaporware).
  const createAtelierApp = useCallback(async () => {
    const def = appDefFromRayfinBinding(binding, spec.appName);
    if (!def || !wsId) return;
    setAtelierBusy(true); setAtelierMsg(null);
    try {
      const r = await fetch('/api/cosmos-items/workshop-app', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId: wsId, displayName: `${spec.appName || binding.model} (Atelier)`, state: { appDef: def } }),
      });
      const j = await r.json().catch(() => ({}));
      if (!j?.ok || !j.item?.id) { setAtelierMsg({ intent: 'error', text: j?.error || `HTTP ${r.status}` }); return; }
      setAtelierMsg({ intent: 'success', text: 'Created an Atelier app from this binding.', itemId: j.item.id });
    } catch (e: any) { setAtelierMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setAtelierBusy(false); }
  }, [binding, spec.appName, wsId]);

  // Load bindable models when the binding tab is first opened.
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
    if (tab === 'binding' && models === null && !modelsLoading) void loadModels();
  }, [tab, models, modelsLoading, loadModels]);

  // Introspect the bound model's objects whenever the bound model changes.
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
    if (tab === 'binding' && binding.model) void loadObjects(binding.model);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, binding.model]);

  const modelTs = useMemo(() => generateModel(spec), [spec]);
  const connector = useMemo(() => generateConnector(spec), [spec]);
  const commands = useMemo(() => generateCommands(spec), [spec]);
  const bindingDax = useMemo(() => buildBindingDax(binding), [binding]);

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

  const patch = (p: Partial<RayfinSpec>) => setSpec((prev) => ({ ...prev, ...p }));
  const patchBinding = (p: Partial<ModelBinding>) =>
    setSpec((prev) => ({ ...prev, binding: { ...DEFAULT_BINDING, ...(prev.binding || {}), ...p } }));
  const patchEntity = (i: number, e: Partial<RayfinEntity>) =>
    setSpec((prev) => ({ ...prev, entities: prev.entities.map((x, idx) => idx === i ? { ...x, ...e } : x) }));

  const toggleMeasure = (name: string) =>
    patchBinding({ measures: binding.measures.includes(name) ? binding.measures.filter((m) => m !== name) : [...binding.measures, name] });
  const toggleGroupBy = (key: string) =>
    patchBinding({ groupBy: binding.groupBy.includes(key) ? binding.groupBy.filter((g) => g !== key) : [...binding.groupBy, key] });

  if (loading) return <div className={s.root}><Spinner label="Loading Rayfin app…" /></div>;

  return (
    <div className={s.root}>
      <Toaster toasterId={toasterId} />
      <div className={s.head}>
        <Rocket20Regular />
        <Subtitle2>Rayfin app</Subtitle2>
        <Badge appearance="outline" color="warning">Preview</Badge>
        {binding.model ? <Badge appearance="tint" color="brand" icon={<Database20Regular />}>Bound: {binding.model}</Badge> : null}
        <div className={s.headActions}>
          <Button appearance="outline" icon={<Open20Regular />} as="a" href="https://learn.microsoft.com/fabric/apps/overview" target="_blank" rel="noreferrer">Docs</Button>
          <Button appearance="outline" icon={<Open20Regular />} as="a" href="https://github.com/microsoft/rayfin" target="_blank" rel="noreferrer">Repo</Button>
          <Button appearance="primary" icon={<Save20Regular />} onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
        </div>
      </div>

      <MessageBar intent="warning">
        <MessageBarBody>
          <MessageBarTitle>Rayfin is a preview SDK + CLI that runs on your dev machine.</MessageBarTitle>
          Define the backend and (optionally) bind it to a real semantic model below — Loom generates the real
          <code> @microsoft/rayfin-core</code> model, a model-bound data connector, and the exact CLI commands. Run them
          locally (<code>npx rayfin up</code>) to deploy the app to your Fabric workspace.
        </MessageBarBody>
      </MessageBar>

      <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as 'backend' | 'binding')}>
        <Tab value="backend">Backend definition</Tab>
        <Tab value="binding" icon={<Database20Regular />}>Model binding</Tab>
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
      ) : (
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

            <Divider />
            <div className={s.head}>
              <Subtitle2>Use in Atelier</Subtitle2>
              <div className={s.headActions}>
                <Button appearance="outline" icon={<Open20Regular />} disabled={atelierBusy || !binding.model || (binding.measures.length === 0 && binding.groupBy.length === 0) || !wsId}
                  onClick={createAtelierApp}>{atelierBusy ? 'Creating…' : 'Create Atelier app'}</Button>
              </div>
            </div>
            <Caption1>
              Lift this semantic-model binding into a visual Atelier (low-code) app — a page bound to the SAME Azure
              Analysis Services model. Atelier is Loom&apos;s visual builder; Rayfin stays code-first (audit-T145).
            </Caption1>
            {atelierMsg ? (
              <MessageBar intent={atelierMsg.intent}>
                <MessageBarBody>
                  {atelierMsg.text}
                  {atelierMsg.itemId ? <> <a href={`/items/workshop-app/${encodeURIComponent(atelierMsg.itemId)}`}>Open the Atelier app →</a></> : null}
                </MessageBarBody>
              </MessageBar>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
