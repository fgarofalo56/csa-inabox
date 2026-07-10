'use client';

/**
 * WorkspaceEgressPane — workspace outbound access protection (rel-T89) manager
 * over /api/governance/workspace-egress (GET list+nsgs+tags, POST upsert+reconcile,
 * [id] DELETE).
 *
 * Azure-native parity with Fabric's workspace outbound access protection: per
 * workspace, an admin picks the compute subnet's NSG and defines an allow-list of
 * outbound destinations (Azure service tag / IPv4 CIDR / FQDN) plus a default-deny
 * switch. Save → reconciles REAL NSG outbound security rules (service-tag + CIDR)
 * and, with default-deny on, a final Deny-to-Internet rule so ONLY the allow-list
 * egresses. FQDN destinations surface an honest "needs Azure Firewall" note in the
 * receipt (NSGs can't match hostnames). No Fabric/Power BI dependency.
 *
 * Backend is REAL (no-vaporware): every call uses clientFetch (same-session
 * cookie). 403 → honest tenant-admin gate. No freeform: destination type + service
 * tag + NSG are Dropdowns, CIDR/FQDN are validated inputs. Web3: Loom tokens,
 * cards/icons, EmptyState/Spinner.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Spinner, Caption1, Badge, Button, Switch, Field, Text,
  Dropdown, Option, Input, Subtitle2,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  MessageBar, MessageBarBody, MessageBarTitle,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  ShieldGlobe20Regular, Add20Regular, ArrowSync16Regular, Edit16Regular,
  Delete16Regular, Delete12Regular, ShieldTask20Regular, Globe16Regular,
} from '@fluentui/react-icons';
import { Section } from '@/lib/components/ui/section';
import { TileGrid } from '@/lib/components/ui/tile-grid';
import { TeachingBanner } from '@/lib/components/shared/teaching-toast';
import { GuidedEmptyState } from '@/lib/components/shared/guided-empty-state';
import { clientFetch } from '@/lib/client-fetch';

type EgressDestinationType = 'service-tag' | 'ip' | 'fqdn';

interface EgressDestination {
  id: string;
  type: EgressDestinationType;
  value: string;
  label?: string;
  protocol?: '*' | 'Tcp' | 'Udp';
  ports?: string;
}

interface EgressPolicy {
  id: string;
  workspaceId: string;
  workspaceName?: string;
  nsgId: string;
  nsgName?: string;
  defaultDeny: boolean;
  destinations: EgressDestination[];
  tenantId: string;
  updatedAt: string;
}

interface NsgOption {
  id: string; name: string; resourceGroup?: string; location?: string; subnets: string[];
}
interface ServiceTag { value: string; label: string }

interface ReconcileReceipt {
  status: 'converged' | 'partial' | 'gated';
  policyId: string;
  workspaceId: string;
  nsgName?: string;
  rulesWritten: number;
  rulesRevoked: number;
  firewallRequired: string[];
  errors: number;
  gate?: string;
  detail: string[];
  at: string;
}

const API = '/api/governance/workspace-egress';

const useStyles = makeStyles({
  card: {
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    padding: tokens.spacingVerticalL,
    boxShadow: tokens.shadow4,
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
    minWidth: 0,
    transition: 'box-shadow 120ms ease, transform 120ms ease',
    ':hover': { boxShadow: tokens.shadow16, transform: 'translateY(-2px)' },
  },
  cardHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, minWidth: 0 },
  chip: {
    width: '36px', height: '36px', borderRadius: tokens.borderRadiusMedium,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    backgroundColor: tokens.colorBrandBackground2, color: tokens.colorBrandForeground1, flexShrink: 0,
  },
  grow: { flex: 1, minWidth: 0 },
  meta: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalS, alignItems: 'center' },
  rowActions: { display: 'flex', gap: tokens.spacingHorizontalS, marginTop: tokens.spacingVerticalS, flexWrap: 'wrap' },
  dialogStack: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: 0 },
  destRow: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'flex-end', flexWrap: 'wrap' },
  destType: { minWidth: '150px' },
  destValue: { flex: 1, minWidth: '200px' },
  destPorts: { width: '96px' },
  mb: { marginBottom: tokens.spacingVerticalM },
  hint: { color: tokens.colorNeutralForeground3 },
});

function statusBadge(s?: ReconcileReceipt['status']) {
  if (s === 'converged') return <Badge appearance="filled" color="success">Converged</Badge>;
  if (s === 'partial') return <Badge appearance="filled" color="warning">Partial</Badge>;
  if (s === 'gated') return <Badge appearance="outline" color="danger">Gated</Badge>;
  return <Badge appearance="outline">Not reconciled</Badge>;
}

export function WorkspaceEgressPane() {
  const styles = useStyles();
  const [policies, setPolicies] = useState<EgressPolicy[]>([]);
  const [nsgs, setNsgs] = useState<NsgOption[]>([]);
  const [serviceTags, setServiceTags] = useState<ServiceTag[]>([]);
  const [nsgGate, setNsgGate] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [forbiddenRemediation, setForbiddenRemediation] = useState<string | null>(null);
  const [receipts, setReceipts] = useState<Record<string, ReconcileReceipt>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [edit, setEdit] = useState<EgressPolicy | null>(null);
  const [saving, setSaving] = useState(false);
  const [lastReceipt, setLastReceipt] = useState<ReconcileReceipt | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null); setForbidden(false); setForbiddenRemediation(null);
    try {
      const r = await clientFetch(API);
      if (r.status === 403) {
        const j = await r.json().catch(() => ({}));
        setForbidden(true);
        setForbiddenRemediation(j?.remediation || j?.reason || null);
        setPolicies([]);
        return;
      }
      const j = await r.json();
      if (!r.ok || !j?.ok) { setError(j?.error || `Failed (${r.status})`); return; }
      setPolicies(j.policies || []);
      setNsgs(j.nsgs || []);
      setServiceTags(j.serviceTags || []);
      setNsgGate(j.nsgGate || null);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const reconcile = useCallback(async (p: EgressPolicy) => {
    setBusyId(p.id); setError(null);
    try {
      const r = await clientFetch(API, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(p) });
      const j = await r.json();
      if (!r.ok || !j?.ok) { setError(j?.error || `Reconcile failed (${r.status})`); return; }
      setReceipts((m) => ({ ...m, [p.id]: j.receipt }));
      setLastReceipt(j.receipt);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setBusyId(null); }
  }, []);

  const remove = useCallback(async (p: EgressPolicy) => {
    setBusyId(p.id);
    try {
      await clientFetch(`${API}/${encodeURIComponent(p.id)}?workspaceId=${encodeURIComponent(p.workspaceId)}`, { method: 'DELETE' });
      await load();
    } finally { setBusyId(null); }
  }, [load]);

  if (forbidden) {
    return (
      <MessageBar intent="warning">
        <MessageBarBody>
          <MessageBarTitle>Tenant administrator required</MessageBarTitle>
          Workspace outbound access protection writes network security rules on the estate&apos;s
          compute subnets — a tenant-wide control.{' '}
          {forbiddenRemediation ||
            'Set LOOM_TENANT_ADMIN_OID (your Entra user object id) or LOOM_TENANT_ADMIN_GROUP_ID, then sign in with that account. A tenant admin can also grant access at /admin/permissions.'}
        </MessageBarBody>
      </MessageBar>
    );
  }

  return (
    <Section
      title="Workspace egress policies"
      actions={<Button appearance="primary" icon={<Add20Regular />} onClick={() => { setEdit(null); setDialogOpen(true); }}>New policy</Button>}
    >
      {/* Teaching banner (SC-6) — explain how allow-list destinations compile to NSG rules. */}
      <div className={styles.mb}>
        <TeachingBanner
          surfaceKey="governance-workspace-egress"
          accent="var(--loom-accent-teal)"
          title="Control where a workspace can send data"
          message="Pick the compute subnet's network security group and list the outbound destinations you allow — Azure service tags and IP/CIDR compile to real NSG outbound rules. Turn on default-deny to add a final Deny-to-Internet rule so only the allow-list egresses. FQDN destinations are reported as needing an Azure Firewall (NSGs can't match hostnames)."
          learnMoreHref="https://learn.microsoft.com/azure/virtual-network/network-security-groups-overview"
        />
      </div>
      {error && (
        <MessageBar intent="error" className={styles.mb}>
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}
      {nsgGate && (
        <MessageBar intent="warning" className={styles.mb}>
          <MessageBarBody>
            <MessageBarTitle>Network security groups not fully readable</MessageBarTitle>
            {nsgGate}
          </MessageBarBody>
        </MessageBar>
      )}
      {lastReceipt && (
        <MessageBar
          intent={lastReceipt.status === 'converged' ? 'success' : lastReceipt.status === 'gated' ? 'warning' : 'info'}
          className={styles.mb}
        >
          <MessageBarBody>
            <MessageBarTitle>Reconcile {lastReceipt.status}</MessageBarTitle>
            {lastReceipt.rulesWritten} rule(s) written · {lastReceipt.rulesRevoked} revoked · {lastReceipt.errors} error(s)
            {lastReceipt.firewallRequired.length > 0 && ` · ${lastReceipt.firewallRequired.length} FQDN destination(s) need an Azure Firewall (${lastReceipt.firewallRequired.join(', ')})`}
            {lastReceipt.gate ? ` · ${lastReceipt.gate}` : ''}
          </MessageBarBody>
        </MessageBar>
      )}

      {loading && <Spinner label="Loading egress policies…" />}

      {!loading && policies.length === 0 && (
        <GuidedEmptyState
          heroIcon={ShieldGlobe20Regular}
          title="No workspace egress policies yet"
          intro="Restrict a workspace's data-plane compute to an exact outbound allow-list. Destinations compile to real Azure NSG outbound rules; turn on default-deny so only the allow-list can reach the internet. No Fabric required."
          ariaLabel="Get started with workspace egress policies"
          columns={1}
          paths={[
            {
              key: 'new-egress-policy',
              title: 'New egress policy',
              body: 'Choose the compute subnet NSG, add allowed service tags or IP ranges, and Save & reconcile to write the outbound rules.',
              icon: ShieldGlobe20Regular,
              onClick: () => { setEdit(null); setDialogOpen(true); },
            },
          ]}
          learnMoreHref="https://learn.microsoft.com/azure/virtual-network/network-security-groups-overview"
        />
      )}

      {!loading && policies.length > 0 && (
        <TileGrid>
          {policies.map((p) => {
            const rec = receipts[p.id];
            const fqdnCount = p.destinations.filter((d) => d.type === 'fqdn').length;
            return (
              <div key={p.id} className={styles.card}>
                <div className={styles.cardHead}>
                  <div className={styles.chip}><ShieldTask20Regular /></div>
                  <div className={styles.grow}>
                    <Subtitle2 truncate>{p.workspaceName || p.workspaceId}</Subtitle2>
                    <Caption1>{p.nsgName || p.nsgId.split('/').pop()}</Caption1>
                  </div>
                </div>
                <div className={styles.meta}>
                  <Badge appearance="outline" color={p.defaultDeny ? 'danger' : 'informative'}>
                    {p.defaultDeny ? 'default-deny' : 'allow-only'}
                  </Badge>
                  <Badge appearance="tint">{p.destinations.length} destination(s)</Badge>
                  {fqdnCount > 0 && <Badge appearance="tint" color="warning" icon={<Globe16Regular />}>{fqdnCount} FQDN · firewall</Badge>}
                  {statusBadge(rec?.status)}
                </div>
                <div className={styles.rowActions}>
                  <Button size="small" icon={<ArrowSync16Regular />} disabled={busyId === p.id} onClick={() => void reconcile(p)}>
                    {busyId === p.id ? 'Reconciling…' : 'Reconcile now'}
                  </Button>
                  <Button size="small" icon={<Edit16Regular />} onClick={() => { setEdit(p); setDialogOpen(true); }}>Edit</Button>
                  <Button size="small" appearance="subtle" icon={<Delete16Regular />} disabled={busyId === p.id} onClick={() => void remove(p)}>Delete</Button>
                </div>
              </div>
            );
          })}
        </TileGrid>
      )}

      {dialogOpen && (
        <EgressDialog
          nsgs={nsgs}
          serviceTags={serviceTags}
          initial={edit}
          saving={saving}
          onClose={() => setDialogOpen(false)}
          onSaved={(rec) => { setLastReceipt(rec); setDialogOpen(false); void load(); }}
          setSaving={setSaving}
        />
      )}
    </Section>
  );
}

const PROTO_OPTIONS: Array<'*' | 'Tcp' | 'Udp'> = ['Tcp', 'Udp', '*'];

function EgressDialog({
  nsgs, serviceTags, initial, saving, setSaving, onClose, onSaved,
}: {
  nsgs: NsgOption[];
  serviceTags: ServiceTag[];
  initial: EgressPolicy | null;
  saving: boolean;
  setSaving: (b: boolean) => void;
  onClose: () => void;
  onSaved: (r: ReconcileReceipt) => void;
}) {
  const styles = useStyles();
  const [workspaceId, setWorkspaceId] = useState(initial?.workspaceId || '');
  const [workspaceName, setWorkspaceName] = useState(initial?.workspaceName || '');
  const [nsgId, setNsgId] = useState(initial?.nsgId || '');
  const [defaultDeny, setDefaultDeny] = useState(initial?.defaultDeny !== false);
  const [destinations, setDestinations] = useState<EgressDestination[]>(initial?.destinations || []);
  const [err, setErr] = useState<string | null>(null);

  // Draft row for adding a destination (no freeform: type + service-tag are dropdowns).
  const [draftType, setDraftType] = useState<EgressDestinationType>('service-tag');
  const [draftValue, setDraftValue] = useState('');
  const [draftProto, setDraftProto] = useState<EgressDestination['protocol']>('Tcp');
  const [draftPorts, setDraftPorts] = useState('443');

  const nsgById = useMemo(() => new Map(nsgs.map((n) => [n.id, n])), [nsgs]);
  const selectedNsg = nsgById.get(nsgId);

  const isValidCidr = (v: string) => /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(\/\d{1,2})?$/.test(v.trim());
  const isValidFqdn = (v: string) => /^(\*\.)?([a-zA-Z0-9-]{1,63}\.)+[a-zA-Z]{2,63}$/.test(v.trim());

  const addDestination = () => {
    const value = draftValue.trim();
    if (!value) { setErr('Enter a destination value'); return; }
    if (draftType === 'ip' && !isValidCidr(value)) { setErr(`Invalid IPv4 CIDR / address: ${value}`); return; }
    if (draftType === 'fqdn' && !isValidFqdn(value)) { setErr(`Invalid FQDN: ${value}`); return; }
    const id = `${draftType}:${value.toLowerCase()}`;
    if (destinations.some((d) => d.id === id)) { setErr('Destination already added'); return; }
    setErr(null);
    setDestinations((ds) => [...ds, { id, type: draftType, value, protocol: draftProto, ports: draftPorts.trim() || (draftType === 'ip' ? '*' : '443') }]);
    setDraftValue('');
  };

  const removeDest = (id: string) => setDestinations((ds) => ds.filter((d) => d.id !== id));

  // When switching to a service-tag draft, reset value; default ports per type.
  const onDraftType = (t: EgressDestinationType) => {
    setDraftType(t);
    setDraftValue('');
    setDraftProto(t === 'ip' ? '*' : 'Tcp');
    setDraftPorts(t === 'ip' ? '*' : '443');
  };

  const save = async () => {
    if (!workspaceId.trim()) { setErr('Enter a workspace id / name'); return; }
    if (!nsgId) { setErr('Pick the workspace compute subnet NSG'); return; }
    setSaving(true); setErr(null);
    try {
      const body = {
        id: initial?.id,
        workspaceId: workspaceId.trim(),
        workspaceName: workspaceName.trim() || undefined,
        nsgId,
        nsgName: selectedNsg?.name,
        defaultDeny,
        destinations,
      };
      const r = await clientFetch(API, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json();
      if (!r.ok || !j?.ok) { setErr(j?.error || `Save failed (${r.status})`); return; }
      onSaved(j.receipt);
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setSaving(false); }
  };

  return (
    <Dialog open onOpenChange={(_e, d) => { if (!d.open) onClose(); }}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>{initial ? 'Edit egress policy' : 'New workspace egress policy'}</DialogTitle>
          <DialogContent className={styles.dialogStack}>
            {err && <MessageBar intent="error"><MessageBarBody>{err}</MessageBarBody></MessageBar>}

            <Field label="Workspace id / name" required>
              <Input placeholder="e.g. finance-analytics" value={workspaceId} onChange={(_e, d) => setWorkspaceId(d.value)} disabled={!!initial} />
            </Field>
            <Field label="Display name">
              <Input placeholder="Optional friendly name" value={workspaceName} onChange={(_e, d) => setWorkspaceName(d.value)} />
            </Field>

            <Field label="Compute subnet network security group" required hint={selectedNsg ? `Subnets: ${selectedNsg.subnets.join(', ') || '—'}${selectedNsg.resourceGroup ? ` · RG ${selectedNsg.resourceGroup}` : ''}` : 'Rules are written to this NSG'}>
              <Dropdown
                placeholder={nsgs.length ? 'Select an NSG' : 'No NSGs readable — grant Reader'}
                value={selectedNsg ? selectedNsg.name : ''}
                selectedOptions={nsgId ? [nsgId] : []}
                onOptionSelect={(_e, d) => setNsgId(d.optionValue || '')}
              >
                {nsgs.map((n) => (
                  <Option key={n.id} value={n.id} text={n.name}>
                    {n.name}{n.resourceGroup ? ` — ${n.resourceGroup}` : ''}
                  </Option>
                ))}
              </Dropdown>
            </Field>

            <Field label="Default deny" hint="Write a final Deny-to-Internet outbound rule so ONLY the allow-list can egress (outbound access protection).">
              <Switch checked={defaultDeny} onChange={(_e, d) => setDefaultDeny(d.checked)} label={defaultDeny ? 'Enabled — deny all other outbound' : 'Disabled — allow-list only, no blanket deny'} />
            </Field>

            <Field label="Outbound allow-list">
              <div className={styles.destRow}>
                <Dropdown
                  className={styles.destType}
                  aria-label="Destination type"
                  value={draftType === 'service-tag' ? 'Service tag' : draftType === 'ip' ? 'IP / CIDR' : 'FQDN'}
                  selectedOptions={[draftType]}
                  onOptionSelect={(_e, d) => onDraftType((d.optionValue as EgressDestinationType) || 'service-tag')}
                >
                  <Option value="service-tag" text="Service tag">Service tag</Option>
                  <Option value="ip" text="IP / CIDR">IP / CIDR</Option>
                  <Option value="fqdn" text="FQDN">FQDN (firewall)</Option>
                </Dropdown>
                {draftType === 'service-tag' ? (
                  <Dropdown
                    className={styles.destValue}
                    aria-label="Service tag"
                    placeholder="Select an Azure service tag"
                    value={serviceTags.find((t) => t.value === draftValue)?.label || draftValue}
                    selectedOptions={draftValue ? [draftValue] : []}
                    onOptionSelect={(_e, d) => setDraftValue(d.optionValue || '')}
                  >
                    {serviceTags.map((t) => <Option key={t.value} value={t.value} text={t.label}>{t.label}</Option>)}
                  </Dropdown>
                ) : (
                  <Input
                    className={styles.destValue}
                    aria-label={draftType === 'ip' ? 'IPv4 CIDR' : 'FQDN'}
                    placeholder={draftType === 'ip' ? 'e.g. 10.0.0.0/24 or 203.0.113.5' : 'e.g. contoso.com or *.blob.core.windows.net'}
                    value={draftValue}
                    onChange={(_e, d) => setDraftValue(d.value)}
                  />
                )}
                <Dropdown
                  className={styles.destPorts}
                  aria-label="Protocol"
                  value={draftProto || 'Tcp'}
                  selectedOptions={[draftProto || 'Tcp']}
                  onOptionSelect={(_e, d) => setDraftProto((d.optionValue as EgressDestination['protocol']) || 'Tcp')}
                >
                  {PROTO_OPTIONS.map((p) => <Option key={p} value={p} text={p}>{p}</Option>)}
                </Dropdown>
                <Input className={styles.destPorts} aria-label="Ports" placeholder="443" value={draftPorts} onChange={(_e, d) => setDraftPorts(d.value)} />
                <Button appearance="secondary" icon={<Add20Regular />} onClick={addDestination}>Add</Button>
              </div>
              {draftType === 'fqdn' && (
                <Caption1 className={styles.hint}>
                  FQDN destinations can&apos;t be enforced by an NSG — they&apos;re saved and reported as needing an Azure Firewall application rule.
                </Caption1>
              )}
            </Field>

            {destinations.length > 0 && (
              <Table size="small" aria-label="Egress destinations">
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>Type</TableHeaderCell>
                    <TableHeaderCell>Destination</TableHeaderCell>
                    <TableHeaderCell>Protocol</TableHeaderCell>
                    <TableHeaderCell>Ports</TableHeaderCell>
                    <TableHeaderCell />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {destinations.map((d) => (
                    <TableRow key={d.id}>
                      <TableCell>
                        <Badge appearance="tint" color={d.type === 'fqdn' ? 'warning' : d.type === 'ip' ? 'informative' : 'brand'}>
                          {d.type === 'service-tag' ? 'service tag' : d.type}
                        </Badge>
                      </TableCell>
                      <TableCell><Text>{d.value}</Text></TableCell>
                      <TableCell>{d.protocol || 'Tcp'}</TableCell>
                      <TableCell>{d.ports || '*'}</TableCell>
                      <TableCell>
                        <Button size="small" appearance="subtle" icon={<Delete12Regular />} aria-label={`Remove ${d.value}`} onClick={() => removeDest(d.id)} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>Cancel</Button>
            <Button appearance="primary" disabled={saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save & reconcile'}</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

export default WorkspaceEgressPane;
