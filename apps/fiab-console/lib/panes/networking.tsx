'use client';

/**
 * NetworkingPane — the workspace "Advanced networking" surface (F15),
 * one-for-one with the Fabric workspace networking pane and the Azure portal
 * networking blade, built entirely on Azure-native backends (NSG security rules
 * + private endpoints over ARM). NO Fabric dependency.
 *
 * Four tabs, matching the source UI:
 *   1. Inbound protection — a Switch that creates/deletes a REAL private
 *      endpoint protecting inbound access to the workspace's bound resource.
 *   2. IP firewall — a grid of NSG security rules with an inline add row;
 *      adding a CIDR writes a REAL Microsoft.Network securityRule.
 *   3. Outbound rules — a grid of outbound private-endpoint access rules; adding
 *      one creates a REAL private endpoint to the target resource.
 *   4. Trusted instances — an allowlist; adding one writes a REAL NSG allow-rule
 *      and records it in Cosmos.
 *
 * Every control calls a real BFF route. When the Console UAMI lacks Network
 * Contributor (ARM 403) or the env isn't wired (503), the route returns a
 * structured `gate` and the pane renders an honest Fluent MessageBar naming the
 * exact role to grant / env var to set — the full surface still renders.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  TabList, Tab, Switch, Button, Input, Dropdown, Option, Field,
  Spinner, Body1, Caption1, Badge, Subtitle2,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions, DialogTrigger,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Add16Regular, Delete16Regular, ShieldLock24Regular, ArrowClockwise16Regular,
} from '@fluentui/react-icons';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, padding: tokens.spacingVerticalM },
  panel: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, paddingTop: tokens.spacingVerticalM },
  addRow: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'flex-end', flexWrap: 'wrap' },
  note: { color: tokens.colorNeutralForeground3, fontSize: '12px', lineHeight: 1.5 },
  switchRow: { display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'center' },
  formGrid: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, maxWidth: 640 },
  tableWrap: { overflowX: 'auto' },
  actions: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center' },
});

type TabKey = 'inbound' | 'ip-firewall' | 'outbound' | 'trusted';
type Direction = 'Inbound' | 'Outbound';

interface GateInfo { reason?: string; remediation?: string; roleId?: string; missing?: string[]; }
interface ApiResult<T> { ok: boolean; error?: string; gate?: GateInfo; data?: T; }

interface NsgRule {
  name: string; priority: number; direction: Direction; access: 'Allow' | 'Deny';
  protocol: string; sourceAddressPrefix: string; destinationAddressPrefix: string;
  destinationPortRange: string; provisioningState?: string; managed?: boolean;
}
interface PeStatus { id: string; name: string; provisioningState?: string; connectionState?: string; privateLinkServiceId?: string; groupIds?: string[]; }
interface OutboundRule { id: string; type: string; targetResourceId?: string; groupIds?: string[]; peName?: string; state: string; addedAt: string; }
interface TrustedInstance { id: string; label: string; ipCidr: string; direction: Direction; addedAt: string; nsgRuleName: string; }

const base = (workspaceId: string) => `/api/admin/workspaces/${encodeURIComponent(workspaceId)}/networking`;

/** A reusable honest-gate MessageBar driven by the BFF `gate` payload. */
function GateBar({ gate, error }: { gate?: GateInfo; error?: string }) {
  if (!gate && !error) return null;
  return (
    <MessageBar intent="warning">
      <MessageBarBody>
        <MessageBarTitle>{gate ? 'Configuration required' : 'Error'}</MessageBarTitle>
        {gate?.reason ? `${gate.reason} ` : ''}
        {gate?.remediation || error}
        {gate?.roleId && <Caption1 block style={{ marginTop: 4 }}>Network Contributor role id: {gate.roleId}</Caption1>}
      </MessageBarBody>
    </MessageBar>
  );
}

export interface NetworkingPaneProps { workspaceId: string; }

export function NetworkingPane({ workspaceId }: NetworkingPaneProps) {
  const styles = useStyles();
  const [tab, setTab] = useState<TabKey>('inbound');

  return (
    <div className={styles.root}>
      <div className={styles.switchRow}>
        <ShieldLock24Regular />
        <Subtitle2>Advanced networking</Subtitle2>
      </div>
      <Body1 className={styles.note}>
        Control inbound protection, outbound access rules, the IP firewall, and trusted instances for this
        workspace. All changes write real Azure network resources (NSG rules + private endpoints) — no
        Microsoft Fabric capacity required.
      </Body1>
      <TabList selectedValue={tab} onTabSelect={(_e, d) => setTab(d.value as TabKey)}>
        <Tab value="inbound">Inbound protection</Tab>
        <Tab value="ip-firewall">IP firewall</Tab>
        <Tab value="outbound">Outbound rules</Tab>
        <Tab value="trusted">Trusted instances</Tab>
      </TabList>
      {tab === 'inbound' && <InboundTab workspaceId={workspaceId} />}
      {tab === 'ip-firewall' && <IpFirewallTab workspaceId={workspaceId} />}
      {tab === 'outbound' && <OutboundTab workspaceId={workspaceId} />}
      {tab === 'trusted' && <TrustedTab workspaceId={workspaceId} />}
    </div>
  );
}

// ============================================================
// Inbound protection
// ============================================================

function InboundTab({ workspaceId }: { workspaceId: string }) {
  const styles = useStyles();
  const [loading, setLoading] = useState(true);
  const [enabled, setEnabled] = useState(false);
  const [pe, setPe] = useState<PeStatus | null>(null);
  const [peConfigured, setPeConfigured] = useState(true);
  const [gate, setGate] = useState<GateInfo | undefined>();
  const [err, setErr] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  // create form
  const [plsId, setPlsId] = useState('');
  const [groupIds, setGroupIds] = useState('blob');
  const [location, setLocation] = useState('');
  const [dnsZoneId, setDnsZoneId] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setGate(undefined); setErr(undefined);
    try {
      const r = await fetch(`${base(workspaceId)}/inbound`);
      const j = await r.json();
      if (j.ok) { setEnabled(!!j.enabled); setPe(j.pe || null); setPeConfigured(j.peConfigured !== false); }
      else { setGate(j.gate); setErr(j.error); }
    } catch (e) { setErr(String(e)); }
    finally { setLoading(false); }
  }, [workspaceId]);
  useEffect(() => { void load(); }, [load]);

  const toggle = async (next: boolean) => {
    setBusy(true); setGate(undefined); setErr(undefined);
    try {
      const body = next
        ? { enable: true, privateLinkServiceId: plsId.trim(), groupIds: groupIds.split(',').map((s) => s.trim()).filter(Boolean), location: location.trim() || undefined, dnsZoneId: dnsZoneId.trim() || undefined }
        : { enable: false };
      const r = await fetch(`${base(workspaceId)}/inbound`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json();
      if (j.ok) { setEnabled(!!j.enabled); setPe(j.pe || null); }
      else { setGate(j.gate); setErr(j.error); }
    } catch (e) { setErr(String(e)); }
    finally { setBusy(false); }
  };

  if (loading) return <Spinner label="Loading inbound protection…" />;

  return (
    <div className={styles.panel}>
      <GateBar gate={gate} error={!gate ? err : undefined} />
      {!peConfigured && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Private-endpoint subnet not configured</MessageBarTitle>
            Set <code>LOOM_PE_SUBNET_ID</code> to the ARM id of <code>snet-private-endpoints</code> (network.bicep
            outputs <code>privateEndpointsSubnetId</code>). Inbound protection creates a private endpoint into that subnet.
          </MessageBarBody>
        </MessageBar>
      )}
      <div className={styles.switchRow}>
        <Switch
          checked={enabled}
          disabled={busy || !peConfigured || (!enabled && !plsId.trim())}
          onChange={(_e, d) => toggle(!!d.checked)}
          label={enabled ? 'Inbound protection ON (private endpoint active)' : 'Enable inbound protection'}
        />
        {busy && <Spinner size="tiny" />}
        {pe?.provisioningState && (
          <Badge appearance="tint" color={pe.provisioningState === 'Succeeded' ? 'success' : 'warning'}>
            {pe.provisioningState}{pe.connectionState ? ` · ${pe.connectionState}` : ''}
          </Badge>
        )}
        <Button appearance="subtle" icon={<ArrowClockwise16Regular />} onClick={() => void load()} aria-label="Refresh" />
      </div>
      <Caption1 className={styles.note}>
        Enabling inbound protection creates an Azure private endpoint that locks inbound access to the bound
        resource down to the hub VNet. Provide the target resource and its sub-resource(s) below.
      </Caption1>
      {!enabled && (
        <div className={styles.formGrid}>
          <Field label="Target resource ARM id (privateLinkServiceId)" required>
            <Input value={plsId} onChange={(_e, d) => setPlsId(d.value)} placeholder="/subscriptions/…/providers/Microsoft.Storage/storageAccounts/myacct" />
          </Field>
          <Field label="Sub-resource group ids (comma-separated)" hint="e.g. blob, sqlServer, vault">
            <Input value={groupIds} onChange={(_e, d) => setGroupIds(d.value)} placeholder="blob" />
          </Field>
          <Field label="Location" hint="defaults to LOOM_LOCATION when blank">
            <Input value={location} onChange={(_e, d) => setLocation(d.value)} placeholder="eastus" />
          </Field>
          <Field label="Private DNS zone ARM id (optional — registers the FQDN)">
            <Input value={dnsZoneId} onChange={(_e, d) => setDnsZoneId(d.value)} placeholder="/subscriptions/…/privateDnsZones/privatelink.blob.core.windows.net" />
          </Field>
        </div>
      )}
      {pe?.privateLinkServiceId && (
        <Caption1 className={styles.note}>Protecting: {pe.privateLinkServiceId} ({(pe.groupIds || []).join(', ')})</Caption1>
      )}
    </div>
  );
}

// ============================================================
// IP firewall (NSG rules)
// ============================================================

function IpFirewallTab({ workspaceId }: { workspaceId: string }) {
  const styles = useStyles();
  const [loading, setLoading] = useState(true);
  const [rules, setRules] = useState<NsgRule[]>([]);
  const [gate, setGate] = useState<GateInfo | undefined>();
  const [err, setErr] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  // add row
  const [cidr, setCidr] = useState('');
  const [direction, setDirection] = useState<Direction>('Inbound');
  const [access, setAccess] = useState<'Allow' | 'Deny'>('Allow');
  const [protocol, setProtocol] = useState<string>('*');

  const cidrValid = /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/.test(cidr.trim());

  const load = useCallback(async () => {
    setLoading(true); setGate(undefined); setErr(undefined);
    try {
      const r = await fetch(`${base(workspaceId)}/ip-rules`);
      const j = await r.json();
      if (j.ok) setRules(j.rules || []);
      else { setGate(j.gate); setErr(j.error); }
    } catch (e) { setErr(String(e)); }
    finally { setLoading(false); }
  }, [workspaceId]);
  useEffect(() => { void load(); }, [load]);

  const add = async () => {
    setBusy(true); setGate(undefined); setErr(undefined);
    try {
      const r = await fetch(`${base(workspaceId)}/ip-rules`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cidr: cidr.trim(), direction, access, protocol }),
      });
      const j = await r.json();
      if (j.ok) { setCidr(''); await load(); }
      else { setGate(j.gate); setErr(j.error); }
    } catch (e) { setErr(String(e)); }
    finally { setBusy(false); }
  };

  const remove = async (name: string) => {
    setBusy(true); setGate(undefined); setErr(undefined);
    try {
      const r = await fetch(`${base(workspaceId)}/ip-rules?ruleName=${encodeURIComponent(name)}`, { method: 'DELETE' });
      const j = await r.json();
      if (j.ok) await load();
      else { setGate(j.gate); setErr(j.error); }
    } catch (e) { setErr(String(e)); }
    finally { setBusy(false); }
  };

  return (
    <div className={styles.panel}>
      <GateBar gate={gate} error={!gate ? err : undefined} />
      <Caption1 className={styles.note}>
        IP firewall rules are real Azure NSG security rules on the hub private-endpoints subnet. Inbound rules
        match the source IP range; outbound rules match the destination range.
      </Caption1>
      <div className={styles.addRow}>
        <Field label="IP range (CIDR)" validationState={cidr && !cidrValid ? 'error' : 'none'} validationMessage={cidr && !cidrValid ? 'Enter a valid CIDR, e.g. 203.0.113.0/24' : undefined}>
          <Input value={cidr} onChange={(_e, d) => setCidr(d.value)} placeholder="203.0.113.0/24" />
        </Field>
        <Field label="Direction">
          <Dropdown value={direction} selectedOptions={[direction]} onOptionSelect={(_e, d) => setDirection(d.optionValue as Direction)}>
            <Option value="Inbound">Inbound</Option>
            <Option value="Outbound">Outbound</Option>
          </Dropdown>
        </Field>
        <Field label="Access">
          <Dropdown value={access} selectedOptions={[access]} onOptionSelect={(_e, d) => setAccess(d.optionValue as 'Allow' | 'Deny')}>
            <Option value="Allow">Allow</Option>
            <Option value="Deny">Deny</Option>
          </Dropdown>
        </Field>
        <Field label="Protocol">
          <Dropdown value={protocol === '*' ? 'Any' : protocol} selectedOptions={[protocol]} onOptionSelect={(_e, d) => setProtocol(d.optionValue as string)}>
            <Option value="*" text="Any">Any</Option>
            <Option value="Tcp">Tcp</Option>
            <Option value="Udp">Udp</Option>
            <Option value="Icmp">Icmp</Option>
          </Dropdown>
        </Field>
        <Button appearance="primary" icon={<Add16Regular />} disabled={busy || !cidrValid} onClick={add}>Add rule</Button>
        <Button appearance="subtle" icon={<ArrowClockwise16Regular />} onClick={() => void load()} aria-label="Refresh" />
      </div>
      {loading ? <Spinner label="Loading rules…" /> : (
        <div className={styles.tableWrap}>
          <Table aria-label="IP firewall rules" size="small">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Name</TableHeaderCell>
                <TableHeaderCell>Priority</TableHeaderCell>
                <TableHeaderCell>Direction</TableHeaderCell>
                <TableHeaderCell>Access</TableHeaderCell>
                <TableHeaderCell>Protocol</TableHeaderCell>
                <TableHeaderCell>IP range</TableHeaderCell>
                <TableHeaderCell>State</TableHeaderCell>
                <TableHeaderCell>Actions</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rules.length === 0 && (
                <TableRow><TableCell colSpan={8}><Caption1 className={styles.note}>No custom rules yet. Add one above.</Caption1></TableCell></TableRow>
              )}
              {rules.map((r) => (
                <TableRow key={r.name}>
                  <TableCell>{r.name}</TableCell>
                  <TableCell>{r.priority}</TableCell>
                  <TableCell>{r.direction}</TableCell>
                  <TableCell><Badge appearance="tint" color={r.access === 'Allow' ? 'success' : 'danger'}>{r.access}</Badge></TableCell>
                  <TableCell>{r.protocol === '*' ? 'Any' : r.protocol}</TableCell>
                  <TableCell>{r.direction === 'Inbound' ? r.sourceAddressPrefix : r.destinationAddressPrefix}</TableCell>
                  <TableCell>{r.provisioningState || '—'}</TableCell>
                  <TableCell>
                    <Button appearance="subtle" size="small" icon={<Delete16Regular />} disabled={busy || !r.managed} title={r.managed ? 'Delete rule' : 'Platform-managed rule — not editable here'} onClick={() => remove(r.name)} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

// ============================================================
// Outbound rules
// ============================================================

function OutboundTab({ workspaceId }: { workspaceId: string }) {
  const styles = useStyles();
  const [loading, setLoading] = useState(true);
  const [rules, setRules] = useState<OutboundRule[]>([]);
  const [gate, setGate] = useState<GateInfo | undefined>();
  const [err, setErr] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState('');
  const [groupIds, setGroupIds] = useState('blob');
  const [location, setLocation] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setGate(undefined); setErr(undefined);
    try {
      const r = await fetch(`${base(workspaceId)}/outbound`);
      const j = await r.json();
      if (j.ok) setRules(j.rules || []);
      else { setGate(j.gate); setErr(j.error); }
    } catch (e) { setErr(String(e)); }
    finally { setLoading(false); }
  }, [workspaceId]);
  useEffect(() => { void load(); }, [load]);

  const add = async () => {
    setBusy(true); setGate(undefined); setErr(undefined);
    try {
      const r = await fetch(`${base(workspaceId)}/outbound`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ targetResourceId: target.trim(), groupIds: groupIds.split(',').map((s) => s.trim()).filter(Boolean), location: location.trim() || undefined }),
      });
      const j = await r.json();
      if (j.ok) { setOpen(false); setTarget(''); await load(); }
      else { setGate(j.gate); setErr(j.error); }
    } catch (e) { setErr(String(e)); }
    finally { setBusy(false); }
  };

  const remove = async (id: string) => {
    setBusy(true); setGate(undefined); setErr(undefined);
    try {
      const r = await fetch(`${base(workspaceId)}/outbound?ruleId=${encodeURIComponent(id)}`, { method: 'DELETE' });
      const j = await r.json();
      if (j.ok) await load();
      else { setGate(j.gate); setErr(j.error); }
    } catch (e) { setErr(String(e)); }
    finally { setBusy(false); }
  };

  return (
    <div className={styles.panel}>
      <GateBar gate={gate} error={!gate ? err : undefined} />
      <Caption1 className={styles.note}>
        Outbound access rules create managed private endpoints from this workspace to a target Azure resource,
        so workspace compute can reach it privately.
      </Caption1>
      <div className={styles.addRow}>
        <Dialog open={open} onOpenChange={(_e, d) => setOpen(d.open)}>
          <DialogTrigger disableButtonEnhancement>
            <Button appearance="primary" icon={<Add16Regular />}>Add private endpoint</Button>
          </DialogTrigger>
          <DialogSurface>
            <DialogBody>
              <DialogTitle>New outbound private endpoint</DialogTitle>
              <DialogContent>
                <div className={styles.formGrid}>
                  <Field label="Target resource ARM id" required>
                    <Input value={target} onChange={(_e, d) => setTarget(d.value)} placeholder="/subscriptions/…/providers/Microsoft.Storage/storageAccounts/myacct" />
                  </Field>
                  <Field label="Sub-resource group ids (comma-separated)" hint="e.g. blob, sqlServer, vault">
                    <Input value={groupIds} onChange={(_e, d) => setGroupIds(d.value)} placeholder="blob" />
                  </Field>
                  <Field label="Location" hint="defaults to LOOM_LOCATION when blank">
                    <Input value={location} onChange={(_e, d) => setLocation(d.value)} placeholder="eastus" />
                  </Field>
                </div>
              </DialogContent>
              <DialogActions>
                <DialogTrigger disableButtonEnhancement>
                  <Button appearance="secondary">Cancel</Button>
                </DialogTrigger>
                <Button appearance="primary" disabled={busy || !target.trim()} onClick={add}>{busy ? <Spinner size="tiny" /> : 'Create'}</Button>
              </DialogActions>
            </DialogBody>
          </DialogSurface>
        </Dialog>
        <Button appearance="subtle" icon={<ArrowClockwise16Regular />} onClick={() => void load()} aria-label="Refresh" />
      </div>
      {loading ? <Spinner label="Loading outbound rules…" /> : (
        <div className={styles.tableWrap}>
          <Table aria-label="Outbound rules" size="small">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Type</TableHeaderCell>
                <TableHeaderCell>Target</TableHeaderCell>
                <TableHeaderCell>Sub-resources</TableHeaderCell>
                <TableHeaderCell>State</TableHeaderCell>
                <TableHeaderCell>Added</TableHeaderCell>
                <TableHeaderCell>Actions</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rules.length === 0 && (
                <TableRow><TableCell colSpan={6}><Caption1 className={styles.note}>No outbound rules yet.</Caption1></TableCell></TableRow>
              )}
              {rules.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>{r.type}</TableCell>
                  <TableCell title={r.targetResourceId}>{(r.targetResourceId || '').split('/').pop() || '—'}</TableCell>
                  <TableCell>{(r.groupIds || []).join(', ') || '—'}</TableCell>
                  <TableCell><Badge appearance="tint" color={r.state === 'Succeeded' ? 'success' : 'warning'}>{r.state}</Badge></TableCell>
                  <TableCell>{r.addedAt ? new Date(r.addedAt).toLocaleString() : '—'}</TableCell>
                  <TableCell>
                    <Button appearance="subtle" size="small" icon={<Delete16Regular />} disabled={busy} title="Delete rule" onClick={() => remove(r.id)} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

// ============================================================
// Trusted instances
// ============================================================

function TrustedTab({ workspaceId }: { workspaceId: string }) {
  const styles = useStyles();
  const [loading, setLoading] = useState(true);
  const [instances, setInstances] = useState<TrustedInstance[]>([]);
  const [gate, setGate] = useState<GateInfo | undefined>();
  const [err, setErr] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [label, setLabel] = useState('');
  const [ipCidr, setIpCidr] = useState('');
  const [direction, setDirection] = useState<Direction>('Inbound');

  const cidrValid = /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/.test(ipCidr.trim());

  const load = useCallback(async () => {
    setLoading(true); setGate(undefined); setErr(undefined);
    try {
      const r = await fetch(`${base(workspaceId)}/trusted`);
      const j = await r.json();
      if (j.ok) setInstances(j.instances || []);
      else { setGate(j.gate); setErr(j.error); }
    } catch (e) { setErr(String(e)); }
    finally { setLoading(false); }
  }, [workspaceId]);
  useEffect(() => { void load(); }, [load]);

  const add = async () => {
    setBusy(true); setGate(undefined); setErr(undefined);
    try {
      const r = await fetch(`${base(workspaceId)}/trusted`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label: label.trim(), ipCidr: ipCidr.trim(), direction }),
      });
      const j = await r.json();
      if (j.ok) { setLabel(''); setIpCidr(''); await load(); }
      else { setGate(j.gate); setErr(j.error); }
    } catch (e) { setErr(String(e)); }
    finally { setBusy(false); }
  };

  const remove = async (id: string) => {
    setBusy(true); setGate(undefined); setErr(undefined);
    try {
      const r = await fetch(`${base(workspaceId)}/trusted?instanceId=${encodeURIComponent(id)}`, { method: 'DELETE' });
      const j = await r.json();
      if (j.ok) await load();
      else { setGate(j.gate); setErr(j.error); }
    } catch (e) { setErr(String(e)); }
    finally { setBusy(false); }
  };

  return (
    <div className={styles.panel}>
      <GateBar gate={gate} error={!gate ? err : undefined} />
      <Caption1 className={styles.note}>
        Trusted instances are allowlisted IP ranges. Adding one writes a real NSG allow-rule and records the
        entry so you can manage the allowlist here.
      </Caption1>
      <div className={styles.addRow}>
        <Field label="Label" required>
          <Input value={label} onChange={(_e, d) => setLabel(d.value)} placeholder="HQ office" />
        </Field>
        <Field label="IP range (CIDR)" validationState={ipCidr && !cidrValid ? 'error' : 'none'} validationMessage={ipCidr && !cidrValid ? 'Enter a valid CIDR' : undefined}>
          <Input value={ipCidr} onChange={(_e, d) => setIpCidr(d.value)} placeholder="203.0.113.0/24" />
        </Field>
        <Field label="Direction">
          <Dropdown value={direction} selectedOptions={[direction]} onOptionSelect={(_e, d) => setDirection(d.optionValue as Direction)}>
            <Option value="Inbound">Inbound</Option>
            <Option value="Outbound">Outbound</Option>
          </Dropdown>
        </Field>
        <Button appearance="primary" icon={<Add16Regular />} disabled={busy || !label.trim() || !cidrValid} onClick={add}>Add</Button>
        <Button appearance="subtle" icon={<ArrowClockwise16Regular />} onClick={() => void load()} aria-label="Refresh" />
      </div>
      {loading ? <Spinner label="Loading trusted instances…" /> : (
        <div className={styles.tableWrap}>
          <Table aria-label="Trusted instances" size="small">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Label</TableHeaderCell>
                <TableHeaderCell>IP range</TableHeaderCell>
                <TableHeaderCell>Direction</TableHeaderCell>
                <TableHeaderCell>Added</TableHeaderCell>
                <TableHeaderCell>Actions</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {instances.length === 0 && (
                <TableRow><TableCell colSpan={5}><Caption1 className={styles.note}>No trusted instances yet.</Caption1></TableCell></TableRow>
              )}
              {instances.map((t) => (
                <TableRow key={t.id}>
                  <TableCell>{t.label}</TableCell>
                  <TableCell>{t.ipCidr}</TableCell>
                  <TableCell>{t.direction}</TableCell>
                  <TableCell>{t.addedAt ? new Date(t.addedAt).toLocaleString() : '—'}</TableCell>
                  <TableCell>
                    <Button appearance="subtle" size="small" icon={<Delete16Regular />} disabled={busy} title="Remove" onClick={() => remove(t.id)} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

export default NetworkingPane;
