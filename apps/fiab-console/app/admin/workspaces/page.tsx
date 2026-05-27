'use client';

/**
 * /admin/workspaces — REAL tenant-wide workspace inventory. Backed by
 * /api/admin/workspaces which enumerates every workspace in the tenant
 * with item counts + last activity + capacity assignment.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Spinner, Badge, Caption1, Body1, Input, Button,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Search24Regular, ArrowSync24Regular, Open16Regular } from '@fluentui/react-icons';
import { AdminShell } from '@/lib/components/admin-shell';

interface Workspace {
  id: string; name: string; description?: string;
  createdBy?: string; createdAt?: string; updatedAt?: string;
  capacity?: string; domain?: string;
  itemCount: number; lastActivity?: string;
  state?: string;
}

const useStyles = makeStyles({
  toolbar: {
    display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12,
    paddingBottom: 12, borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  spacer: { flex: 1 },
  tableWrap: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: 8, overflow: 'auto',
  },
  empty: { padding: 32, color: tokens.colorNeutralForeground3, fontSize: 13, textAlign: 'center' },
});

export default function AdminWorkspacesPage() {
  const s = useStyles();
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await fetch('/api/admin/workspaces');
      const j = await r.json();
      if (!j.ok) { setError(j.error || 'failed'); return; }
      setWorkspaces(j.workspaces || []);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => {
    const f = q.toLowerCase().trim();
    if (!f) return workspaces || [];
    return (workspaces || []).filter((w) =>
      w.name.toLowerCase().includes(f) ||
      (w.description || '').toLowerCase().includes(f) ||
      (w.createdBy || '').toLowerCase().includes(f) ||
      (w.domain || '').toLowerCase().includes(f) ||
      (w.capacity || '').toLowerCase().includes(f)
    );
  }, [workspaces, q]);

  const totalItems = useMemo(() => (workspaces || []).reduce((s, w) => s + (w.itemCount || 0), 0), [workspaces]);

  return (
    <AdminShell sectionTitle="Workspaces (tenant-wide)">
      <Body1 style={{ color: tokens.colorNeutralForeground3, marginBottom: 12 }}>
        Every workspace in your tenant, regardless of owner. Item counts and last activity computed live from Cosmos.
      </Body1>

      <div className={s.toolbar}>
        <Input
          contentBefore={<Search24Regular />}
          placeholder="Search by name, owner, domain, capacity…"
          value={q}
          onChange={(_, d) => setQ(d.value)}
          style={{ flex: 1, maxWidth: 360 }}
        />
        <div className={s.spacer} />
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
          {filtered.length} workspaces · {totalItems} items total
        </Caption1>
        <Button icon={<ArrowSync24Regular />} onClick={load} disabled={loading}>Refresh</Button>
      </div>

      {error && (
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>Could not load workspaces</MessageBarTitle>
            {error}
          </MessageBarBody>
        </MessageBar>
      )}

      {loading && !error && <Spinner label="Loading workspaces…" />}

      {!loading && !error && filtered.length === 0 && (
        <div className={s.empty}>
          {q ? <>No workspaces match &ldquo;{q}&rdquo;.</> : <>No workspaces in this tenant yet. Create one from /workspaces.</>}
        </div>
      )}

      {!loading && !error && filtered.length > 0 && (
        <div className={s.tableWrap}>
          <Table aria-label="Workspaces">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Name</TableHeaderCell>
                <TableHeaderCell>Owner</TableHeaderCell>
                <TableHeaderCell>Capacity</TableHeaderCell>
                <TableHeaderCell>Domain</TableHeaderCell>
                <TableHeaderCell>Items</TableHeaderCell>
                <TableHeaderCell>Last activity</TableHeaderCell>
                <TableHeaderCell>State</TableHeaderCell>
                <TableHeaderCell></TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((w) => (
                <TableRow key={w.id}>
                  <TableCell>
                    <strong>{w.name}</strong>
                    {w.description && <div style={{ fontSize: 12, color: tokens.colorNeutralForeground3 }}>{w.description}</div>}
                  </TableCell>
                  <TableCell>{w.createdBy || '—'}</TableCell>
                  <TableCell>{w.capacity ? <Badge appearance="tint" size="small">{w.capacity}</Badge> : '—'}</TableCell>
                  <TableCell>{w.domain || '—'}</TableCell>
                  <TableCell><strong>{w.itemCount}</strong></TableCell>
                  <TableCell><Caption1>{w.lastActivity ? new Date(w.lastActivity).toLocaleString() : '—'}</Caption1></TableCell>
                  <TableCell>
                    <Badge appearance={w.state === 'Active' ? 'filled' : 'outline'} color="success" size="small">
                      {w.state || 'Active'}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <a
                      href={`/workspaces/${w.id}`}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12 }}
                    >
                      Open <Open16Regular />
                    </a>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </AdminShell>
  );
}
