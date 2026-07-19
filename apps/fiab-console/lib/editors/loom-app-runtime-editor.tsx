'use client';

/**
 * LoomAppRuntimeEditor (DBX-1) — the Databricks-Apps-class hosted-app editor.
 *
 * Full surface (Fluent v9 + Loom tokens), every control wired to a real BFF:
 *   • Overview  — live status/replicas/URL, per-app Start/Stop/Delete, disable.
 *   • Source    — runtime template dropdown (no freeform) + Monaco panes for the
 *                 entry file + dependency manifest, OR a public git source URL.
 *   • Deploy    — Build → Deploy flow; replica min/max; live build status.
 *   • Bindings  — structured env-var table (allowlisted names; KV secretRef or
 *                 plain value) to inject the operator's own LOOM_* endpoints.
 *   • Logs      — live tail from Log Analytics.
 *   • History   — build records.
 *
 * Honest infra gate: when the Container Apps env / ACR isn't wired, the full UI
 * still renders and a MessageBar names the exact env var + bicep module.
 * Kill switch: a tenant-disabled runtime shows a banner and the deploy path 403s.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Tab, TabList, Button, Dropdown, Option, Input, Label, Field, Spinner, Badge,
  Body1, Caption1, Subtitle2, Text,
  MessageBar, MessageBarBody, MessageBarTitle, MessageBarActions,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Rocket20Regular, Play20Regular, Stop20Regular, Delete20Regular, ArrowSync20Regular,
  Open20Regular, Add20Regular, BuildingFactory20Regular, DocumentText20Regular,
} from '@fluentui/react-icons';
import { ItemEditorChrome } from './item-editor-chrome';
import { NewItemCreateGate } from './new-item-gate';
import { TeachingBanner } from '@/lib/components/shared/teaching-toast';
import { CopilotBuilderPane } from '@/lib/components/shared/copilot-builder-pane';
import { ToolbarCrossLinks } from '@/lib/components/shared/item-tab-strip';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';
import { clientFetch } from '@/lib/client-fetch';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';

// Local props (item + id) — declared here rather than imported from ./registry
// so the editor has NO import edge back to the registry barrel. registry.ts
// lazy-loads this module via dynamic import(); pulling a type from registry
// would form a madge-detected cycle (guard:circular). Shape matches EditorProps.
interface EditorProps { item: FabricItemType; id: string }

const useStyles = makeStyles({
  pad: { padding: tokens.spacingVerticalL, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: 0 },
  tabBar: { padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalL} 0`, borderBottom: `1px solid ${tokens.colorNeutralStroke2}` },
  row: { display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'center', flexWrap: 'wrap' },
  field: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, minWidth: '220px' },
  card: { padding: tokens.spacingVerticalM, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge, backgroundColor: tokens.colorNeutralBackground1, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  statGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: tokens.spacingVerticalM },
  stat: { display: 'flex', flexDirection: 'column', gap: '2px', padding: tokens.spacingVerticalS, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium },
  statLabel: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  logs: { fontFamily: 'Consolas, "Cascadia Code", monospace', fontSize: tokens.fontSizeBase200, whiteSpace: 'pre-wrap', background: tokens.colorNeutralBackground3, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium, padding: tokens.spacingVerticalM, maxHeight: '420px', overflow: 'auto', margin: 0 },
  err: { overflowWrap: 'anywhere', wordBreak: 'break-word' },
  urlLink: { overflowWrap: 'anywhere', wordBreak: 'break-word' },
});

interface TemplateMeta {
  id: string; label: string; description: string; runtime: 'python' | 'node';
  defaultPort: number; entryFile: string; manifestFile: string;
  files: { path: string; content: string }[];
}
interface InfraStatus { configured: boolean; missing: string[]; hint?: string }
interface EnvVar { name: string; value?: string; secretRef?: string }
interface BuildRec { runId: string; image: string; imageName: string; status: string; source: string; at: string; by?: string }
interface RuntimeState {
  templateId?: string; gitSource?: string; port?: number; env?: EnvVar[];
  userFiles?: Record<string, string>;
  containerAppName?: string; image?: string; url?: string; authConfigured?: boolean;
  disabled?: boolean; builds?: BuildRec[]; lastDeployAt?: string;
}
interface LiveApp { name: string; provisioningState: string; runningStatus?: string; fqdn?: string; url?: string; image?: string; minReplicas?: number; maxReplicas?: number; authConfigured?: boolean }

type SourceMode = 'template' | 'git';

function monacoLangFor(runtime: 'python' | 'node', manifest: boolean): 'python' | 'javascript' | 'json' {
  if (manifest) return runtime === 'node' ? 'json' : 'python'; // requirements.txt → plain; python highlight is close enough
  return runtime === 'node' ? 'javascript' : 'python';
}

export function LoomAppRuntimeEditor({ item, id }: EditorProps) {
  const s = useStyles();
  const isNew = id === 'new';

  const [tab, setTab] = useState('overview');
  const [templates, setTemplates] = useState<TemplateMeta[]>([]);
  const [infra, setInfra] = useState<InfraStatus | null>(null);
  const [rt, setRt] = useState<RuntimeState>({});
  const [live, setLive] = useState<LiveApp | null>(null);
  const [loading, setLoading] = useState(!isNew);
  const [banner, setBanner] = useState<{ intent: 'success' | 'error' | 'warning' | 'info'; text: string } | null>(null);

  // Source-tab working state
  const [sourceMode, setSourceMode] = useState<SourceMode>('template');
  const [templateId, setTemplateId] = useState('streamlit');
  const [gitSource, setGitSource] = useState('');
  // Private-git token (APP-W4 S3) — status only; the value never round-trips.
  const [gitAuth, setGitAuth] = useState<{ configured: boolean; provider?: string; setAt?: string } | null>(null);
  const [gitPat, setGitPat] = useState('');
  const [gitPatBusy, setGitPatBusy] = useState(false);
  const loadGitAuth = useCallback(async () => {
    try {
      const r = await clientFetch(`/api/items/loom-app-runtime/${encodeURIComponent(id)}/git-credential`);
      const j = await r.json();
      if (j.ok !== false) setGitAuth(j);
    } catch { /* status stays unknown */ }
  }, [id]);
  const saveGitPat = useCallback(async () => {
    setGitPatBusy(true); setBanner(null);
    try {
      const r = await clientFetch(`/api/items/loom-app-runtime/${encodeURIComponent(id)}/git-credential`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pat: gitPat }),
      });
      const j = await r.json();
      if (j.ok === false) setBanner({ intent: 'error', text: j.error || `HTTP ${r.status}` });
      else { setGitPat(''); setBanner({ intent: 'success', text: 'Token stored in Key Vault — the next git build authenticates with it.' }); await loadGitAuth(); }
    } catch (e: any) { setBanner({ intent: 'error', text: e?.message || String(e) }); }
    finally { setGitPatBusy(false); }
  }, [id, gitPat, loadGitAuth]);
  const clearGitPat = useCallback(async () => {
    setGitPatBusy(true);
    try {
      await clientFetch(`/api/items/loom-app-runtime/${encodeURIComponent(id)}/git-credential`, { method: 'DELETE' });
      await loadGitAuth();
    } catch { /* status refresh will show reality */ }
    finally { setGitPatBusy(false); }
  }, [id, loadGitAuth]);
  const [entryContent, setEntryContent] = useState('');
  const [manifestContent, setManifestContent] = useState('');
  const [port, setPort] = useState<number>(8501);

  // Deploy state
  const [minReplicas, setMinReplicas] = useState(0);
  const [maxReplicas, setMaxReplicas] = useState(3);
  const [busy, setBusy] = useState<string | null>(null);
  const [buildStatus, setBuildStatus] = useState<string | null>(null);
  const buildPoll = useRef<ReturnType<typeof setInterval> | null>(null);

  // Bindings
  const [env, setEnv] = useState<EnvVar[]>([]);

  // Logs
  const [logs, setLogs] = useState<string>('');
  const [logsBusy, setLogsBusy] = useState(false);

  // Monitoring (APP-W5 S4) + publish-as-API (S3)
  const [mon, setMon] = useState<any>(null);
  const [monBusy, setMonBusy] = useState(false);
  const [pubApiBusy, setPubApiBusy] = useState(false);
  const loadMonitoring = useCallback(async () => {
    setMonBusy(true);
    try {
      const r = await clientFetch(`/api/items/loom-app-runtime/${encodeURIComponent(id)}/monitoring`);
      const j = await r.json();
      setMon(j.ok === false ? { error: j.error } : j);
    } catch (e: any) { setMon({ error: e?.message || String(e) }); }
    finally { setMonBusy(false); }
  }, [id]);
  const publishAsApi = useCallback(async () => {
    setPubApiBusy(true); setBanner(null);
    try {
      const r = await clientFetch(`/api/items/loom-app-runtime/${encodeURIComponent(id)}/publish-api`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
      });
      const j = await r.json();
      if (j.ok === false) setBanner({ intent: j.gate ? 'warning' : 'error', text: `${j.error}${j.gate ? ` — ${j.gate.remediation}` : ''}` });
      else setBanner({ intent: 'success', text: `Published as API '${j.api?.path}' — find it in Marketplace → APIs.` });
    } catch (e: any) { setBanner({ intent: 'error', text: e?.message || String(e) }); }
    finally { setPubApiBusy(false); }
  }, [id]);

  // ---- Resources (APPS-W2 — Databricks-Apps "App resources" parity) -------
  interface AppResourceRec {
    id: string; kind: string; label: string; envNames: string[];
    grant: { role: string; scope: string; status: string; detail: string; grantScript?: string };
    addedAt: string; addedBy?: string;
  }
  interface ResKindInfo { kind: string; label: string; description: string; available: boolean; missing?: string }
  const [resources, setResources] = useState<AppResourceRec[]>([]);
  const [resKinds, setResKinds] = useState<ResKindInfo[]>([]);
  const [attachKind, setAttachKind] = useState<string>('');
  const [resBusy, setResBusy] = useState(false);
  // Per-item picker (slice 2): workspace lakehouse items for kind='lakehouse'.
  const [appWorkspaceId, setAppWorkspaceId] = useState<string>('');
  const [lakeItems, setLakeItems] = useState<Array<{ id: string; displayName: string }>>([]);
  const [attachItemId, setAttachItemId] = useState<string>('');

  const currentTemplate = useMemo(() => templates.find((t) => t.id === templateId), [templates, templateId]);

  // ---- initial load -------------------------------------------------------
  const loadConfig = useCallback(async () => {
    try {
      const r = await clientFetch('/api/items/loom-app-runtime/config');
      const j = await r.json();
      if (j.ok) { setTemplates(j.templates || []); setInfra(j.infra || null); }
    } catch { /* infra gate rendered via infra state */ }
  }, []);

  const loadItem = useCallback(async () => {
    if (isNew) return;
    setLoading(true);
    try {
      const r = await clientFetch(`/api/items/loom-app-runtime/${encodeURIComponent(id)}`);
      const j = await r.json();
      if (j.ok) {
        const state: RuntimeState = j.runtime || {};
        setRt(state);
        setLive(j.live || null);
        if (j.infra) setInfra(j.infra);
        setEnv(state.env || []);
        if (state.gitSource) { setSourceMode('git'); setGitSource(state.gitSource); }
        else if (state.templateId) { setSourceMode('template'); setTemplateId(state.templateId); }
        if (typeof state.port === 'number') setPort(state.port);
      } else {
        setBanner({ intent: 'error', text: j.error || `HTTP ${r.status}` });
      }
    } catch (e: any) { setBanner({ intent: 'error', text: e?.message || String(e) }); }
    finally { setLoading(false); }
  }, [id, isNew]);

  const loadResources = useCallback(async () => {
    if (isNew) return;
    try {
      const r = await clientFetch(`/api/items/loom-app-runtime/${encodeURIComponent(id)}/resources`);
      const j = await r.json();
      if (j.ok) { setResources(j.resources || []); setResKinds(j.kinds || []); setAppWorkspaceId(j.workspaceId || ''); }
    } catch { /* table renders empty; attach errors surface via banner */ }
  }, [id, isNew]);

  // Workspace items for the per-item picker — kinds that support attaching a
  // SPECIFIC item instead of the deployment default.
  const ITEM_PICKER_TYPES: Record<string, string> = { lakehouse: 'lakehouse', adx: 'kql-database', 'weave-ontology': 'ontology' };
  useEffect(() => {
    const itemType = ITEM_PICKER_TYPES[attachKind];
    if (!itemType || !appWorkspaceId) { setLakeItems([]); setAttachItemId(''); return; }
    let cancelled = false;
    (async () => {
      try {
        const r = await clientFetch(`/api/items?type=${encodeURIComponent(itemType)}&limit=100`);
        const j = await r.json();
        if (!cancelled && j.ok) {
          setLakeItems((j.items || [])
            .filter((it: any) => it.workspaceId === appWorkspaceId)
            .map((it: any) => ({ id: it.id, displayName: it.displayName || it.id })));
        }
      } catch { /* picker renders with the default option only */ }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attachKind, appWorkspaceId]);

  const attachResource = useCallback(async () => {
    if (!attachKind) return;
    setResBusy(true); setBanner(null);
    try {
      const picked = lakeItems.find((it) => it.id === attachItemId);
      const r = await clientFetch(`/api/items/loom-app-runtime/${encodeURIComponent(id)}/resources`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: attachKind,
          ...(picked ? { itemId: picked.id, itemName: picked.displayName } : {}),
        }),
      });
      const j = await r.json();
      if (j.ok) {
        setResources(j.resources || []);
        setAttachKind('');
        setAttachItemId('');
        const g = j.resource?.grant;
        setBanner(g?.status === 'pending-grants'
          ? { intent: 'warning', text: `${j.resource.label} attached — one admin grant is still needed (see the script on the row). Env applies on the next Deploy.` }
          : { intent: 'success', text: `${j.resource?.label || attachKind} attached — grant ${g?.status}. Env applies on the next Deploy.` });
        await loadItem(); // bindings gained the injected env rows
      } else {
        setBanner({ intent: 'error', text: j.error || `HTTP ${r.status}` });
      }
    } catch (e: any) { setBanner({ intent: 'error', text: e?.message || String(e) }); }
    finally { setResBusy(false); }
  }, [attachKind, attachItemId, lakeItems, id, loadItem]);

  const detachResource = useCallback(async (rid: string) => {
    setResBusy(true); setBanner(null);
    try {
      const r = await clientFetch(`/api/items/loom-app-runtime/${encodeURIComponent(id)}/resources?rid=${encodeURIComponent(rid)}`, { method: 'DELETE' });
      const j = await r.json();
      if (j.ok) { setResources(j.resources || []); await loadItem(); }
      else setBanner({ intent: 'error', text: j.error || `HTTP ${r.status}` });
    } catch (e: any) { setBanner({ intent: 'error', text: e?.message || String(e) }); }
    finally { setResBusy(false); }
  }, [id, loadItem]);

  useEffect(() => { loadConfig(); }, [loadConfig]);
  useEffect(() => { loadItem(); }, [loadItem]);
  useEffect(() => { loadResources(); }, [loadResources]);
  useEffect(() => { if (!isNew) void loadGitAuth(); }, [loadGitAuth, isNew]);
  useEffect(() => () => { if (buildPoll.current) clearInterval(buildPoll.current); }, []);

  // Seed Monaco panes from the template starter (or persisted user edits) once
  // templates + item state are available.
  useEffect(() => {
    if (sourceMode !== 'template' || !currentTemplate) return;
    const userFiles = rt.userFiles || {};
    const entry = userFiles[currentTemplate.entryFile]
      ?? currentTemplate.files.find((f) => f.path === currentTemplate.entryFile)?.content ?? '';
    const manifest = userFiles[currentTemplate.manifestFile]
      ?? currentTemplate.files.find((f) => f.path === currentTemplate.manifestFile)?.content ?? '';
    setEntryContent(entry);
    setManifestContent(manifest);
    if (!rt.port) setPort(currentTemplate.defaultPort);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateId, currentTemplate, rt.userFiles]);

  // ---- actions ------------------------------------------------------------
  const doBuild = useCallback(async () => {
    setBusy('build'); setBanner(null); setBuildStatus('Queued');
    try {
      const userFiles = currentTemplate
        ? { [currentTemplate.entryFile]: entryContent, [currentTemplate.manifestFile]: manifestContent }
        : undefined;
      const body = sourceMode === 'git'
        ? { gitSource, port }
        : { templateId, userFiles, port };
      const r = await clientFetch(`/api/items/loom-app-runtime/${encodeURIComponent(id)}/build`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!j.ok) { setBanner({ intent: 'error', text: j.error || `HTTP ${r.status}` }); setBusy(null); setBuildStatus(null); return; }
      if (j.runtime) setRt(j.runtime);
      const runId = j.build?.runId as string;
      setBanner({ intent: 'info', text: `Build ${runId} queued (${j.build?.source}). Watching status…` });
      // poll build status
      if (buildPoll.current) clearInterval(buildPoll.current);
      buildPoll.current = setInterval(async () => {
        try {
          const sr = await clientFetch(`/api/items/loom-app-runtime/${encodeURIComponent(id)}/build?runId=${encodeURIComponent(runId)}`);
          const sj = await sr.json();
          if (sj.ok) {
            setBuildStatus(sj.status?.status || 'Running');
            if (sj.status?.finished) {
              if (buildPoll.current) { clearInterval(buildPoll.current); buildPoll.current = null; }
              setBusy(null);
              if (sj.status.succeeded) setBanner({ intent: 'success', text: `Build succeeded. Image ${j.build?.imageName} pushed — Deploy it below.` });
              else setBanner({ intent: 'error', text: `Build ${sj.status.status}. Check the source + Dockerfile.` });
              loadItem();
            }
          }
        } catch { /* keep polling */ }
      }, 5000);
    } catch (e: any) { setBanner({ intent: 'error', text: e?.message || String(e) }); setBusy(null); setBuildStatus(null); }
  }, [currentTemplate, entryContent, manifestContent, sourceMode, gitSource, templateId, port, id, loadItem]);

  const latestSucceededImage = useMemo(() => {
    const b = (rt.builds || []).find((x) => x.status === 'Succeeded');
    return b?.image || rt.image || null;
  }, [rt.builds, rt.image]);

  const doDeploy = useCallback(async () => {
    const image = latestSucceededImage;
    if (!image) { setBanner({ intent: 'warning', text: 'Build a succeeded image first, then Deploy.' }); return; }
    setBusy('deploy'); setBanner(null);
    try {
      const r = await clientFetch(`/api/items/loom-app-runtime/${encodeURIComponent(id)}/deploy`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ image, port, env, minReplicas, maxReplicas }),
      });
      const j = await r.json();
      if (!j.ok) { setBanner({ intent: 'error', text: j.error || `HTTP ${r.status}` }); setBusy(null); return; }
      if (j.runtime) setRt(j.runtime);
      const url = j.deployed?.url;
      setBanner({
        intent: 'success',
        text: url
          ? `Deployed. Live at ${url}${j.deployed?.authConfigured
              ? ' (Entra-gated).'
              : ` — Entra gate NOT applied: ${j.deployed?.authDetail || 'set LOOM_MSAL_CLIENT_ID on the Console.'} Redeploy to retry.`}`
          : 'Deployed.',
      });
      loadItem();
    } catch (e: any) { setBanner({ intent: 'error', text: e?.message || String(e) }); }
    finally { setBusy(null); }
  }, [latestSucceededImage, id, port, env, minReplicas, maxReplicas, loadItem]);

  const lifecycle = useCallback(async (action: 'start' | 'stop' | 'restart') => {
    setBusy(action); setBanner(null);
    try {
      const r = await clientFetch(`/api/items/loom-app-runtime/${encodeURIComponent(id)}/lifecycle`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }),
      });
      const j = await r.json();
      if (!j.ok) { setBanner({ intent: 'error', text: j.error || `HTTP ${r.status}` }); }
      else { setBanner({ intent: 'success', text: `${action === 'start' ? 'Start' : action === 'restart' ? 'Restart' : 'Stop'} requested (${j.result?.status || j.result?.revision || 'ok'}).` }); if (j.runtime) setRt(j.runtime); loadItem(); }
    } catch (e: any) { setBanner({ intent: 'error', text: e?.message || String(e) }); }
    finally { setBusy(null); }
  }, [id, loadItem]);

  const doDelete = useCallback(async () => {
    setBusy('delete'); setBanner(null);
    try {
      const r = await clientFetch(`/api/items/loom-app-runtime/${encodeURIComponent(id)}`, { method: 'DELETE' });
      const j = await r.json();
      if (!j.ok) setBanner({ intent: 'error', text: j.error || `HTTP ${r.status}` });
      else { setBanner({ intent: 'success', text: 'App deleted.' }); if (j.runtime) setRt(j.runtime); setLive(null); }
    } catch (e: any) { setBanner({ intent: 'error', text: e?.message || String(e) }); }
    finally { setBusy(null); }
  }, [id]);

  const refreshLogs = useCallback(async () => {
    setLogsBusy(true);
    try {
      const r = await clientFetch(`/api/items/loom-app-runtime/${encodeURIComponent(id)}/logs?tail=200`);
      const j = await r.json();
      if (j.ok) setLogs((j.lines || []).map((l: any) => `${l.time}  ${l.message}`).join('\n') || (j.note || 'No log lines.'));
      else setLogs(j.error || `HTTP ${r.status}`);
    } catch (e: any) { setLogs(e?.message || String(e)); }
    finally { setLogsBusy(false); }
  }, [id]);

  useEffect(() => { if (tab === 'logs' && !isNew) refreshLogs(); }, [tab, isNew, refreshLogs]);
  useEffect(() => { if (tab === 'monitoring' && !isNew && !mon) void loadMonitoring(); }, [tab, isNew, mon, loadMonitoring]);

  // ---- env-binding table helpers -----------------------------------------
  const addEnv = () => setEnv((e) => [...e, { name: '', value: '' }]);
  const updateEnv = (i: number, patch: Partial<EnvVar>) => setEnv((e) => e.map((row, idx) => idx === i ? { ...row, ...patch } : row));
  const removeEnv = (i: number) => setEnv((e) => e.filter((_, idx) => idx !== i));

  // ---- ribbon -------------------------------------------------------------
  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Build & deploy', actions: [
        { label: busy === 'build' ? 'Building…' : 'Build', icon: <BuildingFactory20Regular />, onClick: busy ? undefined : doBuild, disabled: !!busy },
        { label: busy === 'deploy' ? 'Deploying…' : 'Deploy', icon: <Rocket20Regular />, onClick: busy ? undefined : doDeploy, disabled: !!busy || !latestSucceededImage },
      ]},
      { label: 'Lifecycle', actions: [
        { label: 'Start', icon: <Play20Regular />, onClick: busy ? undefined : () => lifecycle('start'), disabled: !!busy || !rt.containerAppName },
        { label: 'Restart', icon: <ArrowSync20Regular />, onClick: busy ? undefined : () => lifecycle('restart'), disabled: !!busy || !rt.containerAppName },
        { label: 'Stop', icon: <Stop20Regular />, onClick: busy ? undefined : () => lifecycle('stop'), disabled: !!busy || !rt.containerAppName },
        { label: 'Delete', icon: <Delete20Regular />, onClick: busy ? undefined : doDelete, disabled: !!busy || !rt.containerAppName },
      ]},
      { label: 'View', actions: [
        { label: 'Refresh', icon: <ArrowSync20Regular />, onClick: loadItem, disabled: !!busy },
      ]},
    ]},
  ], [busy, doBuild, doDeploy, lifecycle, doDelete, loadItem, latestSucceededImage, rt.containerAppName]);

  if (isNew) {
    return <NewItemCreateGate item={item} createLabel="Create Loom app"
      intro="Create a hosted app, then pick a runtime template (Streamlit, Dash, Gradio, Flask, Node/Express, or an Agent/FastAPI harness) or a public git repo. Loom builds the image in the Loom ACR and deploys it as an autoscale-to-zero, Entra-gated Azure Container App with a live URL — no Databricks or Fabric. An Agent app can be composed back into a Data Agent as a tool source." />;
  }

  const infraGate = infra && !infra.configured ? (
    <MessageBar intent="warning">
      <MessageBarBody>
        <MessageBarTitle>Loom App Runtime infrastructure not wired</MessageBarTitle>
        <span className={s.err}>{infra.hint || `Missing: ${infra.missing.join(', ')}`}</span>
        <br /><Caption1>Set these on loom-console and grant the Console UAMI Container Apps Contributor + AcrPush. Deployed by platform/fiab/bicep/modules/admin-plane/main.bicep (deployAppsEnabled). The full editor still works — Build/Deploy will surface the exact ARM error until wired.</Caption1>
      </MessageBarBody>
    </MessageBar>
  ) : null;

  const disabledGate = rt.disabled ? (
    <MessageBar intent="info">
      <MessageBarBody><MessageBarTitle>App stopped / disabled</MessageBarTitle>This app is stopped. Start it from the Lifecycle group, or an admin may have disabled the runtime tenant-wide (Admin → Tenant settings → Loom App Runtime).</MessageBarBody>
    </MessageBar>
  ) : null;

  const main = (
    <div style={{ minWidth: 0 }}>
      <div className={s.pad}>
        <TeachingBanner
          surfaceKey="loom-app-runtime-intro"
          title="Host a data app on Azure Container Apps"
          message="Pick a runtime template (Streamlit, Dash, Gradio, Flask, Node/Express, or an Agent/FastAPI harness) or a public git repo. Loom builds the image in the Loom ACR and deploys it as an autoscale-to-zero, Entra-gated Azure Container App with a live URL — no Databricks or Fabric. Wire bindings so the app can call back into your own Loom data plane."
          learnMoreHref="https://learn.microsoft.com/azure/container-apps/overview"
        />
        <div className={s.row}>
          <ToolbarCrossLinks
            ariaLabel="Related app surfaces"
            maxInline={4}
            links={[
              { key: 'loom-app', label: 'Loom App', href: '/items/loom-app/new' },
              { key: 'data-agent', label: 'Data Agent', href: '/items/data-agent/new' },
              { key: 'user-data-function', label: 'User Data Function', href: '/items/user-data-function/new' },
              { key: 'release-environment', label: 'Release environment', href: '/items/release-environment/new' },
            ]}
          />
        </div>
      </div>
      <div className={s.tabBar}>
        <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as string)}>
          <Tab value="overview">Overview</Tab>
          <Tab value="source">Source</Tab>
          <Tab value="copilot">Copilot</Tab>
          <Tab value="deploy">Deploy</Tab>
          <Tab value="resources">Resources</Tab>
          <Tab value="bindings">Bindings</Tab>
          <Tab value="logs">Logs</Tab>
          <Tab value="monitoring">Monitoring</Tab>
          <Tab value="history">History</Tab>
        </TabList>
      </div>

      <div className={s.pad}>
        {banner && (
          <MessageBar intent={banner.intent}>
            <MessageBarBody><span className={s.err}>{banner.text}</span></MessageBarBody>
          </MessageBar>
        )}
        {infraGate}
        {disabledGate}
        {loading && <Spinner size="small" label="Loading app…" labelPosition="after" />}

        {/* ---- OVERVIEW ---- */}
        {tab === 'overview' && !loading && (
          <>
            <Subtitle2>Overview</Subtitle2>
            {live?.url || rt.url ? (
              <MessageBar intent="success">
                <MessageBarBody>
                  <MessageBarTitle>Live URL</MessageBarTitle>
                  <a className={s.urlLink} href={live?.url || rt.url} target="_blank" rel="noreferrer">{live?.url || rt.url}</a>
                  {rt.authConfigured || live?.authConfigured ? <Caption1 style={{ display: 'block' }}>Entra-gated — only your Loom tenant can sign in.</Caption1> : <Caption1 style={{ display: 'block' }}>Set LOOM_MSAL_CLIENT_ID to gate this URL with Entra sign-in.</Caption1>}
                </MessageBarBody>
                <MessageBarActions>
                  <Button size="small" icon={<Open20Regular />} onClick={() => window.open(live?.url || rt.url!, '_blank', 'noreferrer')}>Open</Button>
                  <Button size="small" icon={<Rocket20Regular />} disabled={pubApiBusy} onClick={publishAsApi}>{pubApiBusy ? 'Publishing…' : 'Publish as API'}</Button>
                </MessageBarActions>
              </MessageBar>
            ) : (
              <MessageBar intent="info"><MessageBarBody>Not deployed yet. Configure the Source, Build, then Deploy.</MessageBarBody></MessageBar>
            )}
            <div className={s.statGrid}>
              <div className={s.stat}><span className={s.statLabel}>Provisioning</span><Text weight="semibold">{live?.provisioningState || '—'}</Text></div>
              <div className={s.stat}><span className={s.statLabel}>Running status</span><Text weight="semibold">{live?.runningStatus || (rt.disabled ? 'Stopped' : '—')}</Text></div>
              <div className={s.stat}><span className={s.statLabel}>Replicas (min/max)</span><Text weight="semibold">{live ? `${live.minReplicas ?? 0} / ${live.maxReplicas ?? '—'}` : '—'}</Text></div>
              <div className={s.stat}><span className={s.statLabel}>Container app</span><Text weight="semibold" style={{ overflowWrap: 'anywhere' }}>{rt.containerAppName || '—'}</Text></div>
              <div className={s.stat}><span className={s.statLabel}>Image</span><Text weight="semibold" style={{ overflowWrap: 'anywhere' }}>{(live?.image || rt.image || '—').split('/').pop()}</Text></div>
              <div className={s.stat}><span className={s.statLabel}>Autoscale-to-zero</span><Badge appearance="tint" color={(live?.minReplicas ?? 0) === 0 ? 'success' : 'warning'}>{(live?.minReplicas ?? 0) === 0 ? 'Yes (~$0 at rest)' : `min ${live?.minReplicas}`}</Badge></div>
            </div>
            <div className={s.row}>
              <Button appearance="primary" icon={<Play20Regular />} onClick={() => lifecycle('start')} disabled={!!busy || !rt.containerAppName}>Start</Button>
              <Button icon={<Stop20Regular />} onClick={() => lifecycle('stop')} disabled={!!busy || !rt.containerAppName}>Stop (disable)</Button>
              <Button icon={<Delete20Regular />} onClick={doDelete} disabled={!!busy || !rt.containerAppName}>Delete</Button>
            </div>
          </>
        )}

        {/* ---- SOURCE ---- */}
        {tab === 'source' && !loading && (
          <>
            <Subtitle2>Source</Subtitle2>
            <div className={s.row}>
              <Field label="Source type">
                <Dropdown value={sourceMode === 'git' ? 'Public git repository' : 'Runtime template'}
                  selectedOptions={[sourceMode]}
                  onOptionSelect={(_, d) => setSourceMode((d.optionValue as SourceMode) || 'template')}>
                  <Option value="template">Runtime template</Option>
                  <Option value="git">Public git repository</Option>
                </Dropdown>
              </Field>
              {sourceMode === 'template' && (
                <Field label="Runtime template">
                  <Dropdown value={currentTemplate?.label || templateId}
                    selectedOptions={[templateId]}
                    onOptionSelect={(_, d) => setTemplateId(d.optionValue || 'streamlit')}>
                    {templates.map((t) => <Option key={t.id} value={t.id}>{t.label}</Option>)}
                  </Dropdown>
                </Field>
              )}
              <Field label="Port">
                <Input type="number" value={String(port)} onChange={(_, d) => setPort(Number(d.value) || 8000)} style={{ maxWidth: '120px' }} />
              </Field>
            </div>

            {sourceMode === 'git' ? (
              <>
                <Field label="Git repository URL" hint="https repo on github.com / dev.azure.com / gitlab.com / bitbucket.org. Optionally #branch:subdir. Must contain a Dockerfile. Private repos: store an access token below.">
                  <Input value={gitSource} onChange={(_, d) => setGitSource(d.value)} placeholder="https://github.com/org/repo#main:app" />
                </Field>
                <Field label="Private-repo access token" hint={gitAuth?.configured
                  ? `Token stored in Key Vault (${gitAuth.provider}, ${gitAuth.setAt ? new Date(gitAuth.setAt).toLocaleString() : ''}) — builds authenticate with it. Save a new value to rotate.`
                  : 'Optional — for a private repository, paste a PAT (repo read scope). It is stored in Key Vault, never on the item, and used only at build time.'}>
                  <div className={s.row}>
                    <Input type="password" value={gitPat} onChange={(_, d) => setGitPat(d.value)} placeholder={gitAuth?.configured ? '••••••••  (stored)' : 'ghp_… / PAT'} style={{ minWidth: '280px' }} />
                    <Button size="small" disabled={!gitPat.trim() || gitPatBusy} onClick={() => { void saveGitPat(); }}>{gitPatBusy ? 'Saving…' : 'Save token'}</Button>
                    {gitAuth?.configured && (
                      <Button size="small" appearance="subtle" disabled={gitPatBusy} onClick={() => { void clearGitPat(); }}>Remove</Button>
                    )}
                  </div>
                </Field>
              </>
            ) : currentTemplate ? (
              <>
                <Caption1>{currentTemplate.description} — {currentTemplate.runtime === 'python' ? 'Python' : 'Node.js'}</Caption1>
                <div className={s.card}>
                  <Label weight="semibold"><DocumentText20Regular style={{ verticalAlign: 'middle' }} /> {currentTemplate.entryFile}</Label>
                  <MonacoTextarea value={entryContent} onChange={setEntryContent}
                    language={monacoLangFor(currentTemplate.runtime, false)} height={300} />
                </div>
                <div className={s.card}>
                  <Label weight="semibold"><DocumentText20Regular style={{ verticalAlign: 'middle' }} /> {currentTemplate.manifestFile}</Label>
                  <MonacoTextarea value={manifestContent} onChange={setManifestContent}
                    language={monacoLangFor(currentTemplate.runtime, true)} height={140} />
                </div>
              </>
            ) : <Spinner size="tiny" label="Loading templates…" />}

            <div className={s.row}>
              <Button appearance="primary" icon={<BuildingFactory20Regular />} onClick={doBuild} disabled={!!busy || (sourceMode === 'git' && !gitSource.trim())}>
                {busy === 'build' ? 'Building…' : 'Build image'}
              </Button>
              {buildStatus && <Badge appearance="tint" color={buildStatus === 'Succeeded' ? 'success' : buildStatus === 'Failed' || buildStatus === 'Error' ? 'danger' : 'informative'}>Build: {buildStatus}</Badge>}
            </div>
          </>
        )}

        {/* ---- DEPLOY ---- */}
        {tab === 'deploy' && !loading && (
          <>
            <Subtitle2>Deploy</Subtitle2>
            <Body1>Deploy the latest succeeded build as an autoscale-to-zero Azure Container App. No spend or approval gate — a resting app costs ~$0 (min replicas 0).</Body1>
            <div className={s.row}>
              <Field label="Min replicas" hint="0 = scale-to-zero (recommended)"><Input type="number" value={String(minReplicas)} onChange={(_, d) => setMinReplicas(Math.max(0, Number(d.value) || 0))} style={{ maxWidth: '120px' }} /></Field>
              <Field label="Max replicas"><Input type="number" value={String(maxReplicas)} onChange={(_, d) => setMaxReplicas(Math.max(1, Number(d.value) || 1))} style={{ maxWidth: '120px' }} /></Field>
            </div>
            <div className={s.card}>
              <Caption1>Image to deploy: <strong style={{ overflowWrap: 'anywhere' }}>{latestSucceededImage || '— build first —'}</strong></Caption1>
            </div>
            <div className={s.row}>
              <Button appearance="primary" icon={<Rocket20Regular />} onClick={doDeploy} disabled={!!busy || !latestSucceededImage}>
                {busy === 'deploy' ? 'Deploying…' : rt.containerAppName ? 'Redeploy' : 'Deploy'}
              </Button>
            </div>
          </>
        )}

        {/* ---- BINDINGS ---- */}
        {/* ---- RESOURCES (APPS-W2) ---- */}
        {tab === 'copilot' && !loading && (
          <CopilotBuilderPane
            endpoint={`/api/items/loom-app-runtime/${encodeURIComponent(id)}/assist`}
            title="Copilot — describe your app"
            intro="Describe the data app you want and Copilot scaffolds real source files (template choice, entry file, dependencies) grounded on your attached resources and injected bindings. Review the plan, then Apply — a checkpoint is captured first so every scaffold is reversible. Build + Deploy from the Source and Deploy tabs afterwards."
            fieldLabel="Describe the app"
            fieldHint="Plain English. Generated code reads the injected env bindings (APP_ONT_* / APP_LH_* / LOOM_*) — no hard-coded endpoints or secrets."
            placeholder={'e.g. "A Streamlit dashboard over my attached Sales ontology: list Customers, traverse OWNS links to Accounts, and a form to create Orders."'}
            opNoun="edit"
            onApplied={loadItem}
          />
        )}

        {tab === 'resources' && !loading && (
          <>
            <Subtitle2>Resources</Subtitle2>
            <Body1>
              Attach a Loom backend to this app in one click — the shared apps identity is granted the
              needed role and the connection env vars are injected automatically (Databricks-Apps
              &quot;App resources&quot; parity). Env applies on the next Deploy.
            </Body1>
            <div className={s.row}>
              <Dropdown
                placeholder="Pick a resource to attach"
                value={resKinds.find((k) => k.kind === attachKind)?.label || ''}
                selectedOptions={attachKind ? [attachKind] : []}
                onOptionSelect={(_, d) => setAttachKind(d.optionValue || '')}
                style={{ minWidth: '280px' }}
              >
                {resKinds.map((k) => {
                  // Kinds with a per-item picker (lakehouse, adx) support
                  // MULTIPLE attaches, so they stay pickable even when one is
                  // attached (the route still 409s an exact duplicate
                  // honestly). Other kinds are single-attach.
                  const attached = resources.some((r) => r.kind === k.kind);
                  const disabled = !k.available || (attached && !ITEM_PICKER_TYPES[k.kind]);
                  return (
                    <Option key={k.kind} value={k.kind} disabled={disabled}
                      text={k.label}>
                      {k.label}{disabled && attached ? ' (attached)' : !k.available ? ` — set ${k.missing}` : ''}
                    </Option>
                  );
                })}
              </Dropdown>
              {ITEM_PICKER_TYPES[attachKind] && lakeItems.length > 0 && (
                <Dropdown
                  placeholder={attachKind === 'adx' ? 'Deployment default database'
                    : attachKind === 'weave-ontology' ? 'Graph only (no specific ontology)' : 'Deployment default lake'}
                  value={lakeItems.find((it) => it.id === attachItemId)?.displayName || ''}
                  selectedOptions={attachItemId ? [attachItemId] : []}
                  onOptionSelect={(_, d) => setAttachItemId(d.optionValue || '')}
                  style={{ minWidth: '240px' }}
                >
                  <Option value="" text={attachKind === 'adx' ? 'Deployment default database'
                    : attachKind === 'weave-ontology' ? 'Graph only (no specific ontology)' : 'Deployment default lake'}>
                    {attachKind === 'adx' ? 'Deployment default database (cluster-wide viewer)'
                      : attachKind === 'weave-ontology' ? 'Graph coordinates only (no ontology id/types)' : 'Deployment default lake (all layers)'}
                  </Option>
                  {lakeItems.map((it) => (
                    <Option key={it.id} value={it.id} text={it.displayName}>{it.displayName}</Option>
                  ))}
                </Dropdown>
              )}
              <Button appearance="primary" icon={<Add20Regular />} onClick={attachResource}
                disabled={!attachKind || resBusy}>
                {resBusy ? 'Attaching…' : 'Attach'}
              </Button>
            </div>
            {resources.length === 0 ? (
              <Caption1>No resources attached yet — pick one above. Each attach grants the apps identity + injects env.</Caption1>
            ) : (
              <Table size="small" aria-label="Attached resources">
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>Resource</TableHeaderCell>
                    <TableHeaderCell>Role</TableHeaderCell>
                    <TableHeaderCell>Grant</TableHeaderCell>
                    <TableHeaderCell>Injected env</TableHeaderCell>
                    <TableHeaderCell />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {resources.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell>{r.label}</TableCell>
                      <TableCell>{r.grant.role}</TableCell>
                      <TableCell>
                        <Badge appearance="tint"
                          color={r.grant.status === 'granted' || r.grant.status === 'already-exists' ? 'success'
                            : r.grant.status === 'pending-grants' ? 'warning' : r.grant.status === 'error' ? 'danger' : 'informative'}>
                          {r.grant.status}
                        </Badge>
                      </TableCell>
                      <TableCell style={{ overflowWrap: 'anywhere' }}>
                        <Caption1>{r.envNames.join(', ')}</Caption1>
                      </TableCell>
                      <TableCell>
                        <Button size="small" icon={<Delete20Regular />} disabled={resBusy}
                          onClick={() => detachResource(r.id)} aria-label={`Detach ${r.label}`} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            {resources.filter((r) => r.grant.status === 'pending-grants' && r.grant.grantScript).map((r) => (
              <MessageBar key={r.id} intent="warning" layout="multiline">
                <MessageBarBody>
                  <MessageBarTitle>{r.label}: one admin grant still needed</MessageBarTitle>
                  {r.grant.detail}
                  <pre className={s.logs}>{r.grant.grantScript}</pre>
                </MessageBarBody>
              </MessageBar>
            ))}
          </>
        )}

        {tab === 'bindings' && !loading && (
          <>
            <Subtitle2>Bindings</Subtitle2>
            <Body1>Inject env vars so your app can call back into your own Loom data plane (Synapse / ADX / AI Search / Cosmos). Names are allowlisted (APP_ / LOOM_ / AZURE_ / APPLICATIONINSIGHTS_ / KEYVAULT_ / CSA_LOOM_ / PORT). Use a Key Vault secret reference for secrets — never a plaintext secret.</Body1>
            <Table size="small" aria-label="Environment bindings">
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>Name</TableHeaderCell>
                  <TableHeaderCell>Type</TableHeaderCell>
                  <TableHeaderCell>Value / KV secret name</TableHeaderCell>
                  <TableHeaderCell />
                </TableRow>
              </TableHeader>
              <TableBody>
                {env.map((row, i) => (
                  <TableRow key={i}>
                    <TableCell><Input value={row.name} onChange={(_, d) => updateEnv(i, { name: d.value })} placeholder="LOOM_ADX_CLUSTER" /></TableCell>
                    <TableCell>
                      <Dropdown value={row.secretRef !== undefined ? 'Key Vault secret' : 'Plain value'}
                        selectedOptions={[row.secretRef !== undefined ? 'secret' : 'plain']}
                        onOptionSelect={(_, d) => updateEnv(i, d.optionValue === 'secret' ? { value: undefined, secretRef: row.secretRef || '' } : { secretRef: undefined, value: row.value || '' })}>
                        <Option value="plain">Plain value</Option>
                        <Option value="secret">Key Vault secret</Option>
                      </Dropdown>
                    </TableCell>
                    <TableCell>
                      {row.secretRef !== undefined
                        ? <Input value={row.secretRef} onChange={(_, d) => updateEnv(i, { secretRef: d.value })} placeholder="kv-secret-name" />
                        : <Input value={row.value || ''} onChange={(_, d) => updateEnv(i, { value: d.value })} placeholder="value" />}
                    </TableCell>
                    <TableCell><Button size="small" icon={<Delete20Regular />} onClick={() => removeEnv(i)} aria-label="Remove" /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <div className={s.row}>
              <Button icon={<Add20Regular />} onClick={addEnv}>Add binding</Button>
              <Caption1>Bindings apply on the next Deploy.</Caption1>
            </div>
          </>
        )}

        {/* ---- LOGS ---- */}
        {tab === 'logs' && !loading && (
          <>
            <div className={s.row}>
              <Subtitle2>Logs</Subtitle2>
              <Button size="small" icon={<ArrowSync20Regular />} onClick={refreshLogs} disabled={logsBusy}>{logsBusy ? 'Loading…' : 'Refresh'}</Button>
            </div>
            <pre className={s.logs}>{logs || 'No logs loaded yet.'}</pre>
          </>
        )}

        {/* ---- MONITORING ---- */}
        {tab === 'monitoring' && !loading && (
          <>
            <div className={s.row}>
              <Subtitle2>Monitoring</Subtitle2>
              <Button size="small" icon={<ArrowSync20Regular />} onClick={loadMonitoring} disabled={monBusy}>{monBusy ? 'Loading…' : 'Refresh'}</Button>
            </div>
            <Body1>Live metrics + month-to-date cost for this app&apos;s Container App (Azure Monitor + Cost Management). Logs are on the Logs tab.</Body1>
            {!rt.containerAppName ? (
              <Caption1>Deploy the app first — metrics + cost appear once a revision is running.</Caption1>
            ) : mon?.error ? (
              <MessageBar intent="warning"><MessageBarBody>{mon.error}</MessageBarBody></MessageBar>
            ) : mon ? (
              <>
                <div className={s.statGrid}>
                  <div className={s.stat}><span className={s.statLabel}>Month-to-date cost</span><Text weight="semibold">{mon.cost?.error ? '—' : `${(mon.cost?.amount ?? 0).toFixed(2)} ${mon.cost?.currency || ''}`}</Text></div>
                  {(Array.isArray(mon.metrics) ? mon.metrics : []).map((m: any) => {
                    const pts = (m.series || m.timeseries || m.data || []) as any[];
                    const last = pts.length ? pts[pts.length - 1] : null;
                    const val = last && typeof last === 'object' ? (last.value ?? last.average ?? last.total) : last;
                    return <div key={m.name} className={s.stat}><span className={s.statLabel}>{m.name}</span><Text weight="semibold">{val != null ? Number(val).toLocaleString(undefined, { maximumFractionDigits: 2 }) : '—'}</Text></div>;
                  })}
                </div>
                {mon.cost?.note && <Caption1>{mon.cost.note}</Caption1>}
                <Button size="small" appearance="subtle" icon={<Open20Regular />} onClick={() => window.open('/monitor', '_blank', 'noopener')}>Open full Monitor</Button>
              </>
            ) : <Caption1>Click Refresh to load metrics + cost.</Caption1>}
          </>
        )}

        {/* ---- HISTORY ---- */}
        {tab === 'history' && !loading && (
          <>
            <Subtitle2>Build history</Subtitle2>
            {(rt.builds || []).length === 0 ? <Caption1>No builds yet.</Caption1> : (
              <Table size="small" aria-label="Build history">
                <TableHeader><TableRow><TableHeaderCell>When</TableHeaderCell><TableHeaderCell>Image</TableHeaderCell><TableHeaderCell>Source</TableHeaderCell><TableHeaderCell>Status</TableHeaderCell><TableHeaderCell>By</TableHeaderCell></TableRow></TableHeader>
                <TableBody>
                  {(rt.builds || []).map((b) => (
                    <TableRow key={b.runId}>
                      <TableCell>{new Date(b.at).toLocaleString()}</TableCell>
                      <TableCell style={{ overflowWrap: 'anywhere' }}>{b.imageName}</TableCell>
                      <TableCell>{b.source}</TableCell>
                      <TableCell><Badge appearance="tint" color={b.status === 'Succeeded' ? 'success' : b.status === 'Failed' || b.status === 'Error' ? 'danger' : 'informative'}>{b.status}</Badge></TableCell>
                      <TableCell>{b.by || '—'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </>
        )}
      </div>
    </div>
  );

  return <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={main} displayName={item.displayName} />;
}
