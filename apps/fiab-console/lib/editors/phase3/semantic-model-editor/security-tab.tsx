'use client';

// security-tab.tsx — SemanticModelSecurityTab (RLS/OLS authoring surface) plus
// its shared types. Extracted byte-for-byte from ../semantic-model-editor.tsx.

import {
  Subtitle2, Caption1, Button, Input, Field,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  Label, Select, Textarea, InfoLabel, Tooltip, tokens,
} from '@fluentui/react-components';
import {
  Play20Regular, Save20Regular, Add20Regular, Delete20Regular,
  ArrowSync20Regular, Eye20Regular, Column20Regular, KeyMultiple20Regular,
} from '@fluentui/react-icons';
import { validateRlsDax } from '@/lib/azure/aas-dax-validate';
import type { TableLite } from './types';
import { useSmVisualStyles } from './styles';

// ---- Security (RLS/OLS) tab shared types + presentational component --------
type SmSecColPerm = { name: string; metadataPermission: 'read' | 'none' };
type SmSecTablePerm = {
  name: string;
  filterExpression?: string;
  metadataPermission?: 'read' | 'none';
  columnPermissions?: SmSecColPerm[];
};
export type SmSecRole = {
  name: string;
  modelPermission: 'read';
  tablePermissions: SmSecTablePerm[];
  members?: Array<{ memberName: string }>;
};

interface SecurityTabProps {
  s: Record<string, string>;
  tables: TableLite[];
  roles: SmSecRole[] | null;
  busy: boolean;
  saving: boolean;
  err: string | null;
  gate: { missing: string; detail: string } | null;
  saveMsg: { ok: boolean; text: string } | null;
  selectedRole: string;
  olsTable: string;
  testUpn: string;
  testQuery: string;
  testBusy: boolean;
  testResult: { rows: Array<Record<string, unknown>>; rowCount: number } | null;
  testErr: string | null;
  onReload: () => void;
  onAddRole: () => void;
  onDeleteRole: (name: string) => void;
  onRenameRole: (oldName: string, newName: string) => void;
  onSelectRole: (name: string) => void;
  onSetFilter: (roleName: string, table: string, expr: string) => void;
  onSetTableOls: (roleName: string, table: string, perm: 'read' | 'none') => void;
  onSetColumnOls: (roleName: string, table: string, column: string, perm: 'read' | 'none') => void;
  onSetMembers: (roleName: string, members: string[]) => void;
  onChangeOlsTable: (table: string) => void;
  onSave: () => void;
  onTestUpn: (v: string) => void;
  onTestQuery: (v: string) => void;
  onRunTest: () => void;
}

/**
 * SemanticModelSecurityTab — the RLS + OLS authoring surface, one-for-one with
 * Power BI's "Manage roles" experience (Tabular model security): a roles grid,
 * per-role row-filter DAX editor, an OLS table/column visibility matrix, role
 * membership, and a Test-as-role probe (the receipt). All writes go through the
 * Analysis-Services XMLA TMSL endpoint via the parent's BFF callbacks.
 */
export function SemanticModelSecurityTab(props: SecurityTabProps) {
  const {
    s, tables, roles, busy, saving, err, gate, saveMsg, selectedRole, olsTable,
    testUpn, testQuery, testBusy, testResult, testErr,
    onReload, onAddRole, onDeleteRole, onRenameRole, onSelectRole,
    onSetFilter, onSetTableOls, onSetColumnOls, onSetMembers, onChangeOlsTable,
    onSave, onTestUpn, onTestQuery, onRunTest,
  } = props;
  const sm = useSmVisualStyles();

  const role = (roles || []).find((r) => r.name === selectedRole) || null;
  const tablePerm = (table: string): SmSecTablePerm | undefined =>
    role?.tablePermissions.find((tp) => tp.name === table);
  const olsTableObj = tables.find((t) => t.name === olsTable);
  const filterValidation = (expr?: string) =>
    expr && expr.trim() ? validateRlsDax(expr) : { ok: true as const };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXL }}>
      {gate && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Configure an Analysis-Services tabular engine to author roles</MessageBarTitle>
            {gate.detail} <em>(missing: <code>{gate.missing}</code>)</em>
          </MessageBarBody>
        </MessageBar>
      )}
      {err && <MessageBar intent="error"><MessageBarBody>{err}</MessageBarBody></MessageBar>}

      {/* Section 1 — Roles grid */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingVerticalS}}>
          <KeyMultiple20Regular style={{ color: tokens.colorBrandForeground1, flexShrink: 0 }} />
          <Subtitle2>Model roles</Subtitle2>
          <Button size="small" appearance="outline" icon={<ArrowSync20Regular />} onClick={onReload} disabled={busy}>{busy ? 'Loading…' : 'Reload'}</Button>
          <Button size="small" appearance="primary" icon={<Add20Regular />} onClick={onAddRole} disabled={!!gate}>Add role</Button>
          <Button size="small" appearance="primary" icon={<Save20Regular />} onClick={onSave} disabled={saving || !!gate || !roles || roles.length === 0} style={{ marginLeft: 'auto' }}>{saving ? 'Saving…' : 'Save roles (TMSL)'}</Button>
        </div>
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
          Each role applies a row filter (RLS) and/or hides tables &amp; columns (OLS). Saving deploys the full role set to the model via XMLA <code>createOrReplace</code>.
        </Caption1>
        {saveMsg && <MessageBar intent={saveMsg.ok ? 'success' : 'error'} style={{ marginTop: tokens.spacingVerticalS}}><MessageBarBody>{saveMsg.text}</MessageBarBody></MessageBar>}
        <div className={s.tableWrap} style={{ marginTop: tokens.spacingVerticalS}}>
          <Table aria-label="Roles" size="small">
            <TableHeader><TableRow>
              <TableHeaderCell>Role</TableHeaderCell>
              <TableHeaderCell>Members</TableHeaderCell>
              <TableHeaderCell>Row filters</TableHeaderCell>
              <TableHeaderCell>Hidden objects (OLS)</TableHeaderCell>
              <TableHeaderCell>Actions</TableHeaderCell>
            </TableRow></TableHeader>
            <TableBody>
              {(roles || []).length === 0 && (
                <TableRow><TableCell colSpan={5}><Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{busy ? 'Loading roles…' : 'No roles yet. Add one to define RLS filters and OLS permissions.'}</Caption1></TableCell></TableRow>
              )}
              {(roles || []).map((r) => {
                const filters = r.tablePermissions.filter((tp) => tp.filterExpression && tp.filterExpression.trim()).length;
                const hidden = r.tablePermissions.filter((tp) => tp.metadataPermission === 'none').length
                  + r.tablePermissions.reduce((n, tp) => n + (tp.columnPermissions || []).filter((c) => c.metadataPermission === 'none').length, 0);
                return (
                  <TableRow key={r.name} style={r.name === selectedRole ? { background: tokens.colorNeutralBackground1Selected } : undefined}>
                    <TableCell>{r.name}</TableCell>
                    <TableCell className={s.cell}>{(r.members || []).map((m) => m.memberName).join(', ') || '—'}</TableCell>
                    <TableCell>{filters || 0}</TableCell>
                    <TableCell>{hidden || 0}</TableCell>
                    <TableCell>
                      <Button size="small" appearance="outline" icon={<Eye20Regular />} onClick={() => onSelectRole(r.name)}>Edit</Button>
                      <Button size="small" appearance="subtle" icon={<Delete20Regular />} onClick={() => onDeleteRole(r.name)} aria-label={`Delete role ${r.name}`} />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* Sections 2 + 3 — per-role RLS DAX + OLS matrix */}
      {role && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, padding: tokens.spacingVerticalM, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingVerticalS}}>
            <Subtitle2>Editing role:</Subtitle2>
            <Input value={role.name} onChange={(_, d) => onRenameRole(role.name, d.value)} style={{ maxWidth: 240 }} aria-label="Role name" />
          </div>

          <Field label="Members (Entra UPN or group object id, comma-separated)">
            <Input
              value={(role.members || []).map((m) => m.memberName).join(', ')}
              onChange={(_, d) => onSetMembers(role.name, d.value.split(',').map((x) => x.trim()).filter(Boolean))}
              placeholder="alice@contoso.com, group-object-id"
            />
          </Field>
          <Caption1 style={{ color: tokens.colorNeutralForeground3, marginTop: -8 }}>
            Service principals cannot be added as role members (Power BI/AAS restriction) — use real users or Entra security groups.
          </Caption1>

          {/* Section 2 — Row-level security (DAX filter) */}
          <div>
            <div className={sm.paneHeader}><Eye20Regular /><Subtitle2>Row-level security (DAX filter)</Subtitle2></div>
            <div className={s.tableWrap} style={{ marginTop: tokens.spacingVerticalS}}>
              <Table aria-label="Row filters" size="small">
                <TableHeader><TableRow>
                  <TableHeaderCell>Table</TableHeaderCell>
                  <TableHeaderCell><InfoLabel info="A DAX boolean expression evaluated per row for this role. Rows where it returns TRUE stay visible to members of the role; leaving it empty grants the role full access to the table. Reference the signed-in user with USERPRINCIPALNAME(), e.g. [Region] = 'East'.">Filter DAX (boolean; empty = full access)</InfoLabel></TableHeaderCell>
                </TableRow></TableHeader>
                <TableBody>
                  {tables.map((t) => {
                    const tp = tablePerm(t.name);
                    const v = filterValidation(tp?.filterExpression);
                    return (
                      <TableRow key={t.name}>
                        <TableCell style={{ verticalAlign: 'top', whiteSpace: 'nowrap' }}>{t.name}</TableCell>
                        <TableCell>
                          <Textarea
                            value={tp?.filterExpression || ''}
                            onChange={(_, d) => onSetFilter(role.name, t.name, d.value)}
                            placeholder={`[Region] = "East"   —or—   USERPRINCIPALNAME() = '${t.name}'[UserEmail]`}
                            resize="vertical"
                            style={{ width: '100%', minHeight: 44, fontFamily: 'monospace' }}
                          />
                          {!v.ok && <Caption1 style={{ color: tokens.colorPaletteRedForeground1 }}>{v.error}</Caption1>}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </div>

          {/* Section 3 — Object-level security matrix */}
          <div>
            <div className={sm.paneHeader}><Column20Regular /><Subtitle2>Object-level security (table &amp; column visibility)</Subtitle2></div>
            <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
              Hide a whole table or specific columns from this role. A table set to <strong>None</strong> hides all of its columns (column rows below are disabled).
            </Caption1>
            <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, marginTop: tokens.spacingVerticalS}}>
              {tables.map((t) => {
                const tp = tablePerm(t.name);
                const tableHidden = tp?.metadataPermission === 'none';
                return (
                  <div key={t.name} style={{ border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusSmall, padding: tokens.spacingVerticalS }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingVerticalM}}>
                      <Label weight="semibold" style={{ minWidth: 160 }}>{t.name}</Label>
                      <Field label={<InfoLabel info="Object-level security for the whole table. Read shows the table to this role; None hides the entire table — and every column in it — from anyone in the role.">Table</InfoLabel>} orientation="horizontal">
                        <Select
                          value={tableHidden ? 'none' : 'read'}
                          onChange={(_, d) => onSetTableOls(role.name, t.name, d.value as 'read' | 'none')}
                          aria-label={`Table ${t.name} permission`}
                        >
                          <option value="read">Read</option>
                          <option value="none">None (hidden)</option>
                        </Select>
                      </Field>
                    </div>
                    {(t.columns || []).length > 0 && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: tokens.spacingVerticalS, marginTop: tokens.spacingVerticalS, opacity: tableHidden ? 0.4 : 1 }}>
                        {(t.columns || []).map((c) => {
                          const cp = (tp?.columnPermissions || []).find((x) => x.name === c.name);
                          return (
                            <div key={c.name} style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingVerticalXS}}>
                              <Caption1>{c.name}</Caption1>
                              <Tooltip relationship="description" content="Column-level security (OLS). Read keeps this column visible to the role; None hides only this column while the rest of the table stays visible. Disabled when the whole table is set to None.">
                                <Select
                                  value={cp?.metadataPermission === 'none' ? 'none' : 'read'}
                                  disabled={tableHidden}
                                  onChange={(_, d) => onSetColumnOls(role.name, t.name, c.name, d.value as 'read' | 'none')}
                                  aria-label={`Column ${t.name}.${c.name} permission`}
                                  style={{ minWidth: 90 }}
                                >
                                  <option value="read">Read</option>
                                  <option value="none">None</option>
                                </Select>
                              </Tooltip>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Section 4 — Test as role (receipt) */}
      <div style={{ padding: tokens.spacingVerticalM, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium }}>
        <div className={sm.paneHeader}><Play20Regular /><Subtitle2>Test as role</Subtitle2></div>
        <MessageBar intent="info" style={{ marginTop: tokens.spacingVerticalS}}>
          <MessageBarBody>
            Runs a DAX query impersonating a role via the XMLA <code>EffectiveUserName</code> + <code>Roles</code> connection properties. The named user must exist in the tenant and hold Read access on the model. The result table is your receipt: a restricted role returns only filtered rows, and OLS-hidden columns are absent from the output.
          </MessageBarBody>
        </MessageBar>
        <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, marginTop: tokens.spacingVerticalM, maxWidth: 720 }}>
          <Field label="Effective user (Entra UPN to impersonate)">
            <Input value={testUpn} onChange={(_, d) => onTestUpn(d.value)} placeholder="alice@contoso.com" />
          </Field>
          <Field label="Role">
            <Select value={selectedRole} onChange={(_, d) => onSelectRole(d.value)} aria-label="Role to test">
              <option value="">Select a role…</option>
              {(roles || []).map((r) => <option key={r.name} value={r.name}>{r.name}</option>)}
            </Select>
          </Field>
          <Field label="DAX query">
            <Textarea value={testQuery} onChange={(_, d) => onTestQuery(d.value)} resize="vertical" style={{ minHeight: 60, fontFamily: 'monospace' }} />
          </Field>
          <div>
            <Button appearance="primary" icon={<Play20Regular />} onClick={onRunTest} disabled={testBusy || !!gate || !selectedRole || !testUpn.trim() || !testQuery.trim()}>{testBusy ? 'Running…' : 'Run test'}</Button>
          </div>
          {testErr && <MessageBar intent="error"><MessageBarBody>{testErr}</MessageBarBody></MessageBar>}
          {testResult && (
            <div>
              <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{testResult.rowCount} row(s) returned as role <strong>{selectedRole}</strong>.</Caption1>
              <div className={s.tableWrap} style={{ marginTop: tokens.spacingVerticalS}}>
                <Table aria-label="Test-as-role result" size="small">
                  <TableHeader><TableRow>
                    {Object.keys(testResult.rows[0] || {}).map((k) => <TableHeaderCell key={k}>{k}</TableHeaderCell>)}
                    {testResult.rows.length === 0 && <TableHeaderCell>result</TableHeaderCell>}
                  </TableRow></TableHeader>
                  <TableBody>
                    {testResult.rows.length === 0 && (
                      <TableRow><TableCell><Caption1 style={{ color: tokens.colorNeutralForeground3 }}>No rows visible to this role (filter excludes all rows).</Caption1></TableCell></TableRow>
                    )}
                    {testResult.rows.slice(0, 50).map((row, i) => (
                      <TableRow key={i}>
                        {Object.keys(testResult.rows[0] || {}).map((k) => <TableCell key={k} className={s.cell}>{String((row as any)[k] ?? '')}</TableCell>)}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
