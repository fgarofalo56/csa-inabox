'use client';

/**
 * /admin/audit-logs — real audit-log viewer backed by the Cosmos
 * audit-log container. Tenant-settings flips, item edits, share grants,
 * apps installs all land here.
 *
 * UI: spaced Section + capped Toolbar (search never full-width) + a single
 * LoomDataTable (sort / resize / per-column filter + padded cells for free)
 * on the real data already fetched from /api/admin/audit-logs.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Spinner, Badge, Caption1, Body1, Button, Dropdown, Option, Field,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { ArrowSync24Regular, ArrowDownload24Regular } from '@fluentui/react-icons';
import { AdminShell } from '@/lib/components/admin-shell';
import { Section, Toolbar } from '@/lib/components/ui/section';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';

interface AuditRow {
  id: string;
  itemId: string;
  tenantId: string;
  who: string;
  at: string;
  kind: string;
  key?: string;
  from?: unknown;
  to?: unknown;
  [k: string]: unknown;
}

const useStyles = makeStyles({
  intro: {
    color: tokens.colorNeutralForeground3,
    marginBottom: tokens.spacingVerticalL,
    display: 'block',
  },
  filters: {
    display: 'flex',
    gap: tokens.spacingHorizontalM,
    flexWrap: 'wrap',
    alignItems: 'flex-end',
  },
  mono: {
    fontFamily: 'Consolas, monospace',
    fontSize: '12px',
    color: tokens.colorNeutralForeground2,
  },
  count: { color: tokens.colorNeutralForeground3, whiteSpace: 'nowrap' },
  loadingBox: {
    display: 'flex',
    justifyContent: 'center',
    padding: tokens.spacingVerticalXXL,
  },
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
  const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
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
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setLoading(false); }
  }, [q, kind, since]);

  useEffect(() => { load(); }, [load]);

  const totals = useMemo(() => {
    const out = new Map<string, number>();
    for (const r of (rows || [])) out.set(r.kind, (out.get(r.kind) || 0) + 1);
    return out;
  }, [rows]);

  const tableRows = rows || [];

  const columns = useMemo<LoomColumn<AuditRow>[]>(() => [
    {
      key: 'at',
      label: 'When',
      width: 200,
      getValue: (r) => new Date(r.at).getTime(),
      render: (r) => <Caption1>{new Date(r.at).toLocaleString()}</Caption1>,
    },
    { key: 'who', label: 'Who', width: 200 },
    {
      key: 'kind',
      label: 'Kind',
      width: 220,
      render: (r) => <Badge appearance="outline" size="small">{r.kind}</Badge>,
    },
    {
      key: 'itemId',
      label: 'Target',
      width: 220,
      render: (r) => <span className={s.mono}>{r.itemId}</span>,
    },
    {
      key: 'change',
      label: 'Change',
      width: 320,
      getValue: (r) => describeChange(r),
      render: (r) => <span className={s.mono}>{describeChange(r)}</span>,
    },
  ], [s.mono]);

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
      <Body1 className={s.intro}>
        Every tenant-settings change, item save, share grant, app install, and admin action lands here.
        Backed by the Cosmos <code>audit-log</code> container.
      </Body1>

      {error && (
        <MessageBar intent="error" style={{ marginBottom: tokens.spacingVerticalL }}>
          <MessageBarBody>
            <MessageBarTitle>Could not load audit logs</MessageBarTitle>
            {error}
          </MessageBarBody>
        </MessageBar>
      )}

      <Section
        title="Audit events"
        actions={
          <>
            <Caption1 className={s.count}>{tableRows.length} entries</Caption1>
            <Button icon={<ArrowSync24Regular />} onClick={load} disabled={loading}>Refresh</Button>
            <Button icon={<ArrowDownload24Regular />} onClick={downloadCsv} disabled={!rows?.length}>Export CSV</Button>
          </>
        }
      >
        <Toolbar
          search={q}
          onSearch={setQ}
          searchPlaceholder="Search user, kind, item id, key…"
          actions={
            <div className={s.filters}>
              <Field label="Event type">
                <Dropdown
                  value={kind || 'All event types'}
                  selectedOptions={kind ? [kind] : ['']}
                  onOptionSelect={(_, d) => setKind(d.optionValue || '')}
                  style={{ minWidth: 200 }}
                >
                  <Option value="">All event types</Option>
                  {kinds.map((k) => (
                    <Option key={k} value={k}>{`${k} (${totals.get(k) || 0})`}</Option>
                  ))}
                </Dropdown>
              </Field>
              <Field label="Time range">
                <Dropdown
                  value={SINCE_OPTIONS.find((o) => o.value === since)?.label || 'All time'}
                  selectedOptions={[since]}
                  onOptionSelect={(_, d) => setSince(d.optionValue ?? '')}
                  style={{ minWidth: 160 }}
                >
                  {SINCE_OPTIONS.map((o) => (
                    <Option key={o.value || 'all'} value={o.value}>{o.label}</Option>
                  ))}
                </Dropdown>
              </Field>
            </div>
          }
        />

        {loading ? (
          <div className={s.loadingBox}>
            <Spinner label="Loading audit log…" />
          </div>
        ) : (
          <LoomDataTable
            columns={columns}
            rows={tableRows}
            getRowId={(r) => r.id}
            ariaLabel="Audit log"
            empty="No audit events match the current filters. Try a wider time range or a different event type."
          />
        )}
      </Section>
    </AdminShell>
  );
}
