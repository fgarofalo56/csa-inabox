'use client';

/**
 * F22 — Embed codes pane.
 *
 * Azure-native parity with Fabric Admin "Embed codes": generate a real,
 * loadable read-only signed URL (Blob user-delegation SAS) for a report /
 * visual, list active + revoked codes, copy a URL, and revoke (which deletes
 * the backing blob so the URL immediately 404s). Real backend: /api/admin/embed-codes.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Spinner, Badge, Caption1, Input, Button, Field,
  MessageBar, MessageBarBody, MessageBarTitle,
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Add24Regular, Delete20Regular, ArrowSync24Regular,
  Copy20Regular, Open20Regular,
} from '@fluentui/react-icons';
import { Section, Toolbar } from '@/lib/components/ui/section';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';
import { NotConfiguredBar, type NotConfiguredHint } from '@/lib/components/admin-security/not-configured-bar';
import { SectionExplainer } from '@/lib/components/ui/learn-popover';

interface EmbedCode {
  id: string;
  report: string;
  status: 'active' | 'revoked';
  signedUrl: string;
  expiresAt: string;
  createdAt: string;
  createdBy: string;
  revokedAt?: string;
  revokedBy?: string;
}

const useStyles = makeStyles({
  urlRow: { display: 'flex', gap: '8px', alignItems: 'center', width: '100%' },
});

function fmt(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

export function EmbedCodesPane() {
  const s = useStyles();
  const [codes, setCodes] = useState<EmbedCode[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [gate, setGate] = useState<NotConfiguredHint | null>(null);
  const [q, setQ] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [newReport, setNewReport] = useState('');
  const [creating, setCreating] = useState(false);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [created, setCreated] = useState<EmbedCode | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null); setGate(null);
    try {
      const r = await fetch('/api/admin/embed-codes');
      const j = await r.json();
      if (r.status === 503 && j.code === 'not-configured') { setGate(j.hint || {}); setCodes([]); return; }
      if (!j.ok) { setError(j.error || 'failed'); return; }
      setCodes(j.codes || []);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function copy(text: string, key: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
    } catch { /* clipboard blocked — user can still select the input text */ }
  }

  async function create() {
    if (!newReport.trim()) { setActionErr('Report name is required'); return; }
    setCreating(true); setActionErr(null);
    try {
      const r = await fetch('/api/admin/embed-codes', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ report: newReport.trim() }),
      });
      const j = await r.json();
      if (!j.ok) { setActionErr(j.error || `HTTP ${r.status}`); return; }
      setCreated(j.code);
      setNewReport('');
      setCreateOpen(false);
      await load();
    } catch (e: any) { setActionErr(e?.message || String(e)); }
    finally { setCreating(false); }
  }

  async function revoke(id: string) {
    if (!confirm('Revoke this embed code? The signed URL will stop working immediately.')) return;
    setActionErr(null);
    try {
      const r = await fetch(`/api/admin/embed-codes?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
      const j = await r.json();
      if (!j.ok) { setActionErr(j.error || `HTTP ${r.status}`); return; }
      await load();
    } catch (e: any) { setActionErr(e?.message || String(e)); }
  }

  const filtered = useMemo(() => {
    const f = q.toLowerCase().trim();
    const all = codes || [];
    if (!f) return all;
    return all.filter((c) =>
      c.report.toLowerCase().includes(f) ||
      c.status.toLowerCase().includes(f) ||
      (c.createdBy || '').toLowerCase().includes(f));
  }, [codes, q]);

  const columns: LoomColumn<EmbedCode>[] = useMemo(() => [
    { key: 'report', label: 'Report', width: 220, getValue: (c) => c.report, render: (c) => <strong>{c.report}</strong> },
    {
      key: 'status', label: 'Status', width: 110, getValue: (c) => c.status,
      render: (c) => (
        <Badge appearance="tint" color={c.status === 'active' ? 'success' : 'danger'} size="small">
          {c.status}
        </Badge>
      ),
    },
    { key: 'createdBy', label: 'Created by', width: 180, render: (c) => <Caption1>{c.createdBy}</Caption1> },
    { key: 'createdAt', label: 'Created', width: 170, getValue: (c) => c.createdAt, render: (c) => <Caption1>{fmt(c.createdAt)}</Caption1> },
    { key: 'expiresAt', label: 'URL expires', width: 170, getValue: (c) => c.expiresAt, render: (c) => <Caption1>{c.status === 'active' ? fmt(c.expiresAt) : '—'}</Caption1> },
    {
      key: 'actions', label: '', width: 200, sortable: false, filterable: false,
      render: (c) => c.status === 'active' ? (
        <span style={{ display: 'flex', gap: tokens.spacingHorizontalXS }}>
          <Button size="small" appearance="subtle" icon={<Copy20Regular />} onClick={(e) => { e.stopPropagation(); copy(c.signedUrl, c.id); }}>
            {copied === c.id ? 'Copied' : 'Copy URL'}
          </Button>
          <Button size="small" appearance="subtle" icon={<Open20Regular />} onClick={(e) => { e.stopPropagation(); window.open(c.signedUrl, '_blank', 'noreferrer'); }} aria-label={`Open embed URL for ${c.report}`} />
          <Button size="small" appearance="subtle" icon={<Delete20Regular />} onClick={(e) => { e.stopPropagation(); revoke(c.id); }}>Revoke</Button>
        </span>
      ) : <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Revoked {fmt(c.revokedAt)}</Caption1>,
    },
  ], [copied]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <Section title="About embed codes">
        <SectionExplainer>
          An embed code is a tenant-scoped, read-only <strong>signed URL</strong> that lets a report or
          custom visual be embedded outside Loom. Loom generates it Azure-natively as a Blob Storage
          <strong> user-delegation SAS</strong> (signed with the platform managed identity, never an
          account key) — no Microsoft Fabric or Power BI workspace required. <strong>Revoke</strong> deletes
          the backing object so the URL stops resolving immediately.
        </SectionExplainer>
      </Section>

      {gate && (
        <div style={{ marginBottom: tokens.spacingVerticalL }}>
          <NotConfiguredBar surface="Embed codes" hint={gate} />
        </div>
      )}
      {error && <MessageBar intent="error" style={{ marginBottom: tokens.spacingVerticalL }}><MessageBarBody><MessageBarTitle>Could not load embed codes</MessageBarTitle>{error}</MessageBarBody></MessageBar>}
      {actionErr && <MessageBar intent="error" style={{ marginBottom: tokens.spacingVerticalL }}><MessageBarBody>{actionErr}</MessageBarBody></MessageBar>}

      {created && (
        <MessageBar intent="success" style={{ marginBottom: tokens.spacingVerticalL }}>
          <MessageBarBody>
            <MessageBarTitle>Embed code created for “{created.report}”</MessageBarTitle>
            <Caption1 block style={{ marginBottom: tokens.spacingVerticalSNudge }}>Copy this signed URL — it is loadable now and expires {fmt(created.expiresAt)}.</Caption1>
            <span className={s.urlRow}>
              <Input readOnly value={created.signedUrl} style={{ flex: 1, minWidth: 0, fontFamily: 'monospace', fontSize: tokens.fontSizeBase100 }} onFocus={(e) => e.currentTarget.select()} />
              <Button size="small" icon={<Copy20Regular />} onClick={() => copy(created.signedUrl, 'created')}>
                {copied === 'created' ? 'Copied' : 'Copy'}
              </Button>
              <Button size="small" appearance="subtle" onClick={() => setCreated(null)}>Dismiss</Button>
            </span>
          </MessageBarBody>
        </MessageBar>
      )}

      <Section
        title="Embed codes"
        actions={
          <>
            <Button icon={<ArrowSync24Regular />} onClick={load} disabled={loading}>Refresh</Button>
            <Button appearance="primary" icon={<Add24Regular />} onClick={() => { setActionErr(null); setCreateOpen(true); }} disabled={!!gate}>Create embed code</Button>
          </>
        }
      >
        <Toolbar search={q} onSearch={setQ} searchPlaceholder="Search by report, status, creator…" />
        {loading && !error ? (
          <Spinner label="Loading embed codes…" />
        ) : (
          <LoomDataTable
            columns={columns}
            rows={filtered}
            getRowId={(c) => c.id}
            empty={q ? `No embed codes match "${q}".` : 'No embed codes yet. Click “Create embed code” to generate a signed URL.'}
            ariaLabel="Embed codes"
          />
        )}
      </Section>

      <Dialog open={createOpen} onOpenChange={(_, d) => setCreateOpen(d.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Create embed code</DialogTitle>
            <DialogContent>
              <Field label="Report or visual" hint="A name for what this code embeds. A real signed URL is minted for it.">
                <Input value={newReport} onChange={(_, d) => setNewReport(d.value)} placeholder="e.g. Quarterly sales report" />
              </Field>
              {actionErr && <MessageBar intent="error" style={{ marginTop: tokens.spacingVerticalM }}><MessageBarBody>{actionErr}</MessageBarBody></MessageBar>}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setCreateOpen(false)}>Cancel</Button>
              <Button appearance="primary" onClick={create} disabled={creating || !newReport.trim()}>
                {creating ? 'Generating…' : 'Generate embed code'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </>
  );
}
