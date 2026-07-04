'use client';

/**
 * SecureView — OneLake catalog **Secure** tab (access matrix).
 *
 * One-for-one with the Microsoft Fabric OneLake catalog Secure tab
 * (https://learn.microsoft.com/fabric/governance/secure-your-data), themed with
 * Fluent v9 + Loom tokens. Azure-native — NO Fabric / Power BI dependency: the
 * matrix is rolled up from real Azure RBAC role-assignments, ADLS Gen2 POSIX
 * ACLs (the Azure-native equivalent of OneLake security roles), the Cosmos
 * workspace-roles system-of-record, and (Commercial/GCC) Databricks Unity
 * Catalog grants — all via GET /api/onelake/security.
 *
 *   ┌────────────┬──────────────────────────────────────────────────┐
 *   │ Container  │  [View users]  [View security roles]   [Grant ▸]  │
 *   │ + Workspace├──────────────────────────────────────────────────┤
 *   │ selectors  │  Principal × access-level matrix / security roles  │
 *   │ (left rail)│  role-assignment summary · OneLake security roles  │
 *   └────────────┴──────────────────────────────────────────────────┘
 *
 * The Fabric two-sub-view model is preserved: "View users" (one row per unique
 * principal, columns = access level across each plane) and "View security
 * roles" (Storage RBAC roles + POSIX-ACL OneLake security roles). Granting a
 * Storage Blob Data role via the Grant dialog re-fetches the matrix so the new
 * principal appears (no mock principals — every row originates from a live
 * Azure plane).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Badge,
  Button,
  Caption1,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Dropdown,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Option,
  Persona,
  Spinner,
  Tab,
  TabList,
  Text,
  Title3,
  Tooltip,
  makeStyles,
  tokens,
  mergeClasses,
} from '@fluentui/react-components';
import {
  DatabaseStack16Regular,
  Open16Regular,
  PersonAdd20Regular,
  Search16Regular,
  ShieldKeyhole20Regular,
} from '@fluentui/react-icons';

import { Section } from '@/lib/components/ui/section';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';
import { NotConfiguredBar } from '@/lib/components/admin-security/not-configured-bar';

// ── shapes mirrored from /api/onelake/security ────────────────────────────────
interface MatrixRow {
  principalId: string;
  displayName: string;
  principalType: string;
  workspaceRole?: string;
  storageRbacRole?: string;
  storageRbacAssignmentId?: string;
  aclPermissions?: { read: boolean; write: boolean; execute: boolean };
  ucPrivileges?: string[];
}
interface AclItem {
  scope: 'access' | 'default';
  type: 'user' | 'group' | 'mask' | 'other';
  entityId?: string;
  permissions: { read: boolean; write: boolean; execute: boolean };
}
interface KnownRole {
  name: string;
  id: string;
}
interface SecurityResponse {
  ok: true;
  container: string;
  rbacAssignments: Array<{ principalId: string; roleName?: string; upn?: string }>;
  aclEntries: AclItem[];
  workspaceRoles: Array<{ principalId: string; role: string; displayName: string }>;
  ucGrants?: Array<{ principal: string; privileges: string[] }>;
  matrix: MatrixRow[];
  knownRoles: KnownRole[];
  knownContainers: string[];
  gates: { acl?: string; uc?: string; workspace?: string };
}

interface Workspace {
  id: string;
  name: string;
  itemCount?: number;
}
interface OwnedItem {
  id: string;
  itemType: string;
  workspaceId: string;
  displayName: string;
}

interface PrincipalHit {
  id: string;
  type: 'user' | 'group';
  displayName: string;
  upn?: string;
  mail?: string;
  description?: string;
}

const useStyles = makeStyles({
  layout: {
    display: 'grid',
    gridTemplateColumns: '240px minmax(0, 1fr)',
    gap: tokens.spacingHorizontalL,
    alignItems: 'start',
  },
  rail: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalL,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusXLarge,
    padding: tokens.spacingVerticalL,
    boxShadow: tokens.shadow2,
    position: 'sticky',
    top: tokens.spacingVerticalM,
  },
  railGroupLabel: {
    color: tokens.colorNeutralForeground3,
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    fontWeight: tokens.fontWeightSemibold,
    fontSize: '11px',
    marginBottom: tokens.spacingVerticalXS,
  },
  railList: { display: 'flex', flexDirection: 'column', gap: '2px' },
  railItem: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    width: '100%',
    textAlign: 'left',
    paddingTop: tokens.spacingVerticalXS,
    paddingBottom: tokens.spacingVerticalXS,
    paddingLeft: tokens.spacingHorizontalS,
    paddingRight: tokens.spacingHorizontalS,
    borderRadius: tokens.borderRadiusMedium,
    border: 'none',
    backgroundColor: 'transparent',
    color: tokens.colorNeutralForeground1,
    cursor: 'pointer',
    fontSize: tokens.fontSizeBase300,
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
  },
  railItemActive: {
    backgroundColor: tokens.colorBrandBackground2,
    color: tokens.colorBrandForeground2,
    fontWeight: tokens.fontWeightSemibold,
    ':hover': { backgroundColor: tokens.colorBrandBackground2 },
  },
  railItemText: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  main: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, minWidth: 0 },
  headRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: tokens.spacingHorizontalM,
    flexWrap: 'wrap',
  },
  summary: {
    display: 'flex',
    gap: tokens.spacingHorizontalL,
    flexWrap: 'wrap',
    padding: tokens.spacingVerticalM,
    backgroundColor: tokens.colorNeutralBackground2,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
  },
  stat: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 },
  statVal: { fontSize: tokens.fontSizeBase500, fontWeight: tokens.fontWeightSemibold, fontVariantNumeric: 'tabular-nums' },
  statKey: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  results: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    maxHeight: '220px',
    overflowY: 'auto',
    marginTop: tokens.spacingVerticalS,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
  },
  resultRow: { padding: tokens.spacingVerticalXS, borderRadius: tokens.borderRadiusSmall, cursor: 'pointer', ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover } },
  resultRowSelected: { backgroundColor: tokens.colorBrandBackground2 },
  permChips: { display: 'inline-flex', gap: '4px', flexWrap: 'wrap' },
  muted: { color: tokens.colorNeutralForeground3 },
});

function PermBadges({ p }: { p?: { read: boolean; write: boolean; execute: boolean } }) {
  const styles = useStyles();
  if (!p) return <span className={styles.muted}>—</span>;
  const bits: string[] = [];
  if (p.read) bits.push('r');
  if (p.write) bits.push('w');
  if (p.execute) bits.push('x');
  if (bits.length === 0) return <span className={styles.muted}>—</span>;
  return (
    <span className={styles.permChips}>
      {bits.map((b) => (
        <Badge key={b} size="small" appearance="tint" color="informative">{b}</Badge>
      ))}
    </span>
  );
}

// rough Read/ReadWrite mapping for the "Permission" column (parity w/ Fabric).
function rolePermission(roleName?: string): string {
  if (!roleName) return '—';
  if (/Reader/i.test(roleName)) return 'Read';
  return 'ReadWrite';
}

export function SecureView({ workspaces, items }: { workspaces: Workspace[]; items: OwnedItem[] }) {
  const styles = useStyles();

  const [knownContainers, setKnownContainers] = useState<string[]>([]);
  const [container, setContainer] = useState<string | null>(null);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [subView, setSubView] = useState<'users' | 'roles'>('users');

  const [data, setData] = useState<SecurityResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gate, setGate] = useState<{ surface: string; missing?: string; hint?: string } | null>(null);
  const [grantOpen, setGrantOpen] = useState(false);

  // location label for a container — the lakehouse item whose name matches.
  const wsName = useMemo(() => {
    const m = new Map<string, string>();
    for (const w of workspaces) m.set(w.id, w.name);
    return m;
  }, [workspaces]);

  // ── discover the container list (knownContainers) once ──
  useEffect(() => {
    let cancelled = false;
    fetch('/api/onelake/security', { cache: 'no-store' })
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        const list: string[] = Array.isArray(j?.knownContainers) ? j.knownContainers : [];
        setKnownContainers(list);
        setContainer((prev) => prev ?? list[0] ?? null);
      })
      .catch(() => { if (!cancelled) setKnownContainers([]); });
    return () => { cancelled = true; };
  }, []);

  const load = useCallback(async () => {
    if (!container) return;
    setLoading(true);
    setError(null);
    setGate(null);
    try {
      const qs = new URLSearchParams({ container });
      if (workspaceId) qs.set('workspaceId', workspaceId);
      const res = await fetch(`/api/onelake/security?${qs.toString()}`, { cache: 'no-store' });
      const json = await res.json();
      if (res.status === 503 && json?.gate) {
        setGate({ surface: json.surface || 'OneLake access', missing: json.missing, hint: json.hint });
        setData(null);
        return;
      }
      if (!res.ok || !json?.ok) {
        setError(json?.error || `HTTP ${res.status}`);
        setData(null);
        return;
      }
      setData(json as SecurityResponse);
    } catch (e: any) {
      setError(e?.message || String(e));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [container, workspaceId]);

  useEffect(() => { void load(); }, [load]);

  // ── columns: View users ──
  const userColumns: LoomColumn<MatrixRow>[] = useMemo(
    () => [
      {
        key: 'displayName',
        label: 'Principal',
        width: 260,
        getValue: (r) => r.displayName,
        render: (r) => <Persona name={r.displayName} size="extra-small" textPosition="after" avatar={{ color: 'colorful' }} secondaryText={r.principalType} />,
      },
      { key: 'principalType', label: 'Type', width: 110, getValue: (r) => r.principalType, render: (r) => <Badge size="small" appearance="outline">{r.principalType}</Badge> },
      {
        key: 'workspaceRole',
        label: 'Workspace role',
        width: 150,
        getValue: (r) => r.workspaceRole || '',
        render: (r) => (r.workspaceRole ? <Badge size="small" appearance="tint" color="brand">{r.workspaceRole}</Badge> : <span className={styles.muted}>—</span>),
      },
      {
        key: 'storageRbacRole',
        label: 'Storage RBAC',
        width: 210,
        getValue: (r) => r.storageRbacRole || '',
        render: (r) => (r.storageRbacRole ? <Badge size="small" appearance="tint" color="success">{r.storageRbacRole}</Badge> : <span className={styles.muted}>—</span>),
      },
      { key: 'acl', label: 'ACL (rwx)', width: 110, sortable: false, filterable: false, render: (r) => <PermBadges p={r.aclPermissions} /> },
      {
        key: 'uc',
        label: 'UC grants',
        width: 200,
        getValue: (r) => (r.ucPrivileges || []).join(' '),
        render: (r) =>
          r.ucPrivileges && r.ucPrivileges.length > 0 ? (
            <span className={styles.permChips}>{r.ucPrivileges.map((p) => <Badge key={p} size="small" appearance="outline" color="informative">{p}</Badge>)}</span>
          ) : (
            <span className={styles.muted}>—</span>
          ),
      },
    ],
    [styles.muted, styles.permChips],
  );

  // ── View security roles: derive Storage RBAC role rows + ACL (OneLake roles) ──
  interface RoleRow {
    role: string;
    permission: string;
    members: number;
    location: string;
  }
  const roleRows: RoleRow[] = useMemo(() => {
    if (!data) return [];
    const loc = data.container;
    const byRole = new Map<string, number>();
    for (const a of data.rbacAssignments) {
      if (!a.roleName) continue;
      byRole.set(a.roleName, (byRole.get(a.roleName) ?? 0) + 1);
    }
    return Array.from(byRole.entries()).map(([role, members]) => ({ role, permission: rolePermission(role), members, location: loc }));
  }, [data]);

  const roleColumns: LoomColumn<RoleRow>[] = useMemo(
    () => [
      { key: 'role', label: 'Role name', width: 240, getValue: (r) => r.role, render: (r) => <Text weight="semibold">{r.role}</Text> },
      { key: 'permission', label: 'Permission', width: 130, getValue: (r) => r.permission, render: (r) => <Badge size="small" appearance="tint" color={r.permission === 'Read' ? 'informative' : 'success'}>{r.permission}</Badge> },
      { key: 'members', label: 'Members', width: 110, getValue: (r) => r.members, render: (r) => String(r.members) },
      { key: 'location', label: 'Location', width: 180, getValue: (r) => r.location },
    ],
    [],
  );

  const aclRows = useMemo(() => (data?.aclEntries ?? []).filter((e) => e.scope === 'access'), [data]);
  const aclColumns: LoomColumn<AclItem>[] = useMemo(
    () => [
      { key: 'type', label: 'Type', width: 100, getValue: (r) => r.type, render: (r) => <Badge size="small" appearance="outline">{r.type}</Badge> },
      { key: 'entityId', label: 'Principal (OID)', width: 320, getValue: (r) => r.entityId || '', render: (r) => <code style={{ fontSize: tokens.fontSizeBase200 }}>{r.entityId || '(implicit)'}</code> },
      { key: 'perm', label: 'Permissions (rwx)', width: 140, sortable: false, filterable: false, render: (r) => <PermBadges p={r.permissions} /> },
    ],
    [],
  );

  const containerOptions = knownContainers.length > 0 ? knownContainers : ['bronze', 'silver', 'gold', 'landing', 'csv-imports'];

  return (
    <div className={styles.layout}>
      {/* LEFT — container + workspace selectors */}
      <nav className={styles.rail} aria-label="Secure scope">
        <div>
          <div className={styles.railGroupLabel}>Container (lakehouse zone)</div>
          <div className={styles.railList}>
            {containerOptions.map((c) => (
              <button
                key={c}
                type="button"
                className={mergeClasses(styles.railItem, container === c && styles.railItemActive)}
                aria-pressed={container === c}
                onClick={() => setContainer(c)}
              >
                <DatabaseStack16Regular />
                <span className={styles.railItemText}>{c}</span>
              </button>
            ))}
          </div>
        </div>

        <div>
          <div className={styles.railGroupLabel}>Workspace roles (optional)</div>
          <Field>
            <Dropdown
              placeholder="All / none"
              value={workspaceId ? (wsName.get(workspaceId) ?? workspaceId) : ''}
              selectedOptions={workspaceId ? [workspaceId] : []}
              onOptionSelect={(_e, d) => setWorkspaceId(d.optionValue === '__none__' ? null : (d.optionValue ?? null))}
            >
              <Option value="__none__">None</Option>
              {workspaces.map((w) => (
                <Option key={w.id} value={w.id}>{w.name}</Option>
              ))}
            </Dropdown>
          </Field>
          <Caption1 className={styles.muted} style={{ marginTop: tokens.spacingVerticalSNudge, display: 'block' }}>
            Roll up Admin/Member/Contributor/Viewer roles for the selected workspace.
          </Caption1>
        </div>
      </nav>

      {/* MAIN */}
      <div className={styles.main}>
        <div className={styles.headRow}>
          <TabList selectedValue={subView} onTabSelect={(_e, d) => setSubView(d.value as 'users' | 'roles')}>
            <Tab value="users">View users</Tab>
            <Tab value="roles">View security roles</Tab>
          </TabList>
          <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center' }}>
            <Button appearance="primary" icon={<PersonAdd20Regular />} disabled={!container} onClick={() => setGrantOpen(true)}>
              Grant access
            </Button>
            <Tooltip content="OneLake security roles (Microsoft Learn)" relationship="label">
              <Button
                appearance="subtle"
                icon={<Open16Regular />}
                as="a"
                href="https://learn.microsoft.com/fabric/governance/secure-your-data"
                target="_blank"
                aria-label="OneLake security docs"
              />
            </Tooltip>
          </div>
        </div>

        {gate && (
          <NotConfiguredBar
            surface={gate.surface}
            hint={{ missingEnvVar: gate.missing, followUp: gate.hint }}
          />
        )}
        {error && (
          <MessageBar intent="error">
            <MessageBarBody>
              <MessageBarTitle>Could not load access matrix</MessageBarTitle>
              {error}
            </MessageBarBody>
          </MessageBar>
        )}

        {loading && <Spinner label="Rolling up RBAC, ACL and workspace roles…" />}

        {data && !loading && (
          <>
            {/* role-assignment summary */}
            <div className={styles.summary} role="group" aria-label="Access summary">
              <div className={styles.stat}>
                <span className={styles.statVal}>{data.matrix.length}</span>
                <span className={styles.statKey}>Principals</span>
              </div>
              <div className={styles.stat}>
                <span className={styles.statVal}>{data.matrix.filter((m) => m.storageRbacRole).length}</span>
                <span className={styles.statKey}>With Storage RBAC</span>
              </div>
              <div className={styles.stat}>
                <span className={styles.statVal}>{data.matrix.filter((m) => m.workspaceRole).length}</span>
                <span className={styles.statKey}>With workspace role</span>
              </div>
              <div className={styles.stat}>
                <span className={styles.statVal}>{aclRows.length}</span>
                <span className={styles.statKey}>POSIX ACL entries</span>
              </div>
              <div className={styles.stat}>
                <span className={styles.statVal}>{data.ucGrants?.length ?? 0}</span>
                <span className={styles.statKey}>UC grants</span>
              </div>
            </div>

            {/* honest gates for ACL / UC / workspace planes */}
            {data.gates.acl && (
              <MessageBar intent="warning">
                <MessageBarBody><MessageBarTitle>POSIX ACLs</MessageBarTitle>{data.gates.acl}</MessageBarBody>
              </MessageBar>
            )}
            {data.gates.uc && (
              <MessageBar intent="info">
                <MessageBarBody><MessageBarTitle>Unity Catalog grants</MessageBarTitle>{data.gates.uc}</MessageBarBody>
              </MessageBar>
            )}
            {data.gates.workspace && (
              <MessageBar intent="warning">
                <MessageBarBody><MessageBarTitle>Workspace roles</MessageBarTitle>{data.gates.workspace}</MessageBarBody>
              </MessageBar>
            )}

            {subView === 'users' && (
              <Section title={`Who has access · ${data.container}`}>
                <LoomDataTable
                  columns={userColumns}
                  rows={data.matrix}
                  getRowId={(r) => r.principalId}
                  ariaLabel="Principal access matrix"
                  empty="No principals have access to this container yet. Use Grant access to assign a Storage Blob Data role."
                />
              </Section>
            )}

            {subView === 'roles' && (
              <>
                <Section title="Storage RBAC roles">
                  <LoomDataTable
                    columns={roleColumns}
                    rows={roleRows}
                    getRowId={(r) => r.role}
                    ariaLabel="Storage RBAC roles"
                    empty="No Storage Blob Data role assignments at this container scope."
                  />
                </Section>
                <Section title="OneLake security roles (POSIX ACLs)">
                  <Caption1 className={styles.muted} style={{ display: 'block', marginBottom: tokens.spacingVerticalS }}>
                    These POSIX ACL entries are the Azure-native equivalent of OneLake security roles on HNS-enabled ADLS Gen2 storage.
                  </Caption1>
                  <LoomDataTable
                    columns={aclColumns}
                    rows={aclRows}
                    getRowId={(r) => `${r.scope}:${r.type}:${r.entityId ?? ''}`}
                    ariaLabel="POSIX ACL entries"
                    empty={data.gates.acl ? 'POSIX ACLs not available — see the message above.' : 'No explicit POSIX ACL entries on the container root.'}
                  />
                </Section>
              </>
            )}
          </>
        )}
      </div>

      {container && (
        <GrantDialog
          open={grantOpen}
          container={container}
          knownRoles={data?.knownRoles ?? []}
          onClose={() => setGrantOpen(false)}
          onGranted={() => { setGrantOpen(false); void load(); }}
        />
      )}
    </div>
  );
}

// ── Grant dialog — Entra principal search + Storage Blob Data role → POST ──────
function GrantDialog({
  open,
  container,
  knownRoles,
  onClose,
  onGranted,
}: {
  open: boolean;
  container: string;
  knownRoles: KnownRole[];
  onClose: () => void;
  onGranted: () => void;
}) {
  const styles = useStyles();
  const [kind, setKind] = useState<'user' | 'group'>('user');
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<PrincipalHit[]>([]);
  const [selected, setSelected] = useState<PrincipalHit | null>(null);
  const [role, setRole] = useState<string>('Storage Blob Data Reader');
  const [searching, setSearching] = useState(false);
  const [searchGate, setSearchGate] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const roleOptions = knownRoles.length > 0
    ? knownRoles.map((r) => r.name)
    : ['Storage Blob Data Reader', 'Storage Blob Data Contributor', 'Storage Blob Data Owner'];

  useEffect(() => {
    if (open) { setQ(''); setHits([]); setSelected(null); setRole(roleOptions[0]); setError(null); setSearchGate(null); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open || !q.trim()) { setHits([]); setSearchGate(null); return; }
    const handle = setTimeout(async () => {
      setSearching(true); setSearchGate(null);
      try {
        const res = await fetch(`/api/admin/permissions/principals?q=${encodeURIComponent(q)}&kind=${kind}`, { cache: 'no-store' });
        const json = await res.json();
        if (!res.ok || !json.ok) {
          setSearchGate(json?.error || `Graph ${res.status}`);
          setHits([]);
        } else {
          setHits(json.results || []);
        }
      } catch (e: any) {
        setSearchGate(e?.message || String(e));
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => clearTimeout(handle);
  }, [q, kind, open]);

  const submit = useCallback(async () => {
    if (!selected) return;
    setSaving(true); setError(null);
    try {
      const res = await fetch('/api/onelake/security', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          container,
          principalId: selected.id,
          principalType: selected.type === 'group' ? 'Group' : 'User',
          role,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) { setError(json?.error || `HTTP ${res.status}`); return; }
      onGranted();
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setSaving(false);
    }
  }, [selected, role, container, onGranted]);

  return (
    <Dialog open={open} onOpenChange={(_e, d) => { if (!d.open) onClose(); }} modalType="modal">
      <DialogSurface>
        <DialogBody>
          <DialogTitle>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalS }}>
              <ShieldKeyhole20Regular /> Grant container access — {container}
            </span>
          </DialogTitle>
          <DialogContent>
            <TabList selectedValue={kind} onTabSelect={(_e, d) => { setKind(d.value as 'user' | 'group'); setSelected(null); }}>
              <Tab value="user">User</Tab>
              <Tab value="group">Group</Tab>
            </TabList>
            <Field label="Search Entra" style={{ marginTop: tokens.spacingVerticalM }}>
              <Input value={q} onChange={(_e, d) => setQ(d.value)} contentBefore={<Search16Regular />}
                placeholder={kind === 'user' ? 'Display name or UPN' : 'Group display name'} />
            </Field>

            {searchGate && (
              <MessageBar intent="warning" style={{ marginTop: tokens.spacingVerticalM }}>
                <MessageBarBody><MessageBarTitle>{searchGate}</MessageBarTitle></MessageBarBody>
              </MessageBar>
            )}

            <div className={styles.results}>
              {searching && <Spinner size="tiny" label="Searching Entra…" />}
              {!searching && hits.length === 0 && q.trim() && !searchGate && (
                <div style={{ padding: tokens.spacingVerticalS, color: tokens.colorNeutralForeground3 }}>No matches.</div>
              )}
              {hits.map((h) => (
                <div key={h.id}
                  className={mergeClasses(styles.resultRow, selected?.id === h.id && styles.resultRowSelected)}
                  onClick={() => setSelected(h)}
                  role="button" tabIndex={0}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setSelected(h); }}>
                  <Persona name={h.displayName} secondaryText={h.upn || h.mail || h.description || h.type} avatar={{ color: 'colorful' }} />
                </div>
              ))}
            </div>

            <Field label="Storage role" style={{ marginTop: tokens.spacingVerticalL }}>
              <Dropdown value={role} selectedOptions={[role]} onOptionSelect={(_e, d) => setRole(d.optionValue || roleOptions[0])}>
                {roleOptions.map((r) => (
                  <Option key={r} value={r}>{r}</Option>
                ))}
              </Dropdown>
            </Field>

            {error && (
              <MessageBar intent="error" style={{ marginTop: tokens.spacingVerticalM }}>
                <MessageBarBody>{error}</MessageBarBody>
              </MessageBar>
            )}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>Cancel</Button>
            <Button appearance="primary" onClick={submit} disabled={!selected || saving}>
              {saving ? 'Granting…' : 'Grant'}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
