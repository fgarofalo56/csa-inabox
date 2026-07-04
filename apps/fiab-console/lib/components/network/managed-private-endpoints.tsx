'use client';

/**
 * Managed private endpoints — self-service create + approval tracking on the
 * shared admin Network page (Fabric-parity Phase 4 G5).
 *
 * Renders a live table of the managed private endpoints in the DLZ managed
 * network (connection-approval state badge + per-row refresh/poll + delete), and
 * a Create wizard: a Resource-Graph resource picker (reuses /api/azure/connectables
 * — every connectable Azure resource the caller can reach across subscriptions),
 * a sub-resource (groupId) Dropdown driven by the picked resource type, a
 * justification (sent to the target owner as the approval request message), then
 * a REAL Microsoft.Network/privateEndpoints create over ARM.
 *
 * Honest gate (no-vaporware): a non-admin / not-configured / not-authorized
 * response renders a Fluent MessageBar naming the exact remediation — never a
 * blank table. Web5: Fluent v9 + Loom tokens, consistent with the sibling cards.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Spinner, MessageBar, MessageBarBody, MessageBarTitle, Button, Badge,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  Subtitle2, Body1, Caption1, Divider, tokens,
  Dialog, DialogTrigger, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  Field, Input, Dropdown, Option, Textarea,
} from '@fluentui/react-components';
import {
  ShieldLock24Regular, Add16Regular, ArrowClockwise16Regular, Delete16Regular,
  Checkmark16Filled, Warning16Filled, Dismiss16Filled, Info16Filled,
} from '@fluentui/react-icons';
import { groupOptionsForArmType, type PeGroupOption } from '@/lib/azure/pe-subresource-groups';

const API = '/api/network/managed-private-endpoints';

const card: React.CSSProperties = {
  padding: tokens.spacingVerticalXL, border: `1px solid ${tokens.colorNeutralStroke2}`,
  borderRadius: tokens.borderRadiusXLarge, backgroundColor: tokens.colorNeutralBackground1,
  marginBottom: tokens.spacingVerticalXL, boxShadow: tokens.shadow4,
};
const head: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalMNudge, marginBottom: tokens.spacingVerticalL, flexWrap: 'wrap', minWidth: 0,
};
const formGrid: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: tokens.spacingHorizontalL, minWidth: 380 };

interface ManagedPe {
  id: string; name: string; location?: string; provisioningState?: string;
  connectionState?: string; connectionDescription?: string; actionsRequired?: string;
  privateLinkServiceId?: string; targetResourceName?: string; groupIds?: string[];
  requestMessage?: string; loomManaged?: boolean; createdBy?: string; createdAt?: string;
  /** Private-DNS zone-group registration state (from the create / poll BFF paths). */
  dnsRegistered?: boolean; dnsZoneName?: string; dnsNote?: string;
}
interface Gate { reason?: string; remediation?: string; missing?: string[]; roleId?: string }
interface ListResp {
  ok: boolean; count?: number; endpoints?: ManagedPe[];
  error?: string; gate?: Gate; reason?: string; remediation?: string; code?: string;
}
interface Connectable {
  armResourceId: string; name: string; armType: string; connType: string;
  subscriptionName?: string; resourceGroup: string; location?: string;
}

/** Best human-readable remediation text out of any honest-gate response shape. */
function gateText(j: ListResp | null): string | undefined {
  if (!j || j.ok) return undefined;
  return j.gate?.remediation || j.remediation || j.reason || j.error;
}

function stateBadge(state?: string) {
  const s = (state || '').toLowerCase();
  if (s === 'approved') return <Badge appearance="tint" color="success" icon={<Checkmark16Filled />}>Approved</Badge>;
  if (s === 'rejected' || s === 'disconnected') {
    return <Badge appearance="tint" color="danger" icon={<Dismiss16Filled />}>{state}</Badge>;
  }
  if (s === 'pending') return <Badge appearance="tint" color="warning" icon={<Warning16Filled />}>Pending approval</Badge>;
  return <Badge appearance="tint" color="informative" icon={<Info16Filled />}>{state || '—'}</Badge>;
}

/** Private-DNS registration badge/caption — known only after create or a poll
 * (the BFF attaches the privatelink zone group and reports the outcome). */
function dnsIndicator(e: ManagedPe) {
  if (e.dnsRegistered === true) {
    return (
      <Badge appearance="outline" color="success" title={e.dnsZoneName ? `Registered in ${e.dnsZoneName}` : undefined}>
        DNS registered
      </Badge>
    );
  }
  if (e.dnsRegistered === false) {
    return (
      <Caption1
        title={e.dnsNote}
        style={{ color: tokens.colorPaletteDarkOrangeForeground1 }}
      >
        DNS not registered{e.dnsZoneName ? ` — ${e.dnsZoneName} missing` : ''}
      </Caption1>
    );
  }
  return null;
}

/** Suggest an ARM-safe PE name from the target + sub-resource. */
function suggestName(resourceName: string, groupId: string): string {
  const base = `pe-${(resourceName || 'target').toLowerCase()}-${(groupId || '').toLowerCase()}`
    .replace(/[^a-z0-9-_]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base.slice(0, 60) || 'pe-managed';
}

function CreateDialog({ onCreated }: { onCreated: (msg: string) => void }) {
  const [open, setOpen] = useState(false);
  const [connectables, setConnectables] = useState<Connectable[]>([]);
  const [cLoading, setCLoading] = useState(false);
  const [cErr, setCErr] = useState<string | undefined>();
  const [filter, setFilter] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [groupId, setGroupId] = useState('');
  const [name, setName] = useState('');
  const [nameEdited, setNameEdited] = useState(false);
  const [justification, setJustification] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | undefined>();

  const selected = useMemo(
    () => connectables.find((c) => c.armResourceId === selectedId),
    [connectables, selectedId],
  );
  const groupOptions: PeGroupOption[] = useMemo(
    () => groupOptionsForArmType(selected?.armType),
    [selected],
  );
  const filtered = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const withGroups = connectables.filter((c) => groupOptionsForArmType(c.armType).length > 0);
    if (!f) return withGroups.slice(0, 200);
    return withGroups.filter((c) =>
      c.name.toLowerCase().includes(f) ||
      (c.subscriptionName || '').toLowerCase().includes(f) ||
      c.resourceGroup.toLowerCase().includes(f),
    ).slice(0, 200);
  }, [connectables, filter]);

  const loadConnectables = useCallback(async () => {
    setCLoading(true); setCErr(undefined);
    try {
      const r = await fetch('/api/azure/connectables');
      const j = await r.json();
      if (j.ok) setConnectables(Array.isArray(j.resources) ? j.resources : []);
      else setCErr(j.error || 'Could not enumerate connectable resources.');
    } catch (e) { setCErr(String(e)); }
    finally { setCLoading(false); }
  }, []);

  // Load the resource inventory the first time the dialog opens.
  useEffect(() => { if (open && connectables.length === 0 && !cLoading && !cErr) void loadConnectables(); },
    [open, connectables.length, cLoading, cErr, loadConnectables]);

  // Default the sub-resource + suggested name when the picked resource changes.
  useEffect(() => {
    if (!selected) return;
    const firstGroup = groupOptions[0]?.id || '';
    setGroupId((g) => (groupOptions.some((o) => o.id === g) ? g : firstGroup));
    if (!nameEdited) setName(suggestName(selected.name, groupOptions[0]?.id || ''));
  }, [selected, groupOptions, nameEdited]);

  useEffect(() => {
    if (selected && !nameEdited) setName(suggestName(selected.name, groupId));
  }, [groupId, selected, nameEdited]);

  const reset = () => {
    setSelectedId(''); setGroupId(''); setName(''); setNameEdited(false);
    setJustification(''); setFilter(''); setErr(undefined);
  };

  const create = async () => {
    setBusy(true); setErr(undefined);
    try {
      const r = await fetch(API, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          targetResourceId: selected?.armResourceId,
          armType: selected?.armType,
          groupId,
          name: name.trim(),
          justification: justification.trim(),
        }),
      });
      const j = await r.json();
      if (j.ok) {
        setOpen(false);
        onCreated(j.message || `Managed private endpoint “${j.endpoint?.name}” created (Pending approval).`);
        reset();
      } else {
        setErr(gateText(j) || j.error || 'Create failed.');
      }
    } catch (e) { setErr(String(e)); }
    finally { setBusy(false); }
  };

  const canCreate = !!selected && !!groupId && !!name.trim() && !!justification.trim() && !busy;

  return (
    <Dialog open={open} onOpenChange={(_e, d) => setOpen(d.open)}>
      <DialogTrigger disableButtonEnhancement>
        <Button appearance="primary" icon={<Add16Regular />}>New managed private endpoint</Button>
      </DialogTrigger>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>New managed private endpoint</DialogTitle>
          <DialogContent>
            <div style={formGrid}>
              <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                Creates a real private endpoint into the managed-VNet subnet against the chosen resource.
                It lands <strong>Pending</strong> until the resource owner approves the connection.
              </Caption1>

              <Field label="Find a resource" hint="Search across every subscription you can read (Azure Resource Graph)">
                <Input
                  value={filter}
                  onChange={(_e, d) => setFilter(d.value)}
                  placeholder="name, subscription, or resource group…"
                />
              </Field>

              {cLoading && <Spinner size="tiny" label="Discovering connectable resources…" />}
              {cErr && (
                <MessageBar intent="warning">
                  <MessageBarBody>{cErr}</MessageBarBody>
                </MessageBar>
              )}

              {!cLoading && !cErr && (
                <Field label="Target resource" required>
                  <Dropdown
                    placeholder="Select a resource"
                    value={selected ? `${selected.name} (${selected.resourceGroup})` : ''}
                    selectedOptions={selectedId ? [selectedId] : []}
                    onOptionSelect={(_e, d) => { setSelectedId(d.optionValue || ''); setNameEdited(false); }}
                  >
                    {filtered.length === 0 && <Option value="" disabled>No matching resources</Option>}
                    {filtered.map((c) => (
                      <Option key={c.armResourceId} value={c.armResourceId} text={`${c.name} (${c.resourceGroup})`}>
                        {c.name} · {c.subscriptionName || c.resourceGroup}
                      </Option>
                    ))}
                  </Dropdown>
                </Field>
              )}

              <Field label="Sub-resource (groupId)" required hint="The private-link sub-resource on the target">
                <Dropdown
                  placeholder={selected ? 'Select a sub-resource' : 'Pick a resource first'}
                  disabled={!selected || groupOptions.length === 0}
                  value={groupOptions.find((o) => o.id === groupId)?.label || ''}
                  selectedOptions={groupId ? [groupId] : []}
                  onOptionSelect={(_e, d) => setGroupId(d.optionValue || '')}
                >
                  {groupOptions.map((o) => (
                    <Option key={o.id} value={o.id} text={o.label}>{o.label}</Option>
                  ))}
                </Dropdown>
              </Field>

              <Field label="Name" required hint="1-80 chars: letters, digits, _ or -">
                <Input
                  value={name}
                  onChange={(_e, d) => { setName(d.value); setNameEdited(true); }}
                  placeholder="pe-myresource-blob"
                />
              </Field>

              <Field label="Justification" required hint="Sent to the resource owner as the approval request message">
                <Textarea
                  value={justification}
                  onChange={(_e, d) => setJustification(d.value)}
                  resize="vertical"
                  placeholder="Why this connection is needed (business justification)…"
                  style={{ minHeight: 72 }}
                />
              </Field>

              {err && (
                <MessageBar intent="error">
                  <MessageBarBody>{err}</MessageBarBody>
                </MessageBar>
              )}
            </div>
          </DialogContent>
          <DialogActions>
            <DialogTrigger disableButtonEnhancement>
              <Button appearance="secondary" onClick={reset}>Cancel</Button>
            </DialogTrigger>
            <Button appearance="primary" disabled={!canCreate} onClick={create}>
              {busy ? <Spinner size="tiny" /> : 'Create (request approval)'}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

export function ManagedPrivateEndpointsCard() {
  const [data, setData] = useState<ListResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | undefined>();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(API);
      const j = (await r.json()) as ListResp;
      setData(j);
    } catch (e) {
      setData({ ok: false, error: e instanceof Error ? e.message : String(e) });
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const pollOne = useCallback(async (peName: string) => {
    setBusy(true);
    try {
      const r = await fetch(`${API}?poll=${encodeURIComponent(peName)}`);
      const j = await r.json();
      if (j.ok && j.endpoint) {
        setData((prev) => prev && prev.endpoints
          ? { ...prev, endpoints: prev.endpoints.map((e) => (e.name === peName ? j.endpoint : e)) }
          : prev);
      }
    } catch { /* keep the current row */ }
    finally { setBusy(false); }
  }, []);

  const remove = useCallback(async (peName: string) => {
    setBusy(true); setNotice(undefined);
    try {
      const r = await fetch(`${API}?id=${encodeURIComponent(peName)}`, { method: 'DELETE' });
      const j = await r.json();
      if (j.ok) { setNotice(`Managed private endpoint “${peName}” deleted.`); await load(); }
      else setNotice(gateText(j) || j.error || 'Delete failed.');
    } catch (e) { setNotice(String(e)); }
    finally { setBusy(false); }
  }, [load]);

  const endpoints = data?.endpoints || [];
  const gate = data && !data.ok ? gateText(data) : undefined;

  return (
    <div style={card}>
      <div style={head}>
        <ShieldLock24Regular />
        <Subtitle2>Managed private endpoints</Subtitle2>
        <Badge appearance="tint" color="brand" style={{ marginLeft: 'auto' }}>Azure-native · self-service</Badge>
      </div>

      <Body1 style={{ display: 'block', marginBottom: tokens.spacingVerticalM, color: tokens.colorNeutralForeground3 }}>
        Create a private endpoint from the CSA Loom managed network to any Azure resource you can reach, so
        Loom compute connects to it privately. New endpoints land <strong>Pending</strong> until the target
        resource owner approves the connection — poll the state here after they approve.
      </Body1>

      <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, marginBottom: tokens.spacingVerticalL, flexWrap: 'wrap' }}>
        {data?.ok && <CreateDialog onCreated={(m) => { setNotice(m); void load(); }} />}
        <Button appearance="subtle" icon={<ArrowClockwise16Regular />} onClick={() => void load()}>Refresh</Button>
      </div>

      {notice && (
        <MessageBar intent="info" style={{ marginBottom: tokens.spacingVerticalM }}>
          <MessageBarBody>{notice}</MessageBarBody>
        </MessageBar>
      )}

      {loading && <Spinner label="Loading managed private endpoints…" />}

      {!loading && gate && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Managed private endpoints unavailable</MessageBarTitle>
            {gate}
          </MessageBarBody>
        </MessageBar>
      )}

      {!loading && data?.ok && (
        endpoints.length === 0 ? (
          <Body1 style={{ color: tokens.colorNeutralForeground3 }}>
            No managed private endpoints yet. Use “New managed private endpoint” to create one.
          </Body1>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <Table size="small" aria-label="Managed private endpoints">
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>Name</TableHeaderCell>
                  <TableHeaderCell>Target</TableHeaderCell>
                  <TableHeaderCell>Sub-resource</TableHeaderCell>
                  <TableHeaderCell>Connection</TableHeaderCell>
                  <TableHeaderCell>Provisioning</TableHeaderCell>
                  <TableHeaderCell>Source</TableHeaderCell>
                  <TableHeaderCell>Actions</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {endpoints.map((e) => (
                  <TableRow key={e.id || e.name}>
                    <TableCell><span style={{ fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase200 }}>{e.name}</span></TableCell>
                    <TableCell>{e.targetResourceName || '—'}</TableCell>
                    <TableCell>{(e.groupIds || []).join(', ') || '—'}</TableCell>
                    <TableCell>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingHorizontalXS, alignItems: 'flex-start' }}>
                        {stateBadge(e.connectionState)}
                        {dnsIndicator(e)}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge appearance="tint" color={e.provisioningState === 'Succeeded' ? 'success' : 'warning'}>
                        {e.provisioningState || '—'}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {e.loomManaged
                        ? <Badge appearance="outline" color="brand">Loom</Badge>
                        : <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>external</Caption1>}
                    </TableCell>
                    <TableCell>
                      <div style={{ display: 'flex', gap: tokens.spacingHorizontalXS }}>
                        <Button
                          appearance="subtle" size="small" icon={<ArrowClockwise16Regular />}
                          disabled={busy} title="Refresh connection state"
                          aria-label={`Refresh ${e.name}`} onClick={() => void pollOne(e.name)}
                        />
                        <Button
                          appearance="subtle" size="small" icon={<Delete16Regular />}
                          disabled={busy} title="Delete managed private endpoint"
                          aria-label={`Delete ${e.name}`} onClick={() => void remove(e.name)}
                        />
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )
      )}

      <Divider style={{ margin: '14px 0 10px' }} />
      <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
        Backed by <code>Microsoft.Network/privateEndpoints</code> in the managed network over ARM. Approval is a
        separate action the target resource owner performs (portal → the resource → Networking → Private endpoint
        connections → Approve). Loom registers the endpoint in the matching <code>privatelink.*</code> private DNS
        zone automatically (on create, retried on refresh after approval) so the FQDN resolves privately — a
        &ldquo;DNS not registered&rdquo; note means the zone is missing from the networking resource group.
        Tenant-admin only — private endpoints touch the shared landing-zone network.
      </Caption1>
    </div>
  );
}
