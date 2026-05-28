'use client';

/**
 * PermissionMatrix — Loom-native role grant UI for Unity Catalog +
 * Fabric/OneLake. The user picks (source, securable, principal, role) and
 * the BFF fans out to the right back-end privileges automatically.
 *
 * No fake principals, no mocked grants — every submit POSTs to
 * /api/catalog/permissions and surfaces the response in a live audit log.
 */
import { useState } from 'react';
import {
  Input, Button, Spinner, MessageBar, MessageBarBody, MessageBarTitle,
  Dropdown, Option, Field, Switch, makeStyles, tokens, Body1, Subtitle2, Caption1,
} from '@fluentui/react-components';
import { CheckmarkCircle24Regular, DismissCircle24Regular } from '@fluentui/react-icons';

const useStyles = makeStyles({
  form: {
    display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16,
    padding: 16, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 8,
    marginBottom: 16,
  },
  actions: { gridColumn: '1 / -1', display: 'flex', gap: 8, justifyContent: 'flex-end' },
  log: {
    display: 'flex', flexDirection: 'column', gap: 8, marginTop: 16,
    maxHeight: 280, overflowY: 'auto',
  },
  entry: {
    display: 'flex', gap: 8, alignItems: 'flex-start',
    padding: 8, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 6,
    fontSize: 13,
  },
  ok: { color: tokens.colorPaletteGreenForeground1 },
  err: { color: tokens.colorPaletteRedForeground1 },
});

interface LogEntry {
  ts: string;
  ok: boolean;
  action: string;
  detail: string;
}

const LOOM_ROLES = ['Reader', 'Contributor', 'Admin', 'Owner'];
const UC_SEC_TYPES = ['CATALOG', 'SCHEMA', 'TABLE', 'VOLUME'];
const FABRIC_PRINCIPAL_TYPES = ['User', 'Group', 'ServicePrincipal'];

export function PermissionMatrix() {
  const s = useStyles();
  const [source, setSource] = useState<'unity-catalog' | 'onelake'>('unity-catalog');
  const [secType, setSecType] = useState('CATALOG');
  const [securable, setSecurable] = useState('');
  const [host, setHost] = useState('');
  const [workspaceId, setWorkspaceId] = useState('');
  const [principal, setPrincipal] = useState('');
  const [principalType, setPrincipalType] = useState('User');
  const [role, setRole] = useState('Reader');
  const [useSQL, setUseSQL] = useState(false);
  const [warehouseId, setWarehouseId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [log, setLog] = useState<LogEntry[]>([]);

  async function submit(action: 'POST' | 'DELETE') {
    setSubmitting(true);
    const body: any = { source, loomRole: role, principal };
    if (source === 'unity-catalog') {
      body.host = host; body.secType = secType; body.securable = securable;
      if (useSQL) { body.useSQL = true; body.warehouseId = warehouseId; }
    } else {
      body.workspaceId = workspaceId; body.principalType = principalType;
    }
    try {
      const r = await fetch('/api/catalog/permissions', {
        method: action,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      setLog((prev) => [{
        ts: new Date().toISOString(),
        ok: !!j.ok,
        action: `${action === 'POST' ? 'GRANT' : 'REVOKE'} ${role} on ${source === 'unity-catalog' ? `${secType} ${securable}` : `workspace ${workspaceId}`} to ${principal}`,
        detail: j.ok ? `mode=${j.mode}${j.role ? ` role=${j.role}` : ''}` : j.error,
      }, ...prev].slice(0, 50));
    } catch (e: any) {
      setLog((prev) => [{ ts: new Date().toISOString(), ok: false, action: `${action} failed`, detail: e?.message || String(e) }, ...prev].slice(0, 50));
    } finally { setSubmitting(false); }
  }

  return (
    <>
      <Body1 style={{ marginBottom: 8 }}>
        Pick a securable, a principal, and a Loom role. Loom maps the role to
        Unity Catalog privileges or Fabric workspace roles per the table in <a href="/docs/fiab/catalog/permissions">docs</a>.
      </Body1>

      <div className={s.form}>
        <Field label="Source">
          <Dropdown value={source} onOptionSelect={(_, d) => setSource(d.optionValue as any)} selectedOptions={[source]}>
            <Option value="unity-catalog">Databricks Unity Catalog</Option>
            <Option value="onelake">Fabric / OneLake</Option>
          </Dropdown>
        </Field>

        <Field label="Loom role">
          <Dropdown value={role} onOptionSelect={(_, d) => setRole(d.optionValue as any)} selectedOptions={[role]}>
            {LOOM_ROLES.map((r) => <Option key={r} value={r}>{r}</Option>)}
          </Dropdown>
        </Field>

        {source === 'unity-catalog' ? (
          <>
            <Field label="Workspace hostname (e.g. adb-…azuredatabricks.net)">
              <Input value={host} onChange={(_, d) => setHost(d.value)} />
            </Field>
            <Field label="Securable type">
              <Dropdown value={secType} onOptionSelect={(_, d) => setSecType(d.optionValue as any)} selectedOptions={[secType]}>
                {UC_SEC_TYPES.map((t) => <Option key={t} value={t}>{t}</Option>)}
              </Dropdown>
            </Field>
            <Field label={`${secType} full name (e.g. main.bronze.customers)`} style={{ gridColumn: '1 / -1' }}>
              <Input value={securable} onChange={(_, d) => setSecurable(d.value)} />
            </Field>
            <Field label="Use SQL warehouse fan-out (real GRANT statements)">
              <Switch checked={useSQL} onChange={(_, d) => setUseSQL(d.checked)} />
            </Field>
            {useSQL && (
              <Field label="Warehouse id (running)">
                <Input value={warehouseId} onChange={(_, d) => setWarehouseId(d.value)} />
              </Field>
            )}
          </>
        ) : (
          <>
            <Field label="Workspace id (Fabric)" style={{ gridColumn: '1 / -1' }}>
              <Input value={workspaceId} onChange={(_, d) => setWorkspaceId(d.value)} />
            </Field>
            <Field label="Principal type">
              <Dropdown value={principalType} onOptionSelect={(_, d) => setPrincipalType(d.optionValue as any)} selectedOptions={[principalType]}>
                {FABRIC_PRINCIPAL_TYPES.map((t) => <Option key={t} value={t}>{t}</Option>)}
              </Dropdown>
            </Field>
          </>
        )}

        <Field label="Principal (UPN, group, or SP id)" style={{ gridColumn: '1 / -1' }}>
          <Input value={principal} onChange={(_, d) => setPrincipal(d.value)} placeholder="alice@contoso.com" />
        </Field>

        <div className={s.actions}>
          <Button onClick={() => submit('DELETE')} disabled={submitting || !principal} appearance="secondary">Revoke</Button>
          <Button onClick={() => submit('POST')} disabled={submitting || !principal} appearance="primary">Grant</Button>
        </div>
      </div>

      {submitting && <Spinner label="Updating permissions…" />}

      {log.length > 0 && (
        <>
          <Subtitle2 style={{ marginTop: 12, marginBottom: 8 }}>Audit log (session)</Subtitle2>
          <div className={s.log}>
            {log.map((e, i) => (
              <div key={i} className={s.entry}>
                {e.ok ? <CheckmarkCircle24Regular className={s.ok} /> : <DismissCircle24Regular className={s.err} />}
                <div style={{ flex: 1 }}>
                  <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{e.ts}</Caption1>
                  <div><strong>{e.action}</strong></div>
                  <div style={{ color: e.ok ? tokens.colorNeutralForeground2 : tokens.colorPaletteRedForeground1 }}>{e.detail}</div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}
