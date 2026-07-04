'use client';

import { clientFetch } from '@/lib/client-fetch';
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
  Button, Badge, Caption1, Subtitle2,
  MessageBar, MessageBarBody, MessageBarTitle,
  Input, Dropdown, Option, Field,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { ArrowSync24Regular, ArrowDownload20Regular } from '@fluentui/react-icons';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';

const useStyles = makeStyles({
  section: {
    padding: tokens.spacingHorizontalM,
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  toolbar: {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
    gap: tokens.spacingHorizontalS,
    marginBottom: tokens.spacingVerticalM,
    alignItems: 'end',
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
      const r = await clientFetch(`/api/admin/audit-logs?${params.toString()}`);
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

  const columns = useMemo<LoomColumn<AuditRow>[]>(() => [
    {
      key: 'at', label: 'When', width: 200,
      getValue: (r) => Date.parse(r.at) || 0,
      render: (r) => <Caption1>{new Date(r.at).toLocaleString()}</Caption1>,
    },
    { key: 'who', label: 'Who', width: 180, render: (r) => r.who || '—' },
    {
      key: 'kind', label: 'Kind', width: 160,
      getValue: (r) => r.kind || '',
      render: (r) => <Badge appearance="outline" size="small">{r.kind}</Badge>,
    },
    { key: 'key', label: 'Key', render: (r) => <Caption1>{r.key || '—'}</Caption1> },
    {
      key: 'itemId', label: 'Target',
      getValue: (r) => r.itemId || '',
      render: (r) => <code style={{ fontSize: tokens.fontSizeBase100 }}>{r.itemId || '—'}</code>,
    },
  ], []);

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
      <Subtitle2 block style={{ marginBottom: tokens.spacingVerticalS }}>Audit log</Subtitle2>
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
        <div style={{ display: 'flex', gap: tokens.spacingHorizontalS }}>
          <Button icon={<ArrowSync24Regular />} onClick={load} disabled={loading}>Refresh</Button>
          <Button icon={<ArrowDownload20Regular />} onClick={exportCsv} disabled={!filteredRows.length}>CSV</Button>
        </div>
      </div>
      {error && (
        <MessageBar intent="error">
          <MessageBarBody><MessageBarTitle>Failed to load</MessageBarTitle>{error}</MessageBarBody>
        </MessageBar>
      )}
      {!error && (
        <LoomDataTable<AuditRow>
          columns={columns}
          rows={filteredRows.slice(0, 200)}
          getRowId={(r) => r.id}
          loading={loading}
          skeleton
          empty="No audit events match this filter."
          ariaLabel="Audit events"
        />
      )}
      {filteredRows.length > 200 && (
        <Caption1 block style={{ marginTop: tokens.spacingVerticalS, color: tokens.colorNeutralForeground3 }}>
          Showing first 200 of {filteredRows.length}. Refine filters to see more, or click CSV to export the full filtered set.
        </Caption1>
      )}
    </div>
  );
}
