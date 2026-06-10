'use client';

/**
 * ConnectionBuilder — a reusable dialog to create a Key Vault-backed Loom
 * Connection. Mounted by the Connections page, the mirrored-database wizard, and
 * (future) ADF/Synapse linked-service editors. Pick a source type → an auth
 * method → fill the per-method fields; any secret is POSTed and written to Key
 * Vault server-side (never kept in the page). Fluent v9 + Loom tokens.
 */

import { useState, useCallback } from 'react';
import {
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  Field, Input, Textarea, Dropdown, Option, Button, Badge, MessageBar, MessageBarBody,
  Caption1, makeStyles, tokens,
} from '@fluentui/react-components';
import {
  DatabasePlugConnected20Regular, Key20Regular, ShieldKeyhole20Regular,
} from '@fluentui/react-icons';

export interface ConnectionView {
  id: string; name: string; type: string; authMethod: string; hasSecret: boolean;
  host?: string; database?: string; username?: string;
  projectId?: string; serviceAccountEmail?: string; gateway?: string;
}

const TYPES: { value: string; label: string }[] = [
  { value: 'azure-sql', label: 'Azure SQL Database' },
  { value: 'synapse-dedicated', label: 'Synapse — Dedicated SQL pool' },
  { value: 'synapse-serverless', label: 'Synapse — Serverless SQL' },
  { value: 'databricks-sql', label: 'Databricks SQL' },
  { value: 'postgres', label: 'PostgreSQL' },
  { value: 'storage-adls', label: 'ADLS Gen2 / Storage' },
  { value: 'cosmos', label: 'Azure Cosmos DB' },
  { value: 'generic-sql', label: 'Generic SQL Server' },
  { value: 'bigquery', label: 'Google BigQuery' },
  { value: 'oracle', label: 'Oracle Database' },
];

const METHODS: { value: string; label: string; hint: string }[] = [
  { value: 'entra-mi', label: 'Entra (managed identity)', hint: 'The Console identity connects — no secret. The source must allow this Entra principal.' },
  { value: 'sql-password', label: 'Username + password', hint: 'Password is stored in Key Vault. Use for SQL / Oracle basic authentication.' },
  { value: 'connection-string', label: 'Connection string', hint: 'The full connection string is stored in Key Vault.' },
  { value: 'account-key', label: 'Account key', hint: 'Storage account key is stored in Key Vault.' },
  { value: 'service-principal', label: 'Service principal (Entra app)', hint: 'Client secret is stored in Key Vault.' },
  { value: 'service-account-key', label: 'Service account key (JSON)', hint: 'Google service-account JSON key file contents — stored in Key Vault.' },
];

/** The auth methods each source type can use (drives the Authentication dropdown). */
const METHODS_FOR_TYPE: Record<string, string[]> = {
  bigquery: ['service-account-key'],
  oracle: ['sql-password'],
};
function methodsFor(type: string): typeof METHODS {
  const allow = METHODS_FOR_TYPE[type];
  return allow ? METHODS.filter((m) => allow.includes(m.value)) : METHODS;
}
/** Default auth method when a source type is chosen. */
function defaultMethodFor(type: string): string {
  const allow = METHODS_FOR_TYPE[type];
  return allow ? allow[0] : 'entra-mi';
}

const useStyles = makeStyles({
  body: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: '460px' },
  methodHint: { color: tokens.colorNeutralForeground3 },
  secretRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS },
});

export function ConnectionBuilder({
  open, onClose, onCreated, lockType,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (c: ConnectionView) => void;
  lockType?: string;
}) {
  const s = useStyles();
  const [name, setName] = useState('');
  const [type, setType] = useState(lockType || 'azure-sql');
  const [authMethod, setAuthMethod] = useState('entra-mi');
  const [host, setHost] = useState('');
  const [database, setDatabase] = useState('');
  const [username, setUsername] = useState('');
  const [spnTenantId, setSpnTenantId] = useState('');
  const [spnClientId, setSpnClientId] = useState('');
  const [projectId, setProjectId] = useState('');
  const [serviceAccountEmail, setServiceAccountEmail] = useState('');
  const [gateway, setGateway] = useState('');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const isBigQuery = type === 'bigquery';
  const isOracle = type === 'oracle';
  const needsSecret = ['sql-password', 'connection-string', 'account-key', 'service-principal', 'service-account-key'].includes(authMethod);
  const secretLabel = authMethod === 'connection-string' ? 'Connection string'
    : authMethod === 'account-key' ? 'Account key'
    : authMethod === 'service-principal' ? 'Client secret'
    : authMethod === 'service-account-key' ? 'Service account JSON key' : 'Password';

  // When the source type changes, snap the auth method to one valid for it.
  const onTypeChange = (next: string) => {
    setType(next);
    const allowed = methodsFor(next).map((m) => m.value);
    if (!allowed.includes(authMethod)) setAuthMethod(defaultMethodFor(next));
  };

  const reset = () => { setName(''); setType(lockType || 'azure-sql'); setAuthMethod(defaultMethodFor(lockType || 'azure-sql')); setHost(''); setDatabase(''); setUsername(''); setSpnTenantId(''); setSpnClientId(''); setProjectId(''); setServiceAccountEmail(''); setGateway(''); setSecret(''); setErr(null); };

  const submit = useCallback(async () => {
    setBusy(true); setErr(null);
    try {
      const r = await fetch('/api/connections', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, type, authMethod, host, database, username, spnTenantId, spnClientId, projectId, serviceAccountEmail, gateway, secret: needsSecret ? secret : undefined }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) { setErr(j?.error || `HTTP ${r.status}`); return; }
      onCreated(j.connection);
      reset();
      onClose();
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [name, type, authMethod, host, database, username, spnTenantId, spnClientId, projectId, serviceAccountEmail, gateway, secret, needsSecret, onCreated, onClose]);

  const typeLabel = TYPES.find((t) => t.value === type)?.label || type;
  const availMethods = methodsFor(type);
  const methodObj = availMethods.find((m) => m.value === authMethod) || availMethods[0];

  return (
    <Dialog open={open} onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle><span className={s.secretRow}><DatabasePlugConnected20Regular /> New connection</span></DialogTitle>
          <DialogContent>
            <div className={s.body}>
              <Field label="Name" required>
                <Input value={name} placeholder="e.g. prod-sales-sql" onChange={(_, d) => setName(d.value)} />
              </Field>
              <Field label="Source type" required>
                <Dropdown value={typeLabel} selectedOptions={[type]} disabled={!!lockType}
                  onOptionSelect={(_, d) => onTypeChange(d.optionValue || 'azure-sql')}>
                  {TYPES.map((t) => <Option key={t.value} value={t.value}>{t.label}</Option>)}
                </Dropdown>
              </Field>
              <Field label="Authentication" required hint={methodObj?.hint}>
                <Dropdown value={methodObj?.label || ''} selectedOptions={[authMethod]} disabled={availMethods.length <= 1}
                  onOptionSelect={(_, d) => setAuthMethod(d.optionValue || defaultMethodFor(type))}>
                  {availMethods.map((m) => <Option key={m.value} value={m.value}>{m.label}</Option>)}
                </Dropdown>
              </Field>

              {/* ── Google BigQuery — service-account-key auth (projectId + SA email + JSON key) ── */}
              {isBigQuery && (
                <>
                  <Field label="Project id" required hint="The Google Cloud project that owns the dataset to mirror.">
                    <Input value={projectId} placeholder="my-gcp-project" onChange={(_, d) => setProjectId(d.value)} />
                  </Field>
                  <Field label="Dataset" hint="Optional — the BigQuery dataset; leave blank to choose at mirror time.">
                    <Input value={database} placeholder="analytics" onChange={(_, d) => setDatabase(d.value)} />
                  </Field>
                  <Field label="Service account email" required hint="From Service accounts in the Google Cloud console.">
                    <Input value={serviceAccountEmail} placeholder="svc@my-gcp-project.iam.gserviceaccount.com" onChange={(_, d) => setServiceAccountEmail(d.value)} />
                  </Field>
                  <Field label="Data gateway" hint="Optional — On-Premises/VNet Data Gateway name (set LOOM_MIRROR_GATEWAY to route private BigQuery sources).">
                    <Input value={gateway} placeholder="opdg-cluster (optional)" onChange={(_, d) => setGateway(d.value)} />
                  </Field>
                </>
              )}

              {/* ── Oracle — basic authentication (TNS/connect-descriptor server + user/password) ── */}
              {isOracle && (
                <>
                  <Field label="Server (TNS alias / connect descriptor / Easy Connect)" required
                    hint="e.g. salesserver1:1521/sales.example.com, a TNS alias, or a full (DESCRIPTION=…) connect descriptor.">
                    <Input value={host} placeholder="dbhost:1521/ORCLPDB1" onChange={(_, d) => setHost(d.value)} />
                  </Field>
                  <Field label="Service / schema" hint="Optional — the Oracle service name or schema to mirror.">
                    <Input value={database} placeholder="ORCLPDB1" onChange={(_, d) => setDatabase(d.value)} />
                  </Field>
                  <Field label="Username" required><Input value={username} onChange={(_, d) => setUsername(d.value)} placeholder="MIRROR_USER" /></Field>
                  <Field label="Data gateway" hint="On-Premises Data Gateway name (Oracle mirroring routes through OPDG; set LOOM_MIRROR_GATEWAY).">
                    <Input value={gateway} placeholder="opdg-cluster" onChange={(_, d) => setGateway(d.value)} />
                  </Field>
                </>
              )}

              {/* ── Azure / generic SQL family — server + database ── */}
              {!isBigQuery && !isOracle && authMethod !== 'connection-string' && (
                <>
                  <Field label={type === 'storage-adls' ? 'Account / host' : 'Server / host'}>
                    <Input value={host} placeholder={type === 'storage-adls' ? 'myaccount' : 'myserver.database.windows.net'} onChange={(_, d) => setHost(d.value)} />
                  </Field>
                  {type !== 'storage-adls' && (
                    <Field label="Database">
                      <Input value={database} placeholder="mydb" onChange={(_, d) => setDatabase(d.value)} />
                    </Field>
                  )}
                </>
              )}

              {authMethod === 'sql-password' && !isOracle && (
                <Field label="Username"><Input value={username} onChange={(_, d) => setUsername(d.value)} /></Field>
              )}
              {authMethod === 'service-principal' && (
                <>
                  <Field label="Directory (tenant) id"><Input value={spnTenantId} onChange={(_, d) => setSpnTenantId(d.value)} /></Field>
                  <Field label="Application (client) id"><Input value={spnClientId} onChange={(_, d) => setSpnClientId(d.value)} /></Field>
                </>
              )}

              {needsSecret && (
                <Field label={`${secretLabel} (→ Key Vault)`} required
                  hint={authMethod === 'service-account-key'
                    ? 'Paste the full JSON key file contents — stored in Key Vault, never in plaintext.'
                    : 'Stored in Key Vault — never saved in plaintext.'}>
                  {authMethod === 'service-account-key'
                    ? <Textarea value={secret} onChange={(_, d) => setSecret(d.value)} resize="vertical" rows={4} placeholder='{ "type": "service_account", "project_id": "…", "private_key": "…" }' />
                    : <Input type="password" contentBefore={<Key20Regular />} value={secret} onChange={(_, d) => setSecret(d.value)} />}
                </Field>
              )}
              {authMethod === 'entra-mi' && (
                <Caption1 className={s.methodHint}>
                  <ShieldKeyhole20Regular style={{ verticalAlign: 'middle', marginRight: 4 }} />
                  No secret stored. The source must allow the Console managed identity (Entra) to connect.
                </Caption1>
              )}

              {err && <MessageBar intent="error"><MessageBarBody>{err}</MessageBarBody></MessageBar>}
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>Cancel</Button>
            <Button appearance="primary" icon={<Key20Regular />} disabled={busy || !name.trim() || (needsSecret && !secret)} onClick={submit}>
              {busy ? 'Saving…' : 'Create connection'}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
