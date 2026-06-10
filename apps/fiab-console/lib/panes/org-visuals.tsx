'use client';

/**
 * F23 — Organizational visuals pane.
 *
 * Azure-native parity with Fabric / Power BI Admin "Organizational visuals":
 * upload a real .pbiviz bundle (stored as a Blob in the DLZ org-visuals
 * container), list visuals with version, enable/disable tenant-wide, and
 * delete. Real backend: /api/admin/org-visuals.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Spinner, Badge, Caption1, Body1, Input, Button, Field, Switch,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  ArrowUpload24Regular, Delete20Regular, ArrowSync24Regular, Info20Regular,
  DocumentArrowUp20Regular,
} from '@fluentui/react-icons';
import { Section, Toolbar } from '@/lib/components/ui/section';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';
import { NotConfiguredBar, type NotConfiguredHint } from '@/lib/components/admin-security/not-configured-bar';

interface OrgVisual {
  id: string;
  name: string;
  fileName: string;
  blobPath: string;
  size: number;
  version: string;
  enabled: boolean;
  uploadedAt: string;
  uploadedBy: string;
}

const useStyles = makeStyles({
  explainer: { display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'flex-start' },
  uploadGrid: { display: 'flex', gap: '12px', alignItems: 'flex-end', flexWrap: 'wrap' },
  fileBtn: { display: 'flex', alignItems: 'center', gap: '8px' },
});

function fmt(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

function fmtSize(bytes: number): string {
  if (!bytes) return '0 B';
  const k = 1024;
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), units.length - 1);
  return `${(bytes / Math.pow(k, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function OrgVisualsPane() {
  const s = useStyles();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [visuals, setVisuals] = useState<OrgVisual[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [gate, setGate] = useState<NotConfiguredHint | null>(null);
  const [q, setQ] = useState('');
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);

  // Upload form.
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('');
  const [version, setVersion] = useState('');
  const [uploading, setUploading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null); setGate(null);
    try {
      const r = await fetch('/api/admin/org-visuals');
      const j = await r.json();
      if (r.status === 503 && j.code === 'not-configured') { setGate(j.hint || {}); setVisuals([]); return; }
      if (!j.ok) { setError(j.error || 'failed'); return; }
      setVisuals(j.visuals || []);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  function pickFile(f: File | null) {
    setFile(f);
    if (f && !name.trim()) setName(f.name.replace(/\.pbiviz$/i, ''));
  }

  async function upload() {
    if (!file) { setActionErr('Choose a .pbiviz bundle to upload'); return; }
    if (!name.trim()) { setActionErr('Name is required'); return; }
    if (!version.trim()) { setActionErr('Version is required'); return; }
    setUploading(true); setActionErr(null); setOkMsg(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('name', name.trim());
      fd.append('version', version.trim());
      const r = await fetch('/api/admin/org-visuals', { method: 'POST', body: fd });
      const j = await r.json();
      if (!j.ok) { setActionErr(j.error || `HTTP ${r.status}`); return; }
      setOkMsg(`Uploaded “${j.visual.name}” (${fmtSize(j.visual.size)}). Enable it to make it available tenant-wide.`);
      setFile(null); setName(''); setVersion('');
      if (fileRef.current) fileRef.current.value = '';
      await load();
    } catch (e: any) { setActionErr(e?.message || String(e)); }
    finally { setUploading(false); }
  }

  async function toggle(v: OrgVisual, enabled: boolean) {
    setBusyId(v.id); setActionErr(null);
    try {
      const r = await fetch(`/api/admin/org-visuals?id=${encodeURIComponent(v.id)}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      const j = await r.json();
      if (!j.ok) { setActionErr(j.error || `HTTP ${r.status}`); return; }
      setVisuals((prev) => prev ? prev.map((x) => x.id === v.id ? { ...x, enabled } : x) : prev);
    } catch (e: any) { setActionErr(e?.message || String(e)); }
    finally { setBusyId(null); }
  }

  async function remove(v: OrgVisual) {
    if (!confirm(`Delete “${v.name}”? The bundle is removed and it will no longer be available tenant-wide.`)) return;
    setBusyId(v.id); setActionErr(null);
    try {
      const r = await fetch(`/api/admin/org-visuals?id=${encodeURIComponent(v.id)}`, { method: 'DELETE' });
      const j = await r.json();
      if (!j.ok) { setActionErr(j.error || `HTTP ${r.status}`); return; }
      await load();
    } catch (e: any) { setActionErr(e?.message || String(e)); }
    finally { setBusyId(null); }
  }

  const filtered = useMemo(() => {
    const f = q.toLowerCase().trim();
    const all = visuals || [];
    if (!f) return all;
    return all.filter((v) =>
      v.name.toLowerCase().includes(f) ||
      v.fileName.toLowerCase().includes(f) ||
      v.version.toLowerCase().includes(f) ||
      (v.uploadedBy || '').toLowerCase().includes(f));
  }, [visuals, q]);

  const columns: LoomColumn<OrgVisual>[] = useMemo(() => [
    { key: 'name', label: 'Name', width: 200, getValue: (v) => v.name, render: (v) => <strong>{v.name}</strong> },
    { key: 'fileName', label: 'File', width: 200, getValue: (v) => v.fileName, render: (v) => <code style={{ fontSize: 11 }}>{v.fileName}</code> },
    { key: 'version', label: 'Version', width: 100, getValue: (v) => v.version, render: (v) => <Badge appearance="outline" size="small">{v.version}</Badge> },
    { key: 'size', label: 'Size', width: 100, getValue: (v) => v.size, render: (v) => <Caption1>{fmtSize(v.size)}</Caption1> },
    {
      key: 'enabled', label: 'Enabled', width: 110, sortable: false, filterable: false,
      render: (v) => (
        <Switch
          checked={v.enabled}
          disabled={busyId === v.id}
          onChange={(_, d) => toggle(v, d.checked)}
          aria-label={`${v.enabled ? 'Disable' : 'Enable'} ${v.name} tenant-wide`}
        />
      ),
    },
    { key: 'uploadedBy', label: 'Uploaded by', width: 170, render: (v) => <Caption1>{v.uploadedBy}</Caption1> },
    { key: 'uploadedAt', label: 'Uploaded', width: 170, getValue: (v) => v.uploadedAt, render: (v) => <Caption1>{fmt(v.uploadedAt)}</Caption1> },
    {
      key: 'actions', label: '', width: 100, sortable: false, filterable: false,
      render: (v) => (
        <Button size="small" appearance="subtle" icon={<Delete20Regular />} disabled={busyId === v.id} onClick={(e) => { e.stopPropagation(); remove(v); }}>Delete</Button>
      ),
    },
  ], [busyId]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <Section title="About organizational visuals">
        <div className={s.explainer}>
          <Info20Regular style={{ color: tokens.colorBrandForeground1, flexShrink: 0, marginTop: 2 }} />
          <Body1 style={{ color: tokens.colorNeutralForeground2, lineHeight: 1.5 }}>
            Upload custom visual bundles (<code>.pbiviz</code>) to make them available across the whole
            tenant. Loom stores each bundle Azure-natively as a real Blob in the <code>org-visuals</code>
            container and tracks its version + enabled state — no Microsoft Fabric or Power BI workspace
            required. Toggle <strong>Enabled</strong> to control tenant-wide availability.
          </Body1>
        </div>
      </Section>

      {gate && (
        <div style={{ marginBottom: 16 }}>
          <NotConfiguredBar surface="Organizational visuals" hint={gate} />
        </div>
      )}
      {error && <MessageBar intent="error" style={{ marginBottom: 16 }}><MessageBarBody><MessageBarTitle>Could not load visuals</MessageBarTitle>{error}</MessageBarBody></MessageBar>}
      {actionErr && <MessageBar intent="error" style={{ marginBottom: 16 }}><MessageBarBody>{actionErr}</MessageBarBody></MessageBar>}
      {okMsg && <MessageBar intent="success" style={{ marginBottom: 16 }}><MessageBarBody>{okMsg}</MessageBarBody></MessageBar>}

      <Section title="Upload a custom visual">
        <div className={s.uploadGrid}>
          <input
            ref={fileRef}
            type="file"
            accept=".pbiviz"
            style={{ display: 'none' }}
            onChange={(e) => pickFile(e.target.files?.[0] || null)}
          />
          <Field label="Bundle (.pbiviz)">
            <Button icon={<DocumentArrowUp20Regular />} onClick={() => fileRef.current?.click()} disabled={!!gate || uploading}>
              {file ? file.name : 'Choose file…'}
            </Button>
          </Field>
          <Field label="Name">
            <Input value={name} onChange={(_, d) => setName(d.value)} placeholder="e.g. Custom bar chart" disabled={!!gate || uploading} />
          </Field>
          <Field label="Version">
            <Input value={version} onChange={(_, d) => setVersion(d.value)} placeholder="e.g. 1.0.0" disabled={!!gate || uploading} />
          </Field>
          <Button
            appearance="primary"
            icon={uploading ? <Spinner size="tiny" /> : <ArrowUpload24Regular />}
            onClick={upload}
            disabled={!!gate || uploading || !file || !name.trim() || !version.trim()}
          >
            {uploading ? 'Uploading…' : 'Upload'}
          </Button>
        </div>
      </Section>

      <Section
        title="Custom visuals"
        actions={<Button icon={<ArrowSync24Regular />} onClick={load} disabled={loading}>Refresh</Button>}
      >
        <Toolbar search={q} onSearch={setQ} searchPlaceholder="Search by name, file, version…" />
        {loading && !error ? (
          <Spinner label="Loading visuals…" />
        ) : (
          <LoomDataTable
            columns={columns}
            rows={filtered}
            getRowId={(v) => v.id}
            empty={q ? `No visuals match "${q}".` : 'No custom visuals uploaded yet. Upload a .pbiviz bundle above.'}
            ariaLabel="Organizational visuals"
          />
        )}
      </Section>
    </>
  );
}
