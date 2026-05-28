'use client';

/**
 * AuditPanel — expanded audit log surface for /admin/security.
 *
 * Backed by the existing /api/admin/audit-logs route which already
 * supports q, type, since, top query params. This panel adds a category
 * filter shortcut (sharing/role/policy-change/scan/label-apply/dlp-alert)
 * and a CSV export.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button, Badge, Spinner, Caption1, Subtitle2,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  Input, Dropdown, Option, Field,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { ArrowSync24Regular, ArrowDownload20Regular } from '@fluentui/react-icons';

const useStyles = makeStyles({
  section: {
    padding: 12, borderRadius: 8,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  toolbar: {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
    gap: 8, marginBottom: 12, alignItems: 'end',
  },
});

const CATEGORIES = [
  { value: '', label: 'All' },
  { value: 'share', label: 'Sharing' },
  { value: 'role', label: 'Role' },
  { value: 'permission', label: 'Permission' },
  { value: 'policy', label: 'Policy change' },
  { value: 'scan', label: 'Scan' },
  { value: 'label', label: 'Label apply' },
  { value: 'dlp', label: 'DLP alert' },
];

interface AuditRow {
  id: string;
  at: string;
  who?: string;
  kind?: string;
  key?: string;
  itemId?: string;
  tenantId?: string;
  [k: string]: unknown;
}
interface AuditPayload {
  ok: boolean;
  total?: number;
  rows?: AuditRow[];
  kinds?: string[];
  error?: string;
}

export function AuditPanel() {
  const s = useStyles();
  const [category, setCategory] = useState('');
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('');
  const [data, setData] = useState<AuditPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const params = new URLSearchParams();
      params.set('top', '500');
      if (q.trim()) params.set('q', q.trim());
      if (kind) params.set('type', kind);
      const r = await fetch(`/api/admin/audit-logs?${params.toString()}`);
      const j = await r.json();
      if (!r.ok) setError(j?.error || `HTTP ${r.status}`);
      else setData(j);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setLoading(false); }
  }, [q, kind]);
  useEffect(() => { load(); }, [load]);

  const filteredRows = useMemo<AuditRow[]>(() => {
    if (!data?.rows) return [];
    if (!category) return data.rows;
    return data.rows.filter((r) => (r.kind || '').toLowerCase().includes(category));
  }, [data, category]);

  const exportCsv = () => {
    const headers = ['at', 'who', 'kind', 'key', 'itemId'];
    const lines = [headers.join(',')];
    for (const r of filteredRows) {
      lines.push(headers.map((h) => {
        const v = (r as any)[h] ?? '';
        const str = typeof v === 'string' ? v : JSON.stringify(v);
        return `"${str.replace(/"/g, '""')}"`;
      }).join(','));
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `loom-audit-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className={s.section}>
      <Subtitle2 block style={{ marginBottom: 8 }}>Audit log</Subtitle2>
      <div className={s.toolbar}>
        <Field label="Search">
          <Input value={q} onChange={(_: unknown, d: any) => setQ(d.value)} placeholder="who / key / itemId" />
        </Field>
        <Field label="Category">
          <Dropdown value={CATEGORIES.find((c) => c.value === category)?.label || 'All'}
            selectedOptions={[category]} onOptionSelect={(_: unknown, d: any) => setCategory(d.optionValue || '')}>
            {CATEGORIES.map((c) => <Option key={c.value} value={c.value}>{c.label}</Option>)}
          </Dropdown>
        </Field>
        <Field label="Event kind">
          <Dropdown value={kind || 'All'} selectedOptions={[kind]} onOptionSelect={(_: unknown, d: any) => setKind(d.optionValue || '')}>
            <Option value="">All</Option>
            {(data?.kinds || []).map((k) => <Option key={k} value={k}>{k}</Option>)}
          </Dropdown>
        </Field>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button icon={<ArrowSync24Regular />} onClick={load} disabled={loading}>Refresh</Button>
          <Button icon={<ArrowDownload20Regular />} onClick={exportCsv} disabled={!filteredRows.length}>CSV</Button>
        </div>
      </div>
      {loading && <Spinner label="Loading audit log…" />}
      {error && (
        <MessageBar intent="error">
          <MessageBarBody><MessageBarTitle>Failed to load</MessageBarTitle>{error}</MessageBarBody>
        </MessageBar>
      )}
      {!loading && !error && filteredRows.length === 0 && (
        <Caption1 block style={{ color: tokens.colorNeutralForeground3 }}>No audit events match this filter.</Caption1>
      )}
      {!loading && !error && filteredRows.length > 0 && (
        <Table size="small" aria-label="Audit events">
          <TableHeader>
            <TableRow>
              <TableHeaderCell>When</TableHeaderCell>
              <TableHeaderCell>Who</TableHeaderCell>
              <TableHeaderCell>Kind</TableHeaderCell>
              <TableHeaderCell>Key</TableHeaderCell>
              <TableHeaderCell>Target</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredRows.slice(0, 200).map((r) => (
              <TableRow key={r.id}>
                <TableCell><Caption1>{new Date(r.at).toLocaleString()}</Caption1></TableCell>
                <TableCell>{r.who || '—'}</TableCell>
                <TableCell><Badge appearance="outline" size="small">{r.kind}</Badge></TableCell>
                <TableCell><Caption1>{r.key || '—'}</Caption1></TableCell>
                <TableCell><code style={{ fontSize: 11 }}>{r.itemId || '—'}</code></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {filteredRows.length > 200 && (
        <Caption1 block style={{ marginTop: 8, color: tokens.colorNeutralForeground3 }}>
          Showing first 200 of {filteredRows.length}. Refine filters to see more, or click CSV to export the full filtered set.
        </Caption1>
      )}
    </div>
  );
}
