'use client';

/**
 * RayfinAppEditor — author a Rayfin app backend (Microsoft Fabric "apps"
 * workload, Build 2026 preview) and generate the real @microsoft/rayfin-core
 * SDK model + the exact CLI command sequence to deploy it to a Fabric workspace.
 *
 * TWO app shapes, switched by the TabList:
 *
 *  1) "App backend" (the GENERAL case) — define entities/services/auth in
 *     TypeScript; `npx rayfin up` deploys an app backend (database, auth, Data
 *     APIs via DAB, storage, hosting). Loom emits the @microsoft/rayfin-core
 *     model + the CLI sequence (the no-vaporware honest path — like the deploy
 *     planner generating bicep). The spec persists on the Cosmos item.
 *
 *  2) "Data app (model-bound)" (Build 2026 — "Create an app connected to a
 *     semantic model", the `--template dataapp` flow) — the app does NOT define
 *     its own schema; it BINDS to an existing semantic model and queries it with
 *     DAX through the Execute DAX Queries API. Loom lists the bindable models
 *     from a REAL backend (Azure-native default: Loom-native Cosmos models + the
 *     Azure Analysis Services server; opt-in: Power BI / Fabric datasets in a
 *     workspace), runs a LIVE DAX probe so you prove the binding before
 *     deploying, persists the binding + saved queries, and emits the dataapp
 *     scaffold command + a typed RayfinClient query primitive. Per
 *     no-fabric-dependency.md the Azure-native path is the DEFAULT and works
 *     with LOOM_DEFAULT_FABRIC_WORKSPACE unset.
 *
 * Refs (preview): https://learn.microsoft.com/fabric/apps/overview ·
 *   https://learn.microsoft.com/fabric/apps/data-apps-template ·
 *   https://github.com/microsoft/rayfin · npm @microsoft/rayfin-cli
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  makeStyles, tokens, Button, Input, Field, Switch, Subtitle2, Body1, Caption1,
  Badge, MessageBar, MessageBarBody, MessageBarTitle, Dropdown, Option, Divider,
  Spinner, Tooltip, useId, useToastController, Toast, ToastTitle, Toaster,
  TabList, Tab, Textarea, Table, TableHeader, TableRow, TableHeaderCell,
  TableBody, TableCell,
} from '@fluentui/react-components';
import {
  Add20Regular, Delete20Regular, Copy20Regular, Checkmark20Regular, Save20Regular,
  Rocket20Regular, Open20Regular, Play20Regular, DatabaseLink20Regular,
} from '@fluentui/react-icons';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';

type FieldType = 'text' | 'boolean' | 'date' | 'number';
interface EntityField { name: string; type: FieldType; }
interface RayfinEntity { name: string; fields: EntityField[]; }
interface RayfinSpec {
  appName: string;
  workspaceName: string;
  services: { database: boolean; storage: boolean };
  auth: 'fabric';
  staticHosting: boolean;
  entities: RayfinEntity[];
}

// ── Model-bound (data app) shapes ───────────────────────────────────────────
type ModelSource = 'loom' | 'aas' | 'powerbi';
interface BoundModelLite { id: string; name: string; source: ModelSource; tableCount?: number; detail?: string; }
interface SavedQuery { name: string; dax: string; }
interface ModelBinding {
  modelId: string; name: string; source: ModelSource;
  workspaceId?: string; queries: SavedQuery[]; updatedAt?: string;
}
interface ProbeCapability { aasAvailable: boolean; powerbiAvailable: boolean; hint?: string; }

const DEFAULT_SPEC: RayfinSpec = {
  appName: 'my-app',
  workspaceName: '',
  services: { database: true, storage: false },
  auth: 'fabric',
  staticHosting: true,
  entities: [{ name: 'Todo', fields: [{ name: 'title', type: 'text' }, { name: 'done', type: 'boolean' }, { name: 'dueDate', type: 'date' }] }],
};

const STARTER_DAX = 'EVALUATE TOPN(10, INFO.TABLES())';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '12px', padding: '12px', minWidth: 0, maxWidth: '100%' },
  row: { display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'flex-end' },
  cols: { display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: '16px', minWidth: 0 },
  card: {
    padding: '16px', border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge, backgroundColor: tokens.colorNeutralBackground1,
    display: 'flex', flexDirection: 'column', gap: '10px', minWidth: 0,
  },
  entity: { border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: '6px', padding: '10px', display: 'flex', flexDirection: 'column', gap: '6px' },
  fieldRow: { display: 'flex', gap: '8px', alignItems: 'center' },
  code: {
    fontFamily: 'Consolas, monospace', fontSize: '12px', whiteSpace: 'pre', overflowX: 'auto',
    background: tokens.colorNeutralBackground3, border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: '6px', padding: '12px', margin: 0,
  },
  head: { display: 'flex', alignItems: 'center', gap: '8px' },
  resultWrap: { maxHeight: '260px', overflow: 'auto', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: '6px' },
  stickyHead: {
    '& th': {
      position: 'sticky', top: 0, zIndex: 1,
      backgroundColor: tokens.colorNeutralBackground1,
      boxShadow: `inset 0 -1px 0 ${tokens.colorNeutralStroke2}`,
    },
  },
  resultMeta: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    gap: '8px', flexWrap: 'wrap',
  },
  spread: { marginLeft: 'auto' },
  bindingMeta: {
    display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap',
    padding: '8px 10px', borderRadius: '6px',
    backgroundColor: tokens.colorNeutralBackground2,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  modelId: { fontFamily: 'Consolas, monospace', color: tokens.colorNeutralForeground3, wordBreak: 'break-all' },
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

function camel(s: string): string {
  const p = pascal(s);
  return p.charAt(0).toLowerCase() + p.slice(1);
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

function generateCommands(spec: RayfinSpec): string {
  const services = [spec.services.database ? 'db' : '', spec.services.storage ? 'storage' : ''].filter(Boolean).join(',') || 'db';
  const ws = spec.workspaceName?.trim();
  const lines = [
    '# 1) Scaffold a Rayfin app (creates the project + Fabric workspace binding)',
    `npm create @microsoft/rayfin@latest ${spec.appName}${ws ? ` --workspace "${ws}"` : ''}`,
    `cd ${spec.appName}`,
    '',
    '# 2) (or, in an existing project) initialize Rayfin with the services above',
    `npx rayfin init ${spec.appName} --services ${services} --auth-methods ${spec.auth}${spec.staticHosting ? ' --static-hosting' : ''}`,
    '',
    '# 3) Paste the generated entities into rayfin/model.ts, then deploy to Fabric',
    'npx rayfin up',
  ];
  return lines.join('\n');
}

// ── Data-app (model-bound) artifact generation ──────────────────────────────

function generateDataAppCommands(appName: string, ws: string, binding: ModelBinding | null): string {
  const lines = [
    '# 1) Scaffold a data app bound to a semantic model (--template dataapp)',
    `npm create @microsoft/rayfin@latest -- "${appName}" --template dataapp${ws ? ` --workspace "${ws}"` : ''}`,
    `cd ${appName}`,
    '',
    '# 2) The dataapp template ships Fabric auth + DAX generation + analytical visuals.',
    '#    Point it at the model you bound below (the share link carries workspace + model id):',
  ];
  if (binding) {
    lines.push(`#    Bound model: ${binding.name} (${binding.source})`);
    if (binding.source === 'powerbi' && binding.workspaceId) {
      lines.push(`#    https://app.powerbi.com/groups/${binding.workspaceId}/modeling/${binding.modelId}/modelView`);
    } else if (binding.source === 'aas') {
      lines.push(`#    Azure Analysis Services database: ${binding.modelId.replace(/^aas:/, '')}`);
    } else {
      lines.push(`#    Loom-native semantic model: ${binding.modelId}`);
    }
  }
  lines.push('', '# 3) Build the frontend, then deploy to Fabric', 'npm run build', 'npx rayfin up');
  return lines.join('\n');
}

/**
 * A typed RayfinClient data-access primitive over the bound model. The deployed
 * data app queries the semantic model with DAX via the Execute DAX Queries API
 * — this is the same call the live probe in this editor makes.
 */
function generateDataAccess(binding: ModelBinding | null): string {
  const target = binding?.source === 'powerbi'
    ? `{ workspaceId: '${binding.workspaceId || '<workspace-id>'}', datasetId: '${binding.modelId}' }`
    : binding?.source === 'aas'
      ? `{ database: '${binding.modelId.replace(/^aas:/, '')}' }  // Azure Analysis Services (Azure-native default)`
      : `{ modelId: '${binding?.modelId || '<loom-model-id>'}' }  // Loom-native semantic model`;
  const queries = (binding?.queries || []);
  const methods = (queries.length ? queries : [{ name: 'overview', dax: STARTER_DAX }]).map((q) => {
    const fn = camel(q.name);
    const dax = q.dax.replace(/`/g, '\\`');
    return `  /** Saved query: ${q.name} */\n  async ${fn}() {\n    return this.evaluate(\`${dax}\`);\n  }`;
  }).join('\n\n');
  return [
    "// src/data/model.ts — generated by CSA Loom (data app bound to a semantic model)",
    "// The deployed Fabric app authenticates with Fabric SSO and runs DAX through",
    "// the Execute DAX Queries API. See https://learn.microsoft.com/fabric/apps/data-apps-template",
    "import { RayfinClient } from '@microsoft/rayfin-core';",
    '',
    `const MODEL = ${target};`,
    '',
    'export class ModelData {',
    '  constructor(private client: RayfinClient) {}',
    '',
    '  /** Run an arbitrary EVALUATE query against the bound model. */',
    '  async evaluate(dax: string) {',
    '    return this.client.dax(MODEL, dax);',
    '  }',
    '',
    methods,
    '}',
    '',
  ].join('\n');
}

// ── Renderers ────────────────────────────────────────────────────────────────

function sourceBadge(src: ModelSource) {
  const map: Record<ModelSource, { label: string; color: 'brand' | 'informative' | 'warning' }> = {
    loom: { label: 'Loom-native', color: 'brand' },
    aas: { label: 'Analysis Services', color: 'informative' },
    powerbi: { label: 'Power BI', color: 'warning' },
  };
  const m = map[src];
  return <Badge appearance="tint" color={m.color}>{m.label}</Badge>;
}

export function RayfinAppEditor({ id }: { item?: unknown; id: string }) {
  const s = useStyles();
  const toasterId = useId('rayfin-toaster');
  const { dispatchToast } = useToastController(toasterId);
  const [spec, setSpec] = useState<RayfinSpec>(DEFAULT_SPEC);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [mode, setMode] = useState<'backend' | 'dataapp'>('backend');

  // Model-bound state
  const [models, setModels] = useState<BoundModelLite[]>([]);
  const [probe, setProbe] = useState<ProbeCapability | null>(null);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelNotices, setModelNotices] = useState<string[]>([]);
  const [binding, setBinding] = useState<ModelBinding | null>(null);
  const [dax, setDax] = useState<string>(STARTER_DAX);
  const [probing, setProbing] = useState(false);
  const [probeRows, setProbeRows] = useState<Record<string, unknown>[] | null>(null);
  const [probeCols, setProbeCols] = useState<string[]>([]);
  const [probeErr, setProbeErr] = useState<string | null>(null);
  const [bindingSaving, setBindingSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch(`/api/items/rayfin-app/${encodeURIComponent(id)}`);
        const j = await r.json().catch(() => ({}));
        const st = (j?.state || j?.item?.state || j?.definition?.state) as any;
        const saved = st?.spec as RayfinSpec | undefined;
        if (alive && saved && Array.isArray(saved.entities)) setSpec({ ...DEFAULT_SPEC, ...saved });
        const savedBinding = st?.modelBinding as ModelBinding | undefined;
        if (alive && savedBinding && savedBinding.modelId) {
          setBinding({ ...savedBinding, queries: Array.isArray(savedBinding.queries) ? savedBinding.queries : [] });
        }
      } catch { /* keep default */ }
      finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; };
  }, [id]);

  const loadModels = useCallback(async () => {
    setModelsLoading(true);
    setModelNotices([]);
    try {
      const r = await fetch(`/api/items/rayfin-app/${encodeURIComponent(id)}/bind-model`);
      const j = await r.json().catch(() => ({}));
      if (j?.ok) {
        setModels(Array.isArray(j.models) ? j.models : []);
        setProbe(j.probe || null);
        if (Array.isArray(j.notices)) setModelNotices(j.notices);
        if (j.binding && j.binding.modelId && !binding) {
          setBinding({ ...j.binding, queries: Array.isArray(j.binding.queries) ? j.binding.queries : [] });
        }
      } else {
        setModelNotices([j?.error || 'Failed to list models']);
      }
    } catch (e: any) {
      setModelNotices([e?.message || String(e)]);
    } finally { setModelsLoading(false); }
  }, [id, binding]);

  // Load bindable models the first time the data-app tab is opened.
  useEffect(() => {
    if (mode === 'dataapp' && models.length === 0 && !modelsLoading) void loadModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  const model = useMemo(() => generateModel(spec), [spec]);
  const commands = useMemo(() => generateCommands(spec), [spec]);
  const dataAppCommands = useMemo(() => generateDataAppCommands(spec.appName, spec.workspaceName, binding), [spec.appName, spec.workspaceName, binding]);
  const dataAccess = useMemo(() => generateDataAccess(binding), [binding]);

  const save = useCallback(async () => {
    setSaving(true);
    try {
      const r = await fetch(`/api/items/rayfin-app/${encodeURIComponent(id)}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ state: { spec, ...(binding ? { modelBinding: binding } : {}) } }),
      });
      dispatchToast(<Toast><ToastTitle>{r.ok ? 'Saved' : 'Save failed'}</ToastTitle></Toast>, { intent: r.ok ? 'success' : 'error' });
    } catch (e: any) {
      dispatchToast(<Toast><ToastTitle>Save failed: {e?.message || String(e)}</ToastTitle></Toast>, { intent: 'error' });
    } finally { setSaving(false); }
  }, [id, spec, binding, dispatchToast]);

  const selectModel = useCallback((m: BoundModelLite) => {
    setBinding((prev) => ({
      modelId: m.id, name: m.name, source: m.source,
      workspaceId: prev?.modelId === m.id ? prev.workspaceId : undefined,
      queries: prev?.modelId === m.id ? prev.queries : [],
    }));
    setProbeRows(null); setProbeErr(null); setProbeCols([]);
  }, []);

  const runProbe = useCallback(async () => {
    if (!binding) return;
    setProbing(true); setProbeErr(null); setProbeRows(null); setProbeCols([]);
    try {
      const r = await fetch(`/api/items/rayfin-app/${encodeURIComponent(id)}/bind-model`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ modelId: binding.modelId, dax, workspaceId: binding.workspaceId }),
      });
      const j = await r.json().catch(() => ({}));
      if (j?.ok) {
        const rows = (j.rows || []) as Record<string, unknown>[];
        setProbeRows(rows);
        setProbeCols(j.columns && j.columns.length ? j.columns : (rows[0] ? Object.keys(rows[0]) : []));
      } else if (j?.probeUnavailable) {
        setProbeErr(j.detail || `Live DAX probe not available (set ${j.missing}).`);
      } else {
        setProbeErr(j?.error || `Probe failed (${r.status})`);
      }
    } catch (e: any) {
      setProbeErr(e?.message || String(e));
    } finally { setProbing(false); }
  }, [id, binding, dax]);

  const saveBinding = useCallback(async () => {
    if (!binding) return;
    setBindingSaving(true);
    try {
      const r = await fetch(`/api/items/rayfin-app/${encodeURIComponent(id)}/bind-model`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(binding),
      });
      const j = await r.json().catch(() => ({}));
      dispatchToast(<Toast><ToastTitle>{r.ok && j?.ok ? 'Model binding saved' : (j?.error || 'Save failed')}</ToastTitle></Toast>, { intent: r.ok && j?.ok ? 'success' : 'error' });
    } catch (e: any) {
      dispatchToast(<Toast><ToastTitle>Save failed: {e?.message || String(e)}</ToastTitle></Toast>, { intent: 'error' });
    } finally { setBindingSaving(false); }
  }, [id, binding, dispatchToast]);

  const addSavedQuery = useCallback(() => {
    setBinding((prev) => prev ? { ...prev, queries: [...prev.queries, { name: `query${prev.queries.length + 1}`, dax }] } : prev);
  }, [dax]);

  const patch = (p: Partial<RayfinSpec>) => setSpec((prev) => ({ ...prev, ...p }));
  const patchEntity = (i: number, e: Partial<RayfinEntity>) =>
    setSpec((prev) => ({ ...prev, entities: prev.entities.map((x, idx) => idx === i ? { ...x, ...e } : x) }));

  if (loading) return <div className={s.root}><Spinner label="Loading Rayfin app…" /></div>;

  return (
    <div className={s.root}>
      <Toaster toasterId={toasterId} />
      <div className={s.head}>
        <Rocket20Regular />
        <Subtitle2>Rayfin app</Subtitle2>
        <Badge appearance="outline" color="warning">Preview</Badge>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <Button appearance="outline" icon={<Open20Regular />} as="a" href="https://learn.microsoft.com/fabric/apps/overview" target="_blank">Docs</Button>
          <Button appearance="outline" icon={<Open20Regular />} as="a" href="https://github.com/microsoft/rayfin" target="_blank">Repo</Button>
          <Button appearance="primary" icon={<Save20Regular />} onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
        </div>
      </div>

      <TabList selectedValue={mode} onTabSelect={(_, d) => setMode(d.value as 'backend' | 'dataapp')}>
        <Tab value="backend" icon={<Rocket20Regular />}>App backend</Tab>
        <Tab value="dataapp" icon={<DatabaseLink20Regular />}>Data app (model-bound)</Tab>
      </TabList>

      {mode === 'backend' && (
        <>
          <MessageBar intent="warning">
            <MessageBarBody>
              <MessageBarTitle>Rayfin is a preview SDK + CLI that runs on your dev machine.</MessageBarTitle>
              Define the backend below — Loom generates the real <code>@microsoft/rayfin-core</code> model and the exact
              CLI commands. Run them locally (<code>npx rayfin up</code>) to deploy the app backend to your Fabric
              workspace; data lands in OneLake under your tenant&apos;s identity + governance.
            </MessageBarBody>
          </MessageBar>

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
                    <Input value={e.name} aria-label={`Entity ${i + 1} name`} onChange={(_, d) => patchEntity(i, { name: d.value })} />
                    <Button size="small" appearance="subtle" icon={<Add20Regular />}
                      onClick={() => patchEntity(i, { fields: [...e.fields, { name: 'field', type: 'text' }] })}>Field</Button>
                    <Tooltip content="Remove entity" relationship="label">
                      <Button size="small" appearance="subtle" icon={<Delete20Regular />}
                        onClick={() => patch({ entities: spec.entities.filter((_, idx) => idx !== i) })} />
                    </Tooltip>
                  </div>
                  {e.fields.map((f, fi) => (
                    <div key={fi} className={s.fieldRow} style={{ paddingLeft: 16 }}>
                      <Input size="small" value={f.name} aria-label="Field name" onChange={(_, d) => patchEntity(i, { fields: e.fields.map((x, xi) => xi === fi ? { ...x, name: d.value } : x) })} />
                      <Dropdown size="small" value={f.type} selectedOptions={[f.type]}
                        onOptionSelect={(_, d) => patchEntity(i, { fields: e.fields.map((x, xi) => xi === fi ? { ...x, type: (d.optionValue as FieldType) } : x) })}>
                        {(['text', 'boolean', 'date', 'number'] as FieldType[]).map((t) => <Option key={t} value={t}>{t}</Option>)}
                      </Dropdown>
                      <Tooltip content="Remove field" relationship="label">
                        <Button size="small" appearance="subtle" icon={<Delete20Regular />}
                          onClick={() => patchEntity(i, { fields: e.fields.filter((_, xi) => xi !== fi) })} />
                      </Tooltip>
                    </div>
                  ))}
                </div>
              ))}
            </div>

            {/* Right — generated artifacts */}
            <div className={s.card}>
              <div className={s.head}><Subtitle2>rayfin/model.ts</Subtitle2><div style={{ marginLeft: 'auto' }}><CopyBtn text={model} /></div></div>
              <MonacoTextarea value={model} onChange={() => { /* read-only */ }} language="typescript" height={240} readOnly lineNumbers={false} ariaLabel="Generated Rayfin model" />
              <Caption1>Decorator API per @microsoft/rayfin-core — verify against the current SDK version (preview).</Caption1>

              <Divider />
              <div className={s.head}><Subtitle2>Deploy commands</Subtitle2><div style={{ marginLeft: 'auto' }}><CopyBtn text={commands} /></div></div>
              <pre className={s.code}>{commands}</pre>
            </div>
          </div>
        </>
      )}

      {mode === 'dataapp' && (
        <>
          <MessageBar intent="info">
            <MessageBarBody>
              <MessageBarTitle>Data app — bound to a semantic model.</MessageBarTitle>
              The <code>dataapp</code> template builds an analytical app that queries an existing semantic model with DAX
              (Execute DAX Queries API) instead of defining its own schema. Pick a model, prove the binding with a live
              DAX query, then Loom emits the scaffold command + a typed data-access client. Azure-native by default
              (Loom semantic models + Azure Analysis Services) — no Microsoft Fabric workspace required.
            </MessageBarBody>
          </MessageBar>

          {probe?.hint && (
            <MessageBar intent="warning">
              <MessageBarBody><MessageBarTitle>Live DAX probe is not configured.</MessageBarTitle>{probe.hint}</MessageBarBody>
            </MessageBar>
          )}
          {modelNotices.map((n, i) => (
            <MessageBar key={i} intent="warning"><MessageBarBody>{n}</MessageBarBody></MessageBar>
          ))}

          <div className={s.cols}>
            {/* Left — model picker + binding */}
            <div className={s.card}>
              <div className={s.head}>
                <Subtitle2>Bind a semantic model</Subtitle2>
                <div style={{ marginLeft: 'auto' }}>
                  <Button size="small" appearance="outline" onClick={loadModels} disabled={modelsLoading}>{modelsLoading ? 'Refreshing…' : 'Refresh'}</Button>
                </div>
              </div>
              {modelsLoading && <Spinner size="tiny" label="Listing semantic models…" />}
              {!modelsLoading && models.length === 0 && (
                <MessageBar intent="info"><MessageBarBody>
                  No semantic models found in this tenant yet. Create a Loom-native semantic model (no Fabric required),
                  provision an Azure Analysis Services model, or pass a Power BI workspace to bind a Fabric/Power BI dataset.
                </MessageBarBody></MessageBar>
              )}
              {!modelsLoading && models.length > 0 && (
                <Field label="Semantic model">
                  <Dropdown
                    placeholder="Select a model to bind"
                    value={binding ? `${binding.name}` : ''}
                    selectedOptions={binding ? [binding.modelId] : []}
                    onOptionSelect={(_, d) => {
                      const m = models.find((x) => x.id === d.optionValue);
                      if (m) selectModel(m);
                    }}>
                    {models.map((m) => (
                      <Option key={m.id} value={m.id} text={m.name}>
                        {m.name}{m.tableCount != null ? ` · ${m.tableCount} table(s)` : ''}{m.detail ? ` · ${m.detail}` : ''} ({m.source})
                      </Option>
                    ))}
                  </Dropdown>
                </Field>
              )}

              {binding && (
                <>
                  <div className={s.bindingMeta}>
                    {sourceBadge(binding.source)}
                    <Caption1 className={s.modelId}>{binding.modelId}</Caption1>
                  </div>
                  {binding.source === 'powerbi' && (
                    <Field label="Power BI workspace id" hint="Required to query a Fabric/Power BI dataset (opt-in).">
                      <Input value={binding.workspaceId || ''} placeholder="workspace (group) id"
                        onChange={(_, d) => setBinding((prev) => prev ? { ...prev, workspaceId: d.value } : prev)} />
                    </Field>
                  )}

                  <Divider />
                  <Field label="DAX query (live probe)" hint="Must start with EVALUATE. Proves the binding against the real backend.">
                    <Textarea value={dax} onChange={(_, d) => setDax(d.value)} rows={4}
                      style={{ fontFamily: 'Consolas, monospace', fontSize: 12 }} />
                  </Field>
                  <div className={s.row}>
                    <Button appearance="primary" icon={<Play20Regular />} onClick={runProbe} disabled={probing || !dax.trim()}>
                      {probing ? 'Running…' : 'Run DAX'}
                    </Button>
                    <Button appearance="outline" icon={<Add20Regular />} onClick={addSavedQuery} disabled={!dax.trim()}>Save as named query</Button>
                    <Button appearance="outline" icon={<Save20Regular />} onClick={saveBinding} disabled={bindingSaving}>
                      {bindingSaving ? 'Saving…' : 'Save binding'}
                    </Button>
                  </div>

                  {probeErr && <MessageBar intent="error"><MessageBarBody>{probeErr}</MessageBarBody></MessageBar>}
                  {probeRows && (
                    <>
                      <div className={s.resultMeta}>
                        <Caption1>
                          {probeRows.length === 0
                            ? 'Query returned 0 rows — binding works.'
                            : `${probeRows.length} row${probeRows.length === 1 ? '' : 's'}${probeRows.length > 50 ? ' (showing first 50)' : ''} · ${probeCols.length} column${probeCols.length === 1 ? '' : 's'}`}
                        </Caption1>
                        {probeRows.length > 0 && <Badge appearance="tint" color="success" className={s.spread}>Live result</Badge>}
                      </div>
                      {probeRows.length > 0 && (
                        <div className={s.resultWrap}>
                          <Table size="extra-small" aria-label="DAX probe result" className={s.stickyHead}>
                            <TableHeader>
                              <TableRow>{probeCols.map((c) => <TableHeaderCell key={c}>{c}</TableHeaderCell>)}</TableRow>
                            </TableHeader>
                            <TableBody>
                              {probeRows.slice(0, 50).map((r, ri) => (
                                <TableRow key={ri}>{probeCols.map((c) => <TableCell key={c}>{String((r as any)[c] ?? '')}</TableCell>)}</TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </div>
                      )}
                    </>
                  )}

                  {binding.queries.length > 0 && (
                    <>
                      <Divider />
                      <Body1><strong>Saved queries ({binding.queries.length})</strong></Body1>
                      {binding.queries.map((q, qi) => (
                        <div key={qi} className={s.entity}>
                          <div className={s.fieldRow}>
                            <Input size="small" value={q.name} aria-label={`Saved query ${qi + 1} name`}
                              onChange={(_, d) => setBinding((prev) => prev ? { ...prev, queries: prev.queries.map((x, xi) => xi === qi ? { ...x, name: d.value } : x) } : prev)} />
                            <Button size="small" appearance="subtle" onClick={() => setDax(q.dax)}>Load</Button>
                            <Tooltip content="Delete saved query" relationship="label">
                              <Button size="small" appearance="subtle" icon={<Delete20Regular />}
                                onClick={() => setBinding((prev) => prev ? { ...prev, queries: prev.queries.filter((_, xi) => xi !== qi) } : prev)} />
                            </Tooltip>
                          </div>
                          <Caption1 style={{ fontFamily: 'Consolas, monospace', whiteSpace: 'pre-wrap' }}>{q.dax}</Caption1>
                        </div>
                      ))}
                    </>
                  )}
                </>
              )}
            </div>

            {/* Right — generated data-app artifacts */}
            <div className={s.card}>
              <Field label="App name"><Input value={spec.appName} onChange={(_, d) => patch({ appName: d.value.replace(/\s+/g, '-').toLowerCase() })} /></Field>
              <div className={s.head}><Subtitle2>Scaffold commands</Subtitle2><div style={{ marginLeft: 'auto' }}><CopyBtn text={dataAppCommands} /></div></div>
              <pre className={s.code}>{dataAppCommands}</pre>

              <Divider />
              <div className={s.head}><Subtitle2>src/data/model.ts</Subtitle2><div style={{ marginLeft: 'auto' }}><CopyBtn text={dataAccess} /></div></div>
              <MonacoTextarea value={dataAccess} onChange={() => { /* read-only */ }} language="typescript" height={260} readOnly lineNumbers={false} ariaLabel="Generated data-access client" />
              <Caption1>Typed RayfinClient data-access over the bound model — verify against the current @microsoft/rayfin-core API (preview).</Caption1>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
