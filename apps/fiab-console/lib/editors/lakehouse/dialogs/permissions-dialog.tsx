'use client';
import {
  Caption1, Body1, Badge, Button, Spinner, tokens, Subtitle2, Checkbox,
  MessageBar, MessageBarBody, MessageBarTitle,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  Tab, TabList, Field, Input, Dropdown, Option,
} from '@fluentui/react-components';
import { OnelakeRlsPredicateEditor } from '@/lib/panes/onelake-security-tab';
import { useStyles } from '../shared';
import { useLakehouseCtx } from '../lakehouse-editor-context';
import type { PermsTab } from '../types';

export function PermissionsDialog() {
  const s = useStyles();
  const ctx = useLakehouseCtx();
  const {
    permsOpen, setPermsOpen, permsTab, selectPermsTab,
    permsBusy, permsError, sqlGate,
    permsRows, permsRoles, revokePerm, grantPerm,
    newPrincipalId, setNewPrincipalId, newPrincipalType, setNewPrincipalType, newRole, setNewRole,
    sqlGrants, revokeSqlGrant, grantSqlTable, grantSqlColumn,
    sqlTables, selTableId, onPickTable,
    sqlCols, selColIds, toggleCol,
    rlsPolicies, rlsFilterColId, setRlsFilterColId, rlsSubject, setRlsSubject,
    createRls, dropRls, loadSqlPerms,
    selectedPrincipal, setSelectedPrincipal, principalQuery, setPrincipalQuery,
    principalBusy, principalResults, setPrincipalResults,
    activeContainer,
  } = ctx;

  const renderPrincipalPicker = () => (
    <Field label="Principal (Entra user)" required>
      {selectedPrincipal ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS }}>
          <Badge appearance="tint" color="brand">{selectedPrincipal.upn}</Badge>
          <Button size="small" appearance="subtle" onClick={() => { setSelectedPrincipal(null); setPrincipalQuery(''); }}>Change</Button>
        </div>
      ) : (
        <div style={{ position: 'relative' }}>
          <Input
            value={principalQuery}
            onChange={(_, d) => setPrincipalQuery(d.value)}
            placeholder="Search by name or UPN…"
            contentAfter={principalBusy ? <Spinner size="extra-tiny" /> : undefined}
          />
          {principalResults.length > 0 && (
            <div style={{ position: 'absolute', zIndex: 10, top: '100%', left: 0, right: 0, maxHeight: 200, overflow: 'auto', background: tokens.colorNeutralBackground1, border: `1px solid ${tokens.colorNeutralStroke1}`, borderRadius: tokens.borderRadiusMedium, boxShadow: tokens.shadow8 }}>
              {principalResults.map((p) => (
                <div
                  key={p.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => { setSelectedPrincipal(p); setPrincipalResults([]); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') { setSelectedPrincipal(p); setPrincipalResults([]); } }}
                  style={{ padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`, cursor: 'pointer' }}
                  className={s.rowHover}
                >
                  <Body1>{p.displayName}</Body1>
                  <Caption1 style={{ display: 'block', color: tokens.colorNeutralForeground3 }}>{p.upn}</Caption1>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Field>
  );

  return (
    <Dialog open={permsOpen} onOpenChange={(_, d) => setPermsOpen(d.open)}>
      <DialogSurface style={{ maxWidth: '1000px', width: '92vw' }}>
        <DialogBody>
          <DialogTitle>Permissions — {activeContainer}</DialogTitle>
          <DialogContent>
            <TabList
              selectedValue={permsTab}
              onTabSelect={(_, d) => selectPermsTab(d.value as PermsTab)}
              style={{ marginBottom: tokens.spacingVerticalM }}
            >
              <Tab value="object">Object (RBAC)</Tab>
              <Tab value="table">Table</Tab>
              <Tab value="column">Column</Tab>
              <Tab value="row">Row</Tab>
            </TabList>

            {permsBusy && <Spinner size="tiny" label="Working…" labelPosition="after" />}
            {permsError && (
              <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Permissions error</MessageBarTitle>{permsError}</MessageBarBody></MessageBar>
            )}
            {permsTab !== 'object' && sqlGate && (
              <MessageBar intent="warning">
                <MessageBarBody>
                  <MessageBarTitle>Synapse Dedicated SQL pool not configured</MessageBarTitle>
                  Set <code>{sqlGate.missing}</code>. {sqlGate.hint}
                </MessageBarBody>
              </MessageBar>
            )}

            {/* ── Object (container RBAC) ── */}
            {permsTab === 'object' && (
              <>
                <Caption1>
                  Azure RBAC role assignments scoped to the container. Storage Blob Data
                  Reader/Contributor/Owner govern data-plane access (read/write/manage).
                </Caption1>
                <div style={{ overflow: 'auto', margin: `${tokens.spacingVerticalS} 0 ${tokens.spacingVerticalM}` }}>
                  <Table aria-label="Role assignments" size="small">
                    <TableHeader><TableRow>
                      <TableHeaderCell>Principal</TableHeaderCell>
                      <TableHeaderCell>Type</TableHeaderCell>
                      <TableHeaderCell>Role</TableHeaderCell>
                      <TableHeaderCell>Action</TableHeaderCell>
                    </TableRow></TableHeader>
                    <TableBody>
                      {permsRows.length === 0 && (
                        <TableRow><TableCell colSpan={4}><Caption1>No Storage Blob Data role assignments at the container scope.</Caption1></TableCell></TableRow>
                      )}
                      {permsRows.map((r) => (
                        <TableRow key={r.id}>
                          <TableCell>{r.upn ? <span>{r.upn}</span> : <code style={{ fontSize: tokens.fontSizeBase100 }}>{r.principalId?.slice(0, 8)}…</code>}</TableCell>
                          <TableCell>{r.principalType || '—'}</TableCell>
                          <TableCell>{r.roleName || '—'}</TableCell>
                          <TableCell><Button size="small" appearance="subtle" disabled={permsBusy} onClick={() => revokePerm(r.id)}>Revoke</Button></TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
                <Subtitle2>Grant access</Subtitle2>
                <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,2fr) minmax(0,1fr) minmax(0,2fr)', gap: tokens.spacingHorizontalM, marginTop: tokens.spacingVerticalS }}>
                  <Field label="Principal object id" required>
                    <Input value={newPrincipalId} onChange={(_, d) => setNewPrincipalId(d.value)} placeholder="11111111-2222-3333-4444-555555555555" />
                  </Field>
                  <Field label="Principal type">
                    <Dropdown
                      selectedOptions={[newPrincipalType]}
                      value={newPrincipalType}
                      onOptionSelect={(_, d) => setNewPrincipalType((d.optionValue as 'User' | 'Group' | 'ServicePrincipal') || 'User')}
                    >
                      <Option value="User">User</Option>
                      <Option value="Group">Group</Option>
                      <Option value="ServicePrincipal">ServicePrincipal</Option>
                    </Dropdown>
                  </Field>
                  <Field label="Role">
                    <Dropdown
                      selectedOptions={[newRole]}
                      value={newRole}
                      onOptionSelect={(_, d) => setNewRole(d.optionValue || newRole)}
                    >
                      {permsRoles.map((r) => (
                        <Option key={r.name} value={r.name}>{r.name}</Option>
                      ))}
                    </Dropdown>
                  </Field>
                </div>
                <div style={{ marginTop: tokens.spacingVerticalM, display: 'flex', justifyContent: 'flex-end' }}>
                  <Button appearance="primary" onClick={grantPerm} disabled={permsBusy || !newPrincipalId.trim()}>
                    {permsBusy ? 'Working…' : 'Grant role'}
                  </Button>
                </div>
              </>
            )}

            {/* ── Table-level SELECT ── */}
            {permsTab === 'table' && !sqlGate && (
              <>
                <Caption1>
                  Object-level <code>GRANT SELECT</code> on a Synapse Dedicated SQL pool table/view.
                  Principals are Entra users (UPN); the database user is created
                  <code> FROM EXTERNAL PROVIDER</code> on first grant.
                </Caption1>
                <div style={{ overflow: 'auto', margin: `${tokens.spacingVerticalS} 0 ${tokens.spacingVerticalM}` }}>
                  <Table aria-label="Table grants" size="small">
                    <TableHeader><TableRow>
                      <TableHeaderCell>Principal (UPN)</TableHeaderCell>
                      <TableHeaderCell>Schema.Table</TableHeaderCell>
                      <TableHeaderCell>Permission</TableHeaderCell>
                      <TableHeaderCell>Action</TableHeaderCell>
                    </TableRow></TableHeader>
                    <TableBody>
                      {sqlGrants.filter((g) => g.column == null).length === 0 && (
                        <TableRow><TableCell colSpan={4}><Caption1>No table-level SELECT grants.</Caption1></TableCell></TableRow>
                      )}
                      {sqlGrants.filter((g) => g.column == null).map((g, i) => (
                        <TableRow key={`${g.principal}.${g.schema}.${g.table}.${i}`}>
                          <TableCell>{g.principal}</TableCell>
                          <TableCell>{g.schema}.{g.table}</TableCell>
                          <TableCell>{g.permissionName}</TableCell>
                          <TableCell><Button size="small" appearance="subtle" disabled={permsBusy} onClick={() => revokeSqlGrant(g)}>Revoke</Button></TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
                <Subtitle2>Grant table SELECT</Subtitle2>
                <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: tokens.spacingHorizontalM, marginTop: tokens.spacingVerticalS }}>
                  {renderPrincipalPicker()}
                  <Field label="Table / view" required>
                    <Dropdown
                      placeholder="Select a table"
                      selectedOptions={selTableId != null ? [String(selTableId)] : []}
                      value={selTableId != null ? (sqlTables.find((t) => t.objectId === selTableId) ? `${sqlTables.find((t) => t.objectId === selTableId)!.schema}.${sqlTables.find((t) => t.objectId === selTableId)!.name}` : '') : ''}
                      onOptionSelect={(_, d) => onPickTable(d.optionValue ? Number(d.optionValue) : null)}
                    >
                      {sqlTables.map((t) => (
                        <Option key={t.objectId} value={String(t.objectId)} text={`${t.schema}.${t.name}`}>{t.schema}.{t.name}{t.type === 'V' ? ' (view)' : ''}</Option>
                      ))}
                    </Dropdown>
                  </Field>
                </div>
                <div style={{ marginTop: tokens.spacingVerticalM, display: 'flex', justifyContent: 'flex-end' }}>
                  <Button appearance="primary" onClick={grantSqlTable} disabled={permsBusy || !selectedPrincipal || selTableId == null}>
                    Grant SELECT
                  </Button>
                </div>
              </>
            )}

            {/* ── Column-level SELECT ── */}
            {permsTab === 'column' && !sqlGate && (
              <>
                <Caption1>
                  Column-level <code>GRANT SELECT</code> restricts a principal to specific columns of a
                  table/view. Pick a table, then check the columns to expose.
                </Caption1>
                <div style={{ overflow: 'auto', margin: `${tokens.spacingVerticalS} 0 ${tokens.spacingVerticalM}` }}>
                  <Table aria-label="Column grants" size="small">
                    <TableHeader><TableRow>
                      <TableHeaderCell>Principal (UPN)</TableHeaderCell>
                      <TableHeaderCell>Schema.Table</TableHeaderCell>
                      <TableHeaderCell>Column</TableHeaderCell>
                      <TableHeaderCell>Action</TableHeaderCell>
                    </TableRow></TableHeader>
                    <TableBody>
                      {sqlGrants.filter((g) => g.column != null).length === 0 && (
                        <TableRow><TableCell colSpan={4}><Caption1>No column-level SELECT grants.</Caption1></TableCell></TableRow>
                      )}
                      {sqlGrants.filter((g) => g.column != null).map((g, i) => (
                        <TableRow key={`${g.principal}.${g.schema}.${g.table}.${g.column}.${i}`}>
                          <TableCell>{g.principal}</TableCell>
                          <TableCell>{g.schema}.{g.table}</TableCell>
                          <TableCell>{g.column}</TableCell>
                          <TableCell><Button size="small" appearance="subtle" disabled={permsBusy} onClick={() => revokeSqlGrant(g)}>Revoke</Button></TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
                <Subtitle2>Grant column SELECT</Subtitle2>
                <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: tokens.spacingHorizontalM, marginTop: tokens.spacingVerticalS }}>
                  {renderPrincipalPicker()}
                  <Field label="Table / view" required>
                    <Dropdown
                      placeholder="Select a table"
                      selectedOptions={selTableId != null ? [String(selTableId)] : []}
                      value={selTableId != null && sqlTables.find((t) => t.objectId === selTableId) ? `${sqlTables.find((t) => t.objectId === selTableId)!.schema}.${sqlTables.find((t) => t.objectId === selTableId)!.name}` : ''}
                      onOptionSelect={(_, d) => onPickTable(d.optionValue ? Number(d.optionValue) : null)}
                    >
                      {sqlTables.map((t) => (
                        <Option key={t.objectId} value={String(t.objectId)} text={`${t.schema}.${t.name}`}>{t.schema}.{t.name}{t.type === 'V' ? ' (view)' : ''}</Option>
                      ))}
                    </Dropdown>
                  </Field>
                </div>
                {selTableId != null && (
                  <div style={{ marginTop: tokens.spacingVerticalM }}>
                    <Caption1>Columns to expose ({selColIds.length} selected)</Caption1>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0,1fr))', gap: tokens.spacingHorizontalXS, maxHeight: 200, overflow: 'auto', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium, padding: tokens.spacingVerticalS, marginTop: tokens.spacingVerticalXS }}>
                      {sqlCols.length === 0 && <Caption1>No columns.</Caption1>}
                      {sqlCols.map((c) => (
                        <Checkbox
                          key={c.columnId}
                          label={`${c.name} (${c.dataType})`}
                          checked={selColIds.includes(c.columnId)}
                          onChange={(_, d) => toggleCol(c.columnId, !!d.checked)}
                        />
                      ))}
                    </div>
                  </div>
                )}
                <div style={{ marginTop: tokens.spacingVerticalM, display: 'flex', justifyContent: 'flex-end' }}>
                  <Button appearance="primary" onClick={grantSqlColumn} disabled={permsBusy || !selectedPrincipal || selTableId == null || selColIds.length === 0}>
                    Grant column SELECT
                  </Button>
                </div>
              </>
            )}

            {/* ── Row-level security ── */}
            {permsTab === 'row' && !sqlGate && (
              <>
                <Caption1>
                  Row-level security applies a <code>SECURITY POLICY</code> + inline filter predicate so a
                  principal only sees rows whose filter column matches their identity. Dedicated SQL pool only.
                </Caption1>
                <div style={{ overflow: 'auto', margin: `${tokens.spacingVerticalS} 0 ${tokens.spacingVerticalM}` }}>
                  <Table aria-label="Security policies" size="small">
                    <TableHeader><TableRow>
                      <TableHeaderCell>Policy</TableHeaderCell>
                      <TableHeaderCell>Target table</TableHeaderCell>
                      <TableHeaderCell>Enabled</TableHeaderCell>
                      <TableHeaderCell>Action</TableHeaderCell>
                    </TableRow></TableHeader>
                    <TableBody>
                      {rlsPolicies.length === 0 && (
                        <TableRow><TableCell colSpan={4}><Caption1>No row-level security policies.</Caption1></TableCell></TableRow>
                      )}
                      {rlsPolicies.map((p) => (
                        <TableRow key={p.policyObjectId}>
                          <TableCell>{p.policySchema}.{p.policyName}</TableCell>
                          <TableCell>{p.schema}.{p.table}</TableCell>
                          <TableCell>{p.isEnabled ? 'Yes' : 'No'}</TableCell>
                          <TableCell><Button size="small" appearance="subtle" disabled={permsBusy} onClick={() => dropRls(p)}>Drop</Button></TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
                <Subtitle2>Create row-level security policy</Subtitle2>
                <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr) minmax(0,1fr)', gap: tokens.spacingHorizontalM, marginTop: tokens.spacingVerticalS }}>
                  <Field label="Table" required>
                    <Dropdown
                      placeholder="Select a table"
                      selectedOptions={selTableId != null ? [String(selTableId)] : []}
                      value={selTableId != null && sqlTables.find((t) => t.objectId === selTableId) ? `${sqlTables.find((t) => t.objectId === selTableId)!.schema}.${sqlTables.find((t) => t.objectId === selTableId)!.name}` : ''}
                      onOptionSelect={(_, d) => onPickTable(d.optionValue ? Number(d.optionValue) : null)}
                    >
                      {sqlTables.filter((t) => t.type === 'U').map((t) => (
                        <Option key={t.objectId} value={String(t.objectId)} text={`${t.schema}.${t.name}`}>{t.schema}.{t.name}</Option>
                      ))}
                    </Dropdown>
                  </Field>
                  <Field label="Filter column" required>
                    <Dropdown
                      placeholder="Select a column"
                      selectedOptions={rlsFilterColId != null ? [String(rlsFilterColId)] : []}
                      value={rlsFilterColId != null && sqlCols.find((c) => c.columnId === rlsFilterColId) ? sqlCols.find((c) => c.columnId === rlsFilterColId)!.name : ''}
                      onOptionSelect={(_, d) => setRlsFilterColId(d.optionValue ? Number(d.optionValue) : null)}
                      disabled={selTableId == null}
                    >
                      {sqlCols.map((c) => (
                        <Option key={c.columnId} value={String(c.columnId)} text={c.name}>{c.name} ({c.dataType})</Option>
                      ))}
                    </Dropdown>
                  </Field>
                  <Field label="Match against">
                    <Dropdown
                      selectedOptions={[rlsSubject]}
                      value={rlsSubject}
                      onOptionSelect={(_, d) => setRlsSubject((d.optionValue as 'USER_NAME()' | 'SUSER_SNAME()') || 'USER_NAME()')}
                    >
                      <Option value="USER_NAME()" text="USER_NAME()">USER_NAME() — DB user (UPN)</Option>
                      <Option value="SUSER_SNAME()" text="SUSER_SNAME()">SUSER_SNAME() — login name</Option>
                    </Dropdown>
                  </Field>
                </div>
                <Caption1 style={{ display: 'block', marginTop: tokens.spacingVerticalS }}>
                  Predicate: rows are visible when the filter column equals <code>{rlsSubject}</code> or the
                  caller is <code>db_owner</code>.
                </Caption1>
                <div style={{ marginTop: tokens.spacingVerticalM, display: 'flex', justifyContent: 'flex-end' }}>
                  <Button appearance="primary" onClick={createRls} disabled={permsBusy || selTableId == null || rlsFilterColId == null}>
                    Create policy
                  </Button>
                </div>

                <div style={{ marginTop: tokens.spacingVerticalXL, paddingTop: tokens.spacingVerticalL, borderTop: `1px solid ${tokens.colorNeutralStroke2}` }}>
                  <OnelakeRlsPredicateEditor
                    tables={sqlTables}
                    onSaved={() => loadSqlPerms('row')}
                  />
                </div>
              </>
            )}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={() => setPermsOpen(false)} disabled={permsBusy}>Close</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
