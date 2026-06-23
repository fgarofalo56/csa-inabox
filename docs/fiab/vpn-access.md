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
5. DNS resolution — use the **hosts-file block** from the admin page. Copy the
   block under **Admin → Network & DNS** (every private-endpoint FQDN → its private
   IP) into `C:\Windows\System32\drivers\etc\hosts` (open the editor as admin) or
   `/etc/hosts`. Then the service FQDNs (`*.azuredatabricks.net`,
   `*.documents.azure.com`, `*.sql.azuresynapse.net`, `web.azuresynapse.net`, …)
   resolve to their private IPs over the tunnel.

   > **Browser "Secure DNS" (DNS-over-HTTPS) bypasses the OS hosts file.** If pages
   > still resolve to public IPs, turn it off: Edge `edge://settings/privacy` →
   > *Use secure DNS* → **off**; Chrome `chrome://settings/security` → same; then
   > fully restart the browser.

   > **Note:** an Azure DNS Private Resolver exists in the hub VNet, but it is **not**
   > wired as the VNet DNS — pushing resolver-based DNS to clients also forced the
   > in-VNet Console onto it, where it proved intermittent for recursive
   > public→private (AI Services) lookups. The hub VNet stays on Azure-default DNS;
   > clients use the hosts-file block above. Auto-push DNS can be revisited once the
   > resolver flakiness is root-caused.

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
