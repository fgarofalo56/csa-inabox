'use client';

import { clientFetch } from '@/lib/client-fetch';
/**
 * LakehouseShortcutEditor — the Azure-native equivalent of a OneLake shortcut:
 * a named pointer to external data a lakehouse reads IN PLACE without copying.
 * The pointer persists as a Cosmos workspace item; each shortcut carries a
 * CONNECTOR (source type + non-secret coordinates + an optional Key Vault
 * secretRef). Create + Verify list the target via the REAL backend for the
 * chosen source (ADLS/Blob on the Console identity or a SAS, S3 with SigV4, GCS
 * with a service-account JWT, Dataverse via its Synapse Link ADLS export) to
 * prove resolution WITHOUT copying. No Microsoft Fabric / OneLake dependency.
 *
 * Parity with Fabric's New-shortcut dialog: ADLS Gen2, Amazon S3, S3-compatible,
 * Google Cloud Storage, Azure Blob, Dataverse, and internal lakehouse-to-lakehouse.
 */

import type React from 'react';
import { useCallback, useEffect, useState } from 'react';
import {
  Caption1, Badge, Button, Spinner, Input, Textarea, Field, Select,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  Dialog, DialogTrigger, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  Subtitle2, Divider,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Add20Regular, ArrowSync20Regular, Delete20Regular, Link20Regular, CheckmarkCircle20Regular,
  Folder20Regular, Cloud20Regular, Server20Regular, Database20Regular,
} from '@fluentui/react-icons';
import { ItemEditorChrome } from './item-editor-chrome';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';

const useStyles = makeStyles({
  pad: { padding: tokens.spacingVerticalL, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, flex: 1, minHeight: 0, minWidth: 0, overflowY: 'auto' },
  toolbar: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'flex-end', flexWrap: 'wrap' },
  field: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, minWidth: '220px' },
  mono: { fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase200, overflowWrap: 'anywhere', wordBreak: 'break-word', minWidth: 0 },
  tableWrap: { overflow: 'auto', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium },
  section: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  sourceGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: tokens.spacingHorizontalS },
  sourceCard: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, alignItems: 'flex-start',
    padding: tokens.spacingVerticalM, border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge, background: tokens.colorNeutralBackground1,
    cursor: 'pointer', textAlign: 'left', minWidth: 0,
    transitionProperty: 'box-shadow, border-color, background', transitionDuration: tokens.durationNormal,
    ':hover': { border: `1px solid ${tokens.colorBrandStroke1}`, boxShadow: tokens.shadow4 },
    ':focus-visible': { outline: `2px solid ${tokens.colorStrokeFocus2}`, outlineOffset: '1px' },
  },
  sourceCardActive: { border: `1px solid ${tokens.colorBrandStroke1}`, background: tokens.colorBrandBackground2, boxShadow: tokens.shadow4 },
  sourceHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, color: tokens.colorBrandForeground1 },
  sourceLabel: { fontWeight: tokens.fontWeightSemibold, color: tokens.colorNeutralForeground1 },
  sourceDesc: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200, lineHeight: tokens.lineHeightBase200 },
});

const CONTAINERS = ['bronze', 'silver', 'gold', 'landing', 'csv-imports'];

type SourceType = 'internal' | 'adls' | 'blob' | 's3' | 's3compatible' | 'gcs' | 'dataverse';

interface SourceDef { value: SourceType; label: string; desc: string; icon: React.JSX.Element; needsSecret: boolean }
const SOURCES: SourceDef[] = [
  { value: 'internal', label: 'Internal lakehouse', desc: 'Another Loom lakehouse path (medallion).', icon: <Folder20Regular />, needsSecret: false },
  { value: 'adls', label: 'ADLS Gen2', desc: 'External Data Lake Storage account.', icon: <Cloud20Regular />, needsSecret: false },
  { value: 'blob', label: 'Azure Blob', desc: 'Azure Blob Storage account + container.', icon: <Cloud20Regular />, needsSecret: false },
  { value: 's3', label: 'Amazon S3', desc: 'AWS S3 bucket (incl. GovCloud).', icon: <Cloud20Regular />, needsSecret: true },
  { value: 's3compatible', label: 'S3-compatible', desc: 'MinIO / Wasabi / other S3 API store.', icon: <Server20Regular />, needsSecret: true },
  { value: 'gcs', label: 'Google Cloud Storage', desc: 'GCS bucket (service-account JSON).', icon: <Cloud20Regular />, needsSecret: true },
  { value: 'dataverse', label: 'Dataverse', desc: 'Via Azure Synapse Link ADLS export.', icon: <Database20Regular />, needsSecret: false },
];
const SOURCE_LABEL: Record<SourceType, string> = Object.fromEntries(SOURCES.map((s) => [s.value, s.label])) as Record<SourceType, string>;

interface WorkspaceLite { id: string; name: string }
interface Shortcut {
  id: string; displayName: string; sourceType?: SourceType;
  container?: string; path?: string; account?: string; bucket?: string;
  targetUri?: string; abfss?: string; hasSecret?: boolean; entryCount?: number; lastVerifiedAt?: string;
}
interface Props { item: FabricItemType; id: string }

export function LakehouseShortcutEditor({ item, id }: Props) {
  const s = useStyles();
  const [workspaces, setWorkspaces] = useState<WorkspaceLite[] | null>(null);
  const [workspaceId, setWorkspaceId] = useState('');
  const [shortcuts, setShortcuts] = useState<Shortcut[] | null>(null);
  const [adlsConfigured, setAdlsConfigured] = useState(true);
  const [kvConfigured, setKvConfigured] = useState(true);
  const [msg, setMsg] = useState<{ intent: 'success' | 'error'; text: string } | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [cName, setCName] = useState('');
  const [cSource, setCSource] = useState<SourceType>('internal');
  // Connector fields (per source).
  const [cContainer, setCContainer] = useState('bronze');
  const [cPath, setCPath] = useState('');
  const [cAccount, setCAccount] = useState('');
  const [cBucket, setCBucket] = useState('');
  const [cRegion, setCRegion] = useState('us-east-1');
  const [cEndpoint, setCEndpoint] = useState('');
  const [cEnvUrl, setCEnvUrl] = useState('');
  const [cExportUri, setCExportUri] = useState('');
  const [cSecret, setCSecret] = useState('');
  const [cBusy, setCBusy] = useState(false);
  const [cErr, setCErr] = useState<string | null>(null);
  const [verifyResult, setVerifyResult] = useState<{ resolved: boolean; reason?: string; targetUri?: string; abfss?: string; entryCount?: number } | null>(null);
  const [verifyBusy, setVerifyBusy] = useState(false);

  useEffect(() => {
    clientFetch('/api/loom/workspaces').then(r => r.json()).then(j => setWorkspaces(j.ok ? (j.workspaces || []) : [])).catch(() => setWorkspaces([]));
  }, []);

  const load = useCallback(async (wsId: string) => {
    setShortcuts(null);
    try {
      const r = await clientFetch(`/api/items/lakehouse-shortcut?workspaceId=${encodeURIComponent(wsId)}`);
      const j = await r.json();
      if (!j.ok) { setShortcuts([]); return; }
      setShortcuts(j.shortcuts || []);
      setAdlsConfigured(!!j.adlsConfigured);
      setKvConfigured(!!j.kvConfigured);
    } catch { setShortcuts([]); }
  }, []);

  useEffect(() => { if (workspaceId) void load(workspaceId); }, [workspaceId, load]);

  function resetForm() {
    setCName(''); setCSource('internal'); setCContainer('bronze'); setCPath('');
    setCAccount(''); setCBucket(''); setCRegion('us-east-1'); setCEndpoint('');
    setCEnvUrl(''); setCExportUri(''); setCSecret('');
    setVerifyResult(null); setCErr(null);
  }

  /** Body shared by verify + create (sans displayName/action). */
  const connectorBody = useCallback(() => ({
    sourceType: cSource,
    container: cContainer, path: cPath.trim(),
    account: cAccount.trim(), bucket: cBucket.trim(), region: cRegion.trim(),
    endpointHost: cEndpoint.trim(), environmentUrl: cEnvUrl.trim(), exportAbfssUri: cExportUri.trim(),
    secret: cSecret,
  }), [cSource, cContainer, cPath, cAccount, cBucket, cRegion, cEndpoint, cEnvUrl, cExportUri, cSecret]);

  /** True when the minimal fields for a resolve are present for the source. */
  const missing = ((): boolean => {
    switch (cSource) {
      case 'internal': return !cContainer;
      case 'adls': case 'blob': return !cAccount.trim() || !cContainer.trim();
      case 's3': return !cBucket.trim() || !cRegion.trim() || !cSecret.includes(':');
      case 's3compatible': return !cBucket.trim() || !cRegion.trim() || !cEndpoint.trim() || !cSecret.includes(':');
      case 'gcs': return !cBucket.trim() || !cSecret.trim();
      case 'dataverse': return !cExportUri.trim();
      default: return true;
    }
  })();
  // A secret-required source can't be created without a shortcut Key Vault.
  const secretGateBlocks = SOURCES.find((x) => x.value === cSource)?.needsSecret && !kvConfigured;

  const verify = useCallback(async () => {
    if (!workspaceId || missing) return;
    setVerifyBusy(true); setVerifyResult(null); setCErr(null);
    try {
      const r = await clientFetch(`/api/items/lakehouse-shortcut?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'verify', ...connectorBody() }),
      });
      const j = await r.json();
      if (!j.ok) { setCErr(j.error || 'verify failed'); return; }
      setVerifyResult(j);
    } catch (e: any) { setCErr(e?.message || String(e)); }
    finally { setVerifyBusy(false); }
  }, [workspaceId, missing, connectorBody]);

  const create = useCallback(async () => {
    if (!workspaceId || !cName.trim() || missing) return;
    setCBusy(true); setCErr(null);
    try {
      const r = await clientFetch(`/api/items/lakehouse-shortcut?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ displayName: cName.trim(), ...connectorBody() }),
      });
      const j = await r.json();
      if (!j.ok) { setCErr(j.error || 'create failed'); return; }
      setMsg({ intent: 'success', text: `Created ${SOURCE_LABEL[cSource]} shortcut "${cName.trim()}" → resolved ${j.resolution?.entryCount ?? 0} entries (no copy).` });
      setCreateOpen(false); resetForm();
      await load(workspaceId);
    } finally { setCBusy(false); }
  }, [workspaceId, cName, cSource, missing, connectorBody, load]);

  const del = useCallback(async (sid: string) => {
    if (!workspaceId) return;
    setMsg(null);
    try {
      const r = await clientFetch(`/api/items/lakehouse-shortcut?workspaceId=${encodeURIComponent(workspaceId)}&id=${encodeURIComponent(sid)}`, { method: 'DELETE' });
      const j = await r.json();
      if (!j.ok) { setMsg({ intent: 'error', text: j.error || 'delete failed' }); return; }
      setMsg({ intent: 'success', text: 'Shortcut deleted (the external data is untouched).' });
      await load(workspaceId);
    } catch (e: any) { setMsg({ intent: 'error', text: e?.message || String(e) }); }
  }, [workspaceId, load]);

  const ribbon: RibbonTab[] = [
    { id: 'home', label: 'Home', groups: [
      { label: 'Shortcut', actions: [
        { label: 'New shortcut', onClick: workspaceId ? () => setCreateOpen(true) : undefined, disabled: !workspaceId },
        { label: 'Refresh', onClick: workspaceId ? () => void load(workspaceId) : undefined, disabled: !workspaceId },
      ]},
    ]},
  ];

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={
      <div className={s.pad}>
        <div className={s.toolbar}>
          <Badge appearance="filled" color="brand" icon={<Link20Regular />}>Lakehouse shortcut</Badge>
          <div className={s.field}>
            <Caption1>Workspace</Caption1>
            <Select value={workspaceId} onChange={(_, d) => setWorkspaceId(d.value)} disabled={(workspaces?.length ?? 0) === 0}>
              {!workspaceId && <option value="">{workspaces === null ? 'Loading…' : 'Select a workspace'}</option>}
              {(workspaces || []).map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
            </Select>
          </div>
          <Button appearance="outline" icon={<ArrowSync20Regular />} onClick={() => workspaceId && void load(workspaceId)} disabled={!workspaceId}>Refresh</Button>
        </div>

        {!adlsConfigured && (
          <MessageBar intent="warning">
            <MessageBarBody>
              <MessageBarTitle>No ADLS Gen2 data lake configured</MessageBarTitle>
              Internal shortcuts resolve against the DLZ medallion containers. Set <code>LOOM_BRONZE_URL</code> / <code>LOOM_SILVER_URL</code> / <code>LOOM_GOLD_URL</code> so Loom can verify internal paths in place. External sources (ADLS/Blob/S3/GCS/Dataverse) are unaffected.
            </MessageBarBody>
          </MessageBar>
        )}

        {msg && <MessageBar intent={msg.intent}><MessageBarBody>{msg.text}</MessageBarBody></MessageBar>}

        <Dialog open={createOpen} onOpenChange={(_, d) => { setCreateOpen(d.open); if (!d.open) resetForm(); }}>
          <DialogTrigger disableButtonEnhancement>
            <Button appearance="primary" icon={<Add20Regular />} disabled={!workspaceId}>New shortcut</Button>
          </DialogTrigger>
          <DialogSurface style={{ maxWidth: '680px', width: '92vw' }}>
            <DialogBody>
              <DialogTitle>Create lakehouse shortcut</DialogTitle>
              <DialogContent>
                <div className={s.section}>
                  <Field label="Display name" required><Input value={cName} onChange={(_, d) => setCName(d.value)} placeholder="external-orders" /></Field>

                  <Subtitle2>Source type</Subtitle2>
                  <div className={s.sourceGrid} role="radiogroup" aria-label="Shortcut source type">
                    {SOURCES.map((src) => (
                      <button
                        key={src.value} type="button" role="radio" aria-checked={cSource === src.value}
                        className={`${s.sourceCard} ${cSource === src.value ? s.sourceCardActive : ''}`}
                        onClick={() => { setCSource(src.value); setVerifyResult(null); setCErr(null); }}
                      >
                        <span className={s.sourceHead}>{src.icon}<span className={s.sourceLabel}>{src.label}</span></span>
                        <span className={s.sourceDesc}>{src.desc}</span>
                      </button>
                    ))}
                  </div>

                  <Divider />

                  {/* --- Per-source connection fields --- */}
                  {cSource === 'internal' && (
                    <>
                      <Field label="Target container" required>
                        <Select value={cContainer} onChange={(_, d) => { setCContainer(d.value); setVerifyResult(null); }}>
                          {CONTAINERS.map(c => <option key={c} value={c}>{c}</option>)}
                        </Select>
                      </Field>
                      <Field label="Target path" hint="Path under the container, e.g. external/orders/ (the external Delta/Parquet folder).">
                        <Textarea value={cPath} onChange={(_, d) => { setCPath(d.value); setVerifyResult(null); }} rows={2} className={s.mono} />
                      </Field>
                    </>
                  )}

                  {(cSource === 'adls' || cSource === 'blob') && (
                    <>
                      <Field label="Storage account" required hint="Bare account name, e.g. contosolake.">
                        <Input value={cAccount} onChange={(_, d) => { setCAccount(d.value); setVerifyResult(null); }} placeholder="contosolake" />
                      </Field>
                      <Field label="Container / filesystem" required>
                        <Input value={cContainer} onChange={(_, d) => { setCContainer(d.value); setVerifyResult(null); }} placeholder="curated" />
                      </Field>
                      <Field label="Path / prefix" hint="Folder under the container, e.g. orders/2026/.">
                        <Input value={cPath} onChange={(_, d) => { setCPath(d.value); setVerifyResult(null); }} className={s.mono} />
                      </Field>
                      <Field label="SAS token (optional)" hint="Leave blank to read on the Console managed identity (needs Storage Blob Data Reader). Paste a read+list SAS to reach an account the identity can't — stored in Key Vault, never in the shortcut record.">
                        <Input type="password" value={cSecret} onChange={(_, d) => { setCSecret(d.value); setVerifyResult(null); }} placeholder="sv=2023-…&sig=…" />
                      </Field>
                    </>
                  )}

                  {(cSource === 's3' || cSource === 's3compatible') && (
                    <>
                      <Field label="Bucket" required>
                        <Input value={cBucket} onChange={(_, d) => { setCBucket(d.value); setVerifyResult(null); }} placeholder="my-data-bucket" />
                      </Field>
                      <Field label="Region" required hint="e.g. us-east-1 or GovCloud us-gov-west-1.">
                        <Input value={cRegion} onChange={(_, d) => { setCRegion(d.value); setVerifyResult(null); }} placeholder="us-east-1" />
                      </Field>
                      {cSource === 's3compatible' && (
                        <Field label="Endpoint host" required hint="S3 API host, e.g. minio.example.com or s3.wasabisys.com.">
                          <Input value={cEndpoint} onChange={(_, d) => { setCEndpoint(d.value); setVerifyResult(null); }} placeholder="minio.example.com" />
                        </Field>
                      )}
                      <Field label="Access key" required hint="AccessKeyId:SecretAccessKey — stored in Key Vault, never in the shortcut record.">
                        <Input type="password" value={cSecret} onChange={(_, d) => { setCSecret(d.value); setVerifyResult(null); }} placeholder="AKIA…:wJalrXUtn…" />
                      </Field>
                      <Field label="Prefix" hint="Folder under the bucket, e.g. data/2026/.">
                        <Input value={cPath} onChange={(_, d) => { setCPath(d.value); setVerifyResult(null); }} className={s.mono} />
                      </Field>
                    </>
                  )}

                  {cSource === 'gcs' && (
                    <>
                      <Field label="Bucket" required>
                        <Input value={cBucket} onChange={(_, d) => { setCBucket(d.value); setVerifyResult(null); }} placeholder="my-gcs-bucket" />
                      </Field>
                      <Field label="Service-account key (JSON)" required hint="The GCS service-account JSON (client_email + private_key) — stored in Key Vault, never in the shortcut record.">
                        <Textarea value={cSecret} onChange={(_, d) => { setCSecret(d.value); setVerifyResult(null); }} rows={3} className={s.mono} placeholder='{"client_email":"…","private_key":"…"}' />
                      </Field>
                      <Field label="Prefix" hint="Folder under the bucket, e.g. exports/.">
                        <Input value={cPath} onChange={(_, d) => { setCPath(d.value); setVerifyResult(null); }} className={s.mono} />
                      </Field>
                    </>
                  )}

                  {cSource === 'dataverse' && (
                    <>
                      <Field label="Dataverse environment URL" hint="e.g. https://org.crm.dynamics.com — informational; the data is read from the Synapse Link export path below.">
                        <Input value={cEnvUrl} onChange={(_, d) => setCEnvUrl(d.value)} placeholder="https://org.crm.dynamics.com" />
                      </Field>
                      <Field label="Synapse Link export path (abfss://)" required hint="The ADLS Gen2 path Azure Synapse Link for Dataverse writes tables to (the Console identity needs Storage Blob Data Reader on it).">
                        <Input value={cExportUri} onChange={(_, d) => { setCExportUri(d.value); setVerifyResult(null); }} className={s.mono} placeholder="abfss://dataverse@lake.dfs.core.windows.net/" />
                      </Field>
                      <Field label="Table / sub-path" hint="Optional folder under the export root, e.g. account/.">
                        <Input value={cPath} onChange={(_, d) => { setCPath(d.value); setVerifyResult(null); }} className={s.mono} />
                      </Field>
                    </>
                  )}

                  {secretGateBlocks && (
                    <MessageBar intent="warning">
                      <MessageBarBody>
                        <MessageBarTitle>Key Vault not configured for shortcut credentials</MessageBarTitle>
                        {SOURCE_LABEL[cSource]} needs a credential stored in Key Vault. Set <code>LOOM_SHORTCUT_KEYVAULT</code> (or <code>LOOM_KEY_VAULT_URI</code>) and grant the Console identity the <strong>Key Vault Secrets Officer</strong> role. You can still Verify the connection below.
                      </MessageBarBody>
                    </MessageBar>
                  )}

                  <div>
                    <Button appearance="outline" icon={verifyBusy ? <Spinner size="tiny" /> : <CheckmarkCircle20Regular />} disabled={verifyBusy || missing} onClick={verify}>{verifyBusy ? 'Verifying…' : 'Verify resolves (no copy)'}</Button>
                  </div>
                  {verifyResult && (
                    <MessageBar intent={verifyResult.resolved ? 'success' : 'warning'}>
                      <MessageBarBody>
                        <MessageBarTitle>{verifyResult.resolved ? 'Target resolves in place' : 'Could not resolve'}</MessageBarTitle>
                        {verifyResult.resolved
                          ? <>Listed <strong>{verifyResult.entryCount ?? 0}</strong> entries at <code className={s.mono}>{verifyResult.targetUri || verifyResult.abfss}</code> via the real backend — no data copied.</>
                          : (verifyResult.reason || 'The target could not be listed.')}
                      </MessageBarBody>
                    </MessageBar>
                  )}
                  {cErr && <MessageBar intent="error"><MessageBarBody>{cErr}</MessageBarBody></MessageBar>}
                </div>
              </DialogContent>
              <DialogActions>
                <Button appearance="secondary" onClick={() => setCreateOpen(false)}>Cancel</Button>
                <Button appearance="primary" disabled={cBusy || !cName.trim() || missing || !!secretGateBlocks} onClick={create}>{cBusy ? 'Creating…' : 'Create'}</Button>
              </DialogActions>
            </DialogBody>
          </DialogSurface>
        </Dialog>

        {!workspaceId && <Caption1>Select a workspace to list its lakehouse shortcuts.</Caption1>}
        {workspaceId && shortcuts === null && <Spinner size="small" label="Loading shortcuts…" labelPosition="after" />}
        {workspaceId && shortcuts && shortcuts.length === 0 && (
          <MessageBar intent="info"><MessageBarBody>No shortcuts yet. Click <strong>New shortcut</strong> to point at external data (ADLS, Blob, S3, GCS, Dataverse, or another lakehouse) without copying it.</MessageBarBody></MessageBar>
        )}
        {workspaceId && shortcuts && shortcuts.length > 0 && (
          <div className={s.tableWrap}>
            <Table aria-label="Lakehouse shortcuts" size="small">
              <TableHeader><TableRow>
                <TableHeaderCell>Name</TableHeaderCell><TableHeaderCell>Source</TableHeaderCell><TableHeaderCell>Target</TableHeaderCell>
                <TableHeaderCell>Entries</TableHeaderCell><TableHeaderCell>Last verified</TableHeaderCell>
                <TableHeaderCell>Actions</TableHeaderCell>
              </TableRow></TableHeader>
              <TableBody>
                {shortcuts.map((sc) => (
                  <TableRow key={sc.id}>
                    <TableCell className={s.mono}>{sc.displayName}</TableCell>
                    <TableCell><Badge appearance="tint" color="brand">{SOURCE_LABEL[sc.sourceType || 'internal'] || sc.sourceType || 'internal'}</Badge></TableCell>
                    <TableCell className={s.mono}>{sc.targetUri || sc.abfss || `${sc.container || ''}/${sc.path || ''}`}</TableCell>
                    <TableCell>{sc.entryCount ?? '—'}</TableCell>
                    <TableCell>{sc.lastVerifiedAt?.replace('T', ' ').replace(/\..*/, '') || '—'}</TableCell>
                    <TableCell><Button size="small" appearance="subtle" icon={<Delete20Regular />} onClick={() => del(sc.id)}>Delete</Button></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    } />
  );
}
