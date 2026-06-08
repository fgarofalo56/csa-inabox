'use client';

/**
 * Shortcut wizard building blocks — Azure-native parity with Fabric OneLake's
 * "New shortcut → External sources" experience, NO Fabric dependency.
 *
 * Exports (consumed by lib/editors/lakehouse-editor.tsx):
 *   - SHORTCUT_SOURCE_CARDS  : source-type catalog (label + blurb + readiness)
 *   - ShortcutSourceLogo     : inline brand SVG per source (no external/CDN fetch)
 *   - ExternalCredsForm       : structured credential form (key/secret, SA-JSON,
 *                               SAS, Synapse-Link path — NEVER a freeform JSON
 *                               blob for config) that stashes the secret into Key
 *                               Vault and surfaces ONLY the secret name
 *   - RemoteBrowseTree        : lazy, real remote-object tree over the browse BFF
 *
 * Credentials are written to Key Vault by the BFF and only the secret NAME is
 * ever held in the UI / Cosmos row. Per .claude/rules/no-vaporware.md every
 * control here calls a real backend; the only non-functional state is an honest
 * MessageBar gate. Per loom-no-freeform-config the credential inputs are typed
 * fields, not a JSON textarea (the GCS service-account file is the one exception
 * Google itself distributes as a .json — pasted whole, validated, never echoed).
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Badge, Button, Caption1, Field, Input, Textarea, Dropdown, Option, Spinner,
  Tree, TreeItem, TreeItemLayout, MessageBar, MessageBarBody, MessageBarTitle,
  tokens,
} from '@fluentui/react-components';
import {
  Folder20Regular, Document20Regular, ArrowSync16Regular, CheckmarkCircle16Filled,
  Key16Regular, Eye20Regular, EyeOff20Regular,
} from '@fluentui/react-icons';
import type { ShortcutTargetType } from '@/lib/azure/lakehouse-shortcuts';

// ---------------------------------------------------------------------------
// Source catalog + brand logos (inline SVG — CSP-safe, no remote image fetch).
// ---------------------------------------------------------------------------

export interface ShortcutSourceCard {
  type: ShortcutTargetType;
  label: string;
  blurb: string;
  /** true ⇒ works on the Console UAMI alone; false ⇒ needs a KV credential. */
  uamiReady: boolean;
}

export const SHORTCUT_SOURCE_CARDS: ShortcutSourceCard[] = [
  { type: 'internal', label: 'Internal Loom lakehouse', blurb: 'Another medallion container in this deployment', uamiReady: true },
  { type: 'adls', label: 'ADLS Gen2 / Azure Blob', blurb: 'Any storage account the Console UAMI can read', uamiReady: true },
  { type: 's3', label: 'Amazon S3', blurb: 'Bucket via access key/secret or IAM role', uamiReady: false },
  { type: 'gcs', label: 'Google Cloud Storage', blurb: 'Bucket via a service-account JSON', uamiReady: false },
  { type: 'dataverse', label: 'Dataverse', blurb: 'Tables via the Synapse-Link ADLS export', uamiReady: false },
  { type: 'delta_sharing', label: 'Delta Sharing', blurb: 'Cross-tenant share via a credential file', uamiReady: false },
];

/** Inline brand logo for a shortcut source type. Pure SVG, theme-agnostic fills. */
export function ShortcutSourceLogo({ type, size = 28 }: { type: ShortcutTargetType; size?: number }) {
  const s = size;
  switch (type) {
    case 's3':
      return (
        <svg width={s} height={s} viewBox="0 0 32 32" role="img" aria-label="Amazon S3">
          <path d="M6 7l10-3 10 3v18l-10 3-10-3V7z" fill="#E25444" />
          <path d="M16 4v27l10-3V7L16 4z" fill="#B0341D" />
          <path d="M11 12h10v2H11zm0 4h10v2H11zm0 4h7v2h-7z" fill="#fff" />
        </svg>
      );
    case 'gcs':
      return (
        <svg width={s} height={s} viewBox="0 0 32 32" role="img" aria-label="Google Cloud Storage">
          <rect x="5" y="9" width="22" height="6" rx="1" fill="#4285F4" />
          <rect x="5" y="17" width="22" height="6" rx="1" fill="#AECBFA" />
          <circle cx="9" cy="12" r="1.3" fill="#fff" />
          <circle cx="9" cy="20" r="1.3" fill="#4285F4" />
        </svg>
      );
    case 'adls':
      return (
        <svg width={s} height={s} viewBox="0 0 32 32" role="img" aria-label="Azure Data Lake Storage">
          <path d="M16 4l11 6v12l-11 6-11-6V10l11-6z" fill="#0078D4" />
          <path d="M16 4l11 6-11 6-11-6 11-6z" fill="#50B0E8" />
          <path d="M16 16l11-6v12l-11 6V16z" fill="#005A9E" />
        </svg>
      );
    case 'dataverse':
      return (
        <svg width={s} height={s} viewBox="0 0 32 32" role="img" aria-label="Microsoft Dataverse">
          <path d="M16 3l11 6.5v13L16 29 5 22.5v-13L16 3z" fill="#742774" />
          <path d="M16 3l11 6.5L16 16 5 9.5 16 3z" fill="#B05CB0" />
          <ellipse cx="16" cy="12" rx="6" ry="2.4" fill="#fff" opacity="0.85" />
        </svg>
      );
    case 'delta_sharing':
      return (
        <svg width={s} height={s} viewBox="0 0 32 32" role="img" aria-label="Delta Sharing">
          <path d="M6 22l10-16 10 16H6z" fill="#FF3621" />
          <path d="M11 22l5-8 5 8h-10z" fill="#fff" opacity="0.9" />
        </svg>
      );
    case 'internal':
    default:
      return (
        <svg width={s} height={s} viewBox="0 0 32 32" role="img" aria-label="Internal Loom lakehouse">
          <rect x="5" y="7" width="22" height="18" rx="2" fill="#5B5FC7" />
          <path d="M9 12h14v2H9zm0 5h14v2H9z" fill="#fff" />
        </svg>
      );
  }
}

// ---------------------------------------------------------------------------
// ExternalCredsForm — structured credential capture + KV stash.
// ---------------------------------------------------------------------------

export type CredSourceType = 's3' | 'gcs' | 'adls' | 'dataverse';

export interface ExternalCredsState {
  /** S3/GCS bucket. */
  bucket?: string;
  /** AWS region (S3). */
  region?: string;
  /** ADLS storage account (browse on UAMI — no KV secret). */
  account?: string;
  /** ADLS container/filesystem. */
  container?: string;
  /** KV secret NAME after a successful stash (never the value). */
  secretName?: string;
  /** Path the user picked in the browse tree (relative to the source root). */
  selectedPath?: string;
}

const AWS_REGIONS = [
  'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2',
  'us-gov-west-1', 'us-gov-east-1',
  'eu-west-1', 'eu-central-1', 'ap-southeast-1', 'ap-northeast-1',
];

interface ExternalCredsFormProps {
  sourceType: CredSourceType;
  lakehouseId: string;
  /** Shortcut name — used for the deterministic KV secret name. */
  shortcutName: string;
  value: ExternalCredsState;
  onChange: (next: ExternalCredsState) => void;
}

/**
 * Renders the typed credential inputs for one external source and a
 * "Save to Key Vault" action. On success the credential value is written to KV
 * and the form keeps ONLY the returned secret name; the raw value is dropped
 * from component state immediately.
 */
export function ExternalCredsForm({ sourceType, lakehouseId, shortcutName, value, onChange }: ExternalCredsFormProps) {
  // Local, ephemeral credential material — cleared as soon as it is stashed.
  const [accessKeyId, setAccessKeyId] = useState('');
  const [secretKey, setSecretKey] = useState('');
  const [roleArn, setRoleArn] = useState('');
  const [s3Mode, setS3Mode] = useState<'keys' | 'role'>('keys');
  const [saJson, setSaJson] = useState('');
  const [sasToken, setSasToken] = useState('');
  const [dvPath, setDvPath] = useState('');
  const [showSecret, setShowSecret] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = useCallback((patch: Partial<ExternalCredsState>) => onChange({ ...value, ...patch }), [onChange, value]);

  const stash = useCallback(async () => {
    setBusy(true); setError(null);
    let secretValue = '';
    if (sourceType === 's3') {
      secretValue = s3Mode === 'role' ? roleArn.trim() : `${accessKeyId.trim()}:${secretKey}`;
    } else if (sourceType === 'gcs') {
      secretValue = saJson.trim();
    } else if (sourceType === 'adls') {
      secretValue = sasToken.trim();
    } else {
      secretValue = dvPath.trim();
    }
    try {
      const r = await fetch('/api/lakehouse/shortcuts/credentials', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ lakehouseId, name: shortcutName || sourceType, sourceType, secretValue }),
      });
      const j = await r.json().catch(() => ({}));
      if (!j?.ok) throw new Error(j?.error || j?.hint || `HTTP ${r.status}`);
      // Drop the raw material from memory; keep only the secret name.
      setSecretKey(''); setSaJson(''); setSasToken('');
      set({ secretName: j.data.secretName });
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }, [sourceType, s3Mode, roleArn, accessKeyId, secretKey, saJson, sasToken, dvPath, lakehouseId, shortcutName, set]);

  const canStash =
    sourceType === 's3'
      ? (s3Mode === 'role' ? roleArn.trim().length > 0 : accessKeyId.trim().length > 0 && secretKey.length > 0)
      : sourceType === 'gcs'
      ? saJson.trim().length > 0
      : sourceType === 'adls'
      ? sasToken.trim().length > 0
      : dvPath.trim().length > 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {sourceType === 's3' && (
        <>
          <div style={{ display: 'flex', gap: 8 }}>
            <Field label="Bucket" required style={{ flex: 2 }}>
              <Input value={value.bucket || ''} onChange={(_, d) => set({ bucket: d.value })} placeholder="my-bucket" />
            </Field>
            <Field label="Region" required style={{ flex: 1 }}>
              <Dropdown
                value={value.region || 'us-east-1'}
                selectedOptions={[value.region || 'us-east-1']}
                onOptionSelect={(_, d) => set({ region: d.optionValue || 'us-east-1' })}
              >
                {AWS_REGIONS.map((rg) => <Option key={rg} value={rg}>{rg}</Option>)}
              </Dropdown>
            </Field>
          </div>
          <Field label="Authentication">
            <div style={{ display: 'flex', gap: 8 }}>
              <Button size="small" appearance={s3Mode === 'keys' ? 'primary' : 'outline'} onClick={() => setS3Mode('keys')}>Access key / secret</Button>
              <Button size="small" appearance={s3Mode === 'role' ? 'primary' : 'outline'} onClick={() => setS3Mode('role')}>IAM role ARN (Unity Catalog)</Button>
            </div>
          </Field>
          {s3Mode === 'keys' ? (
            <>
              <Field label="Access key ID" required>
                <Input value={accessKeyId} onChange={(_, d) => setAccessKeyId(d.value)} placeholder="AKIA…" disabled={!!value.secretName} />
              </Field>
              <Field label="Secret access key" required>
                <Input
                  type={showSecret ? 'text' : 'password'}
                  value={secretKey}
                  onChange={(_, d) => setSecretKey(d.value)}
                  disabled={!!value.secretName}
                  contentAfter={
                    <Button appearance="transparent" size="small" icon={showSecret ? <EyeOff20Regular /> : <Eye20Regular />} onClick={() => setShowSecret((v) => !v)} aria-label="Toggle secret visibility" />
                  }
                />
              </Field>
            </>
          ) : (
            <Field label="IAM role ARN" required hint="arn:aws:iam::<acct>:role/<name> — assumed by Unity Catalog (browse uses keys; role binds at create)">
              <Input value={roleArn} onChange={(_, d) => setRoleArn(d.value)} placeholder="arn:aws:iam::123456789012:role/loom-s3-read" disabled={!!value.secretName} />
            </Field>
          )}
        </>
      )}

      {sourceType === 'gcs' && (
        <>
          <Field label="Bucket" required>
            <Input value={value.bucket || ''} onChange={(_, d) => set({ bucket: d.value })} placeholder="my-gcs-bucket" />
          </Field>
          <Field label="Service-account JSON" required hint="Paste the service-account key file (.json) — stored in Key Vault, never echoed.">
            <Textarea value={saJson} onChange={(_, d) => setSaJson(d.value)} rows={5} placeholder={'{ "type": "service_account", "client_email": "…", "private_key": "-----BEGIN PRIVATE KEY-----…" }'} disabled={!!value.secretName} resize="vertical" />
          </Field>
        </>
      )}

      {sourceType === 'adls' && (
        <>
          <div style={{ display: 'flex', gap: 8 }}>
            <Field label="Storage account" required style={{ flex: 1 }} hint="Account name (browse runs on the Console UAMI)">
              <Input value={value.account || ''} onChange={(_, d) => set({ account: d.value })} placeholder="contosolake" />
            </Field>
            <Field label="Container / filesystem" required style={{ flex: 1 }}>
              <Input value={value.container || ''} onChange={(_, d) => set({ container: d.value })} placeholder="landing" />
            </Field>
          </div>
          <Field label="SAS token (optional)" hint="Only needed for accounts the UAMI cannot reach — stored in Key Vault, never echoed.">
            <Input type={showSecret ? 'text' : 'password'} value={sasToken} onChange={(_, d) => setSasToken(d.value)} disabled={!!value.secretName}
              contentAfter={<Button appearance="transparent" size="small" icon={showSecret ? <EyeOff20Regular /> : <Eye20Regular />} onClick={() => setShowSecret((v) => !v)} aria-label="Toggle secret visibility" />} />
          </Field>
        </>
      )}

      {sourceType === 'dataverse' && (
        <Field label="Synapse-Link export path" required hint="abfss://<container>@<account>.dfs.core.windows.net/<path> that Azure Synapse Link for Dataverse writes tables to — stored in Key Vault.">
          <Input value={dvPath} onChange={(_, d) => setDvPath(d.value)} placeholder="abfss://dataverse@contosolake.dfs.core.windows.net/exports" disabled={!!value.secretName} />
        </Field>
      )}

      {/* Stash / stashed status */}
      {value.secretName ? (
        <MessageBar intent="success">
          <MessageBarBody>
            <MessageBarTitle>Credential stored</MessageBarTitle>
            Saved as Key Vault secret <code>{value.secretName}</code>. The shortcut keeps only this name — the value is never stored in Cosmos or shown again.
            {' '}
            <Button size="small" appearance="transparent" onClick={() => set({ secretName: undefined })}>Replace…</Button>
          </MessageBarBody>
        </MessageBar>
      ) : sourceType === 'adls' ? (
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
          ADLS browses on the Console UAMI — save a SAS only for accounts the UAMI cannot read.
          {(value.account && value.container) ? '' : ' Enter account + container to browse.'}
        </Caption1>
      ) : (
        <div>
          <Button appearance="primary" size="small" icon={busy ? <Spinner size="tiny" /> : <Key16Regular />} disabled={!canStash || busy} onClick={stash}>
            {busy ? 'Saving…' : 'Save credential to Key Vault'}
          </Button>
        </div>
      )}
      {error && <MessageBar intent="error"><MessageBarBody>{error}</MessageBarBody></MessageBar>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// RemoteBrowseTree — lazy, real remote-object tree over the browse BFF.
// ---------------------------------------------------------------------------

interface RemoteEntryUi {
  name: string;
  path: string;
  isDirectory: boolean;
  size?: number;
  lastModified?: string;
}

interface RemoteBrowseTreeProps {
  sourceType: CredSourceType;
  /** S3/GCS bucket. */
  bucket?: string;
  /** AWS region (S3). */
  region?: string;
  /** ADLS account + container. */
  account?: string;
  container?: string;
  /** KV secret name (s3/gcs/dataverse). */
  kvSecret?: string;
  /** Called when the user clicks a folder or file in the tree. */
  onSelect: (path: string, isDirectory: boolean) => void;
  selectedPath?: string;
}

function fmtBytes(n?: number): string {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB']; let v = n / 1024; let i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${u[i]}`;
}

/**
 * Lazily lists one level at a time from the browse BFF, rendering an expandable
 * Fluent tree of the real remote objects. Folders fetch their children on first
 * expand; clicking any node selects it as the shortcut target sub-path.
 */
export function RemoteBrowseTree(props: RemoteBrowseTreeProps) {
  const { sourceType, bucket, region, account, container, kvSecret, onSelect, selectedPath } = props;
  const [childrenByPrefix, setChildrenByPrefix] = useState<Record<string, RemoteEntryUi[]>>({});
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [openItems, setOpenItems] = useState<Set<string>>(new Set());

  const ready =
    sourceType === 'adls'
      ? !!account && !!container
      : sourceType === 'dataverse'
      ? !!kvSecret
      : !!bucket && !!kvSecret;

  const fetchLevel = useCallback(async (prefix: string) => {
    setLoading((s) => new Set(s).add(prefix));
    setErrors((e) => { const n = { ...e }; delete n[prefix]; return n; });
    try {
      const qs = new URLSearchParams({ sourceType, prefix });
      if (bucket) qs.set('bucket', bucket);
      if (region) qs.set('region', region);
      if (account) qs.set('account', account);
      if (container) qs.set('container', container);
      if (kvSecret) qs.set('kvSecret', kvSecret);
      const r = await fetch(`/api/lakehouse/shortcuts/browse?${qs.toString()}`);
      const j = await r.json().catch(() => ({}));
      if (!j?.ok) throw new Error(j?.error || j?.hint || `HTTP ${r.status}`);
      setChildrenByPrefix((c) => ({ ...c, [prefix]: (j.data?.entries || []) as RemoteEntryUi[] }));
    } catch (e: any) {
      setErrors((er) => ({ ...er, [prefix]: e?.message || String(e) }));
    } finally {
      setLoading((s) => { const n = new Set(s); n.delete(prefix); return n; });
    }
  }, [sourceType, bucket, region, account, container, kvSecret]);

  // Root load when the inputs become ready (and reset when they change).
  useEffect(() => {
    setChildrenByPrefix({}); setErrors({}); setOpenItems(new Set());
    if (ready) fetchLevel('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, sourceType, bucket, region, account, container, kvSecret]);

  const renderLevel = (prefix: string): React.ReactNode => {
    if (errors[prefix]) {
      return (
        <TreeItem itemType="leaf" value={`err-${prefix}`}>
          <TreeItemLayout><Caption1 style={{ color: tokens.colorPaletteRedForeground1 }}>{errors[prefix]}</Caption1></TreeItemLayout>
        </TreeItem>
      );
    }
    const rows = childrenByPrefix[prefix];
    if (rows === undefined) {
      return (
        <TreeItem itemType="leaf" value={`load-${prefix}`}>
          <TreeItemLayout><Spinner size="tiny" label="Loading…" labelPosition="after" /></TreeItemLayout>
        </TreeItem>
      );
    }
    if (rows.length === 0) {
      return (
        <TreeItem itemType="leaf" value={`empty-${prefix}`}>
          <TreeItemLayout><Caption1 style={{ color: tokens.colorNeutralForeground3 }}>No objects</Caption1></TreeItemLayout>
        </TreeItem>
      );
    }
    return rows.map((e) =>
      e.isDirectory ? (
        <TreeItem key={e.path} itemType="branch" value={e.path}>
          <TreeItemLayout
            iconBefore={<Folder20Regular />}
            onClick={() => onSelect(e.path, true)}
            style={selectedPath === e.path ? { fontWeight: 600, color: tokens.colorBrandForeground1 } : undefined}
          >
            {e.name}
          </TreeItemLayout>
          <Tree>
            {loading.has(e.path)
              ? <TreeItem itemType="leaf" value={`load-${e.path}`}><TreeItemLayout><Spinner size="tiny" /></TreeItemLayout></TreeItem>
              : renderLevel(e.path)}
          </Tree>
        </TreeItem>
      ) : (
        <TreeItem key={e.path} itemType="leaf" value={e.path}>
          <TreeItemLayout
            iconBefore={<Document20Regular />}
            onClick={() => onSelect(e.path, false)}
            aside={<Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{fmtBytes(e.size)}</Caption1>}
            style={selectedPath === e.path ? { fontWeight: 600, color: tokens.colorBrandForeground1 } : undefined}
          >
            {e.name}
          </TreeItemLayout>
        </TreeItem>
      ),
    );
  };

  if (!ready) {
    return (
      <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
        {sourceType === 'adls'
          ? 'Enter a storage account and container to browse.'
          : 'Save the credential to Key Vault and set the bucket to browse.'}
      </Caption1>
    );
  }

  return (
    <div style={{ border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 6, padding: 6, maxHeight: 240, overflow: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
        <Caption1 style={{ flex: 1, color: tokens.colorNeutralForeground3 }}>
          {selectedPath ? <>Target: <code>{selectedPath || '(root)'}</code></> : 'Click a folder or file to set the target'}
        </Caption1>
        <Button size="small" appearance="transparent" icon={<ArrowSync16Regular />} onClick={() => fetchLevel('')} aria-label="Refresh">Refresh</Button>
        {selectedPath !== undefined && <Badge appearance="tint" color="brand" icon={<CheckmarkCircle16Filled />}>selected</Badge>}
      </div>
      <Tree
        aria-label="Remote objects"
        openItems={openItems}
        onOpenChange={(_, data) => {
          setOpenItems(new Set(data.openItems as Set<string>));
          const v = data.value as string;
          if (data.open && v && childrenByPrefix[v] === undefined && !loading.has(v)) fetchLevel(v);
        }}
      >
        {renderLevel('')}
      </Tree>
    </div>
  );
}
