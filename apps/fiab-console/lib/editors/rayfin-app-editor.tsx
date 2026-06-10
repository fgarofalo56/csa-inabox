'use client';

/**
 * RayfinAppEditor — author a Rayfin app backend (Microsoft Fabric "apps"
 * workload, Build 2026 preview) and generate the real @microsoft/rayfin-core
 * SDK model + the exact CLI command sequence to deploy it to a Fabric workspace.
 *
 * Two build modes:
 *   • General (hand-authored) — define entities/fields/services/auth by hand.
 *     This is Rayfin's general case (an empty app you fill out).
 *   • Model-bound — BIND a Loom-native semantic model and Loom DERIVES the
 *     entire web app from it one-for-one: an @entity per model table, a Data API
 *     Builder config exposing each table as REST + GraphQL read endpoints, and a
 *     typed React data-grid page per table plus a measures dashboard. Acceptance:
 *     a full web app backed by a semantic model. The bound model is the
 *     no-Fabric-default source of truth (Cosmos-stored Loom-native model).
 *
 * Rayfin is an open-source SDK + CLI: you define entities/services/auth in
 * TypeScript and `npx rayfin up` deploys an app backend (database, auth, Data
 * APIs via DAB, storage, hosting) to Fabric, with data landing in OneLake under
 * your tenant's identity + governance. The CLI runs on the developer's machine,
 * so Loom authors the spec + emits the model and commands (the no-vaporware
 * honest path — like the deploy planner generating bicep). The spec persists on
 * the Cosmos item so it round-trips.
 *
 * Refs (preview): https://learn.microsoft.com/fabric/apps/overview ·
 *   https://learn.microsoft.com/azure/data-api-builder/ ·
 *   https://github.com/microsoft/rayfin · npm @microsoft/rayfin-cli
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  makeStyles, tokens, Button, Input, Field, Switch, Subtitle2, Body1, Caption1,
  Badge, MessageBar, MessageBarBody, MessageBarTitle, Dropdown, Option, Divider,
  Spinner, Tooltip, useId, useToastController, Toast, ToastTitle, Toaster,
  TabList, Tab,
} from '@fluentui/react-components';
import {
  Add20Regular, Delete20Regular, Copy20Regular, Checkmark20Regular, Save20Regular,
  Rocket20Regular, Open20Regular, Database20Regular, Link20Regular, Document20Regular,
} from '@fluentui/react-icons';
import { MonacoTextarea, type MonacoLanguage } from '@/lib/components/editor/monaco-textarea';
import {
  generateWebApp, generateBoundCommands, mapDataType,
  type BoundModel, type GeneratedFile,
} from './rayfin/model-bound-app';

type FieldType = 'text' | 'boolean' | 'date' | 'number';
interface EntityField { name: string; type: FieldType; }
interface RayfinEntity { name: string; fields: EntityField[]; }
type BuildMode = 'general' | 'model-bound';
interface RayfinSpec {
  appName: string;
  workspaceName: string;
  services: { database: boolean; storage: boolean };
  auth: 'fabric';
  staticHosting: boolean;
  entities: RayfinEntity[];
  /** Build mode: hand-authored (general) or derived from a bound model. */
  mode?: BuildMode;
  /** loom:<id> of the bound semantic model (model-bound mode). */
  boundModelId?: string;
  /** Friendly name of the bound model (cached for display + round-trip). */
  boundModelName?: string;
}

const DEFAULT_SPEC: RayfinSpec = {
  appName: 'my-app',
  workspaceName: '',
  services: { database: true, storage: false },
  auth: 'fabric',
  staticHosting: true,
  entities: [{ name: 'Todo', fields: [{ name: 'title', type: 'text' }, { name: 'done', type: 'boolean' }, { name: 'dueDate', type: 'date' }] }],
  mode: 'general',
  boundModelId: '',
  boundModelName: '',
};

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
  fileTabRow: { display: 'flex', flexWrap: 'wrap', gap: '4px', overflowX: 'auto' },
  tableChip: {
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: '6px', padding: '8px 10px',
    display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0,
  },
  chipGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '8px' },
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

interface ModelLite { id: string; name: string; tables: { name: string; columns: { name: string; dataType: string }[]; measures?: { name: string; expression?: string }[] }[] }

function fileLanguage(path: string): MonacoLanguage {
  if (path.endsWith('.json')) return 'json';
  if (path.endsWith('.tsx') || path.endsWith('.ts')) return 'typescript';
  return 'plaintext';
}

export function RayfinAppEditor({ id }: { item?: unknown; id: string }) {
  const s = useStyles();
  const toasterId = useId('rayfin-toaster');
  const { dispatchToast } = useToastController(toasterId);
  const [spec, setSpec] = useState<RayfinSpec>(DEFAULT_SPEC);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Model-binding state.
  const [models, setModels] = useState<ModelLite[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [boundModel, setBoundModel] = useState<BoundModel | null>(null);
  const [bindError, setBindError] = useState<string | null>(null);
  const [activeFile, setActiveFile] = useState<string>('');

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch(`/api/items/rayfin-app/${encodeURIComponent(id)}`);
        const j = await r.json().catch(() => ({}));
        const saved = (j?.state?.spec || j?.item?.state?.spec || j?.definition?.state?.spec) as RayfinSpec | undefined;
        if (alive && saved && Array.isArray(saved.entities)) setSpec({ ...DEFAULT_SPEC, ...saved });
      } catch { /* keep default */ }
      finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; };
  }, [id]);

  // Load the tenant's Loom-native semantic models for the binding picker.
  const loadModels = useCallback(async () => {
    setModelsLoading(true);
    try {
      const r = await fetch('/api/items/rayfin-app/models', { cache: 'no-store' });
      const j = await r.json().catch(() => ({}));
      if (j?.ok && Array.isArray(j.models)) setModels(j.models);
      else setModels([]);
    } catch { setModels([]); }
    finally { setModelsLoading(false); }
  }, []);

  // Fetch the bound model's full structure (tables + relationships).
  const fetchBoundModel = useCallback(async (modelId: string): Promise<BoundModel | null> => {
    setBindError(null);
    if (!modelId) { setBoundModel(null); return null; }
    try {
      const r = await fetch(`/api/items/rayfin-app/models?id=${encodeURIComponent(modelId)}`, { cache: 'no-store' });
      const j = await r.json().catch(() => ({}));
      if (j?.ok && j.model) { setBoundModel(j.model as BoundModel); return j.model as BoundModel; }
      setBoundModel(null);
      setBindError(j?.error || 'Could not load the bound semantic model.');
      return null;
    } catch (e: any) {
      setBoundModel(null);
      setBindError(e?.message || String(e));
      return null;
    }
  }, []);

  useEffect(() => { if (spec.mode === 'model-bound') void loadModels(); }, [spec.mode, loadModels]);
  useEffect(() => {
    if (spec.mode === 'model-bound' && spec.boundModelId) void fetchBoundModel(spec.boundModelId);
    else setBoundModel(null);
  }, [spec.mode, spec.boundModelId, fetchBoundModel]);

  // General-mode artifacts.
  const model = useMemo(() => generateModel(spec), [spec]);
  const commands = useMemo(() => generateCommands(spec), [spec]);

  // Model-bound artifacts — the full web app derived from the bound model.
  const webAppFiles = useMemo<GeneratedFile[]>(
    () => (boundModel ? generateWebApp(boundModel) : []),
    [boundModel],
  );
  const boundCommands = useMemo(
    () => generateBoundCommands(spec.appName, spec.workspaceName),
    [spec.appName, spec.workspaceName],
  );

  useEffect(() => {
    if (webAppFiles.length > 0 && !webAppFiles.some((f) => f.path === activeFile)) {
      setActiveFile(webAppFiles[0].path);
    }
  }, [webAppFiles, activeFile]);

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

  const patch = (p: Partial<RayfinSpec>) => setSpec((prev) => ({ ...prev, ...p }));
  const patchEntity = (i: number, e: Partial<RayfinEntity>) =>
    setSpec((prev) => ({ ...prev, entities: prev.entities.map((x, idx) => idx === i ? { ...x, ...e } : x) }));

  const mode: BuildMode = spec.mode || 'general';
  const activeContent = webAppFiles.find((f) => f.path === activeFile)?.content || '';

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

      <MessageBar intent="warning">
        <MessageBarBody>
          <MessageBarTitle>Rayfin is a preview SDK + CLI that runs on your dev machine.</MessageBarTitle>
          Define the backend below — Loom generates the real <code>@microsoft/rayfin-core</code> model, a Data API
          Builder config, and the exact CLI commands. Run them locally (<code>npx rayfin up</code>) to deploy the app
          backend to your Fabric workspace; data lands in OneLake under your tenant&apos;s identity + governance.
        </MessageBarBody>
      </MessageBar>

      <TabList selectedValue={mode} onTabSelect={(_, d) => patch({ mode: d.value as BuildMode })}>
        <Tab value="general" icon={<Document20Regular />}>General (author entities)</Tab>
        <Tab value="model-bound" icon={<Link20Regular />}>Model-bound (build from a semantic model)</Tab>
      </TabList>

      {mode === 'general' && (
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
                  <Input value={e.name} onChange={(_, d) => patchEntity(i, { name: d.value })} />
                  <Button size="small" appearance="subtle" icon={<Add20Regular />}
                    onClick={() => patchEntity(i, { fields: [...e.fields, { name: 'field', type: 'text' }] })}>Field</Button>
                  <Tooltip content="Remove entity" relationship="label">
                    <Button size="small" appearance="subtle" icon={<Delete20Regular />}
                      onClick={() => patch({ entities: spec.entities.filter((_, idx) => idx !== i) })} />
                  </Tooltip>
                </div>
                {e.fields.map((f, fi) => (
                  <div key={fi} className={s.fieldRow} style={{ paddingLeft: 16 }}>
                    <Input size="small" value={f.name} onChange={(_, d) => patchEntity(i, { fields: e.fields.map((x, xi) => xi === fi ? { ...x, name: d.value } : x) })} />
                    <Dropdown size="small" value={f.type} selectedOptions={[f.type]}
                      onOptionSelect={(_, d) => patchEntity(i, { fields: e.fields.map((x, xi) => xi === fi ? { ...x, type: (d.optionValue as FieldType) } : x) })}>
                      {(['text', 'boolean', 'date', 'number'] as FieldType[]).map((t) => <Option key={t} value={t}>{t}</Option>)}
                    </Dropdown>
                    <Button size="small" appearance="subtle" icon={<Delete20Regular />}
                      onClick={() => patchEntity(i, { fields: e.fields.filter((_, xi) => xi !== fi) })} />
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
      )}

      {mode === 'model-bound' && (
        <div className={s.cols}>
          {/* Left — bind a semantic model */}
          <div className={s.card}>
            <div className={s.head}>
              <Database20Regular />
              <Subtitle2>Bind a semantic model</Subtitle2>
              <div style={{ marginLeft: 'auto' }}>
                <Button size="small" appearance="outline" onClick={() => void loadModels()} disabled={modelsLoading}>
                  {modelsLoading ? 'Refreshing…' : 'Refresh'}
                </Button>
              </div>
            </div>
            <Body1>
              Loom derives the entire web app — entities, REST + GraphQL endpoints, and a page per table — from the
              model&apos;s tables, columns, and relationships. The model is your Loom-native semantic layer (no Fabric
              workspace required).
            </Body1>
            <div className={s.row}>
              <Field label="App name"><Input value={spec.appName} onChange={(_, d) => patch({ appName: d.value.replace(/\s+/g, '-').toLowerCase() })} /></Field>
              <Field label="Fabric workspace (optional)"><Input value={spec.workspaceName} placeholder="workspace name" onChange={(_, d) => patch({ workspaceName: d.value })} /></Field>
            </div>
            <Field label="Semantic model">
              <Dropdown
                placeholder={modelsLoading ? 'Loading models…' : (models.length ? 'Select a semantic model' : 'No Loom-native semantic models')}
                value={spec.boundModelName || ''}
                selectedOptions={spec.boundModelId ? [spec.boundModelId] : []}
                onOptionSelect={(_, d) => {
                  const picked = models.find((m) => m.id === d.optionValue);
                  patch({ boundModelId: d.optionValue || '', boundModelName: picked?.name || '' });
                }}
              >
                {models.map((m) => (
                  <Option key={m.id} value={m.id} text={m.name}>
                    {m.name} ({m.tables.length} {m.tables.length === 1 ? 'table' : 'tables'})
                  </Option>
                ))}
              </Dropdown>
            </Field>

            {!modelsLoading && models.length === 0 && (
              <MessageBar intent="info">
                <MessageBarBody>
                  <MessageBarTitle>No Loom-native semantic models in this tenant</MessageBarTitle>
                  Create a semantic model item (New item → Semantic model) and define its tables, columns, and
                  relationships. It will appear here to bind — no Fabric or Power BI workspace required.
                </MessageBarBody>
              </MessageBar>
            )}

            {bindError && (
              <MessageBar intent="error">
                <MessageBarBody>
                  <MessageBarTitle>Could not load the bound model</MessageBarTitle>
                  {bindError}
                </MessageBarBody>
              </MessageBar>
            )}

            {boundModel && (
              <>
                <Divider />
                <div className={s.head}>
                  <Body1><strong>Derived entities</strong></Body1>
                  <Badge appearance="tint" color="brand" size="small">{boundModel.tables.length}</Badge>
                </div>
                <div className={s.chipGrid}>
                  {boundModel.tables.map((t) => (
                    <div key={t.name} className={s.tableChip}>
                      <Body1><strong>{pascal(t.name)}</strong></Body1>
                      <Caption1>{t.columns.length} cols · {(t.measures || []).length} measures</Caption1>
                      <Caption1>
                        {t.columns.slice(0, 4).map((c) => `${c.name}:${mapDataType(c.dataType)}`).join(', ')}
                        {t.columns.length > 4 ? ' …' : ''}
                      </Caption1>
                    </div>
                  ))}
                </div>
                {boundModel.relationships && boundModel.relationships.length > 0 && (
                  <Caption1>
                    {boundModel.relationships.length} relationship{boundModel.relationships.length === 1 ? '' : 's'} →
                    typed @relation references in the model.
                  </Caption1>
                )}
              </>
            )}
          </div>

          {/* Right — generated web app */}
          <div className={s.card}>
            {!boundModel ? (
              <MessageBar intent="info">
                <MessageBarBody>
                  <MessageBarTitle>Bind a semantic model to generate the app</MessageBarTitle>
                  Pick a model on the left. Loom emits <code>rayfin/model.ts</code>, a Data API Builder config, and a
                  React page per table — a full web app backed by the model.
                </MessageBarBody>
              </MessageBar>
            ) : (
              <>
                <div className={s.head}>
                  <Subtitle2>Generated web app ({webAppFiles.length} files)</Subtitle2>
                  <div style={{ marginLeft: 'auto' }}><CopyBtn text={activeContent} /></div>
                </div>
                <div className={s.fileTabRow}>
                  <TabList size="small" selectedValue={activeFile} onTabSelect={(_, d) => setActiveFile(d.value as string)}>
                    {webAppFiles.map((f) => <Tab key={f.path} value={f.path}>{f.path}</Tab>)}
                  </TabList>
                </div>
                <MonacoTextarea
                  value={activeContent}
                  onChange={() => { /* read-only */ }}
                  language={fileLanguage(activeFile)}
                  height={320}
                  readOnly
                  lineNumbers={false}
                  ariaLabel={`Generated file ${activeFile}`}
                />

                <Divider />
                <div className={s.head}><Subtitle2>Deploy commands</Subtitle2><div style={{ marginLeft: 'auto' }}><CopyBtn text={boundCommands} /></div></div>
                <pre className={s.code}>{boundCommands}</pre>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
