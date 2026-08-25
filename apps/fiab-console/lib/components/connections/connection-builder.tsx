'use client';

import { clientFetch } from '@/lib/client-fetch';
/**
 * ConnectionBuilder — a reusable dialog to create OR edit a Key Vault-backed
 * Loom Connection. Mounted by the Connections page, the mirrored-database
 * wizard, and ADF/Synapse linked-service editors. Pick a source type → an auth
 * method → fill the per-method fields; any secret is POSTed and written to Key
 * Vault server-side (never kept in the page). Fluent v9 + Loom tokens.
 *
 * Edit mode: pass `editConnection` to prefill all fields and PATCH instead of
 * POST. The secret field is optional in edit mode — leaving it blank keeps the
 * existing stored secret unchanged.
 */

import { useState, useCallback, useEffect, useMemo } from 'react';
import {
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  Field, Input, Textarea, Dropdown, Option, OptionGroup, Button, MessageBar, MessageBarBody,
  Caption1, Spinner, makeStyles, tokens,
} from '@fluentui/react-components';

import {
  DatabasePlugConnected20Regular, Key20Regular, ShieldKeyhole20Regular, Edit20Regular,
} from '@fluentui/react-icons';
import { itemVisual } from '@/lib/components/ui/item-type-visual';
import { CONN_TILE_SLUG } from '@/lib/azure/connectable-types';

export interface ConnectionView {
  id: string; name: string; type: string; authMethod: string; hasSecret: boolean;
  host?: string; database?: string; username?: string;
  spnTenantId?: string; spnClientId?: string; description?: string;
  /** Snowflake non-secret coordinates (warehouse / role / default schema). */
  warehouse?: string; role?: string; schema?: string;
  /** BigQuery project id · Oracle service name + on-prem gateway (SHIR). */
  projectId?: string; serviceName?: string; gateway?: string;
}

/**
 * Every creatable source type, grouped so the picker reads like the Azure /
 * Fabric "new connection" galleries: Azure services first, then the non-Azure
 * databases Loom can mirror.
 *
 * WHY THE NON-AZURE GROUP EXISTS: the mirrored-database wizard has always
 * offered Snowflake, Google BigQuery and Oracle source cards, but this list held
 * Azure services ONLY — so "New connection" from a Snowflake mirror could not
 * produce a Snowflake connection. That is the dead-end bind
 * `auto-bind-by-default.md` forbids: a surface that demands a connection and
 * offers no way to create the one it needs. Every source in MIRROR_SOURCES now
 * has a creatable connection of its own shape.
 */
const TYPES: { value: string; label: string; group: 'azure' | 'other' }[] = [
  { value: 'azure-sql', label: 'Azure SQL Database', group: 'azure' },
  { value: 'synapse-dedicated', label: 'Synapse — Dedicated SQL pool', group: 'azure' },
  { value: 'synapse-serverless', label: 'Synapse — Serverless SQL', group: 'azure' },
  { value: 'databricks-sql', label: 'Databricks SQL', group: 'azure' },
  { value: 'postgres', label: 'PostgreSQL', group: 'azure' },
  { value: 'mysql', label: 'MySQL', group: 'azure' },
  { value: 'storage-adls', label: 'ADLS Gen2 / Storage', group: 'azure' },
  { value: 'cosmos', label: 'Azure Cosmos DB', group: 'azure' },
  { value: 'adx', label: 'Azure Data Explorer (Kusto)', group: 'azure' },
  { value: 'event-hub', label: 'Event Hubs', group: 'azure' },
  { value: 'service-bus', label: 'Service Bus', group: 'azure' },
  { value: 'key-vault', label: 'Key Vault', group: 'azure' },
  { value: 'generic-sql', label: 'Generic SQL Server', group: 'azure' },
  { value: 'snowflake', label: 'Snowflake', group: 'other' },
  { value: 'bigquery', label: 'Google BigQuery', group: 'other' },
  { value: 'oracle', label: 'Oracle Database', group: 'other' },
];

const GROUP_LABEL: Record<'azure' | 'other', string> = {
  azure: 'Azure services',
  other: 'Other databases',
};


/** Types whose connection target is an account/namespace/vault host, not a SQL server + database. */
const HOSTLESS_DB_TYPES = new Set(['storage-adls', 'event-hub', 'service-bus', 'key-vault']);

/** Snowflake carries account/warehouse/role instead of a bare server + database. */
const SNOWFLAKE = 'snowflake';

function hostLabel(type: string): string {
  switch (type) {
    case 'storage-adls': return 'Account / host';
    case 'event-hub': case 'service-bus': return 'Namespace / host';
    case 'key-vault': return 'Vault / host';
    case 'adx': return 'Cluster URI';
    case SNOWFLAKE: return 'Account identifier';
    case 'bigquery': return 'GCP project id';
    case 'oracle': return 'Host (and :port if not 1521)';
    default: return 'Server / host';
  }
}
function hostPlaceholder(type: string): string {
  switch (type) {
    case 'storage-adls': return 'myaccount';
    case 'event-hub': return 'myns.servicebus.windows.net';
    case 'service-bus': return 'mybus.servicebus.windows.net';
    case 'key-vault': return 'myvault.vault.azure.net';
    case 'adx': return 'https://mycluster.eastus.kusto.windows.net';
    case SNOWFLAKE: return 'myorg-account123';
    case 'bigquery': return 'my-gcp-project';
    case 'oracle': return 'oracle.contoso.com:1521';
    case 'mysql': return 'myserver.mysql.database.azure.com';
    default: return 'myserver.database.windows.net';
  }
}
/** The per-type hint under the host field — grounded in the connector's own docs. */
function hostHint(type: string): string | undefined {
  switch (type) {
    case SNOWFLAKE:
      return 'The Snowflake account with its organization, exactly as the ADF SnowflakeV2 connector wants it — e.g. myorg-account123 (not the full .snowflakecomputing.com URL).';
    case 'bigquery': return 'The Google Cloud project that owns the dataset.';
    case 'oracle': return 'The Oracle listener host, reached through the on-prem data gateway below.';
    default: return undefined;
  }
}
function databaseLabel(type: string): string {
  switch (type) {
    case 'bigquery': return 'Dataset';
    case SNOWFLAKE: return 'Database';
    default: return 'Database';
  }
}

const METHODS: { value: string; label: string; hint: string }[] = [
  { value: 'entra-mi', label: 'Entra (managed identity)', hint: 'The Console identity connects — no secret. The source must allow this Entra principal.' },
  { value: 'sql-password', label: 'SQL username + password', hint: 'Password is stored in Key Vault.' },
  { value: 'connection-string', label: 'Connection string', hint: 'The full connection string is stored in Key Vault.' },
  { value: 'account-key', label: 'Account key', hint: 'Storage account key is stored in Key Vault.' },
  { value: 'service-principal', label: 'Service principal (Entra app)', hint: 'Client secret is stored in Key Vault.' },
  { value: 'key-pair', label: 'Key pair (PEM private key)', hint: 'The PEM private key is stored in Key Vault. Snowflake KeyPair authentication.' },
];

/**
 * Auth methods offered per source type. A method a source cannot actually use
 * is not shown — offering Entra MI for Snowflake would produce a connection
 * that can never log in, which is worse than an absent option. Types absent
 * from this map keep the full list (the Azure services, which all accept the
 * historical set).
 */
const TYPE_AUTH_METHODS: Record<string, string[]> = {
  snowflake: ['sql-password', 'key-pair'],
  bigquery: ['connection-string'],
  oracle: ['sql-password', 'connection-string'],
  mysql: ['sql-password', 'entra-mi'],
};

/** Per-type override for the secret field's label, so it names the real artifact. */
function secretLabelFor(type: string, authMethod: string): string {
  if (authMethod === 'key-pair') return 'Private key (PEM)';
  if (type === 'bigquery' && authMethod === 'connection-string') return 'Service-account key (JSON)';
  return authMethod === 'connection-string' ? 'Connection string'
    : authMethod === 'account-key' ? 'Account key'
    : authMethod === 'service-principal' ? 'Client secret' : 'Password';
}


const useStyles = makeStyles({
  body: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: '460px' },
  methodHint: { color: tokens.colorNeutralForeground3 },
  secretRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS },
});

export function ConnectionBuilder({
  open, onClose, onCreated, onSaved, lockType, editConnection,
}: {
  open: boolean;
  onClose: () => void;
  /** Fires after a successful CREATE with the new ConnectionView. */
  onCreated?: (c: ConnectionView) => void;
  /** Fires after a successful PATCH with the updated ConnectionView. */
  onSaved?: (c: ConnectionView) => void;
  lockType?: string;
  /** When set, the dialog is in edit mode: fields are prefilled and the submit PATCHes. */
  editConnection?: ConnectionView;
}) {
  const isEdit = !!editConnection;
  const s = useStyles();
  const [name, setName] = useState('');
  const [type, setType] = useState(lockType || 'azure-sql');
  const [authMethod, setAuthMethod] = useState('entra-mi');
  const [host, setHost] = useState('');
  const [database, setDatabase] = useState('');
  const [username, setUsername] = useState('');
  const [spnTenantId, setSpnTenantId] = useState('');
  const [spnClientId, setSpnClientId] = useState('');
  // Snowflake non-secret coordinates (ADF SnowflakeV2 typeProperties).
  const [warehouse, setWarehouse] = useState('');
  const [role, setRole] = useState('');
  const [schema, setSchema] = useState('');
  // Oracle: TNS service name + the self-hosted IR that reaches the source.
  const [serviceName, setServiceName] = useState('');
  const [gateway, setGateway] = useState('');
  const [secret, setSecret] = useState('');

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // "Test connection" state — a real reachability probe via POST /api/connections/test.
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ reachable: boolean; detail: string } | null>(null);
  const [testError, setTestError] = useState<{ error: string; hint?: string } | null>(null);

  // Prefill from editConnection when the dialog opens in edit mode.
  useEffect(() => {
    if (!open) return;
    if (editConnection) {
      setName(editConnection.name || '');
      setType(editConnection.type || 'azure-sql');
      setAuthMethod(editConnection.authMethod || 'entra-mi');
      setHost(editConnection.host || '');
      setDatabase(editConnection.database || '');
      setUsername(editConnection.username || '');
      setSpnTenantId(editConnection.spnTenantId || '');
      setSpnClientId(editConnection.spnClientId || '');
      setWarehouse(editConnection.warehouse || '');
      setRole(editConnection.role || '');
      setSchema(editConnection.schema || '');
      setServiceName(editConnection.serviceName || '');
      setGateway(editConnection.gateway || '');
      setSecret('');
      setErr(null);
    } else {
      setName(''); setType(lockType || 'azure-sql'); setAuthMethod('entra-mi');
      setHost(''); setDatabase(''); setUsername(''); setSpnTenantId(''); setSpnClientId('');
      setWarehouse(''); setRole(''); setSchema(''); setServiceName(''); setGateway('');
      setSecret(''); setErr(null);
    }
  }, [open, editConnection, lockType]);


  const needsSecret = ['sql-password', 'connection-string', 'account-key', 'service-principal', 'key-pair'].includes(authMethod);
  const secretLabel = secretLabelFor(type, authMethod);

  // Methods this source type can actually use. Snowflake/BigQuery/Oracle each
  // accept a narrower set than the Azure services, and an option that could
  // never authenticate is not offered (no-vaporware.md).
  const methodsForType = useMemo(
    () => (TYPE_AUTH_METHODS[type] ? METHODS.filter((m) => TYPE_AUTH_METHODS[type].includes(m.value)) : METHODS),
    [type],
  );

  // Changing the source type must never leave a stale, unusable auth method
  // selected — snap to the first method the new type supports. Create mode only:
  // in edit mode the type is locked, so the stored method stays authoritative.
  useEffect(() => {
    if (isEdit) return;
    if (!methodsForType.some((m) => m.value === authMethod)) {
      setAuthMethod(methodsForType[0]?.value || 'entra-mi');
    }
  }, [methodsForType, authMethod, isEdit]);

  const isSnowflake = type === SNOWFLAKE;
  const isOracle = type === 'oracle';


  // In create mode, secret is required. In edit mode it is optional (blank = keep existing).
  const secretRequired = needsSecret && !isEdit;
  // Every source type except a bare connection string reaches a host/namespace/
  // account — require it (matches Azure/Fabric, which block save without a
  // server). BigQuery is the exception to the exception: it authenticates with a
  // service-account JSON *and* still needs the GCP project id to address data.
  const hostRequired = authMethod !== 'connection-string' || type === 'bigquery';
  // Snowflake's ADF connector requires accountIdentifier + database + warehouse;
  // a connection missing any of the three cannot produce a valid linked service,
  // so the dialog blocks save rather than storing one that fails at run time.
  const snowflakeReady = !isSnowflake || (!!host.trim() && !!database.trim() && !!warehouse.trim());

  // A stale "Test" result must never linger after the coordinates change — clear
  // it whenever any probed field changes so the badge always reflects the form.
  useEffect(() => {
    setTestResult(null);
    setTestError(null);
  }, [type, authMethod, host, database, username, secret]);

  const runTest = useCallback(async () => {
    setTesting(true); setTestResult(null); setTestError(null);
    try {
      const r = await clientFetch('/api/connections/test', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type, authMethod, host, database, username,
          warehouse, role, schema, serviceName, gateway,
          secret: needsSecret && secret ? secret : undefined,
          id: isEdit ? editConnection?.id : undefined,
        }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) { setTestError({ error: j?.error || `HTTP ${r.status}`, hint: j?.hint }); return; }
      setTestResult({ reachable: !!j.reachable, detail: j.detail || '' });
    } catch (e: any) {
      setTestError({ error: e?.message || String(e) });
    } finally { setTesting(false); }
  }, [type, authMethod, host, database, username, warehouse, role, schema, serviceName, gateway, secret, needsSecret, isEdit, editConnection]);


  const canTest = !testing && !busy && !(hostRequired && !host.trim())
    && !(secretRequired && !secret);

  const submit = useCallback(async () => {
    setBusy(true); setErr(null);
    try {
      if (isEdit && editConnection) {
        // PATCH — only send fields that changed; never send an empty secret (would wipe KV).
        const body: Record<string, unknown> = {
          name, host, database, username, spnTenantId, spnClientId, authMethod,
          warehouse, role, schema, serviceName, gateway,
        };

        if (needsSecret && secret) body.secret = secret;
        const r = await clientFetch(`/api/connections/${encodeURIComponent(editConnection.id)}`, {
          method: 'PATCH', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        const j = await r.json();
        if (!r.ok || !j.ok) { setErr(j?.error || `HTTP ${r.status}`); return; }
        onSaved?.(j.connection);
        onClose();
      } else {
        // POST — create new connection.
        const r = await clientFetch('/api/connections', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name, type, authMethod, host, database, username, spnTenantId, spnClientId,
            warehouse, role, schema, serviceName, gateway,
            secret: needsSecret ? secret : undefined,
          }),

        });
        const j = await r.json();
        if (!r.ok || !j.ok) { setErr(j?.error || `HTTP ${r.status}`); return; }
        onCreated?.(j.connection);
        onClose();
      }
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [isEdit, editConnection, name, type, authMethod, host, database, username, spnTenantId, spnClientId, warehouse, role, schema, serviceName, gateway, secret, needsSecret, onCreated, onSaved, onClose]);


  const typeLabel = TYPES.find((t) => t.value === type)?.label || type;
  const methodObj = METHODS.find((m) => m.value === authMethod);

  return (
    <Dialog open={open} onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>
            <span className={s.secretRow}>
              {isEdit ? <Edit20Regular /> : <DatabasePlugConnected20Regular />}
              {isEdit ? 'Edit connection' : 'New connection'}
            </span>
          </DialogTitle>
          <DialogContent>
            <div className={s.body}>
              <Field label="Name" required>
                <Input value={name} placeholder="e.g. prod-sales-sql" onChange={(_, d) => setName(d.value)} />
              </Field>
              <Field label="Source type" required>
                <Dropdown value={typeLabel} selectedOptions={[type]} disabled={!!lockType || isEdit}
                  onOptionSelect={(_, d) => setType(d.optionValue || 'azure-sql')}>
                  {(['azure', 'other'] as const).map((g) => {
                    const inGroup = TYPES.filter((t) => t.group === g);
                    if (!inGroup.length) return null;
                    return (
                      <OptionGroup key={g} label={GROUP_LABEL[g]}>
                        {inGroup.map((t) => {
                          const TypeIcon = itemVisual(CONN_TILE_SLUG[t.value as keyof typeof CONN_TILE_SLUG] ?? t.value).icon;
                          return (
                            <Option key={t.value} value={t.value} text={t.label}><TypeIcon /> {t.label}</Option>
                          );
                        })}
                      </OptionGroup>
                    );
                  })}
                </Dropdown>
              </Field>
              <Field label="Authentication" required hint={methodObj?.hint}>
                <Dropdown value={methodObj?.label || ''} selectedOptions={[authMethod]}
                  onOptionSelect={(_, d) => setAuthMethod(d.optionValue || methodsForType[0]?.value || 'entra-mi')}>
                  {methodsForType.map((m) => <Option key={m.value} value={m.value}>{m.label}</Option>)}
                </Dropdown>
              </Field>


              {(authMethod !== 'connection-string' || hostRequired) && (
                <>
                  <Field label={hostLabel(type)} required={hostRequired} hint={hostHint(type)}>
                    <Input value={host} placeholder={hostPlaceholder(type)} onChange={(_, d) => setHost(d.value)} />
                  </Field>
                  {!HOSTLESS_DB_TYPES.has(type) && (
                    <Field label={databaseLabel(type)} required={isSnowflake}>
                      <Input value={database} placeholder={type === 'bigquery' ? 'analytics' : 'mydb'} onChange={(_, d) => setDatabase(d.value)} />
                    </Field>
                  )}
                </>
              )}

              {/* Snowflake — the ADF SnowflakeV2 connector's own coordinates.
                  Warehouse is required (it is the compute the session runs on);
                  role and schema are optional session defaults. */}
              {isSnowflake && (
                <>
                  <Field label="Warehouse" required hint="The virtual warehouse the mirroring session runs on.">
                    <Input value={warehouse} placeholder="COMPUTE_WH" onChange={(_, d) => setWarehouse(d.value)} />
                  </Field>
                  <Field label="Role" hint="Optional — the Snowflake role to assume. Needs USAGE on the database and SELECT on the tables to mirror.">
                    <Input value={role} placeholder="ACCOUNTADMIN" onChange={(_, d) => setRole(d.value)} />
                  </Field>
                  <Field label="Schema" hint="Optional — the default schema for the session.">
                    <Input value={schema} placeholder="PUBLIC" onChange={(_, d) => setSchema(d.value)} />
                  </Field>
                </>
              )}

              {/* Oracle reaches its source through an on-prem data gateway. */}
              {isOracle && (
                <>
                  <Field label="Service name / SID" hint="The TNS service name (e.g. ORCLPDB1).">
                    <Input value={serviceName} placeholder="ORCLPDB1" onChange={(_, d) => setServiceName(d.value)} />
                  </Field>
                  <Field label="On-prem data gateway (SHIR)" hint="The self-hosted integration runtime that can reach this Oracle listener.">
                    <Input value={gateway} placeholder="loom-onprem-ir" onChange={(_, d) => setGateway(d.value)} />
                  </Field>
                </>
              )}

              {(authMethod === 'sql-password' || authMethod === 'key-pair') && (
                <Field label="Username" required={isSnowflake}
                  hint={isSnowflake ? 'The Snowflake login name the mirror connects as.' : undefined}>
                  <Input value={username} onChange={(_, d) => setUsername(d.value)} />
                </Field>
              )}

              {authMethod === 'service-principal' && (
                <>
                  <Field label="Directory (tenant) id"><Input value={spnTenantId} onChange={(_, d) => setSpnTenantId(d.value)} /></Field>
                  <Field label="Application (client) id"><Input value={spnClientId} onChange={(_, d) => setSpnClientId(d.value)} /></Field>
                </>
              )}

              {needsSecret && (
                <Field
                  label={`${secretLabel} (→ Key Vault)`}
                  required={secretRequired}
                  hint={isEdit
                    ? 'Leave blank to keep the stored secret unchanged. Enter a new value to rotate it in Key Vault.'
                    : 'Stored in Key Vault — never saved in plaintext.'}>
                  {/* A PEM private key and a service-account JSON are multi-line
                      artifacts — a single-line password box mangles them. Both
                      go to Key Vault by the same POST as every other secret. */}
                  {authMethod === 'key-pair' || (type === 'bigquery' && authMethod === 'connection-string') ? (
                    <Textarea
                      resize="vertical"
                      rows={4}
                      value={secret}
                      placeholder={isEdit && editConnection?.hasSecret
                        ? '(secret stored — leave blank to keep)'
                        : authMethod === 'key-pair' ? '-----BEGIN PRIVATE KEY-----' : '{ "type": "service_account", … }'}
                      onChange={(_, d) => setSecret(d.value)}
                    />
                  ) : (
                    <Input
                      type="password"
                      contentBefore={<Key20Regular />}
                      value={secret}
                      placeholder={isEdit && editConnection?.hasSecret ? '(secret stored — leave blank to keep)' : undefined}
                      onChange={(_, d) => setSecret(d.value)}
                    />
                  )}
                </Field>
              )}

              {authMethod === 'entra-mi' && (
                <Caption1 className={s.methodHint}>
                  <ShieldKeyhole20Regular style={{ verticalAlign: 'middle', marginRight: tokens.spacingHorizontalXS }} />
                  No secret stored. The source must allow the Console managed identity (Entra) to connect.
                </Caption1>
              )}

              {testResult && (
                <MessageBar intent={testResult.reachable ? 'success' : 'info'}>
                  <MessageBarBody>{testResult.detail}</MessageBarBody>
                </MessageBar>
              )}
              {testError && (
                <MessageBar intent="error">
                  <MessageBarBody>
                    {testError.error}{testError.hint ? ` — ${testError.hint}` : ''}
                  </MessageBarBody>
                </MessageBar>
              )}

              {err && <MessageBar intent="error"><MessageBarBody>{err}</MessageBarBody></MessageBar>}
            </div>
          </DialogContent>
          <DialogActions>
            <Button
              appearance="secondary"
              icon={testing ? <Spinner size="tiny" /> : <DatabasePlugConnected20Regular />}
              disabled={!canTest}
              onClick={runTest}>
              {testing ? 'Testing…' : 'Test connection'}
            </Button>
            <Button appearance="secondary" onClick={onClose}>Cancel</Button>
            <Button
              appearance="primary"
              icon={isEdit ? <Edit20Regular /> : <Key20Regular />}
              disabled={busy || !name.trim() || (secretRequired && !secret) || (hostRequired && !host.trim()) || !snowflakeReady}

              onClick={submit}>
              {busy ? 'Saving…' : (isEdit ? 'Save changes' : 'Create connection')}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
