'use client';

/**
 * AdxRbacPanel — Azure Data Explorer / Fabric Eventhouse RBAC principal manager.
 *
 * One-for-one parity with the ADX portal "Permissions" blade + Kusto.Explorer
 * "Manage authorized principals" dialog, themed with Fluent v9 + Loom tokens.
 * Two sub-tabs:
 *   - Database principals — .show database <db> principals + add/drop
 *   - Table principals    — .show table <T> principals + add/drop (admins|ingestors)
 *
 * Every list/add/drop goes through the real BFF route /api/adx/principals which
 * issues live Kusto control commands. The add form is fully structured
 * (principal-type dropdown, role dropdown gated by scope, validated value field)
 * — the UI never assembles raw KQL or FQNs; the BFF builds the FQN
 * (loom-no-freeform-config). When the cluster env var is unset the route 503s
 * and we render the honest infra-gate MessageBar. No mocks.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  TabList, Tab, Table, TableHeader, TableHeaderCell, TableRow, TableBody,
  TableCell, Button, Dropdown, Option, Input, Field, Spinner, Badge, Caption1,
  MessageBar, MessageBarBody, MessageBarTitle, Tooltip,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Add16Regular, Delete16Regular, ArrowSync16Regular, PersonAdd20Regular } from '@fluentui/react-icons';

const DATABASE_ROLES = ['admins', 'users', 'viewers', 'unrestrictedviewers', 'ingestors', 'monitors'] as const;
const TABLE_ROLES = ['admins', 'ingestors'] as const;
const PRINCIPAL_TYPES = ['User', 'App', 'Group'] as const;
type PrincipalType = (typeof PRINCIPAL_TYPES)[number];

interface PrincipalRow {
  role: string; principalType: string; displayName: string; objectId: string; fqn: string;
}

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '12px', minWidth: '560px' },
  form: {
    display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '12px',
    padding: '12px', borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`, background: tokens.colorNeutralBackground2,
  },
  formActions: { gridColumn: '1 / -1', display: 'flex', gap: '8px', alignItems: 'center' },
  hint: { color: tokens.colorNeutralForeground3 },
});

export interface AdxRbacPanelProps {
  /** The bound kql-database item id (so the BFF resolves the right database). */
  itemId: string;
  /** Display-only database name for the header. */
  database?: string;
  /** Table names for the table-scope selector. */
  tables: string[];
}

async function readJson(res: Response): Promise<any> {
  const t = await res.text();
  try { return t ? JSON.parse(t) : {}; } catch { return { ok: false, error: t || `HTTP ${res.status}` }; }
}

function valueHint(t: PrincipalType): string {
  if (t === 'App') return 'appId;tenantId';
  if (t === 'Group') return 'group@tenant.com (or object id)';
  return 'user@tenant.com';
}

export function AdxRbacPanel({ itemId, database, tables }: AdxRbacPanelProps) {
  const s = useStyles();
  const [scope, setScope] = useState<'database' | 'table'>('database');
  const [selTable, setSelTable] = useState<string>(tables[0] || '');
  const [rows, setRows] = useState<PrincipalRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gate, setGate] = useState<{ missing: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Add-form state
  const [fType, setFType] = useState<PrincipalType>('User');
  const [fRole, setFRole] = useState<string>('viewers');
  const [fValue, setFValue] = useState('');

  const roleOptions = scope === 'table' ? TABLE_ROLES : DATABASE_ROLES;

  // Keep the selected role valid when switching scope.
  useEffect(() => {
    if (!(roleOptions as readonly string[]).includes(fRole)) {
      setFRole(scope === 'table' ? 'admins' : 'viewers');
    }
  }, [scope, fRole, roleOptions]);

  const baseUrl = useMemo(() => {
    const q = new URLSearchParams({ id: itemId, scope });
    if (scope === 'table' && selTable) q.set('table', selTable);
    return `/api/adx/principals?${q.toString()}`;
  }, [itemId, scope, selTable]);

  const load = useCallback(async () => {
    if (scope === 'table' && !selTable) { setRows([]); return; }
    setLoading(true); setError(null); setNotice(null);
    try {
      const body = await fetch(baseUrl).then(readJson);
      if (body?.code === 'not_configured' && body?.missing) { setGate({ missing: body.missing }); setLoading(false); return; }
      setGate(null);
      if (!body.ok) { setError(body.error || 'failed to list principals'); setRows([]); }
      else setRows(body.principals || []);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [baseUrl, scope, selTable]);

  useEffect(() => { load(); }, [load]);

  const submit = useCallback(async (action: 'add' | 'drop', overrides?: Partial<{ role: string; principalType: PrincipalType; principalValue: string }>) => {
    setBusy(true); setError(null); setNotice(null);
    try {
      const payload: any = {
        scope,
        table: scope === 'table' ? selTable : undefined,
        role: overrides?.role ?? fRole,
        principalType: overrides?.principalType ?? fType,
        principalValue: overrides?.principalValue ?? fValue.trim(),
        action,
      };
      const res = await fetch(`/api/adx/principals?id=${encodeURIComponent(itemId)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
      });
      const body = await readJson(res);
      if (body?.code === 'not_configured' && body?.missing) { setGate({ missing: body.missing }); setBusy(false); return; }
      if (!body.ok) { setError(body.error || `${action} failed`); setBusy(false); return; }
      setRows(body.principals || []);
      if (action === 'add') { setFValue(''); setNotice(`Added ${payload.principalType} to ${payload.role}.`); }
      else setNotice('Principal removed.');
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }, [scope, selTable, fRole, fType, fValue, itemId]);

  if (gate) {
    return (
      <div className={s.root}>
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>ADX cluster not configured</MessageBarTitle>
            Set <code>{gate.missing}</code> so the Loom console can reach a real Azure Data Explorer /
            Fabric Eventhouse cluster. Database &amp; table principal management uses Kusto control
            commands (<code>.add/.drop database|table &lt;role&gt;</code>); the Loom UAMI needs{' '}
            <strong>AllDatabasesAdmin</strong> on the cluster (granted via{' '}
            <code>adx-cluster.bicep</code>).
          </MessageBarBody>
        </MessageBar>
      </div>
    );
  }

  return (
    <div className={s.root}>
      <TabList selectedValue={scope} onTabSelect={(_, d) => setScope(d.value as 'database' | 'table')}>
        <Tab value="database">Database principals</Tab>
        <Tab value="table">Table principals</Tab>
      </TabList>

      {scope === 'table' && (
        <Field label="Table">
          <Dropdown
            placeholder={tables.length ? 'Select a table' : 'No tables in this database'}
            value={selTable}
            selectedOptions={selTable ? [selTable] : []}
            onOptionSelect={(_, d) => setSelTable(d.optionValue || '')}
            disabled={!tables.length}
          >
            {tables.map((t) => <Option key={t} value={t} text={t}>{t}</Option>)}
          </Dropdown>
        </Field>
      )}

      {notice && <MessageBar intent="success"><MessageBarBody>{notice}</MessageBarBody></MessageBar>}
      {error && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>RBAC error</MessageBarTitle>{error}</MessageBarBody></MessageBar>}

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Caption1 className={s.hint}>
          {scope === 'database'
            ? <>Principals on <code>{database || 'this database'}</code></>
            : <>Principals on table <code>{selTable || '—'}</code> (table scope allows admins &amp; ingestors only)</>}
        </Caption1>
        <Tooltip content="Refresh" relationship="label">
          <Button size="small" appearance="subtle" icon={<ArrowSync16Regular />} onClick={load} disabled={loading} aria-label="Refresh principals" />
        </Tooltip>
      </div>

      {loading ? <Spinner size="tiny" label="Loading principals…" /> : (
        <Table size="small" aria-label="ADX principals">
          <TableHeader>
            <TableRow>
              <TableHeaderCell>Role</TableHeaderCell>
              <TableHeaderCell>Type</TableHeaderCell>
              <TableHeaderCell>Display name</TableHeaderCell>
              <TableHeaderCell>FQN</TableHeaderCell>
              <TableHeaderCell aria-label="Actions" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 && (
              <TableRow><TableCell colSpan={5}><Caption1 className={s.hint}>No principals assigned.</Caption1></TableCell></TableRow>
            )}
            {rows.map((p, i) => (
              <TableRow key={`${p.role}-${p.fqn}-${i}`}>
                <TableCell><Badge appearance="tint" color="brand">{p.role}</Badge></TableCell>
                <TableCell>{p.principalType || '—'}</TableCell>
                <TableCell>{p.displayName || '—'}</TableCell>
                <TableCell><code style={{ fontSize: tokens.fontSizeBase200 }}>{p.fqn}</code></TableCell>
                <TableCell>
                  <Tooltip content="Remove principal" relationship="label">
                    <Button
                      size="small" appearance="subtle" icon={<Delete16Regular />} disabled={busy}
                      aria-label={`Remove ${p.fqn} from ${p.role}`}
                      onClick={() => {
                        // The FQN already encodes the type prefix; map it back so
                        // the BFF re-builds the same FQN for the .drop command.
                        const t: PrincipalType = p.fqn.startsWith('aadapp=') ? 'App' : p.fqn.startsWith('aadgroup=') ? 'Group' : 'User';
                        const value = p.fqn.replace(/^aad(user|app|group)=/, '');
                        submit('drop', { role: p.role, principalType: t, principalValue: value });
                      }}
                    />
                  </Tooltip>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <div className={s.form}>
        <Field label="Principal type">
          <Dropdown value={fType} selectedOptions={[fType]} onOptionSelect={(_, d) => setFType((d.optionValue as PrincipalType) || 'User')}>
            {PRINCIPAL_TYPES.map((t) => <Option key={t} value={t} text={t}>{t}</Option>)}
          </Dropdown>
        </Field>
        <Field label="Role">
          <Dropdown value={fRole} selectedOptions={[fRole]} onOptionSelect={(_, d) => setFRole(d.optionValue || roleOptions[0])}>
            {roleOptions.map((r) => <Option key={r} value={r} text={r}>{r}</Option>)}
          </Dropdown>
        </Field>
        <Field label="Principal" hint={valueHint(fType)} style={{ gridColumn: '1 / -1' }}>
          <Input value={fValue} onChange={(_, d) => setFValue(d.value)} placeholder={valueHint(fType)} contentBefore={<PersonAdd20Regular />} />
        </Field>
        <div className={s.formActions}>
          <Button
            appearance="primary" icon={<Add16Regular />} disabled={busy || !fValue.trim() || (scope === 'table' && !selTable)}
            onClick={() => submit('add')}
          >
            {busy ? 'Applying…' : 'Add principal'}
          </Button>
          <Caption1 className={s.hint}>
            Issues <code>.add {scope} {scope === 'table' ? `["${selTable || 'T'}"]` : ''} {fRole} (&apos;…&apos;)</code> against the live cluster.
          </Caption1>
        </div>
      </div>
    </div>
  );
}
