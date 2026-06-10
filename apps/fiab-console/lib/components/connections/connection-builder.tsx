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
  Field, Input, Textarea, Dropdown, Option, Button, MessageBar, MessageBarBody,
  Caption1, makeStyles, tokens,
} from '@fluentui/react-components';
import {
  DatabasePlugConnected20Regular, Key20Regular, ShieldKeyhole20Regular,
} from '@fluentui/react-icons';

export interface ConnectionView {
  id: string; name: string; type: string; authMethod: string; hasSecret: boolean;
  host?: string; database?: string; username?: string;
  projectId?: string; dataGateway?: string; serviceAccountEmail?: string;
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
  { value: 'sql-password', label: 'SQL username + password', hint: 'Password is stored in Key Vault.' },
  { value: 'connection-string', label: 'Connection string', hint: 'The full connection string is stored in Key Vault.' },
  { value: 'account-key', label: 'Account key', hint: 'Storage account key is stored in Key Vault.' },
  { value: 'service-principal', label: 'Service principal (Entra app)', hint: 'Client secret is stored in Key Vault.' },
  { value: 'service-key', label: 'Service-account key (JSON)', hint: 'The GCP service-account JSON key file contents are stored in Key Vault.' },
  { value: 'basic', label: 'Basic (username + password)', hint: 'Database password is stored in Key Vault; reached over the selected data gateway.' },
];

/** Auth methods each source type offers (others hidden so the form can't post an invalid combo). */
const METHODS_BY_TYPE: Record<string, string[]> = {
  bigquery: ['service-key'],
  oracle: ['basic'],
};
function methodsFor(type: string): typeof METHODS {
  const allow = METHODS_BY_TYPE[type];
  if (!allow) return METHODS.filter((m) => m.value !== 'service-key' && m.value !== 'basic');
  return METHODS.filter((m) => allow.includes(m.value));
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
  const [dataGateway, setDataGateway] = useState('');
  const [serviceAccountEmail, setServiceAccountEmail] = useState('');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const isBigQuery = type === 'bigquery';
  const isOracle = type === 'oracle';
  const availableMethods = methodsFor(type);

  const needsSecret = ['sql-password', 'connection-string', 'account-key', 'service-principal', 'service-key', 'basic'].includes(authMethod);
  const secretLabel = authMethod === 'connection-string' ? 'Connection string'
    : authMethod === 'account-key' ? 'Account key'
    : authMethod === 'service-principal' ? 'Client secret'
    : authMethod === 'service-key' ? 'Service-account JSON key' : 'Password';
  // BigQuery's JSON key file is multi-line — use a textarea-style input instead of a password box.
  const secretIsJson = authMethod === 'service-key';

  // When the source type changes, snap to its first valid auth method (BigQuery →
  // service-key, Oracle → basic, others → entra-mi) so the form never posts an
  // unsupported type/method combo.
  const onType = (next: string) => {
    setType(next);
    const allowed = methodsFor(next);
    if (!allowed.some((m) => m.value === authMethod)) setAuthMethod(allowed[0]?.value || 'entra-mi');
  };

  const reset = () => {
    setName(''); setType(lockType || 'azure-sql'); setAuthMethod('entra-mi');
    setHost(''); setDatabase(''); setUsername(''); setSpnTenantId(''); setSpnClientId('');
    setProjectId(''); setDataGateway(''); setServiceAccountEmail(''); setSecret(''); setErr(null);
  };

  const submit = useCallback(async () => {
    setBusy(true); setErr(null);
    try {
      const r = await fetch('/api/connections', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name, type, authMethod, host, database, username, spnTenantId, spnClientId,
          projectId: isBigQuery ? projectId : undefined,
          dataGateway: (isOracle || isBigQuery) ? dataGateway : undefined,
          serviceAccountEmail: isBigQuery ? serviceAccountEmail : undefined,
          secret: needsSecret ? secret : undefined,
        }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) { setErr(j?.error || `HTTP ${r.status}`); return; }
      onCreated(j.connection);
      reset();
      onClose();
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [name, type, authMethod, host, database, username, spnTenantId, spnClientId, projectId, dataGateway, serviceAccountEmail, secret, needsSecret, isBigQuery, isOracle, onCreated, onClose]);

  const typeLabel = TYPES.find((t) => t.value === type)?.label || type;
  const methodObj = METHODS.find((m) => m.value === authMethod);

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
                  onOptionSelect={(_, d) => onType(d.optionValue || 'azure-sql')}>
                  {TYPES.map((t) => <Option key={t.value} value={t.value}>{t.label}</Option>)}
                </Dropdown>
              </Field>
              <Field label="Authentication" required hint={methodObj?.hint}>
                <Dropdown value={methodObj?.label || ''} selectedOptions={[authMethod]}
                  onOptionSelect={(_, d) => setAuthMethod(d.optionValue || 'entra-mi')}>
                  {availableMethods.map((m) => <Option key={m.value} value={m.value}>{m.label}</Option>)}
                </Dropdown>
              </Field>

              {/* BigQuery — GCP project id + service-account email; the JSON key is the secret below. */}
              {isBigQuery && (
                <>
                  <Field label="Project id" required hint="The GCP project whose datasets/tables are mirrored.">
                    <Input value={projectId} placeholder="my-gcp-project" onChange={(_, d) => setProjectId(d.value)} />
                  </Field>
                  <Field label="Service-account email" required hint="From Service accounts in your Google Cloud console.">
                    <Input value={serviceAccountEmail} placeholder="svc@my-gcp-project.iam.gserviceaccount.com" onChange={(_, d) => setServiceAccountEmail(d.value)} />
                  </Field>
                  <Field label="Dataset (optional)" hint="Leave blank to choose the dataset when loading tables.">
                    <Input value={database} placeholder="analytics" onChange={(_, d) => setDatabase(d.value)} />
                  </Field>
                </>
              )}

              {/* Oracle — server (TNS alias / connect descriptor / Easy Connect) + a data gateway. */}
              {isOracle && (
                <>
                  <Field label="Server" required hint="TNS alias, Connect Descriptor, or Easy Connect (host:port/service).">
                    <Input value={host} placeholder="oracle-host:1521/sales.us.example.com" onChange={(_, d) => setHost(d.value)} />
                  </Field>
                  <Field label="Service / database" hint="The Oracle service name or PDB (if not already in the server string).">
                    <Input value={database} placeholder="ORCLPDB1" onChange={(_, d) => setDatabase(d.value)} />
                  </Field>
                </>
              )}

              {/* Data gateway (self-hosted IR / OPDG) — required by Oracle, optional for BigQuery. */}
              {(isOracle || isBigQuery) && (
                <Field label={isOracle ? 'Data gateway (self-hosted IR)' : 'Data gateway (optional)'} required={isOracle}
                  hint={isOracle
                    ? 'Name of the self-hosted integration runtime / on-premises data gateway that can reach the Oracle server.'
                    : 'Set only when BigQuery is reached over a self-hosted IR / VNET gateway instead of the public endpoint.'}>
                  <Input value={dataGateway} placeholder="loom-shir" onChange={(_, d) => setDataGateway(d.value)} />
                </Field>
              )}

              {/* The classic SQL/Storage coordinate fields — hidden for the BigQuery/Oracle forms above. */}
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

              {(authMethod === 'sql-password' || authMethod === 'basic') && (
                <Field label="Username" required={authMethod === 'basic'}><Input value={username} onChange={(_, d) => setUsername(d.value)} /></Field>
              )}
              {authMethod === 'service-principal' && (
                <>
                  <Field label="Directory (tenant) id"><Input value={spnTenantId} onChange={(_, d) => setSpnTenantId(d.value)} /></Field>
                  <Field label="Application (client) id"><Input value={spnClientId} onChange={(_, d) => setSpnClientId(d.value)} /></Field>
                </>
              )}

              {needsSecret && (
                <Field label={`${secretLabel} (→ Key Vault)`} required
                  hint="Stored in Key Vault — never saved in plaintext.">
                  {secretIsJson ? (
                    <Textarea value={secret} resize="vertical" rows={4}
                      placeholder='{ "type": "service_account", "project_id": "...", "private_key": "..." }'
                      onChange={(_, d) => setSecret(d.value)} />
                  ) : (
                    <Input type="password" contentBefore={<Key20Regular />} value={secret} onChange={(_, d) => setSecret(d.value)} />
                  )}
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
            <Button appearance="primary" icon={<Key20Regular />}
              disabled={busy || !name.trim() || (needsSecret && !secret)
                || (isBigQuery && (!projectId.trim() || !serviceAccountEmail.trim()))
                || (isOracle && (!host.trim() || !dataGateway.trim() || !username.trim()))}
              onClick={submit}>
              {busy ? 'Saving…' : 'Create connection'}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
