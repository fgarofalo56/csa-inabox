'use client';

/**
 * CosmosConnectPanel — the Data Explorer studio's **Connect** surface (the
 * portal's "Keys" blade, themed). One-for-one with the Azure portal Cosmos DB
 * "Keys" pane:
 *
 *   - URI (the account's data-plane endpoint)
 *   - PRIMARY / SECONDARY KEY + READ-ONLY KEYS (masked, reveal + copy)
 *   - PRIMARY / SECONDARY CONNECTION STRING (+ Mongo / Gremlin strings when
 *     those APIs are enabled — ARM returns them all, labeled)
 *   - Regenerate (rotate) each read-write key
 *
 * Real backend: GET/POST /api/items/cosmos-db/[id]/keys → ARM listKeys /
 * listConnectionStrings / regenerateKey (api-version 2024-11-15). No mocks.
 *
 * Honest gates (per no-vaporware.md):
 *   - 503 not_configured  → the env vars to set (cosmosConfigGate hint)
 *   - 403 keys_permission → the EXACT role to grant (DocumentDB Account
 *     Contributor + role ID); "Cosmos DB Operator" is named as insufficient
 *   - disableLocalAuth=true → an info banner: keys exist in ARM but the data
 *     plane rejects them; use AAD/RBAC (new CosmosClient(endpoint, cred)).
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Button, Caption1, Subtitle2, Body1, Field, Input, Spinner, Badge, Divider,
  Tooltip, MessageBar, MessageBarBody, MessageBarTitle, MessageBarActions,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Eye20Regular, EyeOff20Regular, Copy20Regular, Checkmark20Regular,
  ArrowSync20Regular, Key20Regular, LinkMultiple20Regular,
} from '@fluentui/react-icons';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: 14, padding: '8px 4px', overflow: 'auto', height: '100%' },
  head: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  section: { display: 'flex', flexDirection: 'column', gap: 10 },
  sectionHead: { display: 'flex', alignItems: 'center', gap: 8 },
  row: { display: 'flex', alignItems: 'flex-end', gap: 6 },
  grow: { flex: 1, minWidth: 0 },
  note: { color: tokens.colorNeutralForeground3 },
  mono: { fontFamily: tokens.fontFamilyMonospace },
});

interface KeySet {
  primaryMasterKey: string;
  secondaryMasterKey: string;
  primaryReadonlyMasterKey: string;
  secondaryReadonlyMasterKey: string;
}
interface ConnStr { connectionString: string; description: string }

interface KeysResponse {
  ok?: boolean;
  code?: string;
  error?: string;
  hint?: string;
  missing?: string;
  role?: string;
  roleId?: string;
  endpoint?: string;
  account?: string;
  disableLocalAuth?: boolean;
  keys?: KeySet;
  connectionStrings?: ConnStr[];
}

type KeyKind = 'primary' | 'secondary' | 'primaryReadonly' | 'secondaryReadonly';

const KEY_ROWS: { kind: KeyKind; label: string; rw: boolean }[] = [
  { kind: 'primary', label: 'Primary Key', rw: true },
  { kind: 'secondary', label: 'Secondary Key', rw: true },
  { kind: 'primaryReadonly', label: 'Primary Read-Only Key', rw: false },
  { kind: 'secondaryReadonly', label: 'Secondary Read-Only Key', rw: false },
];

const KEY_FIELD: Record<KeyKind, keyof KeySet> = {
  primary: 'primaryMasterKey',
  secondary: 'secondaryMasterKey',
  primaryReadonly: 'primaryReadonlyMasterKey',
  secondaryReadonly: 'secondaryReadonlyMasterKey',
};

/** A masked secret with reveal + copy controls. */
function SecretRow({
  id, label, value, suffix,
}: { id: string; label: string; value: string; suffix?: React.ReactNode }) {
  const s = useStyles();
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch { /* clipboard blocked — reveal lets the user copy manually */ }
  }, [value]);
  return (
    <Field label={label}>
      <div className={s.row}>
        <div className={s.grow}>
          <Input
            readOnly
            id={id}
            className={s.mono}
            type={revealed ? 'text' : 'password'}
            value={value}
            aria-label={label}
          />
        </div>
        <Tooltip content={revealed ? 'Hide' : 'Reveal'} relationship="label">
          <Button
            appearance="subtle"
            icon={revealed ? <EyeOff20Regular /> : <Eye20Regular />}
            aria-label={revealed ? `Hide ${label}` : `Reveal ${label}`}
            onClick={() => setRevealed((r) => !r)}
          />
        </Tooltip>
        <Tooltip content={copied ? 'Copied' : 'Copy'} relationship="label">
          <Button
            appearance="subtle"
            icon={copied ? <Checkmark20Regular /> : <Copy20Regular />}
            aria-label={`Copy ${label}`}
            onClick={copy}
          />
        </Tooltip>
        {suffix}
      </div>
    </Field>
  );
}

export interface CosmosConnectPanelProps {
  /** Loom catalog item ID (path param; the account itself is env-pinned). */
  id: string;
}

export function CosmosConnectPanel({ id }: CosmosConnectPanelProps) {
  const s = useStyles();
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<KeysResponse | null>(null);
  const [rotating, setRotating] = useState<KeyKind | null>(null);
  const [confirmKind, setConfirmKind] = useState<KeyKind | null>(null);
  const [rotateError, setRotateError] = useState<string | null>(null);

  const url = `/api/items/cosmos-db/${encodeURIComponent(id || '_')}/keys`;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(url, { cache: 'no-store' });
      const j: KeysResponse = await res.json().catch(() => ({}));
      setData({ ...j, ok: res.ok && j.ok !== false });
    } catch (e) {
      setData({ ok: false, error: (e as Error)?.message || 'Failed to load keys' });
    } finally {
      setLoading(false);
    }
  }, [url]);

  useEffect(() => { void load(); }, [load]);

  const regenerate = useCallback(async (kind: KeyKind) => {
    setRotating(kind);
    setRotateError(null);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ keyKind: kind }),
      });
      const j: KeysResponse = await res.json().catch(() => ({}));
      if (res.ok && j.keys) {
        setData((d) => (d ? { ...d, keys: j.keys } : d));
      } else {
        setRotateError(j.hint || j.error || `Regenerate failed (HTTP ${res.status})`);
      }
    } catch (e) {
      setRotateError((e as Error)?.message || 'Regenerate failed');
    } finally {
      setRotating(null);
      setConfirmKind(null);
    }
  }, [url]);

  if (loading) {
    return (
      <div className={s.root}>
        <Spinner label="Loading endpoint, keys, and connection strings…" />
      </div>
    );
  }

  // ---- Honest gates -------------------------------------------------------
  if (data?.code === 'not_configured') {
    return (
      <div className={s.root}>
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Cosmos DB account not configured</MessageBarTitle>
            {data.hint || `Set ${data.missing} on the Console Container App.`}
          </MessageBarBody>
        </MessageBar>
      </div>
    );
  }
  if (data?.code === 'keys_permission') {
    return (
      <div className={s.root}>
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>Key access denied — grant the right role</MessageBarTitle>
            The Console managed identity can reach the account but lacks the
            {' '}<code>Microsoft.DocumentDB/databaseAccounts/listKeys/action</code> permission. Grant
            it the <strong>{data.role || 'DocumentDB Account Contributor'}</strong> role
            {data.roleId ? <> (role ID <code>{data.roleId}</code>)</> : null} at the Cosmos account
            scope. <strong>Cosmos DB Operator is NOT sufficient</strong> — it explicitly blocks key
            access. {data.hint}
          </MessageBarBody>
        </MessageBar>
      </div>
    );
  }
  if (!data?.ok || !data.keys) {
    return (
      <div className={s.root}>
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>Couldn&apos;t load keys</MessageBarTitle>
            {data?.error || 'The ARM listKeys / listConnectionStrings call did not return data.'}
          </MessageBarBody>
          <MessageBarActions>
            <Button appearance="transparent" icon={<ArrowSync20Regular />} onClick={() => void load()}>
              Retry
            </Button>
          </MessageBarActions>
        </MessageBar>
      </div>
    );
  }

  const keys = data.keys;
  const conns = data.connectionStrings || [];

  return (
    <div className={s.root}>
      <div className={s.head}>
        <Subtitle2>Connect</Subtitle2>
        {data.account && <Badge appearance="tint">{data.account}</Badge>}
        <div style={{ flex: 1 }} />
        <Tooltip content="Refresh" relationship="label">
          <Button appearance="subtle" icon={<ArrowSync20Regular />} aria-label="Refresh keys" onClick={() => void load()} />
        </Tooltip>
      </div>

      {data.disableLocalAuth && (
        <MessageBar intent="info">
          <MessageBarBody>
            <MessageBarTitle>Key auth is disabled on this account (RBAC-only)</MessageBarTitle>
            This account sets <code>disableLocalAuth: true</code>. The keys below exist in ARM but the
            data plane will reject them — connect with AAD/RBAC instead:
            {' '}<code>new CosmosClient(endpoint, new DefaultAzureCredential())</code>. Loom drives the
            Data Explorer this way (the Console managed identity), which is why no key is needed to
            browse data here.
          </MessageBarBody>
        </MessageBar>
      )}

      {/* ---- Endpoint URI ---- */}
      <Field label="URI">
        <div className={s.row}>
          <div className={s.grow}>
            <Input readOnly className={s.mono} value={data.endpoint || ''} aria-label="Account endpoint URI" />
          </div>
          <CopyIconButton label="URI" value={data.endpoint || ''} />
        </div>
      </Field>

      <Divider />

      {/* ---- Keys ---- */}
      <div className={s.section}>
        <div className={s.sectionHead}>
          <Key20Regular />
          <Subtitle2>Keys</Subtitle2>
        </div>
        {rotateError && (
          <MessageBar intent="error">
            <MessageBarBody>
              <MessageBarTitle>Regenerate failed</MessageBarTitle>
              {rotateError}
            </MessageBarBody>
          </MessageBar>
        )}
        {KEY_ROWS.map((r) => (
          <SecretRow
            key={r.kind}
            id={`cosmos-key-${r.kind}`}
            label={r.label}
            value={keys[KEY_FIELD[r.kind]]}
            suffix={r.rw ? (
              <Tooltip content="Regenerate (rotate) this key" relationship="label">
                <Button
                  appearance="subtle"
                  icon={<ArrowSync20Regular />}
                  aria-label={`Regenerate ${r.label}`}
                  disabled={rotating !== null}
                  onClick={() => setConfirmKind(r.kind)}
                />
              </Tooltip>
            ) : undefined}
          />
        ))}
      </div>

      <Divider />

      {/* ---- Connection strings ---- */}
      <div className={s.section}>
        <div className={s.sectionHead}>
          <LinkMultiple20Regular />
          <Subtitle2>Connection Strings</Subtitle2>
        </div>
        {conns.length === 0 ? (
          <Caption1 className={s.note}>
            ARM returned no connection strings for this account.
          </Caption1>
        ) : (
          conns.map((c, i) => (
            <SecretRow
              key={`${c.description}-${i}`}
              id={`cosmos-conn-${i}`}
              label={c.description}
              value={c.connectionString}
            />
          ))
        )}
        <Caption1 className={s.note}>
          ARM returns the connection strings for every enabled API in one call — NoSQL/SQL always,
          plus Mongo and Gremlin strings when those capabilities are enabled on the account. The
          endpoint embedded in each string is already cloud-correct
          (<code>documents.azure.com</code> / <code>documents.azure.us</code>).
        </Caption1>
      </div>

      <Divider />
      <Caption1 className={s.note}>
        Keys and connection strings are read live from the real ARM control plane
        (<code>POST …/databaseAccounts/&#123;acct&#125;/listKeys</code> and
        {' '}<code>/listConnectionStrings</code>, api-version 2024-11-15). The Console managed identity
        needs <strong>DocumentDB Account Contributor</strong> (role ID
        {' '}<code>5bd9cd88-fe45-4216-938b-f97437e15450</code>) — Cosmos DB Operator is not enough.
      </Caption1>

      {/* Regenerate confirmation */}
      <Dialog open={confirmKind !== null} onOpenChange={(_e, d) => { if (!d.open) setConfirmKind(null); }}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Regenerate key?</DialogTitle>
            <DialogContent>
              <Body1>
                Rotating the <strong>{KEY_ROWS.find((r) => r.kind === confirmKind)?.label}</strong> immediately
                invalidates the old value. Any client or connection string still using the old key will
                stop authenticating. This cannot be undone.
              </Body1>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setConfirmKind(null)} disabled={rotating !== null}>
                Cancel
              </Button>
              <Button
                appearance="primary"
                icon={rotating !== null ? <Spinner size="tiny" /> : <ArrowSync20Regular />}
                disabled={rotating !== null}
                onClick={() => { if (confirmKind) void regenerate(confirmKind); }}
              >
                Regenerate
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}

/** Copy-to-clipboard icon button with a transient check. */
function CopyIconButton({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch { /* clipboard blocked */ }
  }, [value]);
  return (
    <Tooltip content={copied ? 'Copied' : 'Copy'} relationship="label">
      <Button
        appearance="subtle"
        icon={copied ? <Checkmark20Regular /> : <Copy20Regular />}
        aria-label={`Copy ${label}`}
        onClick={copy}
      />
    </Tooltip>
  );
}

export default CosmosConnectPanel;
