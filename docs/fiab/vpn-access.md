# Admin VPN access — reach the private-by-default estate

CSA Loom deploys private-by-default: the services sit behind **private endpoints**
(Cosmos, Synapse, Storage, ADLS, Event Hubs, ADF, Key Vault), an **Internal**
API Management gateway, and **firewall / IP-access** rules (Databricks, AI Search).
From a workstation that isn't on the VNet you'll hit *"IP access restriction"*,
*"fetch failed"*, or DNS that resolves to an unreachable public IP.

A **point-to-site (P2S) VPN** fixes this: connect from your laptop, and the
Loom VNets are routed to you over the tunnel. This is day-one config.

## What's deployed (day-one)

- **VPN gateway** `vpngw-loom-<region>` (`VpnGw1AZ`, RouteBased, Entra-ID auth,
  OpenVPN) on the hub VNet `GatewaySubnet`. Client address pool `172.16.201.0/24`.
  Bicep: `platform/fiab/bicep/modules/admin-plane/vpn-gateway.bicep`
  (`vpnGatewayEnabled = true`).
- **Gateway transit** on the hub↔DLZ peering, so P2S clients also reach the DLZ
  VNet (`10.100.0.0/16`) where the data services live — not just the hub
  (`10.0.0.0/16`).
- **Admin → Network & DNS** page: a **VPN access** card (download the client
  profile + setup steps) and the live **private-endpoint inventory + hosts-file
  block** (every service FQDN → its private IP).

## One-time setup (per admin)

1. Install the **Azure VPN Client** (Windows: Microsoft Store · macOS: App Store).
2. In Loom go to **Admin → Network & DNS → VPN access → Download VPN client
   config**. Unzip it.
3. Azure VPN Client → **+ → Import** → select `AzureVPN/azurevpnconfig.xml`.
4. **Connect** and sign in with your Microsoft Entra ID (the admin / metastore-admin account).
5. DNS resolution — **works automatically** via an **Azure DNS Private Resolver**
   in the hub VNet (inbound endpoint `10.0.9.4`). The hub VNet's custom DNS points
   at it, and the VPN gateway **auto-pushes that DNS server to your client** in the
   downloaded profile. The resolver answers from every `privatelink.*` zone linked
   to the hub VNet (admin-plane **and** the DLZ Databricks zone) and forwards public
   names to Azure DNS — so the normal service FQDNs (`*.azuredatabricks.net`,
   `*.documents.azure.com`, `*.sql.azuresynapse.net`, `web.azuresynapse.net`, …)
   resolve to their private IPs over the tunnel with **no host-file edit needed**.

   > **If you set up the VPN before this was in place, re-download the VPN client
   > config** (step 2) and re-import it — the profile must carry the new DNS server
   > (`10.0.9.4`). Reconnect afterward.

   > **Browser "Secure DNS" (DNS-over-HTTPS) bypasses all OS/VPN DNS.** If pages
   > still resolve to public IPs after reconnecting, turn it off: Edge
   > `edge://settings/privacy` → *Use secure DNS* → **off**; Chrome
   > `chrome://settings/security` → *Use secure DNS* → **off**. Then fully restart
   > the browser.
   - *Fallback / air-gapped resolver:* the admin page still publishes a copy/paste
     **hosts-file block** (FQDN → private IP) if you'd rather pin entries in
     `C:\Windows\System32\drivers\etc\hosts` or `/etc/hosts`.

Now you can reach the backends over the tunnel — e.g. Synapse Studio
(`web.azuresynapse.net`), the Databricks workspace, AI Search, Cosmos, Key Vault,
Storage, and the Internal APIM gateway (`apim-…azure-api.net`).

## How each class of service is reached

| Class | Services | How it works over VPN |
|---|---|---|
| **Private endpoint** | Cosmos, Synapse, ADLS/Blob, Event Hubs, ADF, Key Vault, (console) | Routed via the PE private IP through the tunnel; hosts-file/private-DNS resolves the FQDN. Firewall is bypassed by the PE — no IP rule needed. |
| **Internal VNet** | API Management (Internal) | Reached via its private gateway IP (`azure-api.net` private DNS zone is VNet-linked). |
| **Firewall / IP-ACL (no PE)** | Databricks workspace, AI Search (if IP-rule) | Two options: (a) add a **front-end private endpoint** (then it behaves like the PE row — recommended), or (b) allow the gateway's **egress public IP** in the service's IP access list and force-tunnel. The P2S *client pool* (`172.16.201.x`, private) is NOT the source IP these public endpoints see, so a client-pool IP rule alone won't admit them. |

> **Databricks note:** the workspace currently has no front-end private endpoint,
> so reaching it over VPN needs option (b) above, or adding a Databricks
> front-end PE (`privatelink.azuredatabricks.net`). Until then, run one-off admin
> SQL (e.g. the Delta Sharing `GRANT`s) from a host whose public IP is on the
> workspace IP access list.

## Firewall — why there's no "add the VPN subnet" IP rule

A common ask is *"add the VPN client subnet to every firewall."* **Azure rejects
that** — service firewall **IP rules only accept public IPs**; the P2S client
pool (`172.16.201.0/24`) is RFC-1918 private and is refused
(`overlaps with private or reserved IPs`). So the reachability model is **not**
IP rules — it's:

- **Private-endpoint services** (Cosmos, Synapse, Storage, ADLS, Event Hubs,
  ADF, Key Vault, AI Search, ACR — all `publicNetworkAccess = Disabled`):
  reached over the tunnel via the PE private IP. The PE **bypasses** the firewall
  entirely, so no IP rule is needed — just routing (gateway transit, done) +
  name resolution (hosts-file / private DNS).
- **Public-endpoint + IP-ACL services without a PE** (e.g. the Databricks
  workspace): give them a **front-end private endpoint** (then they join the row
  above), or **force-tunnel** the VPN and allow the gateway's **egress public IP**
  in their IP access list. The private client-pool can't be the source for a
  public endpoint.

Net: once connected + hosts-file in place, every private-endpoint service is
reachable; the only extra step is a front-end PE for any IP-ACL-only service.
