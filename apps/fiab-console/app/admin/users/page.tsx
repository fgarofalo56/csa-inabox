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
  Spinner, Badge, Caption1, Body1, Button,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { ArrowSync24Regular, Open16Regular, Person24Regular } from '@fluentui/react-icons';
import { AdminShell } from '@/lib/components/admin-shell';
import { Section, Toolbar } from '@/lib/components/ui/section';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';

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
  intro: { color: tokens.colorNeutralForeground3, marginBottom: tokens.spacingVerticalL },
  userCell: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, minWidth: 0 },
  avatar: {
    flexShrink: 0, width: '32px', height: '32px', borderRadius: '50%',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    backgroundColor: tokens.colorBrandBackground2, color: tokens.colorBrandForeground1,
  },
  userText: { display: 'flex', flexDirection: 'column', minWidth: 0 },
  entraLink: { display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '12px' },
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

  const columns: LoomColumn<UserRow>[] = useMemo(() => [
    {
      key: 'user', label: 'User', width: 260,
      getValue: (u) => u.displayName || u.upn,
      render: (u) => (
        <span className={s.userCell}>
          <span className={s.avatar} aria-hidden><Person24Regular style={{ width: 18, height: 18 }} /></span>
          <span className={s.userText}>
            <strong title={u.displayName || u.upn} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {u.displayName || u.upn}
            </strong>
            {u.displayName && (
              <Caption1 style={{ color: tokens.colorNeutralForeground3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {u.upn}
              </Caption1>
            )}
          </span>
        </span>
      ),
    },
    { key: 'department', label: 'Department', width: 160, getValue: (u) => u.department || '',
      render: (u) => u.department || '—' },
    {
      key: 'roles', label: 'Roles', width: 200, sortable: false,
      getValue: (u) => u.roles.join(' '),
      render: (u) => u.roles.length
        ? u.roles.map((r) => <Badge key={r} appearance="outline" size="small" style={{ marginRight: 4 }}>{r}</Badge>)
        : <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>—</Caption1>,
    },
    { key: 'workspacesOwned', label: 'Workspaces', width: 150, getValue: (u) => u.workspacesOwned,
      render: (u) => <span><strong>{u.workspacesOwned}</strong> owned / {u.workspacesMember} member</span> },
    { key: 'itemsCreated', label: 'Items created', width: 130, getValue: (u) => u.itemsCreated,
      render: (u) => <strong>{u.itemsCreated}</strong> },
    { key: 'lastActivity', label: 'Last activity', width: 140,
      getValue: (u) => (u.lastActivity ? new Date(u.lastActivity).getTime() : 0),
      render: (u) => <Caption1>{u.lastActivity ? new Date(u.lastActivity).toLocaleDateString() : '—'}</Caption1> },
    {
      key: 'entra', label: 'Entra', width: 110, sortable: false, filterable: false,
      render: (u) => (
        <a
          href={`https://portal.azure.com/#view/Microsoft_AAD_UsersAndTenants/UserProfileMenuBlade/~/overview/userId/${encodeURIComponent(u.upn)}`}
          target="_blank" rel="noreferrer" className={s.entraLink} onClick={(e) => e.stopPropagation()}
        >
          Entra <Open16Regular />
        </a>
      ),
    },
  ], [s]);

  return (
    <AdminShell sectionTitle="Users, roles & licenses">
      <Body1 className={s.intro}>
        Users with access to this tenant&apos;s workspaces. Derived from Cosmos workspaces + items + workspace-permissions.
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
        <MessageBar intent="info" style={{ marginBottom: 16 }}>
          <MessageBarBody>
            Set <code>LOOM_GRAPH_USERS_ENABLED=true</code> and grant the Console UAMI
            <strong> Directory.Read.All</strong> in Microsoft Graph for display name + department enrichment.
            Without Graph, the page still shows UPN + activity + roles from Cosmos.
          </MessageBarBody>
        </MessageBar>
      )}

      {error && (
        <MessageBar intent="error" style={{ marginBottom: 16 }}>
          <MessageBarBody>
            <MessageBarTitle>Could not load users</MessageBarTitle>
            {error}
          </MessageBarBody>
        </MessageBar>
      )}

      <Section
        title="Users"
        actions={
          <>
            <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{filtered.length} users</Caption1>
            <Button icon={<ArrowSync24Regular />} onClick={load} disabled={loading}>Refresh</Button>
          </>
        }
      >
        <Toolbar search={q} onSearch={setQ} searchPlaceholder="Search by UPN, name, department, role…" />
        {loading && !error ? (
          <Spinner label="Loading users…" />
        ) : (
          <LoomDataTable
            columns={columns}
            rows={filtered}
            getRowId={(u) => u.upn}
            empty={q ? `No users match "${q}".` : 'No users have created workspaces or items yet.'}
            ariaLabel="Users"
          />
        )}
      </Section>
    </AdminShell>
  );
}
