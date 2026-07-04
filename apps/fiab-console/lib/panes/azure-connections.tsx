'use client';

import { clientFetch } from '@/lib/client-fetch';
/**
 * AzureConnectionsPane (F16) — connect ADLS Gen2 + Log Analytics to a workspace.
 *
 * Azure-native parity for the Fabric/Azure "Connections & gateways" experience,
 * scoped to a Loom workspace. Two bindings:
 *
 *   • ADLS Gen2 → Dataflow staging. Pick a real storage account (HNS first);
 *     once connected the Dataflow Gen2 ADF run path stages its output there.
 *   • Log Analytics → Query-log export. Pick a real Log Analytics workspace;
 *     once connected the workspace's query/run logs stream to it.
 *
 * Backend (all real, per no-vaporware.md):
 *   GET    /api/admin/workspaces/{id}/connections
 *   POST   /api/admin/workspaces/{id}/connections
 *   DELETE /api/admin/workspaces/{id}/connections/{connId}
 *   GET    /api/admin/workspaces/{id}/connections/adls-accounts
 *   GET    /api/admin/workspaces/{id}/connections/log-analytics-workspaces
 *
 * Connecting verifies the Console UAMI holds the required Contributor role and
 * probes the real data plane. When the role is missing the binding is saved
 * with status 'role-missing' and this pane renders an honest Fluent MessageBar
 * naming the exact role + bicep remediation, with a Retry button. No Microsoft
 * Fabric / Power BI is involved.
 *
 * Two render modes:
 *   • embeddedMode → renders inline (used inside a drawer/tab).
 *   • default      → renders its own trigger Button + Drawer.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Drawer, DrawerHeader, DrawerHeaderTitle, DrawerBody,
  Button, Tooltip, Field, Input, Dropdown, Option,
  MessageBar, MessageBarBody, MessageBarTitle, Spinner, Badge,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  Subtitle2, Caption1,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  PlugConnected24Regular, Dismiss24Regular, PlugDisconnected20Regular,
  Storage24Regular, DataHistogram24Regular,
} from '@fluentui/react-icons';

type ConnectionKind = 'adls-gen2' | 'log-analytics';
type ConnectionStatus = 'connected' | 'role-missing' | 'probe-failed';

interface RoleGate { missing: string; hint: string }

interface AzureConnection {
  id: string;
  workspaceId: string;
  kind: ConnectionKind;
  name: string;
  storageAccountId?: string;
  storageAccountName?: string;
  containerName?: string;
  dfsEndpoint?: string;
  subscriptionId?: string;
  resourceGroup?: string;
  lawResourceId?: string;
  lawWorkspaceId?: string;
  lawName?: string;
  status: ConnectionStatus;
  statusDetail?: string;
  roleGate?: RoleGate;
  connectedAt?: string;
}

interface StorageAccountSummary {
  id: string; name: string; location?: string; isHns: boolean; resourceGroup?: string;
}
interface LawSummary {
  id: string; name: string; location?: string; customerId?: string; resourceGroup?: string;
}

const useStyles = makeStyles({
  body: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXL, minWidth: 0 },
  section: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, minWidth: 0 },
  sectionHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  form: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, padding: tokens.spacingVerticalM, borderRadius: tokens.borderRadiusMedium, border: `1px solid ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground2, minWidth: 0 },
  row: { display: 'flex', alignItems: 'flex-end', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  grow: { flex: 1, minWidth: '220px' },
  empty: { padding: tokens.spacingVerticalL, textAlign: 'center', color: tokens.colorNeutralForeground3, border: `1px dashed ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium, overflowWrap: 'anywhere', wordBreak: 'break-word' },
  detail: { fontSize: '11px', color: tokens.colorNeutralForeground3, overflowWrap: 'anywhere', wordBreak: 'break-word' },
});

function statusBadge(status: ConnectionStatus): { color: 'success' | 'warning' | 'danger'; label: string } {
  switch (status) {
    case 'connected': return { color: 'success', label: 'Connected' };
    case 'role-missing': return { color: 'warning', label: 'Role missing' };
    default: return { color: 'danger', label: 'Probe failed' };
  }
}

// =========================================================================

interface Props { workspaceId: string; embeddedMode?: boolean; }

export function AzureConnectionsPane({ workspaceId, embeddedMode }: Props) {
  const [open, setOpen] = useState(false);

  if (embeddedMode) return <ConnectionsBody workspaceId={workspaceId} />;

  return (
    <>
      <Tooltip content="Azure connections" relationship="label">
        <Button appearance="subtle" icon={<PlugConnected24Regular />} onClick={() => setOpen(true)}
          aria-label="Azure connections">
          Connections
        </Button>
      </Tooltip>
      <Drawer open={open} onOpenChange={(_, d) => setOpen(d.open)} position="end" size="medium">
        <DrawerHeader>
          <DrawerHeaderTitle action={
            <Button appearance="subtle" icon={<Dismiss24Regular />} onClick={() => setOpen(false)} aria-label="Close" />
          }>
            Azure connections
          </DrawerHeaderTitle>
        </DrawerHeader>
        <DrawerBody>
          <ConnectionsBody workspaceId={workspaceId} />
        </DrawerBody>
      </Drawer>
    </>
  );
}

function ConnectionsBody({ workspaceId }: { workspaceId: string }) {
  const styles = useStyles();
  const [connections, setConnections] = useState<AzureConnection[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await clientFetch(`/api/admin/workspaces/${workspaceId}/connections`, { cache: 'no-store' });
      const json = await res.json();
      if (!res.ok || !json.ok) { setLoadError(json?.error || `HTTP ${res.status}`); return; }
      setConnections(json.connections || []);
    } catch (e: any) {
      setLoadError(e?.message || String(e));
    }
  }, [workspaceId]);

  useEffect(() => { void load(); }, [load]);

  const adls = (connections || []).find((c) => c.kind === 'adls-gen2') || null;
  const law = (connections || []).find((c) => c.kind === 'log-analytics') || null;

  return (
    <div className={styles.body}>
      {loadError && (
        <MessageBar intent="error"><MessageBarBody>{loadError}</MessageBarBody></MessageBar>
      )}
      {!connections && !loadError && <Spinner size="tiny" label="Loading connections…" />}

      {connections && (
        <>
          <AdlsSection workspaceId={workspaceId} current={adls} onChanged={load} />
          <LawSection workspaceId={workspaceId} current={law} onChanged={load} />
        </>
      )}
    </div>
  );
}

// ---------------------------------- shared gate + row ----------------------

function GateBar({ conn, workspaceId, onRetry }: { conn: AzureConnection; workspaceId: string; onRetry: () => void }) {
  const [retrying, setRetrying] = useState(false);
  const retry = useCallback(async () => {
    setRetrying(true);
    try {
      const body = conn.kind === 'adls-gen2'
        ? { kind: 'adls-gen2', storageAccountId: conn.storageAccountId, containerName: conn.containerName, name: conn.name }
        : { kind: 'log-analytics', lawResourceId: conn.lawResourceId, name: conn.name };
      await clientFetch(`/api/admin/workspaces/${workspaceId}/connections`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      onRetry();
    } finally {
      setRetrying(false);
    }
  }, [conn, workspaceId, onRetry]);

  if (conn.status === 'role-missing' && conn.roleGate) {
    return (
      <MessageBar intent="warning">
        <MessageBarBody>
          <MessageBarTitle>Missing role: {conn.roleGate.missing}</MessageBarTitle>
          {conn.roleGate.hint}
          <div style={{ marginTop: tokens.spacingVerticalS }}>
            <Button size="small" appearance="primary" onClick={retry} disabled={retrying}>
              {retrying ? 'Retrying…' : 'Retry'}
            </Button>
          </div>
        </MessageBarBody>
      </MessageBar>
    );
  }
  if (conn.status === 'probe-failed') {
    return (
      <MessageBar intent="error">
        <MessageBarBody>
          <MessageBarTitle>Connectivity probe failed</MessageBarTitle>
          {conn.statusDetail || 'The data-plane probe failed.'}
          <div style={{ marginTop: tokens.spacingVerticalS }}>
            <Button size="small" appearance="primary" onClick={retry} disabled={retrying}>
              {retrying ? 'Retrying…' : 'Retry'}
            </Button>
          </div>
        </MessageBarBody>
      </MessageBar>
    );
  }
  return null;
}

// ---------------------------------- ADLS section ---------------------------

function AdlsSection({ workspaceId, current, onChanged }: { workspaceId: string; current: AzureConnection | null; onChanged: () => void }) {
  const styles = useStyles();
  const [accounts, setAccounts] = useState<StorageAccountSummary[] | null>(null);
  const [accountsError, setAccountsError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string>('');
  const [container, setContainer] = useState<string>('dataflow-staging');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadAccounts = useCallback(async () => {
    setAccountsError(null);
    try {
      const res = await clientFetch(`/api/admin/workspaces/${workspaceId}/connections/adls-accounts`, { cache: 'no-store' });
      const json = await res.json();
      if (!res.ok || !json.ok) { setAccountsError(json?.error || `HTTP ${res.status}`); return; }
      setAccounts(json.accounts || []);
    } catch (e: any) {
      setAccountsError(e?.message || String(e));
    }
  }, [workspaceId]);

  useEffect(() => { void loadAccounts(); }, [loadAccounts]);

  const connect = useCallback(async () => {
    if (!selected) return;
    setSaving(true); setError(null);
    try {
      const res = await clientFetch(`/api/admin/workspaces/${workspaceId}/connections`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'adls-gen2', storageAccountId: selected, containerName: container }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) { setError(json?.error || `HTTP ${res.status}`); return; }
      setSelected('');
      onChanged();
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setSaving(false);
    }
  }, [selected, container, workspaceId, onChanged]);

  const disconnect = useCallback(async () => {
    if (!current) return;
    setSaving(true);
    try {
      await clientFetch(`/api/admin/workspaces/${workspaceId}/connections/${encodeURIComponent(current.id)}`, { method: 'DELETE' });
      onChanged();
    } finally {
      setSaving(false);
    }
  }, [current, workspaceId, onChanged]);

  const selectedAccount = (accounts || []).find((a) => a.id === selected);

  return (
    <div className={styles.section}>
      <div className={styles.sectionHead}>
        <Storage24Regular />
        <Subtitle2>ADLS Gen2 — Dataflow staging</Subtitle2>
      </div>
      <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
        Stage Dataflow Gen2 output to a storage account. Requires the Console UAMI to hold
        Storage Blob Data Contributor on the account.
      </Caption1>

      {accountsError && (
        <MessageBar intent="error"><MessageBarBody>{accountsError}</MessageBarBody></MessageBar>
      )}

      {current ? (
        <>
          <GateBar conn={current} workspaceId={workspaceId} onRetry={onChanged} />
          <Table aria-label="ADLS connection" size="small">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Account</TableHeaderCell>
                <TableHeaderCell>Staging container</TableHeaderCell>
                <TableHeaderCell>DFS endpoint</TableHeaderCell>
                <TableHeaderCell>Status</TableHeaderCell>
                <TableHeaderCell>Actions</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow>
                <TableCell>
                  <div>{current.storageAccountName}</div>
                  <div className={styles.detail}>{current.resourceGroup}</div>
                </TableCell>
                <TableCell>{current.containerName}</TableCell>
                <TableCell>
                  {current.dfsEndpoint ? (
                    <Tooltip content={current.dfsEndpoint} relationship="label">
                      <span className={styles.detail} style={{ wordBreak: 'break-all' }}>{current.dfsEndpoint}</span>
                    </Tooltip>
                  ) : (
                    <span className={styles.detail}>—</span>
                  )}
                </TableCell>
                <TableCell>
                  <Badge appearance="tint" color={statusBadge(current.status).color}>{statusBadge(current.status).label}</Badge>
                </TableCell>
                <TableCell>
                  <Button appearance="subtle" size="small" icon={<PlugDisconnected20Regular />}
                    disabled={saving} onClick={disconnect}>Disconnect</Button>
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </>
      ) : (
        <div className={styles.form}>
          <div className={styles.row}>
            <Field label="Storage account" className={styles.grow}>
              <Dropdown
                placeholder={accounts ? 'Select an ADLS Gen2 / Blob account' : 'Loading…'}
                value={selectedAccount ? `${selectedAccount.name}${selectedAccount.isHns ? ' (ADLS Gen2)' : ' (Blob)'}` : ''}
                selectedOptions={selected ? [selected] : []}
                onOptionSelect={(_e, d) => setSelected(d.optionValue || '')}>
                {(accounts || []).map((a) => (
                  <Option key={a.id} value={a.id} text={`${a.name}${a.isHns ? ' (ADLS Gen2)' : ' (Blob)'}`}>
                    {a.name} {a.location ? `· ${a.location}` : ''} {a.isHns ? '· ADLS Gen2' : '· Blob'}
                  </Option>
                ))}
              </Dropdown>
            </Field>
            <Field label="Staging container">
              <Input value={container} onChange={(_e, d) => setContainer(d.value)} placeholder="dataflow-staging" />
            </Field>
            <Button appearance="primary" icon={<PlugConnected24Regular />} onClick={connect} disabled={!selected || saving}>
              {saving ? 'Connecting…' : 'Connect'}
            </Button>
          </div>
          {accounts && accounts.length === 0 && (
            <div className={styles.empty}>
              No storage accounts visible to the Console identity. Grant it Reader on a subscription with an ADLS Gen2 account.
            </div>
          )}
          {error && <MessageBar intent="error"><MessageBarBody>{error}</MessageBarBody></MessageBar>}
        </div>
      )}
    </div>
  );
}

// ---------------------------------- Log Analytics section ------------------

function LawSection({ workspaceId, current, onChanged }: { workspaceId: string; current: AzureConnection | null; onChanged: () => void }) {
  const styles = useStyles();
  const [workspaces, setWorkspaces] = useState<LawSummary[] | null>(null);
  const [wsError, setWsError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadWs = useCallback(async () => {
    setWsError(null);
    try {
      const res = await clientFetch(`/api/admin/workspaces/${workspaceId}/connections/log-analytics-workspaces`, { cache: 'no-store' });
      const json = await res.json();
      if (!res.ok || !json.ok) { setWsError(json?.error || `HTTP ${res.status}`); return; }
      setWorkspaces(json.workspaces || []);
    } catch (e: any) {
      setWsError(e?.message || String(e));
    }
  }, [workspaceId]);

  useEffect(() => { void loadWs(); }, [loadWs]);

  const connect = useCallback(async () => {
    if (!selected) return;
    setSaving(true); setError(null);
    try {
      const res = await clientFetch(`/api/admin/workspaces/${workspaceId}/connections`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'log-analytics', lawResourceId: selected }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) { setError(json?.error || `HTTP ${res.status}`); return; }
      setSelected('');
      onChanged();
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setSaving(false);
    }
  }, [selected, workspaceId, onChanged]);

  const disconnect = useCallback(async () => {
    if (!current) return;
    setSaving(true);
    try {
      await clientFetch(`/api/admin/workspaces/${workspaceId}/connections/${encodeURIComponent(current.id)}`, { method: 'DELETE' });
      onChanged();
    } finally {
      setSaving(false);
    }
  }, [current, workspaceId, onChanged]);

  const selectedWs = (workspaces || []).find((w) => w.id === selected);

  return (
    <div className={styles.section}>
      <div className={styles.sectionHead}>
        <DataHistogram24Regular />
        <Subtitle2>Log Analytics — Query-log export</Subtitle2>
      </div>
      <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
        Stream workspace query/run logs to a Log Analytics workspace. Requires the Console UAMI to hold
        Log Analytics Contributor on the workspace.
      </Caption1>

      {wsError && (
        <MessageBar intent="warning"><MessageBarBody>{wsError}</MessageBarBody></MessageBar>
      )}

      {current ? (
        <>
          <GateBar conn={current} workspaceId={workspaceId} onRetry={onChanged} />
          <Table aria-label="Log Analytics connection" size="small">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Workspace</TableHeaderCell>
                <TableHeaderCell>Workspace GUID</TableHeaderCell>
                <TableHeaderCell>Status</TableHeaderCell>
                <TableHeaderCell>Actions</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow>
                <TableCell>
                  <div>{current.lawName}</div>
                  <div className={styles.detail}>{current.resourceGroup}</div>
                </TableCell>
                <TableCell><span className={styles.detail}>{current.lawWorkspaceId || '—'}</span></TableCell>
                <TableCell>
                  <Badge appearance="tint" color={statusBadge(current.status).color}>{statusBadge(current.status).label}</Badge>
                </TableCell>
                <TableCell>
                  <Button appearance="subtle" size="small" icon={<PlugDisconnected20Regular />}
                    disabled={saving} onClick={disconnect}>Disconnect</Button>
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </>
      ) : (
        <div className={styles.form}>
          <div className={styles.row}>
            <Field label="Log Analytics workspace" className={styles.grow}>
              <Dropdown
                placeholder={workspaces ? 'Select a Log Analytics workspace' : 'Loading…'}
                value={selectedWs ? selectedWs.name : ''}
                selectedOptions={selected ? [selected] : []}
                onOptionSelect={(_e, d) => setSelected(d.optionValue || '')}>
                {(workspaces || []).map((w) => (
                  <Option key={w.id} value={w.id} text={w.name}>
                    {w.name} {w.location ? `· ${w.location}` : ''} {w.resourceGroup ? `· ${w.resourceGroup}` : ''}
                  </Option>
                ))}
              </Dropdown>
            </Field>
            <Button appearance="primary" icon={<PlugConnected24Regular />} onClick={connect} disabled={!selected || saving}>
              {saving ? 'Connecting…' : 'Connect'}
            </Button>
          </div>
          {workspaces && workspaces.length === 0 && (
            <div className={styles.empty}>
              No Log Analytics workspaces visible. Grant the Console identity Reader on a subscription with a workspace.
            </div>
          )}
          {error && <MessageBar intent="error"><MessageBarBody>{error}</MessageBarBody></MessageBar>}
        </div>
      )}
    </div>
  );
}
