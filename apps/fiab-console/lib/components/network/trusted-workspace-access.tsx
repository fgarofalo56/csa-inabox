'use client';

/**
 * Trusted workspace access — storage resource-instance rules on the shared
 * admin Network page (Fabric-parity Phase 4 G6).
 *
 * The Azure-native equivalent of Fabric's "trusted workspace access": authorize
 * a managed identity (the Console UAMI, or a workspace's own uami-ws-<id>) to
 * reach a FIREWALLED ADLS Gen2 / Blob storage account by writing a REAL
 * `{ tenantId, resourceId }` entry into the account's
 * `networkAcls.resourceAccessRules` over ARM (GET + PATCH — the sibling
 * trusted-resources BFF route). Pick a workspace (scopes the route + the
 * workspace-identity option) and a storage account (live ARM discovery via
 * /api/storage/accounts), see the live rules + firewall posture, Add / Remove.
 *
 * Honest gates (no-vaporware): 503 → the exact env var; 403 → the exact role
 * (Storage Account Contributor on the target account) — rendered as Fluent
 * MessageBars, never a blank table. Web5: Fluent v9 + Loom tokens, same card
 * language as the sibling network cards. NO Fabric dependency.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Spinner, MessageBar, MessageBarBody, MessageBarTitle, Button, Badge,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  Subtitle2, Body1, Caption1, Divider, tokens,
  Field, Dropdown, Option,
} from '@fluentui/react-components';
import {
  LockClosedKey24Regular, Add16Regular, ArrowClockwise16Regular, Delete16Regular,
  Checkmark16Filled, Warning16Filled, Info16Filled,
} from '@fluentui/react-icons';

const card: React.CSSProperties = {
  padding: tokens.spacingVerticalXL, border: `1px solid ${tokens.colorNeutralStroke2}`,
  borderRadius: tokens.borderRadiusXLarge, backgroundColor: tokens.colorNeutralBackground1,
  marginBottom: tokens.spacingVerticalXL, boxShadow: tokens.shadow4,
};
const head: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalMNudge, marginBottom: tokens.spacingVerticalL, flexWrap: 'wrap', minWidth: 0,
};
const mono: React.CSSProperties = { fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase200, overflowWrap: 'anywhere' };

const api = (ws: string) => `/api/admin/workspaces/${encodeURIComponent(ws)}/networking/trusted-resources`;

interface WsLite { id: string; name: string; storageAccountId?: string }
interface StorageAccount {
  id: string; name: string; resourceGroup?: string; subscriptionId: string; isHns: boolean;
}
interface Rule { tenantId: string; resourceId: string }
interface TrustedState {
  accountId: string; accountName: string; publicNetworkAccess?: string;
  defaultAction?: string; bypass?: string; resourceInstances: Rule[];
}
interface IdentityChoice { resourceId: string; tenantId: string; name: string }
interface Gate { reason?: string; remediation?: string; missing?: string[]; roleId?: string }
interface GetResp {
  ok: boolean; state?: TrustedState;
  identities?: { consoleUami: IdentityChoice | null; workspaceIdentity: IdentityChoice | null };
  error?: string; gate?: Gate; reason?: string;
}

/** Best human-readable remediation text out of any honest-gate response shape. */
function gateText(j: { ok?: boolean; error?: string; gate?: Gate; reason?: string } | null): string | undefined {
  if (!j || j.ok) return undefined;
  return j.gate?.remediation || j.reason || j.error;
}

/** Firewall-posture badge + honest hint about when resource-instance rules apply. */
function postureHint(state: TrustedState): { intent: 'info' | 'warning' | 'success'; title: string; body: string } {
  if ((state.publicNetworkAccess || '').toLowerCase() === 'disabled') {
    return {
      intent: 'warning',
      title: 'Public network access is fully disabled on this account.',
      body: 'Resource-instance rules only take effect when the account is "Enabled from selected virtual networks and IP addresses". ' +
        'With public access Disabled, ONLY private endpoints reach the account — the rules below are inert until the account is switched to selected-networks mode.',
    };
  }
  if ((state.defaultAction || '').toLowerCase() !== 'deny') {
    return {
      intent: 'info',
      title: 'The firewall default action is Allow.',
      body: 'Every network can already reach this account, so resource-instance rules are not being enforced. ' +
        'Set the account firewall default action to Deny for trusted access to become the authorization boundary.',
    };
  }
  return {
    intent: 'success',
    title: 'Trusted access is enforced.',
    body: 'The firewall default action is Deny with selected-networks public access — only the resource instances below (plus any IP/VNet rules and trusted Azure services) can reach the account.',
  };
}

export function TrustedWorkspaceAccessCard() {
  // Pickers
  const [workspaces, setWorkspaces] = useState<WsLite[] | null>(null);
  const [wsErr, setWsErr] = useState<string | undefined>();
  const [wsId, setWsId] = useState('');
  const [accounts, setAccounts] = useState<StorageAccount[] | null>(null);
  const [acctErr, setAcctErr] = useState<string | undefined>();
  const [accountId, setAccountId] = useState('');
  // Rules
  const [data, setData] = useState<GetResp | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | undefined>();
  const [identity, setIdentity] = useState<'console-uami' | 'workspace-identity' | ''>('');

  // Load workspaces (route scope + the workspace-identity option) once.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch('/api/workspaces');
        const j = await r.json();
        const list: WsLite[] = Array.isArray(j) ? j : (j?.workspaces || []);
        if (!alive) return;
        setWorkspaces(list);
        if (list.length > 0) setWsId((cur) => cur || list[0].id);
      } catch (e) { if (alive) { setWorkspaces([]); setWsErr(e instanceof Error ? e.message : String(e)); } }
    })();
    return () => { alive = false; };
  }, []);

  // Live storage-account discovery (ARM, Console identity Reader).
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch('/api/storage/accounts');
        const j = await r.json();
        if (!alive) return;
        if (j?.ok) setAccounts(Array.isArray(j.accounts) ? j.accounts : []);
        else { setAccounts([]); setAcctErr(`${j?.error || 'Could not list storage accounts.'}${j?.hint ? ' — ' + j.hint : ''}`); }
      } catch (e) { if (alive) { setAccounts([]); setAcctErr(e instanceof Error ? e.message : String(e)); } }
    })();
    return () => { alive = false; };
  }, []);

  const selectedWs = useMemo(() => (workspaces || []).find((w) => w.id === wsId), [workspaces, wsId]);
  const selectedAccount = useMemo(() => (accounts || []).find((a) => a.id === accountId), [accounts, accountId]);

  // Default the account to the workspace's bound lake (else the first ADLS Gen2 account).
  useEffect(() => {
    if (!accounts || accounts.length === 0 || accountId) return;
    const bound = selectedWs?.storageAccountId
      && accounts.find((a) => a.id.toLowerCase() === selectedWs.storageAccountId!.toLowerCase());
    setAccountId((bound || accounts.find((a) => a.isHns) || accounts[0]).id);
  }, [accounts, accountId, selectedWs]);

  const load = useCallback(async () => {
    if (!wsId || !accountId) return;
    setLoading(true); setNotice(undefined);
    try {
      const r = await fetch(`${api(wsId)}?storageAccountId=${encodeURIComponent(accountId)}`);
      const j = (await r.json()) as GetResp;
      setData(j);
    } catch (e) {
      setData({ ok: false, error: e instanceof Error ? e.message : String(e) });
    } finally { setLoading(false); }
  }, [wsId, accountId]);
  useEffect(() => { void load(); }, [load]);

  const identities = data?.identities;
  // Default the Add dropdown to the first resolvable identity.
  useEffect(() => {
    if (!identities) return;
    setIdentity((cur) => {
      if (cur === 'console-uami' && identities.consoleUami) return cur;
      if (cur === 'workspace-identity' && identities.workspaceIdentity) return cur;
      return identities.consoleUami ? 'console-uami' : identities.workspaceIdentity ? 'workspace-identity' : '';
    });
  }, [identities]);

  const add = useCallback(async () => {
    if (!wsId || !accountId || !identity) return;
    setBusy(true); setNotice(undefined);
    try {
      const r = await fetch(api(wsId), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ storageAccountId: accountId, identity }),
      });
      const j = await r.json();
      if (j.ok) { setNotice(j.message || 'Resource-instance rule added.'); setData((p) => (p ? { ...p, state: j.state } : p)); }
      else setNotice(gateText(j) || j.error || 'Add failed.');
    } catch (e) { setNotice(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }, [wsId, accountId, identity]);

  const remove = useCallback(async (rule: Rule) => {
    if (!wsId || !accountId) return;
    setBusy(true); setNotice(undefined);
    try {
      const qs = new URLSearchParams({
        storageAccountId: accountId, resourceId: rule.resourceId, tenantId: rule.tenantId,
      });
      const r = await fetch(`${api(wsId)}?${qs.toString()}`, { method: 'DELETE' });
      const j = await r.json();
      if (j.ok) { setNotice('Resource-instance rule removed.'); setData((p) => (p ? { ...p, state: j.state } : p)); }
      else setNotice(gateText(j) || j.error || 'Remove failed.');
    } catch (e) { setNotice(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }, [wsId, accountId]);

  /** Which known identity a rule matches — for the Identity badge. */
  const ruleBadge = useCallback((rule: Rule) => {
    const rid = rule.resourceId.toLowerCase();
    if (identities?.consoleUami && rid === identities.consoleUami.resourceId.toLowerCase()) {
      return <Badge appearance="tint" color="brand" icon={<Checkmark16Filled />}>Console UAMI</Badge>;
    }
    if (identities?.workspaceIdentity && rid === identities.workspaceIdentity.resourceId.toLowerCase()) {
      return <Badge appearance="tint" color="success" icon={<Checkmark16Filled />}>Workspace identity</Badge>;
    }
    return <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>external</Caption1>;
  }, [identities]);

  const state = data?.ok ? data.state : undefined;
  const gate = data && !data.ok ? gateText(data) : undefined;
  const rules = state?.resourceInstances || [];
  const hint = state ? postureHint(state) : undefined;

  return (
    <div style={card}>
      <div style={head}>
        <LockClosedKey24Regular />
        <Subtitle2>Trusted access (storage resource-instance rules)</Subtitle2>
        <Badge appearance="tint" color="brand" style={{ marginLeft: 'auto' }}>Azure-native · trusted workspace access</Badge>
      </div>

      <Body1 style={{ display: 'block', marginBottom: tokens.spacingVerticalM, color: tokens.colorNeutralForeground3 }}>
        Authorize a managed identity through a firewalled storage account&rsquo;s network rules — the Azure-native
        equivalent of Fabric&rsquo;s trusted workspace access. Adding an identity writes a real
        {' '}<code>networkAcls.resourceAccessRules</code> entry (<code>{'{ tenantId, resourceId }'}</code>) on the
        account over ARM, so that identity reaches the data even with the firewall default action set to Deny.
      </Body1>

      {/* Scope pickers */}
      <div style={{ display: 'flex', gap: tokens.spacingHorizontalL, flexWrap: 'wrap', marginBottom: tokens.spacingVerticalL }}>
        <Field label="Workspace" hint="Scopes the request + the workspace-identity option" style={{ minWidth: 240 }}>
          <Dropdown
            placeholder={workspaces === null ? 'Loading…' : workspaces.length === 0 ? 'No workspaces' : 'Select a workspace'}
            disabled={!workspaces || workspaces.length === 0}
            value={selectedWs?.name || ''}
            selectedOptions={wsId ? [wsId] : []}
            onOptionSelect={(_e, d) => { setWsId(d.optionValue || ''); setData(null); }}
          >
            {(workspaces || []).map((w) => (
              <Option key={w.id} value={w.id} text={w.name}>{w.name}</Option>
            ))}
          </Dropdown>
        </Field>
        <Field label="Storage account" hint="Live ARM discovery — accounts the Console identity can read" style={{ minWidth: 280 }}>
          <Dropdown
            placeholder={accounts === null ? 'Loading…' : accounts.length === 0 ? 'No storage accounts readable' : 'Select an account'}
            disabled={!accounts || accounts.length === 0}
            value={selectedAccount ? `${selectedAccount.name}${selectedAccount.isHns ? ' (ADLS Gen2)' : ''}` : ''}
            selectedOptions={accountId ? [accountId] : []}
            onOptionSelect={(_e, d) => { setAccountId(d.optionValue || ''); setData(null); }}
          >
            {(accounts || []).map((a) => (
              <Option key={a.id} value={a.id} text={`${a.name} (${a.resourceGroup || a.subscriptionId})`}>
                {a.name} · {a.resourceGroup || a.subscriptionId}{a.isHns ? ' · ADLS Gen2' : ''}
              </Option>
            ))}
          </Dropdown>
        </Field>
        <div style={{ display: 'flex', alignItems: 'flex-end' }}>
          <Button appearance="subtle" icon={<ArrowClockwise16Regular />} disabled={!wsId || !accountId || loading} onClick={() => void load()}>
            Refresh
          </Button>
        </div>
      </div>

      {wsErr && (
        <MessageBar intent="warning" style={{ marginBottom: tokens.spacingVerticalM }}>
          <MessageBarBody><MessageBarTitle>Couldn&rsquo;t list workspaces</MessageBarTitle>{wsErr}</MessageBarBody>
        </MessageBar>
      )}
      {workspaces !== null && workspaces.length === 0 && !wsErr && (
        <MessageBar intent="info" style={{ marginBottom: tokens.spacingVerticalM }}>
          <MessageBarBody>
            <MessageBarTitle>No workspaces yet</MessageBarTitle>
            Trusted access routes through a workspace&rsquo;s networking surface — create a workspace first.
          </MessageBarBody>
        </MessageBar>
      )}
      {acctErr && (
        <MessageBar intent="warning" style={{ marginBottom: tokens.spacingVerticalM }}>
          <MessageBarBody><MessageBarTitle>Couldn&rsquo;t list storage accounts</MessageBarTitle>{acctErr}</MessageBarBody>
        </MessageBar>
      )}

      {notice && (
        <MessageBar intent="info" style={{ marginBottom: tokens.spacingVerticalM }}>
          <MessageBarBody>{notice}</MessageBarBody>
        </MessageBar>
      )}

      {loading && <Spinner label="Reading the account's network rules…" />}

      {!loading && gate && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Trusted access unavailable</MessageBarTitle>
            {gate}
          </MessageBarBody>
        </MessageBar>
      )}

      {!loading && state && (
        <>
          {hint && (
            <MessageBar intent={hint.intent} style={{ marginBottom: tokens.spacingVerticalM }}>
              <MessageBarBody>
                <MessageBarTitle>{hint.title}</MessageBarTitle>
                {hint.body}
              </MessageBarBody>
            </MessageBar>
          )}

          <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', alignItems: 'center', marginBottom: tokens.spacingVerticalM }}>
            <Badge appearance="tint" color={(state.defaultAction || '').toLowerCase() === 'deny' ? 'success' : 'warning'} icon={<Info16Filled />}>
              Default action: {state.defaultAction || '—'}
            </Badge>
            <Badge appearance="tint" color={(state.publicNetworkAccess || 'Enabled').toLowerCase() === 'disabled' ? 'danger' : 'informative'}>
              Public network access: {state.publicNetworkAccess || 'Enabled'}
            </Badge>
            <Badge appearance="tint" color="informative">Bypass: {state.bypass || 'None'}</Badge>
          </div>

          {/* Add rule */}
          <div style={{ display: 'flex', gap: tokens.spacingHorizontalMNudge, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: tokens.spacingVerticalL }}>
            <Field label="Identity to authorize" hint="The rule admits this identity's ARM resource instance" style={{ minWidth: 300 }}>
              <Dropdown
                placeholder={identities && (identities.consoleUami || identities.workspaceIdentity) ? 'Select an identity' : 'No identity resolvable'}
                disabled={!identities || (!identities.consoleUami && !identities.workspaceIdentity)}
                value={
                  identity === 'console-uami' && identities?.consoleUami ? `Console UAMI (${identities.consoleUami.name})`
                  : identity === 'workspace-identity' && identities?.workspaceIdentity ? `Workspace identity (${identities.workspaceIdentity.name})`
                  : ''
                }
                selectedOptions={identity ? [identity] : []}
                onOptionSelect={(_e, d) => setIdentity((d.optionValue as typeof identity) || '')}
              >
                <Option value="console-uami" disabled={!identities?.consoleUami}
                  text={identities?.consoleUami ? `Console UAMI (${identities.consoleUami.name})` : 'Console UAMI — set LOOM_UAMI_RESOURCE_ID'}>
                  {identities?.consoleUami
                    ? `Console UAMI (${identities.consoleUami.name})`
                    : 'Console UAMI — set LOOM_UAMI_RESOURCE_ID to enable'}
                </Option>
                <Option value="workspace-identity" disabled={!identities?.workspaceIdentity}
                  text={identities?.workspaceIdentity ? `Workspace identity (${identities.workspaceIdentity.name})` : 'Workspace identity — not provisioned'}>
                  {identities?.workspaceIdentity
                    ? `Workspace identity (${identities.workspaceIdentity.name})`
                    : 'Workspace identity — none for this workspace (deploy workspace-identity.bicep)'}
                </Option>
              </Dropdown>
            </Field>
            <Button appearance="primary" icon={<Add16Regular />} disabled={busy || !identity} onClick={() => void add()}>
              {busy ? <Spinner size="tiny" /> : 'Authorize identity'}
            </Button>
          </div>

          {identities && !identities.workspaceIdentity && (
            <Caption1 block style={{ color: tokens.colorNeutralForeground3, marginBottom: tokens.spacingVerticalM }}>
              <Warning16Filled style={{ verticalAlign: 'text-bottom' }} /> This workspace has no per-workspace managed
              identity (uami-ws-{wsId || '<id>'}) — only the Console UAMI can be authorized. Provision one with
              {' '}<code>platform/fiab/bicep/modules/landing-zone/workspace-identity.bicep</code> to grant the
              workspace its own trusted access.
            </Caption1>
          )}

          {/* Live rules */}
          {rules.length === 0 ? (
            <Body1 style={{ color: tokens.colorNeutralForeground3 }}>
              No resource-instance rules on <strong>{state.accountName}</strong> yet — no identity is authorized
              through the firewall. Use &ldquo;Authorize identity&rdquo; above to add one.
            </Body1>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <Table size="small" aria-label="Storage resource-instance rules">
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>Resource instance</TableHeaderCell>
                    <TableHeaderCell>Identity</TableHeaderCell>
                    <TableHeaderCell>Tenant</TableHeaderCell>
                    <TableHeaderCell>Actions</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rules.map((r, i) => (
                    <TableRow key={`${r.resourceId}-${i}`}>
                      <TableCell>
                        <span style={{ fontWeight: 600 }}>{r.resourceId.split('/').pop()}</span>
                        <Caption1 block style={{ ...mono, color: tokens.colorNeutralForeground3 }}>{r.resourceId}</Caption1>
                      </TableCell>
                      <TableCell>{ruleBadge(r)}</TableCell>
                      <TableCell><span style={mono}>{r.tenantId || '—'}</span></TableCell>
                      <TableCell>
                        <Button
                          appearance="subtle" size="small" icon={<Delete16Regular />}
                          disabled={busy} title="Remove this resource-instance rule"
                          aria-label={`Remove ${r.resourceId}`} onClick={() => void remove(r)}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </>
      )}

      <Divider style={{ margin: '14px 0 10px' }} />
      <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
        Backed by <code>Microsoft.Storage/storageAccounts</code> PATCH of{' '}
        <code>networkAcls.resourceAccessRules</code> over ARM — the complete firewall object is read back and
        preserved on every update. Rules take effect when the account is &ldquo;Enabled from selected networks&rdquo;
        with default action Deny. Tenant-admin only — storage firewall rules govern shared landing-zone data.
      </Caption1>
    </div>
  );
}
