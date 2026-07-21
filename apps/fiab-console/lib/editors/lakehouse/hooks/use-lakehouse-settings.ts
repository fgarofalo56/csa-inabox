'use client';
import { useState, useCallback } from 'react';
import { clientFetch } from '@/lib/client-fetch';
import { parseJsonOrError } from '../shared';
import type { LakehouseSettings, IcebergEndpoint } from '../types';

interface Params {
  activeContainer: string | null;
  schemasEnabled: boolean;
  setSchemasEnabled: (v: boolean) => void;
  setActionStatus: (s: string | null) => void;
}

export function useLakehouseSettings({ activeContainer, schemasEnabled, setSchemasEnabled, setActionStatus }: Params) {
  // ── Settings dialog ───────────────────────────────────────────────────────
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<LakehouseSettings>({});
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [settingsSparkConfText, setSettingsSparkConfText] = useState('');
  // Spark pools (enumerated; no freeform compute input)
  const [sparkPools, setSparkPools] = useState<{ name: string }[] | null>(null);
  // Cloud boundary — drives honest per-cloud disclosures
  const [cloud, setCloud] = useState<'commercial' | 'gcc' | 'gcch' | 'il5'>('commercial');

  // ── Liquid clustering ─────────────────────────────────────────────────────
  const [lcTableName, setLcTableName] = useState('');
  const [lcColumns, setLcColumns] = useState('');
  const [lcApplied, setLcApplied] = useState<boolean | null>(null);
  const [lcSql, setLcSql] = useState<string | null>(null);
  const [lcGate, setLcGate] = useState<string | null>(null);
  const [lcError, setLcError] = useState<string | null>(null);

  // ── Iceberg UniForm ───────────────────────────────────────────────────────
  const [icebergEnabled, setIcebergEnabled] = useState(false);
  const [icebergTable, setIcebergTable] = useState('');
  const [icebergSchema, setIcebergSchema] = useState('');
  const [icebergEndpoint, setIcebergEndpoint] = useState<IcebergEndpoint | null>(null);
  const [icebergApplied, setIcebergApplied] = useState<boolean | null>(null);
  const [icebergSql, setIcebergSql] = useState<string | null>(null);
  const [icebergGate, setIcebergGate] = useState<string | null>(null);
  const [icebergError, setIcebergError] = useState<string | null>(null);

  // ── Callbacks ─────────────────────────────────────────────────────────────
  const loadSettings = useCallback(async () => {
    if (!activeContainer) return;
    setSettingsBusy(true); setSettingsError(null);
    try {
      const r = await clientFetch(`/api/lakehouse/settings?container=${encodeURIComponent(activeContainer)}`);
      const j = await parseJsonOrError<{ ok: boolean; error?: string; cloud?: typeof cloud; settings?: LakehouseSettings; icebergEndpoint?: IcebergEndpoint }>(r, 'Load settings');
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setSettings(j.settings || {});
      setSchemasEnabled(j.settings?.schemasEnabled ?? false);
      if (j.cloud) setCloud(j.cloud);
      const cfg = j.settings?.sparkConfig || {};
      setSettingsSparkConfText(Object.entries(cfg).map(([k, v]) => `${k}=${v}`).join('\n'));
      setLcTableName(j.settings?.liquidClustering?.tableName || '');
      setLcColumns((j.settings?.liquidClustering?.columns || []).join(', '));
      setLcApplied(null); setLcSql(null); setLcGate(null); setLcError(null);
      setIcebergEnabled(j.settings?.icebergExpose?.enabled ?? false);
      setIcebergTable(j.settings?.icebergExpose?.tableName || '');
      setIcebergSchema(j.settings?.icebergExpose?.schemaName || '');
      setIcebergEndpoint(j.icebergEndpoint || null);
      setIcebergApplied(null); setIcebergSql(null); setIcebergGate(null); setIcebergError(null);
    } catch (e: any) { setSettingsError(e?.message || String(e)); }
    finally { setSettingsBusy(false); }
  }, [activeContainer, setSchemasEnabled]);

  const loadSparkPools = useCallback(async () => {
    try {
      const r = await clientFetch('/api/loom/compute-targets');
      const j = await parseJsonOrError<{ ok: boolean; computes?: { name: string; kind: string }[] }>(r, 'List compute');
      if (j.ok && Array.isArray(j.computes)) {
        setSparkPools(j.computes.filter((c) => c.kind === 'synapse-spark').map((c) => ({ name: c.name.replace(/\s*\(Synapse Spark\)\s*$/, '') })));
      } else {
        setSparkPools([]);
      }
    } catch { setSparkPools([]); }
  }, []);

  const openSettings = useCallback(() => {
    setSettingsOpen(true);
    loadSettings();
    if (sparkPools === null) loadSparkPools();
  }, [loadSettings, loadSparkPools, sparkPools]);

  const saveSettings = useCallback(async () => {
    if (!activeContainer) return;
    setSettingsBusy(true); setSettingsError(null);
    setLcApplied(null); setLcSql(null); setLcGate(null); setLcError(null);
    setIcebergApplied(null); setIcebergSql(null); setIcebergGate(null); setIcebergError(null);
    try {
      const sparkConfig: Record<string, string> = {};
      for (const line of settingsSparkConfText.split(/\r?\n/)) {
        const t = line.trim(); if (!t || t.startsWith('#')) continue;
        const idx = t.indexOf('=');
        if (idx > 0) sparkConfig[t.slice(0, idx).trim()] = t.slice(idx + 1).trim();
      }
      const trimmedTable = lcTableName.trim();
      const liquidClustering = trimmedTable
        ? { tableName: trimmedTable, columns: lcColumns.split(',').map((c) => c.trim()).filter(Boolean) }
        : undefined;
      const icebergTbl = icebergTable.trim();
      const icebergExpose = icebergTbl
        ? { enabled: icebergEnabled, tableName: icebergTbl, schemaName: schemasEnabled && icebergSchema.trim() ? icebergSchema.trim() : undefined }
        : undefined;
      const r = await clientFetch('/api/lakehouse/settings', {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          container: activeContainer,
          displayName: settings.displayName,
          description: settings.description,
          defaultSparkPool: settings.defaultSparkPool,
          sparkConfig,
          timeTravelDays: settings.timeTravelDays ?? 7,
          deltaDefaults: settings.deltaDefaults || { autoOptimize: true },
          schemasEnabled: settings.schemasEnabled ?? false,
          liquidClustering,
          icebergExpose,
          fabricToggles: settings.fabricToggles,
        }),
      });
      const j = await parseJsonOrError<{
        ok: boolean; error?: string; settings?: LakehouseSettings;
        clusteringApplied?: boolean; clusteringSql?: string; clusteringGate?: string; clusteringError?: string;
        icebergApplied?: boolean; icebergSql?: string; icebergGate?: string; icebergError?: string;
        icebergEndpoint?: IcebergEndpoint;
      }>(r, 'Save settings');
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setSettings(j.settings || settings);
      setSchemasEnabled(j.settings?.schemasEnabled ?? settings.schemasEnabled ?? false);
      setLcApplied(j.clusteringApplied ?? null);
      setLcSql(j.clusteringSql || null);
      setLcGate(j.clusteringGate || null);
      setLcError(j.clusteringError || null);
      setIcebergApplied(j.icebergApplied ?? null);
      setIcebergSql(j.icebergSql || null);
      setIcebergGate(j.icebergGate || null);
      setIcebergError(j.icebergError || null);
      if (j.icebergEndpoint) setIcebergEndpoint(j.icebergEndpoint);
      setActionStatus(`Lakehouse settings saved at ${new Date().toLocaleTimeString()}`);
      if (!j.clusteringGate && !j.clusteringError && !j.icebergGate && !j.icebergError) setSettingsOpen(false);
    } catch (e: any) { setSettingsError(e?.message || String(e)); }
    finally { setSettingsBusy(false); }
  }, [activeContainer, settings, settingsSparkConfText, lcTableName, lcColumns, icebergEnabled, icebergTable, icebergSchema, schemasEnabled, setSchemasEnabled, setActionStatus]);

  return {
    settingsOpen, setSettingsOpen, openSettings,
    settings, setSettings,
    settingsBusy, settingsError,
    settingsSparkConfText, setSettingsSparkConfText,
    sparkPools, cloud,
    lcTableName, setLcTableName,
    lcColumns, setLcColumns,
    lcApplied, lcSql, lcGate, lcError,
    icebergEnabled, setIcebergEnabled,
    icebergTable, setIcebergTable,
    icebergSchema, setIcebergSchema,
    icebergEndpoint,
    icebergApplied, icebergSql, icebergGate, icebergError,
    loadSettings, loadSparkPools, saveSettings,
  };
}
