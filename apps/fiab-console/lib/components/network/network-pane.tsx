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
  AccordionHeader, AccordionPanel, tokens,
} from '@fluentui/react-components';
import {
  Copy24Regular, Checkmark24Regular, ServerMultipleRegular,
  Globe24Regular, ShieldLock24Regular, DocumentBulletList24Regular,
} from '@fluentui/react-icons';

interface DnsRecord { fqdn: string; ips: string[]; zone: string; }
interface PrivateEndpoint {
  id: string; name: string; resourceGroup?: string; location?: string;
  connectedResourceName?: string; groupIds: string[]; state?: string; dns: DnsRecord[];
}
interface ApiResp {
  ok: boolean; count?: number; endpoints?: PrivateEndpoint[]; zones?: string[];
  hostsBlock?: string; error?: string; hint?: string;
}

const card: React.CSSProperties = {
  padding: 20, border: `1px solid ${tokens.colorNeutralStroke2}`,
  borderRadius: tokens.borderRadiusXLarge, backgroundColor: tokens.colorNeutralBackground1,
  marginBottom: 20, boxShadow: tokens.shadow4,
};
const head: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 };
const codeBox: React.CSSProperties = {
  fontFamily: 'Consolas, monospace', fontSize: 12, whiteSpace: 'pre', overflowX: 'auto',
  background: tokens.colorNeutralBackground3, border: `1px solid ${tokens.colorNeutralStroke2}`,
  borderRadius: 6, padding: 12, margin: 0,
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
      <MessageBar intent="info" style={{ marginBottom: 16 }}>
        <MessageBarBody>
          <MessageBarTitle>Private by default.</MessageBarTitle>
          Loom backing services run with <strong>public network access disabled</strong>. The console reaches
          them over private endpoints + private DNS linked to the hub VNet. To reach them <em>directly</em> (Synapse
          Studio, SSMS, Storage Explorer, <code>az</code>/REST) from your workstation, your VPN-connected machine must
          resolve each service FQDN to its <strong>private endpoint IP</strong>. Use the hosts override for a quick
          local fix, or wire the enterprise DNS below for everyone.
        </MessageBarBody>
      </MessageBar>

      {loading && <Spinner label="Discovering private endpoints…" />}

      {!loading && data && !data.ok && (
        <MessageBar intent="warning" style={{ marginBottom: 16 }}>
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
                      <TableCell>{i === 0 ? pe.groupIds.join(', ') : ''}</TableCell>
                      <TableCell style={{ fontFamily: 'Consolas, monospace', fontSize: 12 }}>{rec.fqdn}</TableCell>
                      <TableCell style={{ fontFamily: 'Consolas, monospace', fontSize: 12 }}>{rec.ips.join(', ') || '—'}</TableCell>
                      <TableCell style={{ fontFamily: 'Consolas, monospace', fontSize: 12 }}>{rec.zone || '—'}</TableCell>
                      <TableCell>{i === 0 ? <Badge appearance="tint" color={pe.state === 'Approved' || pe.state === 'Succeeded' ? 'success' : 'warning'}>{pe.state || '—'}</Badge> : ''}</TableCell>
                    </TableRow>
                  )),
                )}
              </TableBody>
            </Table>
          )}
        </div>
      )}

      {/* 2 · Hosts-file override */}
      {!loading && data?.ok && hostsBlock && (
        <div style={card}>
          <div style={head}>
            <DocumentBulletList24Regular />
            <Subtitle2>Local hosts-file override (developer quick-start)</Subtitle2>
          </div>
          <Body1 style={{ display: 'block', marginBottom: 8 }}>
            Paste into <code>C:\Windows\System32\drivers\etc\hosts</code> (Windows) or <code>/etc/hosts</code>
            (macOS/Linux) while on the VPN. This is a stop-gap for one machine — IPs can change on PE re-create,
            and it doesn’t cover wildcards. For anything shared, use the enterprise DNS below.
          </Body1>
          <pre style={codeBox}>{hostsBlock}</pre>
          <div style={{ marginTop: 10 }}><CopyButton text={hostsBlock} label="Copy hosts block" /></div>
        </div>
      )}

      {/* 3 · Enterprise DNS */}
      <div style={card}>
        <div style={head}>
          <Globe24Regular />
          <Subtitle2>Enterprise / corporate DNS configuration</Subtitle2>
        </div>
        <Body1 style={{ display: 'block', marginBottom: 12 }}>
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
              <Body1Strong style={{ display: 'block', marginTop: 10, marginBottom: 4 }}>Conditional-forwarder domains</Body1Strong>
              <pre style={codeBox}>{forwardDomains.length ? forwardDomains.join('\n') : '(load the inventory to populate)'}</pre>
              <div style={{ marginTop: 8 }}><CopyButton text={forwardDomains.join('\n')} label="Copy domains" /></div>
            </AccordionPanel>
          </AccordionItem>

          <AccordionItem value="zones">
            <AccordionHeader>Private DNS zones to host / link</AccordionHeader>
            <AccordionPanel>
              <Body1 style={{ display: 'block', marginBottom: 8 }}>
                These are the <code>privatelink.*</code> zones the deployment uses. With the resolver pattern they
                already exist in Azure (linked to the hub VNet). If instead you host DNS entirely on-prem, create
                these zones on your DNS and add the A records from the inventory above.
              </Body1>
              <pre style={codeBox}>{zones.length ? zones.join('\n') : '(load the inventory to populate)'}</pre>
              <div style={{ marginTop: 8 }}><CopyButton text={zones.join('\n')} label="Copy zones" /></div>
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
        <Body1Strong style={{ display: 'block', marginBottom: 4 }}>Is this breaking the Synapse-backed Loom apps? No.</Body1Strong>
        <Body1 style={{ display: 'block' }}>
          The console resolves those private FQDNs through the hub-linked zones, so it authors + runs Synapse
          pipelines privately — Synapse REST calls succeed (you get artifact-level responses, not connection
          timeouts). Pipeline issues seen in the app were artifact-commit problems (long-running PUT not awaited /
          unresolved dataset references), not connectivity — fixed separately. “Synapse Link” (HTAP for
          Cosmos/SQL/Dataverse) is unrelated; what matters here — <strong>Private Link</strong> — is already
          configured. To reach Synapse Studio yourself, add the two <code>azuresynapse</code> entries from the hosts
          block (or the conditional forwarders) and browse to <code>web.azuresynapse.net</code> on the VPN.
        </Body1>
      </div>

      <Caption1>
        Inventory reads live from ARM (Microsoft.Network/privateEndpoints) via the Console identity. See the
        networking how-to in the docs for the full bicep + bootstrap details.
      </Caption1>
    </div>
  );
}
