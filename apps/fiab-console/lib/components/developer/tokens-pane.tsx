'use client';

/**
 * TokensPane — the Developer / scoped API tokens surface (BR-PAT).
 *
 * One component drives BOTH the per-user Developer settings page
 * (`/settings/developer/tokens`) and the tenant-admin oversight page
 * (`/admin/developer/tokens`) via the `admin` prop:
 *   • admin={false} → GET/POST/DELETE /api/developer/tokens (own tokens; create).
 *   • admin={true}  → GET /api/admin/developer/tokens (all tenant tokens),
 *                     DELETE /api/admin/developer/tokens/[id] (revoke any).
 *
 * Create wizard (users only): name + typed scope (dropdown) + expiry (dropdown)
 * — no free-form config. On create the full token is shown ONCE with a copy
 * button and an explicit "you won't see it again" warning; after that only the
 * safe view (id/name/scope/lastUsed/expiry) is ever rendered. All fetches go
 * through clientFetch (session cookie + fail-fast). Real backend, no mocks.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  makeStyles, tokens,
  Spinner, MessageBar, MessageBarBody, MessageBarTitle,
  Button, Badge, Caption1, Body1, Body1Strong, Text,
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  Field, Input, Dropdown, Option, Tooltip,
} from '@fluentui/react-components';
import {
  Add24Regular, Delete24Regular, Copy16Regular, Checkmark16Regular,
  Key24Regular, Warning24Filled,
} from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';
import { Section } from '@/lib/components/ui/section';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';

type PatScope = 'read-only' | 'read-write' | 'admin';

interface TokenView {
  id: string;
  name: string;
  scope: PatScope;
  createdByOid: string;
  createdByUpn: string;
  createdByName: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt?: string;
  revoked: boolean;
  revokedAt?: string;
  expired: boolean;
}

const SCOPE_LABEL: Record<PatScope, string> = {
  'read-only': 'Read only',
  'read-write': 'Read / write',
  'admin': 'Admin',
};
const SCOPE_HINT: Record<PatScope, string> = {
  'read-only': 'GET requests only — cannot make changes.',
  'read-write': 'Full data-plane access as you (no admin surfaces).',
  'admin': 'Admin surfaces too — only works while you are a tenant admin.',
};

const EXPIRY_OPTIONS = [
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days (default)' },
  { days: 60, label: '60 days' },
  { days: 90, label: '90 days (max)' },
];

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  form: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: '420px' },
  reveal: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: '480px' },
  tokenBox: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS,
    padding: tokens.spacingVerticalS,
    paddingLeft: tokens.spacingHorizontalM, paddingRight: tokens.spacingHorizontalM,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground3,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
    wordBreak: 'break-all',
  },
  tokenText: { flexGrow: 1, minWidth: 0 },
  scopeHint: { color: tokens.colorNeutralForeground3 },
  muted: { color: tokens.colorNeutralForeground3 },
});

function fmtDate(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

function statusBadge(t: TokenView) {
  if (t.revoked) return <Badge appearance="tint" color="danger">Revoked</Badge>;
  if (t.expired) return <Badge appearance="tint" color="warning">Expired</Badge>;
  return <Badge appearance="tint" color="success">Active</Badge>;
}

export function TokensPane({ admin = false }: { admin?: boolean }) {
  const s = useStyles();
  const listUrl = admin ? '/api/admin/developer/tokens' : '/api/developer/tokens';
  const revokeUrl = (id: string) =>
    admin ? `/api/admin/developer/tokens/${id}` : `/api/developer/tokens/${id}`;

  const [tokens_, setTokens] = useState<TokenView[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Create dialog state (users only).
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [scope, setScope] = useState<PatScope>('read-only');
  const [ttlDays, setTtlDays] = useState(30);
  const [creating, setCreating] = useState(false);
  const [createErr, setCreateErr] = useState<string | null>(null);

  // One-time reveal state.
  const [revealToken, setRevealToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const res = await clientFetch(listUrl);
      const body = await res.json();
      if (!res.ok || !body.ok) throw new Error(body?.error || body?.reason || `HTTP ${res.status}`);
      setTokens(body.tokens as TokenView[]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setTokens([]);
    }
  }, [listUrl]);

  useEffect(() => { void load(); }, [load]);

  const resetCreate = () => { setName(''); setScope('read-only'); setTtlDays(30); setCreateErr(null); };

  const submitCreate = async () => {
    setCreating(true);
    setCreateErr(null);
    try {
      const res = await clientFetch('/api/developer/tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, scope, ttlDays }),
      });
      const body = await res.json();
      if (!res.ok || !body.ok) throw new Error(body?.error || body?.reason || `HTTP ${res.status}`);
      setCreateOpen(false);
      resetCreate();
      setRevealToken(body.token as string);
      setCopied(false);
      await load();
    } catch (e) {
      setCreateErr(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  };

  const revoke = async (t: TokenView) => {
    if (t.revoked) return;
    setBusy(true);
    try {
      const res = await clientFetch(revokeUrl(t.id), { method: 'DELETE' });
      const body = await res.json();
      if (!res.ok || !body.ok) throw new Error(body?.error || body?.reason || `HTTP ${res.status}`);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const copyToken = async () => {
    if (!revealToken) return;
    try { await navigator.clipboard.writeText(revealToken); setCopied(true); } catch { /* clipboard blocked */ }
  };

  const columns = useMemo<LoomColumn<TokenView>[]>(() => {
    const cols: LoomColumn<TokenView>[] = [
      { key: 'name', label: 'Name', sortable: true, filterable: true, render: (t) => <Body1Strong>{t.name}</Body1Strong> },
      { key: 'scope', label: 'Scope', sortable: true, filterable: true, width: 130, render: (t) => <Badge appearance="outline">{SCOPE_LABEL[t.scope]}</Badge> },
      { key: 'status', label: 'Status', width: 110, render: (t) => statusBadge(t) },
    ];
    if (admin) {
      cols.push({ key: 'owner', label: 'Owner', sortable: true, filterable: true, render: (t) => <Caption1>{t.createdByUpn}</Caption1> });
    }
    cols.push(
      { key: 'lastUsedAt', label: 'Last used', sortable: true, width: 180, render: (t) => <Caption1 className={s.muted}>{fmtDate(t.lastUsedAt)}</Caption1> },
      { key: 'expiresAt', label: 'Expires', sortable: true, width: 180, render: (t) => <Caption1 className={s.muted}>{fmtDate(t.expiresAt)}</Caption1> },
      {
        key: 'actions', label: '', width: 100, render: (t) => (
          <Tooltip content={t.revoked ? 'Already revoked' : 'Revoke token'} relationship="label">
            <Button
              appearance="subtle"
              size="small"
              icon={<Delete24Regular />}
              disabled={t.revoked || busy}
              onClick={() => void revoke(t)}
              aria-label={`Revoke ${t.name}`}
            >Revoke</Button>
          </Tooltip>
        ),
      },
    );
    return cols;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [admin, busy, s.muted]);

  const actions = admin ? undefined : (
    <Button appearance="primary" icon={<Add24Regular />} onClick={() => { resetCreate(); setCreateOpen(true); }}>
      New token
    </Button>
  );

  return (
    <div className={s.root}>
      {err && (
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>Could not load tokens.</MessageBarTitle> {err}
          </MessageBarBody>
        </MessageBar>
      )}

      <Section
        title={admin ? 'Tenant API tokens' : 'Your API tokens'}
        actions={actions}
      >
        {tokens_ === null ? (
          <Spinner label="Loading tokens…" />
        ) : (
          <LoomDataTable
            columns={columns as unknown as LoomColumn<Record<string, unknown>>[]}
            rows={tokens_ as unknown as Record<string, unknown>[]}
            getRowId={(r) => (r as unknown as TokenView).id}
            empty={admin
              ? 'No API tokens have been created in this tenant yet.'
              : 'You have no API tokens yet. Create one to call the Loom API from CI, scripts, or Terraform.'}
          />
        )}
      </Section>

      {/* Create dialog (users only) */}
      <Dialog open={createOpen} onOpenChange={(_, d) => setCreateOpen(d.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Create API token</DialogTitle>
            <DialogContent>
              <div className={s.form}>
                {createErr && (
                  <MessageBar intent="error"><MessageBarBody>{createErr}</MessageBarBody></MessageBar>
                )}
                <Field label="Name" required hint="A label so you can recognize this token later.">
                  <Input value={name} onChange={(_, d) => setName(d.value)} placeholder="e.g. CI pipeline — prod deploy" maxLength={120} />
                </Field>
                <Field label="Scope" required hint={SCOPE_HINT[scope]}>
                  <Dropdown
                    value={SCOPE_LABEL[scope]}
                    selectedOptions={[scope]}
                    onOptionSelect={(_, d) => { if (d.optionValue) setScope(d.optionValue as PatScope); }}
                  >
                    <Option value="read-only" text={SCOPE_LABEL['read-only']}>{SCOPE_LABEL['read-only']}</Option>
                    <Option value="read-write" text={SCOPE_LABEL['read-write']}>{SCOPE_LABEL['read-write']}</Option>
                    <Option value="admin" text={SCOPE_LABEL['admin']}>{SCOPE_LABEL['admin']}</Option>
                  </Dropdown>
                </Field>
                <Field label="Expires" required hint="Tokens are short-lived by design. Maximum 90 days.">
                  <Dropdown
                    value={EXPIRY_OPTIONS.find((o) => o.days === ttlDays)?.label || `${ttlDays} days`}
                    selectedOptions={[String(ttlDays)]}
                    onOptionSelect={(_, d) => { if (d.optionValue) setTtlDays(Number(d.optionValue)); }}
                  >
                    {EXPIRY_OPTIONS.map((o) => (
                      <Option key={o.days} value={String(o.days)} text={o.label}>{o.label}</Option>
                    ))}
                  </Dropdown>
                </Field>
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setCreateOpen(false)} disabled={creating}>Cancel</Button>
              <Button appearance="primary" onClick={() => void submitCreate()} disabled={creating || !name.trim()} icon={creating ? <Spinner size="tiny" /> : <Key24Regular />}>
                Create token
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* One-time secret reveal */}
      <Dialog open={!!revealToken} onOpenChange={(_, d) => { if (!d.open) setRevealToken(null); }}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Copy your API token now</DialogTitle>
            <DialogContent>
              <div className={s.reveal}>
                <MessageBar intent="warning" icon={<Warning24Filled />}>
                  <MessageBarBody>
                    <MessageBarTitle>This is the only time the token is shown.</MessageBarTitle>
                    Loom stores only a one-way hash — if you lose it you must create a new one.
                  </MessageBarBody>
                </MessageBar>
                <div className={s.tokenBox}>
                  <Text className={s.tokenText} font="monospace">{revealToken}</Text>
                  <Tooltip content={copied ? 'Copied' : 'Copy to clipboard'} relationship="label">
                    <Button
                      appearance="subtle"
                      size="small"
                      icon={copied ? <Checkmark16Regular /> : <Copy16Regular />}
                      onClick={() => void copyToken()}
                      aria-label="Copy token"
                    />
                  </Tooltip>
                </div>
                <Body1 className={s.scopeHint}>
                  Use it as a bearer header:{' '}
                  <Text font="monospace">Authorization: Bearer &lt;token&gt;</Text>. Verify it against{' '}
                  <Text font="monospace">/api/v1/whoami</Text>.
                </Body1>
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="primary" onClick={() => setRevealToken(null)}>Done</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}
