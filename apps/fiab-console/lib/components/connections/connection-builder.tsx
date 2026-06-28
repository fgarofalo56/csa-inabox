'use client';

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

import { useState, useCallback, useEffect } from 'react';
import {
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  Field, Input, Dropdown, Option, Button, MessageBar, MessageBarBody,
  Caption1, makeStyles, tokens,
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
}

const TYPES: { value: string; label: string }[] = [
  { value: 'azure-sql', label: 'Azure SQL Database' },
  { value: 'synapse-dedicated', label: 'Synapse — Dedicated SQL pool' },
  { value: 'synapse-serverless', label: 'Synapse — Serverless SQL' },
  { value: 'databricks-sql', label: 'Databricks SQL' },
  { value: 'postgres', label: 'PostgreSQL' },
  { value: 'storage-adls', label: 'ADLS Gen2 / Storage' },
  { value: 'cosmos', label: 'Azure Cosmos DB' },
  { value: 'adx', label: 'Azure Data Explorer (Kusto)' },
  { value: 'event-hub', label: 'Event Hubs' },
  { value: 'service-bus', label: 'Service Bus' },
  { value: 'key-vault', label: 'Key Vault' },
  { value: 'generic-sql', label: 'Generic SQL Server' },
];

/** Types whose connection target is an account/namespace/vault host, not a SQL server + database. */
const HOSTLESS_DB_TYPES = new Set(['storage-adls', 'event-hub', 'service-bus', 'key-vault']);

function hostLabel(type: string): string {
  switch (type) {
    case 'storage-adls': return 'Account / host';
    case 'event-hub': case 'service-bus': return 'Namespace / host';
    case 'key-vault': return 'Vault / host';
    case 'adx': return 'Cluster URI';
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
    default: return 'myserver.database.windows.net';
  }
}

const METHODS: { value: string; label: string; hint: string }[] = [
  { value: 'entra-mi', label: 'Entra (managed identity)', hint: 'The Console identity connects — no secret. The source must allow this Entra principal.' },
  { value: 'sql-password', label: 'SQL username + password', hint: 'Password is stored in Key Vault.' },
  { value: 'connection-string', label: 'Connection string', hint: 'The full connection string is stored in Key Vault.' },
  { value: 'account-key', label: 'Account key', hint: 'Storage account key is stored in Key Vault.' },
  { value: 'service-principal', label: 'Service principal (Entra app)', hint: 'Client secret is stored in Key Vault.' },
];

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
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

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
      setSecret('');
      setErr(null);
    } else {
      setName(''); setType(lockType || 'azure-sql'); setAuthMethod('entra-mi');
      setHost(''); setDatabase(''); setUsername(''); setSpnTenantId(''); setSpnClientId('');
      setSecret(''); setErr(null);
    }
  }, [open, editConnection, lockType]);

  const needsSecret = ['sql-password', 'connection-string', 'account-key', 'service-principal'].includes(authMethod);
  const secretLabel = authMethod === 'connection-string' ? 'Connection string'
    : authMethod === 'account-key' ? 'Account key'
    : authMethod === 'service-principal' ? 'Client secret' : 'Password';

  // In create mode, secret is required. In edit mode it is optional (blank = keep existing).
  const secretRequired = needsSecret && !isEdit;

  const submit = useCallback(async () => {
    setBusy(true); setErr(null);
    try {
      if (isEdit && editConnection) {
        // PATCH — only send fields that changed; never send an empty secret (would wipe KV).
        const body: Record<string, unknown> = { name, host, database, username, spnTenantId, spnClientId, authMethod };
        if (needsSecret && secret) body.secret = secret;
        const r = await fetch(`/api/connections/${encodeURIComponent(editConnection.id)}`, {
          method: 'PATCH', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        const j = await r.json();
        if (!r.ok || !j.ok) { setErr(j?.error || `HTTP ${r.status}`); return; }
        onSaved?.(j.connection);
        onClose();
      } else {
        // POST — create new connection.
        const r = await fetch('/api/connections', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name, type, authMethod, host, database, username, spnTenantId, spnClientId, secret: needsSecret ? secret : undefined }),
        });
        const j = await r.json();
        if (!r.ok || !j.ok) { setErr(j?.error || `HTTP ${r.status}`); return; }
        onCreated?.(j.connection);
        onClose();
      }
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [isEdit, editConnection, name, type, authMethod, host, database, username, spnTenantId, spnClientId, secret, needsSecret, onCreated, onSaved, onClose]);

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
                  {TYPES.map((t) => {
                    const TypeIcon = itemVisual(CONN_TILE_SLUG[t.value as keyof typeof CONN_TILE_SLUG] ?? t.value).icon;
                    return (
                      <Option key={t.value} value={t.value} text={t.label} media={<TypeIcon />}>{t.label}</Option>
                    );
                  })}
                </Dropdown>
              </Field>
              <Field label="Authentication" required hint={methodObj?.hint}>
                <Dropdown value={methodObj?.label || ''} selectedOptions={[authMethod]}
                  onOptionSelect={(_, d) => setAuthMethod(d.optionValue || 'entra-mi')}>
                  {METHODS.map((m) => <Option key={m.value} value={m.value}>{m.label}</Option>)}
                </Dropdown>
              </Field>

              {authMethod !== 'connection-string' && (
                <>
                  <Field label={hostLabel(type)}>
                    <Input value={host} placeholder={hostPlaceholder(type)} onChange={(_, d) => setHost(d.value)} />
                  </Field>
                  {!HOSTLESS_DB_TYPES.has(type) && (
                    <Field label="Database">
                      <Input value={database} placeholder="mydb" onChange={(_, d) => setDatabase(d.value)} />
                    </Field>
                  )}
                </>
              )}

              {authMethod === 'sql-password' && (
                <Field label="Username"><Input value={username} onChange={(_, d) => setUsername(d.value)} /></Field>
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
                  <Input
                    type="password"
                    contentBefore={<Key20Regular />}
                    value={secret}
                    placeholder={isEdit && editConnection?.hasSecret ? '(secret stored — leave blank to keep)' : undefined}
                    onChange={(_, d) => setSecret(d.value)}
                  />
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
            <Button
              appearance="primary"
              icon={isEdit ? <Edit20Regular /> : <Key20Regular />}
              disabled={busy || !name.trim() || (secretRequired && !secret)}
              onClick={submit}>
              {busy ? 'Saving…' : (isEdit ? 'Save changes' : 'Create connection')}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
