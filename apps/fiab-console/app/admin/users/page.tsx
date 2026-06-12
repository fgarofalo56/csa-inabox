'use client';

/**
 * /admin/users — REAL user inventory + license roll-up + workspace-role
 * expansion, backed by /api/admin/users.
 *
 * Derives the user list from Cosmos (workspace owners + item creators +
 * workspace-permissions assignments). When Microsoft Graph
 * Directory.Read.All + User.Read.All are granted to the Console UAMI +
 * LOOM_GRAPH_USERS_ENABLED is set:
 *   • tenant license SKUs roll up into stat cards (consumed / available)
 *   • each user shows displayName, department, account status, and assigned
 *     license SKU part-numbers
 *   • per-user workspace roles (from the F5 workspace-roles store) expand from
 *     the Roles cell
 *   • an "Open in M365 admin" deep-link points at the sovereign-correct admin
 *     center (admin.microsoft.com / .us / admin.apps.mil)
 * Works without Graph by default (UPN + activity + legacy roles from Cosmos).
 */

import { clientFetch } from '@/lib/client-fetch';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Spinner, Badge, Caption1, Body1, Button,
  MessageBar, MessageBarBody, MessageBarTitle,
  Popover, PopoverTrigger, PopoverSurface,
  makeStyles, tokens, mergeClasses,
} from '@fluentui/react-components';
import { ArrowSync24Regular, Open16Regular, Person24Regular, ChevronDown16Regular } from '@fluentui/react-icons';
import { AdminShell } from '@/lib/components/admin-shell';
import { Section, Toolbar } from '@/lib/components/ui/section';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';
import { useAdminTabStyles } from '@/lib/components/ui/admin-tab-styles';

interface TenantSubscribedSku {
  skuId: string;
  skuPartNumber: string;
  consumedUnits: number;
  prepaidUnits: { enabled: number; suspended: number; warning: number };
  capabilityStatus: string;
}

interface UserRow {
  upn: string;
  objectId?: string;
  displayName?: string;
  department?: string;
  accountEnabled?: boolean;
  workspacesOwned: number;
  workspacesMember: number;
  itemsCreated: number;
  lastActivity?: string;
  roles: string[];
  wsRoles: Array<{ workspaceId: string; role: string }>;
  licenses: string[];
  graphEnriched: boolean;
}

const useStyles = makeStyles({
  intro: { color: tokens.colorNeutralForeground3, marginBottom: tokens.spacingVerticalL },
  statsRow: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
    gap: tokens.spacingHorizontalL,
  },
  statCard: {
    padding: tokens.spacingVerticalL,
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
  },
  statVal: {
    fontSize: '28px',
    lineHeight: '32px',
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorBrandForeground1,
  },
  statLabel: {
    fontSize: '12px',
    color: tokens.colorNeutralForeground3,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  userCell: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, minWidth: 0 },
  avatar: {
    flexShrink: 0, width: '32px', height: '32px', borderRadius: '50%',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    backgroundColor: tokens.colorBrandBackground2, color: tokens.colorBrandForeground1,
  },
  userText: { display: 'flex', flexDirection: 'column', minWidth: 0 },
  adminLinks: { display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'center' },
  link: { display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '12px', color: tokens.colorBrandForeground1 },
  rolesCell: { display: 'flex', alignItems: 'center', gap: '4px', flexWrap: 'wrap' },
  expandBtn: {
    display: 'inline-flex', alignItems: 'center', gap: '2px', cursor: 'pointer',
    fontSize: '12px', color: tokens.colorBrandForeground1,
    background: 'none', border: 'none', padding: '2px 4px',
  },
  popoverSurface: { maxWidth: '420px', maxHeight: '360px', overflowY: 'auto' },
  wsRoleTable: { width: '100%', borderCollapse: 'collapse', fontSize: '13px' },
  wsRoleHeadCell: {
    textAlign: 'left', padding: '4px 8px', borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    color: tokens.colorNeutralForeground3, fontWeight: tokens.fontWeightSemibold,
  },
  wsRoleCell: { padding: '4px 8px', borderBottom: `1px solid ${tokens.colorNeutralStroke3}` },
  selfStart: { alignSelf: 'flex-start' },
});

function RoleExpansion({ user, graphEnabled, styles }: { user: UserRow; graphEnabled: boolean; styles: ReturnType<typeof useStyles> }) {
  const a = useAdminTabStyles();
  return (
    <Popover positioning="below-start" withArrow>
      <PopoverTrigger disableButtonEnhancement>
        <button
          type="button"
          className={styles.expandBtn}
          aria-label={`Show workspace roles for ${user.displayName || user.upn}`}
          onClick={(e) => e.stopPropagation()}
        >
          {user.wsRoles.length} ws-role{user.wsRoles.length === 1 ? '' : 's'} <ChevronDown16Regular />
        </button>
      </PopoverTrigger>
      <PopoverSurface className={styles.popoverSurface}>
        {user.wsRoles.length > 0 ? (
          <table className={styles.wsRoleTable}>
            <thead>
              <tr>
                <th className={styles.wsRoleHeadCell}>Workspace</th>
                <th className={styles.wsRoleHeadCell}>Role</th>
              </tr>
            </thead>
            <tbody>
              {user.wsRoles.map((wr, i) => (
                <tr key={`${wr.workspaceId}:${wr.role}:${i}`}>
                  <td className={styles.wsRoleCell}>
                    <a className={styles.link} href={`/workspaces/${encodeURIComponent(wr.workspaceId)}`}>
                      {wr.workspaceId}
                    </a>
                  </td>
                  <td className={styles.wsRoleCell}>
                    <Badge appearance="filled" color="brand" size="small">{wr.role}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : graphEnabled ? (
          <Caption1 className={a.muted}>
            No assignments in the workspace-roles store for this user.
          </Caption1>
        ) : (
          <Caption1 className={a.muted}>
            Enable Microsoft Graph (LOOM_GRAPH_USERS_ENABLED + User.Read.All) to
            resolve this user&apos;s Entra objectId and expand workspace-role assignments.
          </Caption1>
        )}
      </PopoverSurface>
    </Popover>
  );
}

export default function UsersPage() {
  const s = useStyles();
  const a = useAdminTabStyles();
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [subscribedSkus, setSubscribedSkus] = useState<TenantSubscribedSku[]>([]);
  const [m365AdminBase, setM365AdminBase] = useState('https://admin.microsoft.com');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [graphEnabled, setGraphEnabled] = useState(false);
  const [enrichedCount, setEnrichedCount] = useState(0);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await clientFetch('/api/admin/users');
      const j = await r.json();
      if (!j.ok) { setError(j.error || 'failed'); return; }
      setUsers(j.users || []);
      setSubscribedSkus(j.subscribedSkus || []);
      setM365AdminBase(j.m365AdminBase || 'https://admin.microsoft.com');
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
      u.roles.some((r) => r.toLowerCase().includes(f)) ||
      u.licenses.some((l) => l.toLowerCase().includes(f))
    );
  }, [users, q]);

  const columns: LoomColumn<UserRow>[] = useMemo(() => {
    const cols: LoomColumn<UserRow>[] = [
      {
        key: 'user', label: 'User', width: 250,
        getValue: (u) => u.displayName || u.upn,
        render: (u) => (
          <span className={s.userCell}>
            <span className={s.avatar} aria-hidden><Person24Regular className={a.iconSm} /></span>
            <span className={s.userText}>
              <strong title={u.displayName || u.upn} className={a.ellipsis}>
                {u.displayName || u.upn}
              </strong>
              {u.displayName && (
                <Caption1 className={mergeClasses(a.muted, a.ellipsis)}>
                  {u.upn}
                </Caption1>
              )}
            </span>
          </span>
        ),
      },
      { key: 'department', label: 'Department', width: 150, getValue: (u) => u.department || '',
        render: (u) => u.department || '—' },
    ];

    if (graphEnabled) {
      cols.push({
        key: 'account', label: 'Account', width: 110, sortable: true,
        getValue: (u) => (u.accountEnabled === false ? 'Disabled' : u.accountEnabled === true ? 'Active' : ''),
        render: (u) => u.accountEnabled === false
          ? <Badge appearance="tint" color="danger" size="small">Disabled</Badge>
          : u.accountEnabled === true
            ? <Badge appearance="tint" color="success" size="small">Active</Badge>
            : <Caption1 className={a.muted}>—</Caption1>,
      });
    }

    cols.push(
      {
        key: 'licenses', label: 'Licenses', width: 220, sortable: false,
        getValue: (u) => u.licenses.join(' '),
        render: (u) => u.licenses.length
          ? <span className={s.rolesCell}>{u.licenses.map((l) => <Badge key={l} appearance="filled" color="informative" size="small">{l}</Badge>)}</span>
          : <Caption1 className={a.muted}>—</Caption1>,
      },
      {
        key: 'roles', label: 'Roles', width: 230, sortable: false,
        getValue: (u) => u.roles.join(' '),
        render: (u) => (
          <span className={s.rolesCell}>
            {u.roles.length
              ? u.roles.map((r) => <Badge key={r} appearance="outline" size="small">{r}</Badge>)
              : <Caption1 className={a.muted}>—</Caption1>}
            {u.wsRoles.length > 0 && <RoleExpansion user={u} graphEnabled={graphEnabled} styles={s} />}
          </span>
        ),
      },
      { key: 'workspacesOwned', label: 'Workspaces', width: 150, getValue: (u) => u.workspacesOwned,
        render: (u) => <span><strong>{u.workspacesOwned}</strong> owned / {u.workspacesMember} member</span> },
      { key: 'itemsCreated', label: 'Items created', width: 120, getValue: (u) => u.itemsCreated,
        render: (u) => <strong>{u.itemsCreated}</strong> },
      { key: 'lastActivity', label: 'Last activity', width: 130,
        getValue: (u) => (u.lastActivity ? new Date(u.lastActivity).getTime() : 0),
        render: (u) => <Caption1>{u.lastActivity ? new Date(u.lastActivity).toLocaleDateString() : '—'}</Caption1> },
      {
        key: 'admin', label: 'Admin', width: 150, sortable: false, filterable: false,
        render: (u) => (
          <span className={s.adminLinks}>
            <a
              href={`https://portal.azure.com/#view/Microsoft_AAD_UsersAndTenants/UserProfileMenuBlade/~/overview/userId/${encodeURIComponent(u.upn)}`}
              target="_blank" rel="noreferrer" className={s.link} onClick={(e) => e.stopPropagation()}
            >
              Entra <Open16Regular />
            </a>
            <a
              href={u.objectId
                ? `${m365AdminBase}/Adminportal/Home#/users/:/UserDetails/${u.objectId}`
                : `${m365AdminBase}/Adminportal/Home#/users`}
              target="_blank" rel="noreferrer" className={s.link} onClick={(e) => e.stopPropagation()}
              title={u.objectId ? 'Open this user in the Microsoft 365 admin center' : 'Open the Microsoft 365 admin center users list (objectId requires Graph)'}
            >
              M365 <Open16Regular />
            </a>
          </span>
        ),
      },
    );
    return cols;
  }, [s, a, graphEnabled, m365AdminBase]);

  // License roll-up totals across all tenant SKUs.
  const licenseTotals = useMemo(() => {
    let consumed = 0; let enabled = 0;
    for (const sku of subscribedSkus) { consumed += sku.consumedUnits || 0; enabled += sku.prepaidUnits?.enabled || 0; }
    return { consumed, enabled };
  }, [subscribedSkus]);

  return (
    <AdminShell sectionTitle="Users, roles & licenses">
      <Body1 className={s.intro}>
        Users with access to this tenant&apos;s workspaces. Derived from Cosmos workspaces + items + workspace-permissions,
        enriched with Microsoft Graph identity, license assignments, and the F5 workspace-roles store.
        {graphEnabled ? (
          <Badge appearance="outline" color="brand" size="small" className={a.badgeGap}>
            Graph enriched: {enrichedCount}/{(users || []).length}
          </Badge>
        ) : (
          <Badge appearance="outline" color="informative" size="small" className={a.badgeGap}>
            Graph not enabled
          </Badge>
        )}
      </Body1>

      {!graphEnabled && (
        <MessageBar intent="info" className={a.messageBar}>
          <MessageBarBody>
            <MessageBarTitle>Enable identity + license enrichment</MessageBarTitle>
            Set <code>LOOM_GRAPH_USERS_ENABLED=true</code> and grant the Console UAMI
            <strong> Directory.Read.All</strong> + <strong>User.Read.All</strong> in Microsoft Graph
            (run <code>scripts/csa-loom/grant-uami-graph-roles.sh</code>) for display name, department,
            account status, license SKU assignments, and per-user workspace-role expansion.
            Without Graph, the page still shows UPN + activity + roles from Cosmos.
          </MessageBarBody>
        </MessageBar>
      )}

      {error && (
        <MessageBar intent="error" className={a.messageBar}>
          <MessageBarBody>
            <MessageBarTitle>Could not load users</MessageBarTitle>
            {error}
          </MessageBarBody>
        </MessageBar>
      )}

      {subscribedSkus.length > 0 && (
        <Section
          title="License inventory"
          actions={
            <Caption1 className={a.muted}>
              {licenseTotals.consumed} / {licenseTotals.enabled} seats assigned across {subscribedSkus.length} SKUs
            </Caption1>
          }
          bare
        >
          <div className={s.statsRow}>
            {subscribedSkus.map((sku) => (
              <div key={sku.skuId} className={s.statCard}>
                <div className={s.statVal}>{sku.consumedUnits}/{sku.prepaidUnits.enabled}</div>
                <div className={s.statLabel} title={sku.skuPartNumber}>{sku.skuPartNumber}</div>
                <Badge
                  appearance="outline"
                  color={sku.capabilityStatus === 'Enabled' ? 'success' : 'warning'}
                  size="small"
                  className={s.selfStart}
                >
                  {sku.capabilityStatus}
                </Badge>
              </div>
            ))}
          </div>
        </Section>
      )}

      <Section
        title="Users"
        actions={
          <>
            <Caption1 className={a.muted}>{filtered.length} users</Caption1>
            <Button icon={<ArrowSync24Regular />} onClick={load} disabled={loading}>Refresh</Button>
          </>
        }
      >
        <Toolbar search={q} onSearch={setQ} searchPlaceholder="Search by UPN, name, department, role, license…" />
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
