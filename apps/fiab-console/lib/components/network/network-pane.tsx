'use client';

/**
 * Network & Private DNS pane — the developer-facing view of CSA Loom's
 * private-endpoint topology. Reads live from ARM (/api/network/private-endpoints)
 * and renders:
 *   1. The private-endpoint inventory (resource, sub-resource, FQDN, private IP, zone).
 *   2. A copy/paste hosts-file block for local dev (quick, no-infra override).
 *   3. The privatelink zones + step-by-step ENTERPRISE DNS guidance (conditional
 *      forwarders → DNS Private Resolver, or zone VNet-links) and VPN notes — so
 *      developers on the corp VPN resolve service FQDNs to their private IPs and
 *      can reach Synapse / SQL / Storage / etc. directly, with no public access.
 *
 * Honest gate (no-vaporware): if the Console identity can't read private
 * endpoints, a warning MessageBar names the Reader role to grant — the page
 * still renders the enterprise-DNS guidance, which is deployment-independent.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Spinner, MessageBar, MessageBarBody, MessageBarTitle, Button, Badge,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  Subtitle2, Body1, Body1Strong, Caption1, Divider, Accordion, AccordionItem,
  AccordionHeader, AccordionPanel, Link, tokens,
} from '@fluentui/react-components';
import {
  Copy24Regular, Checkmark24Regular, ServerMultipleRegular,
  Globe24Regular, ShieldLock24Regular, DocumentBulletList24Regular,
  PlugConnected24Regular, Checkmark16Filled, Warning16Filled,
  Info16Filled, Dismiss16Filled,
} from '@fluentui/react-icons';
import { FullNetworkTopologyCanvas } from './full-topology-canvas';
import { ManagedPrivateEndpointsCard } from './managed-private-endpoints';
import { TrustedWorkspaceAccessCard } from './trusted-workspace-access';

interface DnsRecord { fqdn: string; ips: string[]; zone: string; }
interface PrivateEndpoint {
  id: string; name: string; resourceGroup?: string; location?: string;
  connectedResourceName?: string; connectedResourceType?: string; loomDomain?: string;
  groupIds: string[]; state?: string; dns: DnsRecord[];
  subnetId?: string; subnetName?: string;
}
interface VNetLite {
  id: string; name: string; subscriptionId: string; resourceGroup?: string;
  addressPrefixes: string[];
  subnets: { id?: string; name: string; addressPrefix?: string; privateEndpointCount: number; delegations: string[]; nsgId?: string }[];
}
interface NsgRuleLite {
  name: string; direction: string; access: string; priority: number;
  protocol: string; sourcePrefix: string; destPrefix: string; sourcePort: string; destPort: string;
}
interface NsgLite {
  id: string; name: string; subscriptionId: string; resourceGroup?: string;
  location?: string; subnetIds: string[]; rules: NsgRuleLite[];
}
interface ApiResp {
  ok: boolean; count?: number; endpoints?: PrivateEndpoint[]; zones?: string[];
  hostsBlock?: string; error?: string; hint?: string;
  vnets?: VNetLite[]; nsgs?: NsgLite[]; dnsZones?: { name: string; records: DnsRecord[] }[];
}

const card: React.CSSProperties = {
  padding: tokens.spacingVerticalXL, border: `1px solid ${tokens.colorNeutralStroke2}`,
  borderRadius: tokens.borderRadiusXLarge, backgroundColor: tokens.colorNeutralBackground1,
  marginBottom: tokens.spacingVerticalXL, boxShadow: tokens.shadow4,
};
const head: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalMNudge, marginBottom: tokens.spacingVerticalL, flexWrap: 'wrap', minWidth: 0 };
const codeBox: React.CSSProperties = {
  fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase200, whiteSpace: 'pre', overflow: 'auto',
  maxHeight: 320, maxWidth: '100%',
  background: tokens.colorNeutralBackground3, border: `1px solid ${tokens.colorNeutralStroke2}`,
  borderRadius: 6, padding: tokens.spacingVerticalM, margin: tokens.spacingVerticalNone,
};

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  const copy = useCallback(async () => {
    try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1800); }
    catch { /* clipboard blocked — user can select manually */ }
  }, [text]);
  return (
    <Button size="small" appearance="outline"
      icon={done ? <Checkmark24Regular /> : <Copy24Regular />} onClick={copy} disabled={!text}>
      {done ? 'Copied' : label}
    </Button>
  );
}

// ── VNet data gateway (Fabric tenant capability) — honest read-only gate ──
type GwPrereqStatus = 'met' | 'unmet' | 'tenant' | 'unavailable';
interface GwPrereq {
  id: string; label: string; status: GwPrereqStatus; detail: string;
  azureDetectable: boolean; docUrl?: string;
}
interface GwDelegatedSubnet { vnet: string; subnet: string; subscriptionId: string; resourceGroup?: string; }
interface GwReadiness {
  cloud: string; capabilityAvailable: boolean;
  rpRegistrationState: string | null; rpRegistered: boolean;
  delegatedSubnets: GwDelegatedSubnet[]; prereqs: GwPrereq[]; azureNativeDefault: string;
}
interface GwApiResp { ok: boolean; readiness?: GwReadiness; error?: string; gate?: { reason?: string; remediation?: string }; }

function gwBadge(status: GwPrereqStatus) {
  switch (status) {
    case 'met':
      return <Badge appearance="tint" color="success" icon={<Checkmark16Filled />}>Detected in Azure</Badge>;
    case 'unmet':
      return <Badge appearance="tint" color="warning" icon={<Warning16Filled />}>Action needed</Badge>;
    case 'tenant':
      return <Badge appearance="tint" color="informative" icon={<Info16Filled />}>Fabric tenant action</Badge>;
    case 'unavailable':
    default:
      return <Badge appearance="tint" color="danger" icon={<Dismiss16Filled />}>Not available in this cloud</Badge>;
  }
}

/**
 * VNet data gateway status card. A VNet data gateway is a Fabric / Power
 * Platform TENANT capability — Loom does NOT create one (no-fabric-dependency).
 * This card reads /api/network/vnet-data-gateway (Reader-only ARM detection of
 * the Microsoft.PowerPlatform RP + delegated subnet) and renders an honest
 * prerequisite checklist: Azure-detectable rows get a real success/warning
 * badge; the tenant-only rows are clearly labeled as Fabric-admin actions Loom
 * cannot perform. No "create gateway" control — the Azure-native private-
 * endpoint plane above is the supported default.
 */
function VnetGatewayCard() {
  const [gw, setGw] = useState<GwApiResp | null>(null);
  const [gwLoading, setGwLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch('/api/network/vnet-data-gateway');
        const j = (await r.json()) as GwApiResp;
        if (alive) setGw(j);
      } catch (e: any) {
        if (alive) setGw({ ok: false, error: e?.message || String(e) });
      } finally { if (alive) setGwLoading(false); }
    })();
    return () => { alive = false; };
  }, []);

  const r = gw?.readiness;
  return (
    <div style={card}>
      <div style={head}>
        <PlugConnected24Regular />
        <Subtitle2>Virtual network (VNet) data gateway</Subtitle2>
        <Badge appearance="outline" color="brand" style={{ marginLeft: 'auto' }}>Fabric tenant capability</Badge>
      </div>

      <MessageBar intent="info" style={{ marginBottom: tokens.spacingVerticalM }}>
        <MessageBarBody>
          <MessageBarTitle>Tenant-managed — Loom does not provision this.</MessageBarTitle>
          A VNet data gateway is enabled by a <strong>Fabric administrator</strong> (Power Platform admin
          center → Data → Virtual network data gateways → <em>Manage gateway installers</em>) and requires a
          Power BI/Fabric <strong>Premium capacity</strong>. CSA Loom cannot toggle that tenant switch or create
          the gateway. The supported Azure-native default for private connectivity is the
          <strong> private-endpoint plane</strong> shown above — no Fabric capacity, workspace, or gateway required.
        </MessageBarBody>
      </MessageBar>

      {gwLoading && <Spinner label="Reading VNet-gateway prerequisites…" />}

      {!gwLoading && gw && !gw.ok && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Couldn’t read the Azure prerequisites</MessageBarTitle>
            {gw.gate?.remediation || gw.error}
          </MessageBarBody>
        </MessageBar>
      )}

      {!gwLoading && r && (
        <>
          <Body1 style={{ display: 'block', marginBottom: tokens.spacingVerticalMNudge, color: tokens.colorNeutralForeground3 }}>
            Cloud boundary: <Body1Strong>{r.cloud}</Body1Strong>
            {!r.capabilityAvailable && ' — VNet data gateways are not offered in this sovereign cloud.'}
          </Body1>
          <Table size="small" aria-label="VNet data gateway prerequisites">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Prerequisite</TableHeaderCell>
                <TableHeaderCell>Status</TableHeaderCell>
                <TableHeaderCell>Detail</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {r.prereqs.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={3}>
                    <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                      No prerequisites reported for this cloud boundary.
                    </Caption1>
                  </TableCell>
                </TableRow>
              ) : r.prereqs.map((p) => (
                <TableRow key={p.id}>
                  <TableCell>
                    <Body1Strong>{p.label}</Body1Strong>
                    {!p.azureDetectable && (
                      <Caption1 block style={{ color: tokens.colorNeutralForeground3 }}>
                        Loom cannot verify this — Fabric/Power BI tenant action.
                      </Caption1>
                    )}
                  </TableCell>
                  <TableCell>{gwBadge(p.status)}</TableCell>
                  <TableCell>
                    <Caption1>{p.detail}</Caption1>
                    {p.docUrl && (
                      <Caption1 block style={{ marginTop: tokens.spacingVerticalXXS }}>
                        <Link href={p.docUrl} target="_blank" rel="noreferrer">Microsoft Learn</Link>
                      </Caption1>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {r.delegatedSubnets.length > 0 && (
            <Body1 style={{ display: 'block', marginTop: tokens.spacingVerticalMNudge }}>
              Delegated subnet(s) ready for a gateway:{' '}
              <code style={{ overflowWrap: 'anywhere', wordBreak: 'break-word' }}>{r.delegatedSubnets.map((s) => `${s.vnet}/${s.subnet}`).join(', ')}</code>
            </Body1>
          )}
          <Divider style={{ margin: '12px 0' }} />
          <Body1 style={{ display: 'block', color: tokens.colorNeutralForeground2 }}>
            {r.azureNativeDefault}
          </Body1>
        </>
      )}
    </div>
  );
}

interface VpnGw {
  found: boolean; ready: boolean; name?: string; provisioningState?: string;
  publicIp?: string; clientAddressPool?: string[]; vpnAuthTypes?: string[];
  vpnClientProtocols?: string[]; reachableRanges?: string[];
}

/** Point-to-site VPN access — download the client profile + setup steps so an
 *  admin can reach the private-by-default estate (private endpoints, Internal
 *  APIM, firewall'd services) from their workstation. Pairs with the hosts-file
 *  block below (which maps every FQDN → private IP). */
function VpnAccessCard() {
  const [gw, setGw] = useState<VpnGw | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch('/api/network/vpn-profile');
        const j = await r.json();
        if (alive) setGw(j?.gateway ?? { found: false, ready: false });
      } catch { if (alive) setGw({ found: false, ready: false }); }
      finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; };
  }, []);

  const download = useCallback(async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch('/api/network/vpn-profile', { method: 'POST' });
      const j = await r.json();
      if (j?.ok && j.profileUrl) {
        window.open(j.profileUrl, '_blank', 'noopener');
        setMsg('Profile generated — the download (AzureVPN/OpenVPN config zip) opened in a new tab.');
      } else {
        setMsg(`${j?.error || 'Could not generate the profile.'}${j?.hint ? ' — ' + j.hint : ''}`);
      }
    } catch (e: any) { setMsg(e?.message || String(e)); }
    finally { setBusy(false); }
  }, []);

  return (
    <div style={card}>
      <div style={head}>
        <ShieldLock24Regular />
        <Subtitle2>VPN access (point-to-site)</Subtitle2>
        {gw?.found && (
          <Badge appearance="tint" color={gw.ready ? 'success' : 'warning'} style={{ marginLeft: 'auto' }}>
            {gw.ready ? 'Ready' : (gw.provisioningState || 'Provisioning')}
          </Badge>
        )}
      </div>

      <Body1 style={{ marginBottom: tokens.spacingVerticalM }}>
        Connect from your workstation to reach the private-by-default Azure backends — private endpoints,
        the Internal API Management gateway, and firewall-protected services (Databricks, AI Search, Synapse,
        Cosmos, Key Vault, Storage). Sign-in is your Microsoft Entra ID (no certificates).
      </Body1>

      {loading && <Spinner size="tiny" label="Checking VPN gateway…" />}

      {!loading && !gw?.found && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>No VPN gateway provisioned yet</MessageBarTitle>
            Deploy the day-one VPN gateway (bicep module <code>admin-plane/vpn-gateway.bicep</code>). It provisions a
            point-to-site Entra-ID gateway on the hub VNet GatewaySubnet.
          </MessageBarBody>
        </MessageBar>
      )}

      {!loading && gw?.found && !gw.ready && (
        <MessageBar intent="info">
          <MessageBarBody>
            <MessageBarTitle>Gateway is still provisioning ({gw.provisioningState})</MessageBarTitle>
            A VPN gateway takes ~30–45 minutes to create on first deploy. The download unlocks automatically once it’s Ready.
          </MessageBarBody>
        </MessageBar>
      )}

      {!loading && gw?.found && (
        <>
          <Table size="small" style={{ marginBottom: tokens.spacingVerticalM }}>
            <TableBody>
              <TableRow><TableCell><Body1Strong>Gateway</Body1Strong></TableCell><TableCell>{gw.name} {gw.publicIp ? `· ${gw.publicIp}` : ''}</TableCell></TableRow>
              <TableRow><TableCell><Body1Strong>Auth · protocol</Body1Strong></TableCell><TableCell>{(gw.vpnAuthTypes || []).join(', ') || 'AAD'} · {(gw.vpnClientProtocols || []).join(', ') || 'OpenVPN'}</TableCell></TableRow>
              <TableRow><TableCell><Body1Strong>Client IP pool</Body1Strong></TableCell><TableCell>{(gw.clientAddressPool || []).join(', ')}</TableCell></TableRow>
              <TableRow><TableCell><Body1Strong>Reaches (routed)</Body1Strong></TableCell><TableCell>{(gw.reachableRanges || []).join(', ') || '—'}</TableCell></TableRow>
            </TableBody>
          </Table>

          <Button appearance="primary" icon={<PlugConnected24Regular />} disabled={!gw.ready || busy} onClick={download}>
            {busy ? 'Generating…' : 'Download VPN client config'}
          </Button>
          {msg && <MessageBar intent="info" style={{ marginTop: tokens.spacingVerticalMNudge }}><MessageBarBody>{msg}</MessageBarBody></MessageBar>}

          <Divider style={{ margin: '14px 0' }} />
          <Body1Strong>Setup (one time)</Body1Strong>
          <ol style={{ margin: '6px 0 0 18px', lineHeight: 1.7 }}>
            <li>Install the <strong>Azure VPN Client</strong> (Microsoft Store on Windows, or the macOS App Store).</li>
            <li>Click <strong>Download VPN client config</strong> above and unzip it.</li>
            <li>In the Azure VPN Client: <em>+ → Import</em>, choose the <code>azurevpnconfig.xml</code> from the <code>AzureVPN</code> folder.</li>
            <li><strong>Connect</strong> and sign in with your Microsoft Entra ID (the metastore/admin account).</li>
            <li>For service FQDN resolution, paste the <strong>hosts-file block below</strong> into your hosts file
              (<code>C:\Windows\System32\drivers\etc\hosts</code> or <code>/etc/hosts</code>) — it maps every private-endpoint
              FQDN to its private IP. Then you can reach Databricks, Synapse Studio, AI Search, etc. over the tunnel.</li>
          </ol>
        </>
      )}
    </div>
  );
}

export function NetworkPane() {
  const [data, setData] = useState<ApiResp | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch('/api/network/private-endpoints');
        const j = (await r.json()) as ApiResp;
        if (alive) setData(j);
      } catch (e: any) {
        if (alive) setData({ ok: false, error: e?.message || String(e) });
      } finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; };
  }, []);

  const endpoints = data?.endpoints || [];
  const zones = data?.zones || [];
  const hostsBlock = data?.hostsBlock || '';

  // Conditional-forwarder targets = the public parent domains of each zone
  // (strip the leading `privatelink.` label) — what corp DNS forwards to Azure.
  const forwardDomains = Array.from(new Set(zones.map((z) => z.replace(/^privatelink\./, '')))).sort();

  return (
    <div>
      {/* Posture banner */}
      <MessageBar intent="info" style={{ marginBottom: tokens.spacingVerticalL }}>
        <MessageBarBody>
          <MessageBarTitle>Private by default.</MessageBarTitle>
          Loom backing services run with <strong>public network access disabled</strong>. The console reaches
          them over private endpoints + private DNS linked to the hub VNet. To reach them <em>directly</em> (Synapse
          Studio, SSMS, Storage Explorer, <code>az</code>/REST) from your workstation, your VPN-connected machine must
          resolve each service FQDN to its <strong>private endpoint IP</strong>. Use the hosts override for a quick
          local fix, or wire the enterprise DNS below for everyone.
        </MessageBarBody>
      </MessageBar>

      {/* 0 · Full network topology — live Azure Resource Graph visual of the
          ENTIRE network estate (vNets, subnets, peering, PEs, NSGs, firewalls,
          Bastion, Container Apps envs, App Gateways, LBs, private DNS zones).
          Fetches its own data + renders its own honest gate, so it shows the
          full graph even when the private-endpoint inventory below is empty. */}
      <div style={card}>
        <div style={head}>
          <Globe24Regular />
          <Subtitle2>CSA Loom network topology</Subtitle2>
          <Badge appearance="tint" color="brand" style={{ marginLeft: 'auto' }}>Azure Resource Graph</Badge>
        </div>
        <Body1 style={{ display: 'block', marginBottom: tokens.spacingVerticalM, color: tokens.colorNeutralForeground3 }}>
          A live resource-graph map of the whole network estate across the readable subscription(s):
          virtual networks &rarr; subnets &rarr; the private endpoints, NSGs, Azure Firewalls, Bastion hosts,
          Container Apps environments, application gateways and load balancers attached to each — plus
          vNet&harr;vNet peering and the private DNS zones. Select any node for its live ARM detail.
        </Body1>
        <FullNetworkTopologyCanvas />
      </div>

      {loading && <Spinner label="Discovering private endpoints…" />}

      {!loading && data && !data.ok && (
        <MessageBar intent="warning" style={{ marginBottom: tokens.spacingVerticalL }}>
          <MessageBarBody>
            <MessageBarTitle>Couldn’t read private endpoints</MessageBarTitle>
            {data.error}{data.hint ? ` — ${data.hint}` : ''}
          </MessageBarBody>
        </MessageBar>
      )}

      {/* 1 · Inventory */}
      {!loading && data?.ok && (
        <div style={card}>
          <div style={head}>
            <ServerMultipleRegular />
            <Subtitle2>Private endpoints ({data.count ?? endpoints.length})</Subtitle2>
          </div>
          {endpoints.length === 0 ? (
            <Body1>No private endpoints found in the readable subscription(s). If services are public-access
              disabled but have no PE, they’re unreachable — provision the endpoints in the network bicep module.</Body1>
          ) : (
            <Table size="small" aria-label="Private endpoints">
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>Service</TableHeaderCell>
                  <TableHeaderCell>Loom domain</TableHeaderCell>
                  <TableHeaderCell>Sub-resource</TableHeaderCell>
                  <TableHeaderCell>FQDN</TableHeaderCell>
                  <TableHeaderCell>Private IP</TableHeaderCell>
                  <TableHeaderCell>Private DNS zone</TableHeaderCell>
                  <TableHeaderCell>State</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {endpoints.flatMap((pe) =>
                  (pe.dns.length ? pe.dns : [{ fqdn: '(no DNS config)', ips: [], zone: '' }]).map((rec, i) => (
                    <TableRow key={`${pe.id}-${i}`}>
                      <TableCell>{i === 0 ? (pe.connectedResourceName || pe.name) : ''}</TableCell>
                      <TableCell>{i === 0 ? (pe.loomDomain ? <Badge appearance="tint" color="brand">{pe.loomDomain}</Badge> : <span style={{ color: tokens.colorNeutralForeground3 }}>—</span>) : ''}</TableCell>
                      <TableCell>{i === 0 ? pe.groupIds.join(', ') : ''}</TableCell>
                      <TableCell style={{ fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase200 }}>{rec.fqdn}</TableCell>
                      <TableCell style={{ fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase200 }}>{rec.ips.join(', ') || '—'}</TableCell>
                      <TableCell style={{ fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase200 }}>{rec.zone || '—'}</TableCell>
                      <TableCell>{i === 0 ? <Badge appearance="tint" color={pe.state === 'Approved' || pe.state === 'Succeeded' ? 'success' : 'warning'}>{pe.state || '—'}</Badge> : ''}</TableCell>
                    </TableRow>
                  )),
                )}
              </TableBody>
            </Table>
          )}
        </div>
      )}

      {/* 1b · Managed private endpoints — self-service create + approval (Phase 4 G5).
          Tenant-admin gated; renders its own honest MessageBar when not configured
          / not authorized, so it shows the create + approval surface independently
          of the read-only inventory above. */}
      <ManagedPrivateEndpointsCard />

      {/* 1c · Trusted access — storage resource-instance rules (Phase 4 G6).
          The Fabric "trusted workspace access" equivalent: authorize the Console
          UAMI / a per-workspace identity through a firewalled storage account's
          networkAcls.resourceAccessRules over real ARM. Tenant-admin gated;
          renders its own honest MessageBars. */}
      <TrustedWorkspaceAccessCard />

      {/* 2 · Hosts-file override */}
      {!loading && data?.ok && hostsBlock && (
        <div style={card}>
          <div style={head}>
            <DocumentBulletList24Regular />
            <Subtitle2>Local hosts-file override (developer quick-start)</Subtitle2>
          </div>
          <Body1 style={{ display: 'block', marginBottom: tokens.spacingVerticalS }}>
            Paste into <code>C:\Windows\System32\drivers\etc\hosts</code> (Windows) or <code>/etc/hosts</code>
            (macOS/Linux) while on the VPN. This is a stop-gap for one machine — IPs can change on PE re-create,
            and it doesn’t cover wildcards. For anything shared, use the enterprise DNS below.
          </Body1>
          <pre style={codeBox}>{hostsBlock}</pre>
          <div style={{ marginTop: tokens.spacingVerticalMNudge }}><CopyButton text={hostsBlock} label="Copy hosts block" /></div>
        </div>
      )}

      {/* 2b · Virtual networks & subnets */}
      {!loading && data?.ok && (data.vnets?.length ?? 0) > 0 && (
        <div style={card}>
          <div style={head}>
            <ServerMultipleRegular />
            <Subtitle2>Virtual networks &amp; subnets</Subtitle2>
          </div>
          <Table size="small" aria-label="Virtual networks">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>vNet</TableHeaderCell>
                <TableHeaderCell>Address space</TableHeaderCell>
                <TableHeaderCell>Subnet</TableHeaderCell>
                <TableHeaderCell>Prefix</TableHeaderCell>
                <TableHeaderCell>Private endpoints</TableHeaderCell>
                <TableHeaderCell>Delegation</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(data.vnets || []).flatMap((v) => (v.subnets.length ? v.subnets : [{ name: '—', addressPrefix: '', privateEndpointCount: 0, delegations: [] }]).map((sn, i) => (
                <TableRow key={`${v.id}-${sn.name}-${i}`}>
                  <TableCell>{i === 0 ? <Body1Strong>{v.name}</Body1Strong> : ''}</TableCell>
                  <TableCell>{i === 0 ? (v.addressPrefixes.join(', ') || '—') : ''}</TableCell>
                  <TableCell>{sn.name}</TableCell>
                  <TableCell>{sn.addressPrefix || '—'}</TableCell>
                  <TableCell>{sn.privateEndpointCount || 0}</TableCell>
                  <TableCell>{sn.delegations.join(', ') || '—'}</TableCell>
                </TableRow>
              )))}
            </TableBody>
          </Table>
        </div>
      )}

      {/* 2b-2 · Network security groups */}
      {!loading && data?.ok && (data.nsgs?.length ?? 0) > 0 && (
        <div style={card}>
          <div style={head}>
            <ShieldLock24Regular />
            <Subtitle2>Network security groups ({data.nsgs?.length ?? 0})</Subtitle2>
          </div>
          <Table size="small" aria-label="Network security groups">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>NSG</TableHeaderCell>
                <TableHeaderCell>Attached subnets</TableHeaderCell>
                <TableHeaderCell>Rules</TableHeaderCell>
                <TableHeaderCell>Deny rules</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(data.nsgs || []).map((n) => (
                <TableRow key={n.id}>
                  <TableCell><Body1Strong>{n.name}</Body1Strong></TableCell>
                  <TableCell>{n.subnetIds.map((s) => s.split('/').pop()).join(', ') || '—'}</TableCell>
                  <TableCell>{n.rules.length}</TableCell>
                  <TableCell>{n.rules.filter((r) => r.access === 'Deny').length}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <Caption1 block style={{ marginTop: tokens.spacingVerticalS, color: tokens.colorNeutralForeground3 }}>
            Select an NSG node in the topology below to view its full inbound/outbound security-rule grid.
          </Caption1>
        </div>
      )}

      {/* 2c · (removed) The old private-endpoint-derived topology graph used to
          render a SECOND "CSA Loom network topology" card here, duplicating the
          comprehensive Azure-Resource-Graph FullNetworkTopologyCanvas in section
          0 above (and frequently rendering empty when the PE inventory was thin).
          Section 0 is the single source of truth for the network topology visual. */}

      {/* 3 · Enterprise DNS */}
      <div style={card}>
        <div style={head}>
          <Globe24Regular />
          <Subtitle2>Enterprise / corporate DNS configuration</Subtitle2>
        </div>
        <Body1 style={{ display: 'block', marginBottom: tokens.spacingVerticalM }}>
          The durable fix: make your corporate DNS resolve every Azure private-link domain to the private IPs.
          Pick <strong>one</strong> of the patterns below. Both let any VPN-connected user reach the services
          by their normal public FQDN, with traffic staying on the private endpoints.
        </Body1>

        <Accordion multiple collapsible defaultOpenItems={['resolver']}>
          <AccordionItem value="resolver">
            <AccordionHeader>Recommended — Azure DNS Private Resolver + conditional forwarders</AccordionHeader>
            <AccordionPanel>
              <Body1 style={{ display: 'block' }}>
                1. Deploy an <strong>Azure DNS Private Resolver</strong> with an <strong>inbound endpoint</strong> in
                the hub VNet (the VNet the private DNS zones are linked to). Note its inbound IP.<br />
                2. Ensure every privatelink zone below is linked to that VNet (Loom’s bicep already links them to the
                hub).<br />
                3. On your corporate DNS servers (or Azure Firewall / forwarder), add a <strong>conditional
                forwarder</strong> for each public parent domain → the resolver inbound IP. Queries for
                <code> *.privatelink.* </code> then resolve to the private IPs automatically.<br />
                4. Route the resolver inbound IP over the VPN/ExpressRoute so on-prem clients can reach it.
              </Body1>
              <Body1Strong style={{ display: 'block', marginTop: tokens.spacingVerticalMNudge, marginBottom: tokens.spacingVerticalXS }}>Conditional-forwarder domains</Body1Strong>
              <pre style={codeBox}>{forwardDomains.length ? forwardDomains.join('\n') : '(load the inventory to populate)'}</pre>
              <div style={{ marginTop: tokens.spacingVerticalS }}><CopyButton text={forwardDomains.join('\n')} label="Copy domains" /></div>
            </AccordionPanel>
          </AccordionItem>

          <AccordionItem value="zones">
            <AccordionHeader>Private DNS zones to host / link</AccordionHeader>
            <AccordionPanel>
              <Body1 style={{ display: 'block', marginBottom: tokens.spacingVerticalS }}>
                These are the <code>privatelink.*</code> zones the deployment uses. With the resolver pattern they
                already exist in Azure (linked to the hub VNet). If instead you host DNS entirely on-prem, create
                these zones on your DNS and add the A records from the inventory above.
              </Body1>
              <pre style={codeBox}>{zones.length ? zones.join('\n') : '(load the inventory to populate)'}</pre>
              <div style={{ marginTop: tokens.spacingVerticalS }}><CopyButton text={zones.join('\n')} label="Copy zones" /></div>
            </AccordionPanel>
          </AccordionItem>

          <AccordionItem value="vpn">
            <AccordionHeader>VPN client notes</AccordionHeader>
            <AccordionPanel>
              <Body1 style={{ display: 'block' }}>
                • Use a <strong>VPN that pushes the corporate DNS</strong> (or the DNS Private Resolver inbound IP) to
                clients, so split-tunnel DNS resolves <code>*.privatelink.*</code> privately.<br />
                • If split-tunneling, include the private endpoint subnet ranges and the resolver IP in the tunnel
                routes.<br />
                • Verify with <code>nslookup &lt;service-fqdn&gt;</code> — it must return the private IP (10.x), not a
                public one. <code>Resolve-DnsName</code> on Windows shows the CNAME chain ending at the
                <code> privatelink </code> zone.
              </Body1>
            </AccordionPanel>
          </AccordionItem>
        </Accordion>
      </div>

      {/* 4 · Synapse note */}
      <div style={card}>
        <div style={head}>
          <ShieldLock24Regular />
          <Subtitle2>Synapse workspace — public access disabled</Subtitle2>
        </div>
        <Body1 style={{ display: 'block' }}>
          The Synapse workspace runs <code>publicNetworkAccess: Disabled</code>, with private endpoints for its
          <strong> Dev</strong> (<code>*.dev.azuresynapse.net</code> — Studio + artifact REST),
          <strong> SQL</strong> (dedicated pools) and <strong> SqlOnDemand</strong> (serverless)
          sub-resources, all registered in the <code>privatelink.dev.azuresynapse.net</code> /
          <code> privatelink.sql.azuresynapse.net</code> zones linked to the hub VNet.
        </Body1>
        <Divider style={{ margin: '12px 0' }} />
        <Body1 style={{ display: 'block' }}>
          To reach Synapse Studio from your workstation, add the <code>azuresynapse</code> entries from the hosts
          block above (or configure the conditional forwarders) while on the VPN, then browse to
          <code> web.azuresynapse.net</code>. SQL tools (SSMS / <code>sqlcmd</code>) connect to the
          <code> *.sql.azuresynapse.net</code> endpoint the same way.
        </Body1>
      </div>

      {/* 5 · Point-to-site VPN access (download + setup + reaches the private estate) */}
      <VpnAccessCard />

      {/* 6 · VNet data gateway (Fabric tenant capability) — honest gate */}
      <VnetGatewayCard />

      <Caption1>
        Inventory reads live from ARM (Microsoft.Network/privateEndpoints) via the Console identity. See the
        networking how-to in the docs for the full bicep + bootstrap details.
      </Caption1>
    </div>
  );
}
