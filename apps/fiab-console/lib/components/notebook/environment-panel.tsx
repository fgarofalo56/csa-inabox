'use client';

import { clientFetch } from '@/lib/client-fetch';
/**
 * EnvironmentPanel — Library & Environment management for a Loom notebook.
 *
 * Azure-native 1:1 for the Fabric notebook "Environment" experience (the ribbon
 * Environment selector + Manage panel: libraries, attach-to-notebook). Backed by
 * real AML environment REST via /api/aml/environments — NO Fabric workspace
 * required (see no-fabric-dependency.md). Three tabs:
 *
 *   1. Environments — pick a curated AML Environment and attach it to the
 *      notebook (PATCH ?action=attach, validated against the live backend).
 *      A guided "Create" dialog registers a new environment version from a base
 *      image + structured PyPI/Conda package lists (no freeform YAML —
 *      loom_no_freeform_config rule).
 *   2. Packages — the attached environment's REAL package list (pip / conda),
 *      extracted server-side from the version's condaFile. Inline %pip install
 *      runs a package into the live session via the notebook's run path.
 *   3. Custom libraries — attach a .jar / .whl by path (the one allowed
 *      free-text field — a filename, not a config blob). Persisted onto the
 *      notebook's state.customLibraries.
 *
 * Honest gate: when no AML workspace is configured the list call returns 503 and
 * we render a Fluent MessageBar naming the env vars to set; the panel still
 * renders fully.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  Subtitle2, Caption1, Body1, Badge, Button, Spinner, Input, Field, Select,
  TabList, Tab, Textarea,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Add20Regular, ArrowSync20Regular, Library20Regular, Box20Regular,
} from '@fluentui/react-icons';

export interface AmlPackageLite { name: string; source: 'pip' | 'conda'; }
export interface AmlEnvironmentLite {
  name: string;
  latestVersion?: string;
  image?: string;
  description?: string;
  stage?: string;
  condaFile?: string;
  packages: AmlPackageLite[];
}

export interface EnvironmentPanelProps {
  notebookId: string;
  workspaceId: string;
  attached: { name: string; version: string } | null;
  customLibraries: string[];
  onAttached: (env: { name: string; version: string } | null) => void;
  onJarsChanged: (jars: string[]) => void;
  /** Run `%pip install <pkg>` as a new cell on the live session. */
  onPipInstall: (pkg: string) => void;
}

// Curated Azure ML base images (real MCR azureml images). Used by the guided
// Create dialog so the user picks a base instead of hand-typing one.
const BASE_IMAGES: { label: string; value: string }[] = [
  { label: 'Ubuntu 22.04 · Python 3.10 (minimal)', value: 'mcr.microsoft.com/azureml/openmpi4.1.0-ubuntu22.04:latest' },
  { label: 'Ubuntu 20.04 · Python 3.9 (minimal)', value: 'mcr.microsoft.com/azureml/openmpi4.1.0-ubuntu20.04:latest' },
  { label: 'Sklearn 1.5 · Ubuntu 22.04 · Py3.10', value: 'mcr.microsoft.com/azureml/curated/sklearn-1.5:latest' },
  { label: 'PyTorch 2.2 · CUDA 12 · Ubuntu 22.04', value: 'mcr.microsoft.com/azureml/curated/acpt-pytorch-2.2-cuda12.1:latest' },
];

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingHorizontalM, minWidth: '520px', minHeight: '360px' },
  row: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'flex-end', flexWrap: 'wrap' },
  grow: { flex: 1, minWidth: '220px' },
  tableWrap: { overflow: 'auto', maxHeight: '280px', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium },
  pre: {
    fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase200, whiteSpace: 'pre-wrap',
    background: tokens.colorNeutralBackground3, padding: tokens.spacingHorizontalMNudge, borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`, maxHeight: '200px', overflow: 'auto',
  },
  chips: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalSNudge },
  section: { display: 'flex', flexDirection: 'column', gap: tokens.spacingHorizontalS },
});

export function EnvironmentPanel(props: EnvironmentPanelProps) {
  const { notebookId, workspaceId, attached, customLibraries, onAttached, onJarsChanged, onPipInstall } = props;
  const s = useStyles();
  const [tab, setTab] = useState<'envs' | 'packages' | 'libs'>('envs');

  const [envs, setEnvs] = useState<AmlEnvironmentLite[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [loadHint, setLoadHint] = useState<string | null>(null);
  const [notDeployed, setNotDeployed] = useState(false);
  const [loading, setLoading] = useState(false);

  const [selectedEnv, setSelectedEnv] = useState('');
  const [attachBusy, setAttachBusy] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  // Detail (packages) for the attached environment.
  const [detail, setDetail] = useState<AmlEnvironmentLite | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [pipPkg, setPipPkg] = useState('');

  // Create-environment guided dialog.
  const [createOpen, setCreateOpen] = useState(false);
  const [cName, setCName] = useState('');
  const [cImage, setCImage] = useState(BASE_IMAGES[0].value);
  const [cConda, setCConda] = useState('');
  const [cPip, setCPip] = useState('');
  const [cDesc, setCDesc] = useState('');
  const [cBusy, setCBusy] = useState(false);
  const [cErr, setCErr] = useState<string | null>(null);

  // Custom libraries (.jar / .whl).
  const [jarInput, setJarInput] = useState('');
  const [jarBusy, setJarBusy] = useState(false);

  const loadEnvs = useCallback(async () => {
    setLoading(true); setLoadErr(null); setLoadHint(null); setNotDeployed(false);
    try {
      const r = await clientFetch('/api/aml/environments');
      const j = await r.json();
      if (!j.ok) {
        setEnvs([]);
        setLoadErr(j.error || 'failed to list environments');
        setLoadHint(j.hint || null);
        setNotDeployed(!!j.notDeployed);
      } else {
        setEnvs(j.environments || []);
      }
    } catch (e: any) { setEnvs([]); setLoadErr(e?.message || String(e)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void loadEnvs(); }, [loadEnvs]);

  // Load the attached environment's detailed package list (real, server-extracted).
  const loadDetail = useCallback(async (name: string, version?: string) => {
    setDetailLoading(true);
    try {
      const qs = new URLSearchParams({ name });
      if (version) qs.set('version', version);
      const r = await clientFetch(`/api/aml/environments?${qs.toString()}`);
      const j = await r.json();
      if (j.ok && j.environment) setDetail(j.environment);
      else setDetail(null);
    } catch { setDetail(null); }
    finally { setDetailLoading(false); }
  }, []);

  useEffect(() => {
    if (attached?.name) { void loadDetail(attached.name, attached.version); setSelectedEnv(attached.name); }
    else setDetail(null);
  }, [attached, loadDetail]);

  const attach = useCallback(async () => {
    if (!selectedEnv) return;
    const env = (envs || []).find((e) => e.name === selectedEnv);
    setAttachBusy(true); setStatusMsg('Attaching environment…');
    try {
      const r = await clientFetch('/api/aml/environments?action=attach', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ notebookId, workspaceId, envName: selectedEnv, envVersion: env?.latestVersion }),
      });
      const j = await r.json();
      if (!j.ok) { setStatusMsg(`Attach failed: ${j.error}${j.hint ? ' — ' + j.hint : ''}`); return; }
      onAttached(j.attachedAmlEnv);
      setDetail(j.environment || null);
      setStatusMsg(`Attached ${j.attachedAmlEnv.name}:${j.attachedAmlEnv.version}. Its libraries are available on the next session.`);
      setTab('packages');
    } catch (e: any) { setStatusMsg(`Attach failed: ${e?.message || e}`); }
    finally { setAttachBusy(false); }
  }, [selectedEnv, envs, notebookId, workspaceId, onAttached]);

  const detach = useCallback(async () => {
    setAttachBusy(true); setStatusMsg('Detaching…');
    try {
      const r = await clientFetch('/api/aml/environments?action=detach', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ notebookId, workspaceId }),
      });
      const j = await r.json();
      if (!j.ok) { setStatusMsg(`Detach failed: ${j.error}`); return; }
      onAttached(null); setDetail(null); setStatusMsg('Environment detached.');
    } catch (e: any) { setStatusMsg(`Detach failed: ${e?.message || e}`); }
    finally { setAttachBusy(false); }
  }, [notebookId, workspaceId, onAttached]);

  const createEnv = useCallback(async () => {
    if (!cName.trim() || !cImage) { setCErr('Name and base image are required.'); return; }
    setCBusy(true); setCErr(null);
    try {
      const condaPackages = cConda.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);
      const pipPackages = cPip.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);
      const r = await clientFetch('/api/aml/environments', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: cName.trim(), image: cImage, description: cDesc.trim(), condaPackages, pipPackages }),
      });
      const j = await r.json();
      if (!j.ok) { setCErr(`${j.error}${j.hint ? ' — ' + j.hint : ''}`); return; }
      setCreateOpen(false);
      setCName(''); setCConda(''); setCPip(''); setCDesc('');
      await loadEnvs();
      setSelectedEnv(j.environment?.name || '');
      setStatusMsg(`Registered environment ${j.environment?.name}:${j.environment?.latestVersion}.`);
    } catch (e: any) { setCErr(e?.message || String(e)); }
    finally { setCBusy(false); }
  }, [cName, cImage, cConda, cPip, cDesc, loadEnvs]);

  const installPip = useCallback(() => {
    const pkg = pipPkg.trim();
    if (!pkg) return;
    onPipInstall(pkg);
    setStatusMsg(`Queued %pip install ${pkg} — running on the live session. Import it in the next cell once it completes.`);
    setPipPkg('');
  }, [pipPkg, onPipInstall]);

  const addJar = useCallback(async () => {
    const jar = jarInput.trim();
    if (!jar) return;
    setJarBusy(true);
    try {
      const r = await clientFetch('/api/aml/environments?action=attach-jar', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ notebookId, workspaceId, jar }),
      });
      const j = await r.json();
      if (j.ok) { onJarsChanged(j.customLibraries || []); setJarInput(''); }
      else setStatusMsg(`Could not attach library: ${j.error}`);
    } catch (e: any) { setStatusMsg(`Could not attach library: ${e?.message || e}`); }
    finally { setJarBusy(false); }
  }, [jarInput, notebookId, workspaceId, onJarsChanged]);

  const removeJar = useCallback(async (jar: string) => {
    setJarBusy(true);
    try {
      const r = await clientFetch('/api/aml/environments?action=detach-jar', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ notebookId, workspaceId, jar }),
      });
      const j = await r.json();
      if (j.ok) onJarsChanged(j.customLibraries || []);
    } catch { /* ignore */ }
    finally { setJarBusy(false); }
  }, [notebookId, workspaceId, onJarsChanged]);

  const packages = detail?.packages || [];

  return (
    <div className={s.root}>
      <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS }}>
        <Library20Regular />
        <Subtitle2>Manage environment</Subtitle2>
        <div style={{ flex: 1 }} />
        {attached
          ? <Badge appearance="filled" color="brand">{attached.name}:{attached.version}</Badge>
          : <Badge appearance="outline" color="informative">No environment attached</Badge>}
      </div>

      <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as typeof tab)}>
        <Tab value="envs">Environments</Tab>
        <Tab value="packages">Packages{packages.length ? ` (${packages.length})` : ''}</Tab>
        <Tab value="libs">Custom libraries{customLibraries.length ? ` (${customLibraries.length})` : ''}</Tab>
      </TabList>

      {notDeployed && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Azure ML workspace not configured</MessageBarTitle>
            {loadErr}{loadHint ? <><br /><Caption1>{loadHint}</Caption1></> : null}
          </MessageBarBody>
        </MessageBar>
      )}
      {loadErr && !notDeployed && (
        <MessageBar intent="error"><MessageBarBody>{loadErr}</MessageBarBody></MessageBar>
      )}
      {statusMsg && <MessageBar intent="info"><MessageBarBody>{statusMsg}</MessageBarBody></MessageBar>}

      {tab === 'envs' && (
        <div className={s.section}>
          <div className={s.row}>
            <div className={s.grow}>
              <Field label="Azure ML environment">
                <Select
                  value={selectedEnv}
                  onChange={(_, d) => setSelectedEnv(d.value)}
                  disabled={loading || (envs?.length ?? 0) === 0}
                >
                  {!selectedEnv && <option value="">{loading ? 'Loading environments…' : 'Select an environment'}</option>}
                  {(envs || []).map((e) => (
                    <option key={e.name} value={e.name}>
                      {e.name}{e.latestVersion ? `:${e.latestVersion}` : ''}{e.packages.length ? ` · ${e.packages.length} pkgs` : ''}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Button appearance="primary" icon={<Add20Regular />} disabled={!selectedEnv || attachBusy} onClick={attach}>
              {attachBusy ? 'Working…' : 'Attach'}
            </Button>
            {attached && <Button appearance="subtle" disabled={attachBusy} onClick={detach}>Detach</Button>}
            <Button appearance="outline" icon={<ArrowSync20Regular />} onClick={loadEnvs}>Refresh</Button>
            <Button appearance="outline" icon={<Add20Regular />} onClick={() => setCreateOpen(true)}>Create new</Button>
          </div>
          {!loading && (envs?.length ?? 0) === 0 && !loadErr && (
            <MessageBar intent="info">
              <MessageBarBody>
                No environments registered in this Azure ML workspace yet. Use <strong>Create new</strong> to
                register one from a base image and a package list — or attach packages inline from the
                Packages tab with <code>%pip install</code>.
              </MessageBarBody>
            </MessageBar>
          )}
          {selectedEnv && (() => {
            const e = (envs || []).find((x) => x.name === selectedEnv);
            if (!e) return null;
            return (
              <div className={s.section}>
                <Caption1>Base image: <code>{e.image || '—'}</code>{e.stage ? ` · stage ${e.stage}` : ''}</Caption1>
                {e.description && <Body1>{e.description}</Body1>}
                {e.condaFile && (
                  <>
                    <Caption1>Conda specification (read-only)</Caption1>
                    <div className={s.pre}>{e.condaFile}</div>
                  </>
                )}
              </div>
            );
          })()}
        </div>
      )}

      {tab === 'packages' && (
        <div className={s.section}>
          {!attached && <Caption1>Attach an environment to see its packages, or install a package inline below.</Caption1>}
          <div className={s.row}>
            <div className={s.grow}>
              <Field label="Install a package into the running session (%pip install)" hint="Runs as a new cell on the attached compute; import it in the next cell.">
                <Input value={pipPkg} placeholder="e.g. scikit-learn==1.5.0" onChange={(_, d) => setPipPkg(d.value)} />
              </Field>
            </div>
            <Button appearance="primary" icon={<Box20Regular />} disabled={!pipPkg.trim()} onClick={installPip}>
              Install in session
            </Button>
          </div>
          {detailLoading && <Spinner size="tiny" label="Loading packages…" />}
          <div className={s.tableWrap}>
            <Table aria-label="Environment packages" size="small">
              <TableHeader><TableRow>
                <TableHeaderCell>Package</TableHeaderCell>
                <TableHeaderCell>Source</TableHeaderCell>
              </TableRow></TableHeader>
              <TableBody>
                {packages.length === 0 && (
                  <TableRow><TableCell colSpan={2}>{attached ? 'No packages declared in this environment.' : 'No environment attached.'}</TableCell></TableRow>
                )}
                {packages.map((p) => (
                  <TableRow key={`${p.source}:${p.name}`}>
                    <TableCell style={{ fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase200 }}>{p.name}</TableCell>
                    <TableCell><Badge appearance="outline" color={p.source === 'pip' ? 'brand' : 'success'} size="small">{p.source}</Badge></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}

      {tab === 'libs' && (
        <div className={s.section}>
          <Caption1>Attach a custom <code>.jar</code> / <code>.whl</code> by path. Surfaced to the Spark / Databricks runtime as a session-level package.</Caption1>
          <div className={s.row}>
            <div className={s.grow}>
              <Field label="Library path or filename">
                <Input value={jarInput} placeholder="abfss://libs@acct.dfs.core.windows.net/my-udf.jar" onChange={(_, d) => setJarInput(d.value)} />
              </Field>
            </div>
            <Button appearance="primary" icon={<Add20Regular />} disabled={!jarInput.trim() || jarBusy} onClick={addJar}>Attach</Button>
          </div>
          {customLibraries.length === 0
            ? <Caption1>No custom libraries attached.</Caption1>
            : (
              <div className={s.chips}>
                {customLibraries.map((jar) => (
                  <Badge key={jar} appearance="tint" color="informative" style={{ paddingRight: tokens.spacingHorizontalXS }}>
                    {jar}
                    <Button size="small" appearance="subtle" disabled={jarBusy} onClick={() => removeJar(jar)} style={{ minWidth: 20, marginLeft: tokens.spacingHorizontalXS }}>×</Button>
                  </Badge>
                ))}
              </div>
            )}
        </div>
      )}

      {/* Guided create-environment dialog (no freeform YAML). */}
      <Dialog open={createOpen} onOpenChange={(_, d) => setCreateOpen(d.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Register Azure ML environment</DialogTitle>
            <DialogContent>
              <div className={s.section}>
                <Field label="Environment name" required>
                  <Input value={cName} placeholder="loom-sklearn" onChange={(_, d) => setCName(d.value)} />
                </Field>
                <Field label="Base image" required>
                  <Select value={cImage} onChange={(_, d) => setCImage(d.value)}>
                    {BASE_IMAGES.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}
                  </Select>
                </Field>
                <Field label="Conda packages" hint="One per line or comma-separated, e.g. numpy=1.26, pandas">
                  <Textarea value={cConda} onChange={(_, d) => setCConda(d.value)} rows={2} />
                </Field>
                <Field label="PyPI (pip) packages" hint="One per line or comma-separated, e.g. scikit-learn==1.5.0">
                  <Textarea value={cPip} onChange={(_, d) => setCPip(d.value)} rows={2} />
                </Field>
                <Field label="Description">
                  <Input value={cDesc} onChange={(_, d) => setCDesc(d.value)} />
                </Field>
                {cErr && <MessageBar intent="error"><MessageBarBody>{cErr}</MessageBarBody></MessageBar>}
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setCreateOpen(false)}>Cancel</Button>
              <Button appearance="primary" disabled={cBusy || !cName.trim() || !cImage} onClick={createEnv}>
                {cBusy ? 'Registering…' : 'Register'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}
