'use client';

/**
 * /admin/audit-logs — real audit-log viewer backed by the Cosmos
 * audit-log container. Tenant-settings flips, item edits, share grants,
 * apps installs all land here.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Spinner, Badge, Caption1, Body1, Input, Button, Dropdown, Option,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Search24Regular, ArrowSync24Regular, ArrowDownload24Regular } from '@fluentui/react-icons';
import { AdminShell } from '@/lib/components/admin-shell';

interface AuditRow {
  id: string;
  itemId: string;
  tenantId: string;
  who: string;
  at: string;
  kind: string;
  key?: string;
  from?: any;
  to?: any;
  [k: string]: any;
}

const useStyles = makeStyles({
  toolbar: {
    display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12,
    paddingBottom: 12, borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    flexWrap: 'wrap',
  },
  spacer: { flex: 1 },
  tableWrap: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: 8, overflow: 'auto',
  },
  mono: { fontFamily: 'Consolas, monospace', fontSize: 11 },
  empty: { padding: 32, color: tokens.colorNeutralForeground3, fontSize: 13, textAlign: 'center' },
});

const SINCE_OPTIONS = [
  { value: '', label: 'All time' },
  { value: hoursAgo(1), label: 'Last hour' },
  { value: hoursAgo(24), label: 'Last 24 hours' },
  { value: hoursAgo(24 * 7), label: 'Last 7 days' },
  { value: hoursAgo(24 * 30), label: 'Last 30 days' },
];

function hoursAgo(h: number): string {
  return new Date(Date.now() - h * 3600_000).toISOString();
}

function describeChange(r: AuditRow): string {
  if (r.kind === 'tenant-settings.toggle') {
    return `${r.key}: ${String(r.from)} → ${String(r.to)}`;
  }
  if (r.key) return `${r.key}: ${JSON.stringify(r.to ?? '')}`;
  return JSON.stringify(r, null, 0).slice(0, 200);
}

function toCsv(rows: AuditRow[]): string {
  const header = ['at', 'who', 'kind', 'itemId', 'key', 'from', 'to'];
  const esc = (v: any) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const out = [header.join(',')];
  for (const r of rows) {
    out.push([r.at, r.who, r.kind, r.itemId, r.key, r.from, r.to].map(esc).join(','));
  }
  return out.join('\n');
}

export default function AuditLogsPage() {
  const s = useStyles();
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  const [kinds, setKinds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('');
  const [since, setSince] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const params = new URLSearchParams();
      if (q) params.set('q', q);
      if (kind) params.set('type', kind);
      if (since) params.set('since', since);
      params.set('top', '500');
      const r = await fetch(`/api/admin/audit-logs?${params.toString()}`);
      const j = await r.json();
      if (!j.ok) { setError(j.error || 'failed'); return; }
      setRows(j.rows || []);
      setKinds(j.kinds || []);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally { setLoading(false); }
  }, [q, kind, since]);

  useEffect(() => { load(); }, [load]);

  const totals = useMemo(() => {
    const out = new Map<string, number>();
    for (const r of (rows || [])) out.set(r.kind, (out.get(r.kind) || 0) + 1);
    return out;
  }, [rows]);

  function downloadCsv() {
    if (!rows) return;
    const blob = new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `loom-audit-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  return (
    <AdminShell sectionTitle="Audit logs">
      <Body1 style={{ color: tokens.colorNeutralForeground3, marginBottom: 12 }}>
        Every tenant-settings change, item save, share grant, app install, and admin action lands here.
        Backed by the Cosmos <code>audit-log</code> container.
      </Body1>

      <div className={s.toolbar}>
        <Input
          contentBefore={<Search24Regular />}
          placeholder="Filter by user, kind, item id, key…"
          value={q}
          onChange={(_, d) => setQ(d.value)}
          style={{ flex: 1, maxWidth: 360 }}
        />
        <Dropdown
          value={kind || 'All event types'}
          selectedOptions={kind ? [kind] : []}
          onOptionSelect={(_, d) => setKind(d.optionValue || '')}
          style={{ minWidth: 200 }}
        >
          <Option value="">All event types</Option>
          {kinds.map((k) => <Option key={k} value={k}>{k} ({totals.get(k) || 0})</Option>)}
        </Dropdown>
        <Dropdown
          value={SINCE_OPTIONS.find((o) => o.value === since)?.label || 'All time'}
          selectedOptions={[since]}
          onOptionSelect={(_, d) => setSince(d.optionValue ?? '')}
          style={{ minWidth: 160 }}
        >
          {SINCE_OPTIONS.map((o) => <Option key={o.value || 'all'} value={o.value}>{o.label}</Option>)}
        </Dropdown>
        <div className={s.spacer} />
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
          {(rows || []).length} entries
        </Caption1>
        <Button icon={<ArrowSync24Regular />} onClick={load} disabled={loading}>Refresh</Button>
        <Button icon={<ArrowDownload24Regular />} onClick={downloadCsv} disabled={!rows?.length}>Export CSV</Button>
      </div>

      {error && (
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>Could not load audit logs</MessageBarTitle>
            {error}
          </MessageBarBody>
        </MessageBar>
      )}

      {loading && !error && <Spinner label="Loading audit log…" />}

      {!loading && !error && (rows?.length ?? 0) === 0 && (
        <div className={s.empty}>
          No audit events match the current filters. Try a wider time range or change the event type.
        </div>
      )}

      {!loading && !error && (rows?.length ?? 0) > 0 && (
        <div className={s.tableWrap}>
          <Table aria-label="Audit log">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>When</TableHeaderCell>
                <TableHeaderCell>Who</TableHeaderCell>
                <TableHeaderCell>Kind</TableHeaderCell>
                <TableHeaderCell>Target</TableHeaderCell>
                <TableHeaderCell>Change</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(rows || []).map((r) => (
                <TableRow key={r.id}>
                  <TableCell><Caption1>{new Date(r.at).toLocaleString()}</Caption1></TableCell>
                  <TableCell>{r.who}</TableCell>
                  <TableCell><Badge appearance="outline" size="small">{r.kind}</Badge></TableCell>
                  <TableCell className={s.mono}>{r.itemId}</TableCell>
                  <TableCell className={s.mono}>{describeChange(r)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </AdminShell>
  );
}
