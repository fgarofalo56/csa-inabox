'use client';

/**
 * ShareDialog — reusable per-item "Share" surface that mirrors the Azure portal
 * "Access control (IAM) → Role assignments" experience scoped to a single
 * Azure SQL database. Embedded inline in the SQL editor's Share tab (the `open`
 * prop gates the initial load; navigation is via the editor tab, not a modal).
 *
 * Real backend (per no-vaporware.md + ui-parity.md):
 *   - Principal picker → GET  /api/items/azure-sql-database/[id]/principal-search
 *                              (Microsoft Graph users/groups via the Console UAMI)
 *   - Current access   → GET  /api/items/azure-sql-database/[id]/share
 *   - Assign           → POST /api/items/azure-sql-database/[id]/share
 *                              (ARM PUT roleAssignment at the database scope)
 *   - Revoke           → DELETE …/share?assignmentId=<full ARM id>
 *
 * Honest 403: when the Console UAMI lacks the constrained RBAC-Admin grant
 * (sql-database-share-rbac.bicep), ARM returns 403 and it surfaces here verbatim
 * in a MessageBar — no fake success.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Subtitle2, Caption1, Badge, Button, Spinner, Skeleton, SkeletonItem, Input, Field,
  Dropdown, Option, Tooltip, Persona,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  TabList, Tab, makeStyles, tokens,
} from '@fluentui/react-components';
import {
  PeopleTeam20Regular, PersonAdd20Regular, Delete20Regular, Search20Regular, Copy20Regular,
  ShieldKeyhole20Regular,
} from '@fluentui/react-icons';
import { EmptyState } from '@/lib/components/empty-state';

const ROLE_OPTIONS = [
  { name: 'Reader', desc: 'View the database resource (control-plane read).' },
  { name: 'Contributor', desc: 'Manage the database resource (no access-grant rights).' },
  { name: 'SQL DB Contributor', desc: 'Manage SQL databases (not security policies / RBAC).' },
];

interface EntraPrincipal {
  id: string;
  type: 'user' | 'group';
  displayName: string;
  upn?: string;
  mail?: string;
  description?: string;
}

interface DbRoleAssignment {
  id: string;
  principalId: string;
  principalType?: string;
  roleDefinitionId: string;
  roleName?: string;
  createdOn?: string;
}

interface Props {
  /** Loom item id (path segment for the BFF routes). */
  itemId: string;
  /** Azure SQL logical server name. */
  server: string;
  /** Database name. */
  database: string;
  /** When false the panel skips its initial load (lazy until the tab is shown). */
  open: boolean;
}

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  card: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    padding: tokens.spacingVerticalL,
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
    transition: 'box-shadow 0.15s ease-in-out',
    ':hover': { boxShadow: tokens.shadow16 },
  },
  cardHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  headText: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, minWidth: 0 },
  headIcon: { display: 'inline-flex', color: tokens.colorBrandForeground1, flexShrink: 0 },
  hint: { color: tokens.colorNeutralForeground3 },
  searchRow: { display: 'grid', gridTemplateColumns: '160px minmax(0, 1fr) auto', gap: tokens.spacingHorizontalS, alignItems: 'end' },
  resultsWrap: { maxHeight: '200px', overflow: 'auto', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium, backgroundColor: tokens.colorNeutralBackground1 },
  resultRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`, cursor: 'pointer', borderBottom: `1px solid ${tokens.colorNeutralStroke3}` },
  selectedRow: { backgroundColor: tokens.colorBrandBackground2 },
  assignRow: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 220px auto', gap: tokens.spacingHorizontalS, alignItems: 'end' },
  tableWrap: { overflow: 'auto', maxHeight: '280px', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium },
  loadingWrap: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, padding: tokens.spacingVerticalM },
  refreshBtn: { marginLeft: 'auto' },
  badgeEnd: { marginLeft: 'auto' },
  mono: { fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase100, wordBreak: 'break-all' },
});

async function fetchJson(input: string, init?: RequestInit): Promise<any> {
  let r: Response;
  try { r = await fetch(input, init); }
  catch (e: any) { return { ok: false, status: 0, error: e?.message || String(e) }; }
  const ct = r.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    const text = await r.text().catch(() => '');
    return {
      ok: false, status: r.status,
      error: `Expected JSON from ${input} but received ${ct || 'unknown'} (HTTP ${r.status}). ` +
        (r.status === 401 || r.status === 403 ? 'Your session may have expired — sign in again.' : `First bytes: ${text.slice(0, 120)}`),
    };
  }
  try { return await r.json(); }
  catch (e: any) { return { ok: false, status: r.status, error: `Malformed JSON from ${input}: ${e?.message || String(e)}` }; }
}

export function ShareDialog({ itemId, server, database, open }: Props) {
  const s = useStyles();
  const base = `/api/items/azure-sql-database/${encodeURIComponent(itemId)}`;

  const [view, setView] = useState<'assign' | 'current'>('assign');

  // Principal search
  const [query, setQuery] = useState('');
  const [queryKind, setQueryKind] = useState<'user' | 'group'>('user');
  const [searchResults, setSearchResults] = useState<EntraPrincipal[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchRemediation, setSearchRemediation] = useState<string | null>(null);
  const [selectedPrincipal, setSelectedPrincipal] = useState<EntraPrincipal | null>(null);
  const [selectedRole, setSelectedRole] = useState<string>('Reader');

  // Assignments
  const [assignments, setAssignments] = useState<DbRoleAssignment[]>([]);
  const [loadingAssignments, setLoadingAssignments] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<DbRoleAssignment | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);

  const loadAssignments = useCallback(async () => {
    if (!server || !database) return;
    setLoadingAssignments(true); setListError(null);
    const j = await fetchJson(`${base}/share?server=${encodeURIComponent(server)}&database=${encodeURIComponent(database)}`);
    if (!j.ok) setListError(j.error || 'failed to list role assignments');
    else setAssignments(j.assignments || []);
    setLoadingAssignments(false);
  }, [base, server, database]);

  useEffect(() => { if (open && server && database) loadAssignments(); }, [open, server, database, loadAssignments]);

  // Debounced principal search.
  useEffect(() => {
    const term = query.trim();
    if (!term) { setSearchResults([]); setSearchError(null); setSearchRemediation(null); return; }
    let cancelled = false;
    setSearching(true);
    const h = setTimeout(async () => {
      const j = await fetchJson(`${base}/principal-search?q=${encodeURIComponent(term)}&kind=${queryKind}`);
      if (cancelled) return;
      if (!j.ok) {
        setSearchResults([]);
        setSearchError(j.error || 'principal search failed');
        setSearchRemediation(j.remediation || null);
      } else {
        setSearchResults(j.results || []);
        setSearchError(null);
        setSearchRemediation(null);
      }
      setSearching(false);
    }, 350);
    return () => { cancelled = true; clearTimeout(h); };
  }, [query, queryKind, base]);

  const assign = useCallback(async () => {
    if (!selectedPrincipal || !selectedRole) return;
    setBusy(true); setError(null); setReceipt(null);
    const j = await fetchJson(`${base}/share`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        server, database,
        principalId: selectedPrincipal.id,
        principalType: selectedPrincipal.type === 'group' ? 'Group' : 'User',
        roleNameOrGuid: selectedRole,
      }),
    });
    if (!j.ok) setError(j.error || 'role assignment failed');
    else {
      setReceipt(j.assignment || null);
      setSelectedPrincipal(null);
      setQuery('');
      setSearchResults([]);
      await loadAssignments();
    }
    setBusy(false);
  }, [base, server, database, selectedPrincipal, selectedRole, loadAssignments]);

  const revoke = useCallback(async (assignmentId: string) => {
    setRevoking(assignmentId); setError(null);
    const j = await fetchJson(`${base}/share?assignmentId=${encodeURIComponent(assignmentId)}`, { method: 'DELETE' });
    if (!j.ok) setError(j.error || 'revoke failed');
    else await loadAssignments();
    setRevoking(null);
  }, [base, loadAssignments]);

  return (
    <div className={s.root}>
      <MessageBar intent="info">
        <MessageBarBody>
          <MessageBarTitle>Share — Access control (IAM) for {database}</MessageBarTitle>
          Assign Azure RBAC roles to Entra users / groups at the database scope
          (<code>Microsoft.Sql/servers/{server}/databases/{database}</code>), mirroring the Azure portal
          Access control blade. Requires the Console UAMI to hold the constrained
          <strong> Role Based Access Control Administrator</strong> role (Reader / Contributor / SQL DB
          Contributor only) on the SQL server's resource group — deployed by
          <code> platform/fiab/bicep/modules/admin-plane/sql-database-share-rbac.bicep</code>.
          Without it ARM returns <code>403</code> and it surfaces below verbatim.
        </MessageBarBody>
      </MessageBar>

      <TabList selectedValue={view} onTabSelect={(_, d) => setView(d.value as any)}>
        <Tab value="assign" icon={<PersonAdd20Regular />}>Assign access</Tab>
        <Tab value="current" icon={<PeopleTeam20Regular />}>Current access ({assignments.length})</Tab>
      </TabList>

      {error && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Role assignment error</MessageBarTitle>{error}</MessageBarBody></MessageBar>}

      {view === 'assign' && (
        <div className={s.card}>
          <div className={s.cardHead}>
            <span className={s.headIcon}><Search20Regular /></span>
            <div className={s.headText}>
              <Subtitle2>Find a principal</Subtitle2>
              <Caption1 className={s.hint}>Search Entra ID for the user or group to grant access, then pick a role.</Caption1>
            </div>
          </div>
          <div className={s.searchRow}>
            <Field label="Principal type">
              <Dropdown selectedOptions={[queryKind]} value={queryKind === 'group' ? 'Group' : 'User'}
                onOptionSelect={(_, d) => { setQueryKind((d.optionValue as 'user' | 'group') || 'user'); setSearchResults([]); }}
                aria-label="Principal type">
                <Option value="user">User</Option>
                <Option value="group">Group</Option>
              </Dropdown>
            </Field>
            <Field label={`Search ${queryKind === 'group' ? 'groups' : 'users'} by name${queryKind === 'user' ? ' or UPN' : ''}`}>
              <Input value={query} onChange={(_, d) => setQuery(d.value)} placeholder="start typing a display name…"
                contentAfter={searching ? <Spinner size="tiny" /> : <Search20Regular />} />
            </Field>
            <div />
          </div>

          {searchError && (
            <MessageBar intent="warning">
              <MessageBarBody>
                <MessageBarTitle>Graph search unavailable</MessageBarTitle>
                {searchError}{searchRemediation && <><br /><code>{searchRemediation}</code></>}
              </MessageBarBody>
            </MessageBar>
          )}

          {searchResults.length > 0 && (
            <div className={s.resultsWrap}>
              {searchResults.map((p) => (
                <div
                  key={p.id}
                  className={`${s.resultRow} ${selectedPrincipal?.id === p.id ? s.selectedRow : ''}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => setSelectedPrincipal(p)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelectedPrincipal(p); } }}
                >
                  <Persona name={p.displayName} secondaryText={p.upn || p.mail || p.description || p.type} avatar={{ color: 'colorful' }} />
                  <Badge appearance="outline" className={s.badgeEnd}>{p.type}</Badge>
                </div>
              ))}
            </div>
          )}

          <div className={s.assignRow}>
            <Field label="Selected principal">
              <Input
                readOnly
                value={selectedPrincipal ? `${selectedPrincipal.displayName}${selectedPrincipal.upn ? ' · ' + selectedPrincipal.upn : ''}` : ''}
                placeholder="select a result above"
              />
            </Field>
            <Field label="Role" hint={ROLE_OPTIONS.find((r) => r.name === selectedRole)?.desc}>
              <Dropdown selectedOptions={[selectedRole]} value={selectedRole}
                onOptionSelect={(_, d) => setSelectedRole(d.optionValue || 'Reader')} aria-label="Role">
                {ROLE_OPTIONS.map((r) => <Option key={r.name} value={r.name} text={r.name}>{r.name}</Option>)}
              </Dropdown>
            </Field>
            <Button appearance="primary" icon={<PersonAdd20Regular />} disabled={busy || !selectedPrincipal || !selectedRole} onClick={assign}>
              {busy ? 'Assigning…' : 'Assign'}
            </Button>
          </div>

          {receipt && (
            <MessageBar intent="success">
              <MessageBarBody>
                <MessageBarTitle>Role assigned — {receipt.roleName || 'role'} granted</MessageBarTitle>
                Live ARM role assignment created. Assignment id:&nbsp;
                <code className={s.mono}>{receipt.id}</code>
                <Tooltip content="Copy assignment id" relationship="label">
                  <Button size="small" appearance="subtle" icon={<Copy20Regular />} aria-label="Copy assignment id"
                    onClick={() => navigator.clipboard?.writeText(receipt.id)} />
                </Tooltip>
              </MessageBarBody>
            </MessageBar>
          )}
        </div>
      )}

      {view === 'current' && (
        <div className={s.card}>
          <div className={s.cardHead}>
            <span className={s.headIcon}><PeopleTeam20Regular /></span>
            <div className={s.headText}>
              <Subtitle2>Role assignments at this database</Subtitle2>
              <Caption1 className={s.hint}>Live ARM role assignments scoped directly to this database.</Caption1>
            </div>
            <Button size="small" appearance="outline" onClick={loadAssignments} disabled={loadingAssignments} className={s.refreshBtn}>
              {loadingAssignments ? 'Refreshing…' : 'Refresh'}
            </Button>
          </div>
          {listError && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>List failed</MessageBarTitle>{listError}</MessageBarBody></MessageBar>}
          {loadingAssignments && assignments.length === 0 ? (
            <Skeleton aria-label="Loading role assignments" className={s.loadingWrap}>
              <SkeletonItem />
              <SkeletonItem />
              <SkeletonItem />
            </Skeleton>
          ) : !listError && assignments.length === 0 ? (
            <EmptyState
              icon={<ShieldKeyhole20Regular />}
              title="No role assignments at this scope"
              body="No Azure RBAC roles are declared directly at this database. Switch to Assign access to grant a user or group Reader, Contributor, or SQL DB Contributor here."
              primaryAction={{ label: 'Assign access', onClick: () => setView('assign') }}
            />
          ) : (
            <div className={s.tableWrap}>
              <Table size="small" aria-label="Database role assignments">
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>Principal (object id)</TableHeaderCell>
                    <TableHeaderCell>Type</TableHeaderCell>
                    <TableHeaderCell>Role</TableHeaderCell>
                    <TableHeaderCell>Action</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {assignments.map((a) => (
                    <TableRow key={a.id}>
                      <TableCell><code className={s.mono}>{a.principalId}</code></TableCell>
                      <TableCell>{a.principalType || '—'}</TableCell>
                      <TableCell>
                        {a.roleName
                          ? <Badge appearance="tint" color="brand">{a.roleName}</Badge>
                          : <code className={s.mono}>{a.roleDefinitionId.split('/').pop()}</code>}
                      </TableCell>
                      <TableCell>
                        <Tooltip content="Revoke this role assignment" relationship="label">
                          <Button size="small" appearance="subtle" icon={<Delete20Regular />}
                            aria-label={`Revoke ${a.roleName || 'role'} from ${a.principalId}`}
                            disabled={revoking === a.id} onClick={() => revoke(a.id)}>
                            {revoking === a.id ? 'Revoking…' : 'Revoke'}
                          </Button>
                        </Tooltip>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          <Caption1 className={s.hint}>Only role assignments declared directly at the database scope are shown. Inherited assignments (subscription / resource group / server) are managed at those scopes.</Caption1>
        </div>
      )}
    </div>
  );
}
