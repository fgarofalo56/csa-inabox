'use client';
import { useState, useCallback, useEffect } from 'react';
import { clientFetch } from '@/lib/client-fetch';
import { parseJsonOrError } from '../shared';
import type { ShortcutRow, ShortcutTargetType, ShortcutKind, SchemaRow } from '../types';
import type { ContainerInfo } from '../shared';
import type { ExternalCredsState, SharePointSelection } from '@/lib/components/onelake/shortcut-wizard';
import type { LakehouseContent } from '@/lib/apps/content-bundles/types';

interface Params {
  shortcutLakehouseId: string;
  schemasEnabled: boolean;
  containers: ContainerInfo[] | null;
  schemas: SchemaRow[] | null;
  bundleShortcuts: NonNullable<LakehouseContent['shortcuts']>;
  loadSchemas: () => Promise<void>;
  confirm: (opts: { title: string; body: string; danger?: boolean; confirmLabel?: string }) => Promise<boolean>;
  setSqlText: (t: string) => void;
  setTab: (t: string) => void;
  tab: string;
  scWizardOpenExternal?: boolean;
}

export function useLakehouseShortcuts({
  shortcutLakehouseId, schemasEnabled, containers, schemas, bundleShortcuts,
  loadSchemas, confirm, setSqlText, setTab, tab,
}: Params) {
  // ── Shortcuts state ───────────────────────────────────────────────────────
  const [shortcuts, setShortcuts] = useState<ShortcutRow[] | null>(null);
  const [shortcutsBusy, setShortcutsBusy] = useState(false);
  const [selectedShortcut, setSelectedShortcut] = useState<ShortcutRow | null>(null);
  const [shortcutsError, setShortcutsError] = useState<string | null>(null);
  const [regBusy, setRegBusy] = useState<string | null>(null);

  // ── Shortcut wizard state ─────────────────────────────────────────────────
  const [scWizardOpen, setScWizardOpen] = useState(false);
  const [scStep, setScStep] = useState<1 | 2 | 3>(1);
  const [scType, setScType] = useState<ShortcutTargetType>('internal');
  const [scAdlsMode, setScAdlsMode] = useState<'picker' | 'external'>('picker');
  const [storageAccts, setStorageAccts] = useState<Array<{ name: string; dfsHost?: string; blobHost?: string; isHns: boolean; resourceGroup?: string }>>([]);
  const [storageAcctsLoading, setStorageAcctsLoading] = useState(false);
  const [scAcctHost, setScAcctHost] = useState('');
  const [scAdlsContainer, setScAdlsContainer] = useState('');
  const [scAdlsPath, setScAdlsPath] = useState('');
  const [scInternalContainer, setScInternalContainer] = useState('');
  const [scInternalPath, setScInternalPath] = useState('');
  const [scTargetUri, setScTargetUri] = useState('');
  const [scKvSecret, setScKvSecret] = useState('');
  const [scExtSas, setScExtSas] = useState('');
  const [scExtSasBusy, setScExtSasBusy] = useState(false);
  const [scExtSasErr, setScExtSasErr] = useState<string | null>(null);
  const [extCreds, setExtCreds] = useState<ExternalCredsState>({ region: 'us-east-1' });
  const [scSpSelection, setScSpSelection] = useState<SharePointSelection | null>(null);
  const [scName, setScName] = useState('');
  const [scKind, setScKind] = useState<ShortcutKind>('files');
  const [scParentPath, setScParentPath] = useState('');
  const [scFormat, setScFormat] = useState<'delta' | 'parquet' | 'csv' | 'json'>('delta');
  const [scSubmitting, setScSubmitting] = useState(false);
  const [scSubmitError, setScSubmitError] = useState<string | null>(null);
  const [scTargetSchema, setScTargetSchema] = useState<string>('dbo');

  // Discover in-tenant storage accounts when ADLS picker mode opens
  useEffect(() => {
    if (!scWizardOpen || scType !== 'adls' || scAdlsMode !== 'picker' || storageAccts.length) return;
    setStorageAcctsLoading(true);
    clientFetch('/api/storage/accounts').then((r) => r.json()).then((j) => {
      if (j?.ok && Array.isArray(j.accounts)) setStorageAccts(j.accounts);
    }).catch(() => {}).finally(() => setStorageAcctsLoading(false));
  }, [scWizardOpen, scType, scAdlsMode, storageAccts.length]);

  // Load shortcuts when the tab opens or lakehouse changes
  useEffect(() => {
    if (tab === 'shortcuts' && shortcutLakehouseId) void loadShortcuts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, shortcutLakehouseId]);

  // Populate schemas for the wizard (schema-enabled lakehouse)
  useEffect(() => {
    if (scWizardOpen && schemasEnabled && schemas === null && shortcutLakehouseId) void loadSchemas();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scWizardOpen, schemasEnabled, schemas, shortcutLakehouseId]);

  // ── Callbacks ─────────────────────────────────────────────────────────────
  const loadShortcuts = useCallback(async () => {
    if (!shortcutLakehouseId) return;
    setShortcutsBusy(true); setShortcutsError(null);
    try {
      const r = await clientFetch(`/api/lakehouse/shortcuts?lakehouseId=${encodeURIComponent(shortcutLakehouseId)}`);
      const j = await parseJsonOrError<{ ok: boolean; error?: string; data?: ShortcutRow[] }>(r, 'List shortcuts');
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setShortcuts(j.data || []);
    } catch (e: any) { setShortcutsError(e?.message || String(e)); setShortcuts([]); }
    finally { setShortcutsBusy(false); }
  }, [shortcutLakehouseId]);

  const resetWizard = useCallback((presetKind?: ShortcutKind, presetParent?: string) => {
    setScStep(1); setScType('internal'); setScTargetUri('');
    setScInternalContainer(''); setScInternalPath(''); setScKvSecret('');
    setScName(''); setScKind(presetKind || 'files'); setScParentPath(presetParent || '');
    setScFormat('delta'); setScSubmitError(null); setScTargetSchema('dbo');
    setExtCreds({ region: 'us-east-1' });
    setScSpSelection(null);
    setScExtSas(''); setScExtSasBusy(false); setScExtSasErr(null);
  }, []);

  const stashExternalSas = useCallback(async () => {
    if (!scExtSas.trim() || !shortcutLakehouseId) return;
    setScExtSasBusy(true); setScExtSasErr(null);
    try {
      const r = await clientFetch('/api/lakehouse/shortcuts/credentials', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ lakehouseId: shortcutLakehouseId, name: scName.trim() || 'ext-adls', sourceType: 'adls', secretValue: scExtSas.trim() }),
      });
      const j = await r.json().catch(() => ({}));
      if (!j?.ok) throw new Error(j?.error || j?.hint || `HTTP ${r.status}`);
      setScExtSas('');
      setScKvSecret(j.data?.secretName || '');
    } catch (e: any) { setScExtSasErr(e?.message || String(e)); }
    finally { setScExtSasBusy(false); }
  }, [scExtSas, shortcutLakehouseId, scName]);

  const openShortcutWizard = useCallback((presetKind?: ShortcutKind, presetParent?: string) => {
    resetWizard(presetKind, presetParent);
    setScWizardOpen(true);
  }, [resetWizard]);

  const submitShortcut = useCallback(async () => {
    if (!shortcutLakehouseId || !scName.trim()) return;
    setScSubmitting(true); setScSubmitError(null);
    let targetUri = scTargetUri.trim();
    let credentialRef: { kind: string; keyVaultSecret: string } | undefined;
    if (scType === 'internal') {
      const c = scInternalContainer.trim();
      const p = scInternalPath.trim().replace(/^\/+/, '');
      targetUri = `internal://${c}${p ? `/${p}` : ''}`;
    } else if (scType === 'adls' && scAdlsMode === 'picker' && scAcctHost) {
      const c = scAdlsContainer.trim();
      const p = (extCreds.selectedPath || scAdlsPath).trim().replace(/^\/+/, '');
      targetUri = `abfss://${c}@${scAcctHost}/${p}`;
    } else if (scType === 's3' || scType === 'gcs') {
      const scheme = scType === 's3' ? 's3' : 'gs';
      const key = (extCreds.selectedPath || '').replace(/^\/+/, '');
      targetUri = `${scheme}://${(extCreds.bucket || '').trim()}/${key}`;
      credentialRef = extCreds.secretName ? { kind: scType === 's3' ? 'awsKeys' : 'gcsServiceAccount', keyVaultSecret: extCreds.secretName } : undefined;
    } else if (scType === 'dataverse') {
      const sub = (extCreds.selectedPath || 'tables').replace(/^\/+/, '');
      targetUri = `dataverse://${sub}`;
      credentialRef = extCreds.secretName ? { kind: 'sas', keyVaultSecret: extCreds.secretName } : undefined;
    } else if (scType === 'sharepoint') {
      if (scSpSelection) targetUri = `sharepoint://${scSpSelection.driveId}/${(scSpSelection.path || '').replace(/^\/+/, '')}`;
    } else if (scType === 'adls' && scAdlsMode === 'external') {
      credentialRef = scKvSecret.trim() ? { kind: 'sas', keyVaultSecret: scKvSecret.trim() } : undefined;
    } else if (scType === 'delta_sharing') {
      credentialRef = scKvSecret.trim() ? { kind: 'deltaSharing', keyVaultSecret: scKvSecret.trim() } : undefined;
    }
    const effectiveParent = schemasEnabled && scKind === 'tables'
      ? [scTargetSchema, scParentPath.trim()].filter(Boolean).join('/')
      : scParentPath.trim();
    try {
      const r = await clientFetch('/api/lakehouse/shortcuts', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          lakehouseId: shortcutLakehouseId, name: scName.trim(), kind: scKind,
          parentPath: effectiveParent, targetType: scType, targetUri,
          format: scKind === 'tables' ? scFormat : undefined, credentialRef,
          schemaName: schemasEnabled && scKind === 'tables' ? scTargetSchema : undefined,
        }),
      });
      const j = await parseJsonOrError<{ ok: boolean; error?: string; hint?: string }>(r, 'Create shortcut');
      if (!j.ok) throw new Error(j.hint || j.error || `HTTP ${r.status}`);
      setScWizardOpen(false);
      await loadShortcuts();
    } catch (e: any) { setScSubmitError(e?.message || String(e)); }
    finally { setScSubmitting(false); }
  }, [shortcutLakehouseId, scName, scTargetUri, scType, scAdlsMode, scAcctHost, scAdlsContainer, scAdlsPath, scInternalContainer, scInternalPath, scKvSecret, scKind, scParentPath, scFormat, schemasEnabled, scTargetSchema, extCreds, scSpSelection, loadShortcuts]);

  const registerBundleShortcut = useCallback(async (sc: any) => {
    if (!shortcutLakehouseId) return;
    setRegBusy(sc.name); setShortcutsError(null);
    try {
      const r = await clientFetch('/api/lakehouse/shortcuts', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ lakehouseId: shortcutLakehouseId, name: sc.name, kind: sc.kind || 'files', parentPath: sc.parentPath || '', targetType: 'adls', targetUri: sc.target }),
      });
      const j = await parseJsonOrError<{ ok: boolean; error?: string; hint?: string }>(r, 'Register shortcut');
      if (!j.ok) throw new Error(j.hint || j.error || `HTTP ${r.status}`);
      await loadShortcuts();
    } catch (e: any) { setShortcutsError(e?.message || String(e)); }
    finally { setRegBusy(null); }
  }, [shortcutLakehouseId, loadShortcuts]);

  const registerAllBundleShortcuts = useCallback(async () => {
    for (const sc of bundleShortcuts) await registerBundleShortcut(sc);
  }, [bundleShortcuts, registerBundleShortcut]);

  const testShortcut = useCallback(async (row: ShortcutRow) => {
    setShortcutsBusy(true); setShortcutsError(null);
    try {
      const r = await clientFetch('/api/lakehouse/shortcuts/test', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ lakehouseId: row.lakehouseId, id: row.id }),
      });
      await parseJsonOrError<{ ok: boolean; error?: string }>(r, 'Test shortcut');
      await loadShortcuts();
    } catch (e: any) { setShortcutsError(e?.message || String(e)); }
    finally { setShortcutsBusy(false); }
  }, [loadShortcuts]);

  const deleteShortcutRow = useCallback(async (row: ShortcutRow) => {
    const ok = await confirm({
      title: `Delete shortcut "${row.name}"?`,
      body: 'This drops the registry pointer and any external table — it never deletes the underlying source data.',
      danger: true, confirmLabel: 'Delete shortcut',
    });
    if (!ok) return;
    setShortcutsBusy(true); setShortcutsError(null);
    try {
      const r = await clientFetch(`/api/lakehouse/shortcuts?lakehouseId=${encodeURIComponent(row.lakehouseId)}&id=${encodeURIComponent(row.id)}`, { method: 'DELETE' });
      const j = await parseJsonOrError<{ ok: boolean; error?: string }>(r, 'Delete shortcut');
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      await loadShortcuts();
    } catch (e: any) { setShortcutsError(e?.message || String(e)); }
    finally { setShortcutsBusy(false); }
  }, [loadShortcuts, confirm]);

  const queryShortcut = useCallback((sc: ShortcutRow) => {
    const toBulk = (uri?: string): string | null => {
      if (!uri) return null;
      const m = uri.match(/^abfss:\/\/([^@]+)@([^/]+)\/(.*)$/i);
      if (m) return `https://${m[2]}/${m[1]}/${m[3].replace(/\/+$/, '')}`;
      return null;
    };
    const base = toBulk(sc.abfssUri);
    if (!base) {
      setShortcutsError(`Shortcut "${sc.name}" has no resolved ADLS path to query directly (target type ${sc.targetType}). Run Test to resolve it, or — for an external-cloud source — register it as a Tables shortcut so it gets a SQL object.`);
      return;
    }
    const fmt = (sc.format || '').toLowerCase();
    let bulk = base;
    let clause: string;
    if (fmt === 'delta') { clause = "FORMAT='DELTA'"; }
    else if (fmt === 'parquet') { bulk = `${base}/*.parquet`; clause = "FORMAT='PARQUET'"; }
    else { bulk = `${base}/*.csv`; clause = "FORMAT='CSV', PARSER_VERSION='2.0', HEADER_ROW=TRUE"; }
    setSqlText(
      `-- Query THROUGH shortcut '${sc.name}' (${sc.fullPath}) — zero-copy.\n-- Resolves the shortcut target ${sc.targetUri} to its physical path.\n-- Adjust FORMAT (CSV / PARQUET / DELTA) if the source data differs.\nSELECT TOP 100 *\nFROM OPENROWSET(BULK '${bulk}', ${clause}) AS r;`,
    );
    setTab('sql');
  }, [setSqlText, setTab]);

  return {
    shortcuts, shortcutsBusy, selectedShortcut, setSelectedShortcut, shortcutsError,
    regBusy,
    scWizardOpen, setScWizardOpen,
    scStep, setScStep,
    scType, setScType,
    scAdlsMode, setScAdlsMode,
    storageAccts, storageAcctsLoading,
    scAcctHost, setScAcctHost,
    scAdlsContainer, setScAdlsContainer,
    scAdlsPath, setScAdlsPath,
    scInternalContainer, setScInternalContainer,
    scInternalPath, setScInternalPath,
    scTargetUri, setScTargetUri,
    scKvSecret, setScKvSecret,
    scExtSas, setScExtSas,
    scExtSasBusy, scExtSasErr,
    extCreds, setExtCreds,
    scSpSelection, setScSpSelection,
    scName, setScName,
    scKind, setScKind,
    scParentPath, setScParentPath,
    scFormat, setScFormat,
    scSubmitting, scSubmitError,
    scTargetSchema, setScTargetSchema,
    loadShortcuts, resetWizard, stashExternalSas, openShortcutWizard, submitShortcut,
    registerBundleShortcut, registerAllBundleShortcuts,
    testShortcut, deleteShortcutRow, queryShortcut,
  };
}
