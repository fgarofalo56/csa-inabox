'use client';

/**
 * /admin/users — REAL user inventory backed by /api/admin/users.
 *
 * Derives the user list from Cosmos (workspace owners + item creators +
 * workspace-permissions assignments). When Microsoft Graph
 * Directory.Read.All is granted to the Console UAMI + the
 * LOOM_GRAPH_USERS_ENABLED env var is set, display names + departments
 * are merged in. Works without Graph by default.
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

interface UserRow {
  upn: string;
  displayName?: string;
  department?: string;
  workspacesOwned: number;
  workspacesMember: number;
  itemsCreated: number;
  lastActivity?: string;
  roles: string[];
  graphEnriched: boolean;
}

const useStyles = makeStyles({
  toolbar: {
    display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12,
    paddingBottom: 12, borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  spacer: { flex: 1 },
  empty: { padding: 32, color: tokens.colorNeutralForeground3, fontSize: 13, textAlign: 'center' },
});

export default function UsersPage() {
  const s = useStyles();
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [graphEnabled, setGraphEnabled] = useState(false);
  const [enrichedCount, setEnrichedCount] = useState(0);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await fetch('/api/admin/users');
      const j = await r.json();
      if (!j.ok) { setError(j.error || 'failed'); return; }
      setUsers(j.users || []);
      setGraphEnabled(!!j.graphEnabled);
      setEnrichedCount(j.enrichedCount || 0);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => {
    const f = q.toLowerCase().trim();
    if (!f) return users || [];
    return (users || []).filter((u) =>
      u.upn.toLowerCase().includes(f) ||
      (u.displayName || '').toLowerCase().includes(f) ||
      (u.department || '').toLowerCase().includes(f) ||
      u.roles.some((r) => r.toLowerCase().includes(f))
    );
  }, [users, q]);

  return (
    <AdminShell sectionTitle="Users, roles & licenses">
      <Body1 style={{ color: tokens.colorNeutralForeground3, marginBottom: 12 }}>
        Users with access to this tenant's workspaces. Derived from Cosmos workspaces + items + workspace-permissions.
        {graphEnabled ? (
          <Badge appearance="outline" color="brand" size="small" style={{ marginLeft: 8 }}>
            Graph enriched: {enrichedCount}/{(users || []).length}
          </Badge>
        ) : (
          <Badge appearance="outline" color="informative" size="small" style={{ marginLeft: 8 }}>
            Graph not enabled
          </Badge>
        )}
      </Body1>

      {!graphEnabled && (
        <MessageBar intent="info" style={{ marginBottom: 12 }}>
          <MessageBarBody>
            Set <code>LOOM_GRAPH_USERS_ENABLED=true</code> and grant the Console UAMI
            <strong> Directory.Read.All</strong> in Microsoft Graph for display name + department enrichment.
            Without Graph, the page still shows UPN + activity + roles from Cosmos.
          </MessageBarBody>
        </MessageBar>
      )}

      <div className={s.toolbar}>
        <Input
          contentBefore={<Search24Regular />}
          placeholder="Search by UPN, name, department, role…"
          value={q}
          onChange={(_, d) => setQ(d.value)}
          style={{ flex: 1, maxWidth: 360 }}
        />
        <div className={s.spacer} />
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{filtered.length} users</Caption1>
        <Button icon={<ArrowSync24Regular />} onClick={load} disabled={loading}>Refresh</Button>
      </div>

      {error && (
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>Could not load users</MessageBarTitle>
            {error}
          </MessageBarBody>
        </MessageBar>
      )}

      {loading && !error && <Spinner label="Loading users…" />}

      {!loading && !error && filtered.length === 0 && (
        <div className={s.empty}>
          {q ? <>No users match &ldquo;{q}&rdquo;.</> : <>No users have created workspaces or items yet.</>}
        </div>
      )}

      {!loading && !error && filtered.length > 0 && (
        <Table aria-label="Users">
          <TableHeader>
            <TableRow>
              <TableHeaderCell>User</TableHeaderCell>
              <TableHeaderCell>Department</TableHeaderCell>
              <TableHeaderCell>Roles</TableHeaderCell>
              <TableHeaderCell>Workspaces (owned / member)</TableHeaderCell>
              <TableHeaderCell>Items created</TableHeaderCell>
              <TableHeaderCell>Last activity</TableHeaderCell>
              <TableHeaderCell></TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((u) => (
              <TableRow key={u.upn}>
                <TableCell>
                  <strong>{u.displayName || u.upn}</strong>
                  {u.displayName && (
                    <Caption1 style={{ display: 'block', color: tokens.colorNeutralForeground3 }}>{u.upn}</Caption1>
                  )}
                </TableCell>
                <TableCell>{u.department || '—'}</TableCell>
                <TableCell>
                  {u.roles.map((r) => (
                    <Badge key={r} appearance="outline" size="small" style={{ marginRight: 4 }}>{r}</Badge>
                  ))}
                </TableCell>
                <TableCell><strong>{u.workspacesOwned}</strong> / {u.workspacesMember}</TableCell>
                <TableCell><strong>{u.itemsCreated}</strong></TableCell>
                <TableCell>
                  <Caption1>{u.lastActivity ? new Date(u.lastActivity).toLocaleDateString() : '—'}</Caption1>
                </TableCell>
                <TableCell>
                  <a
                    href={`https://portal.azure.com/#view/Microsoft_AAD_UsersAndTenants/UserProfileMenuBlade/~/overview/userId/${encodeURIComponent(u.upn)}`}
                    target="_blank" rel="noreferrer"
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12 }}
                  >
                    Entra <Open16Regular />
                  </a>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </AdminShell>
  );
}
