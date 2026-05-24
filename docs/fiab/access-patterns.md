---
title: CSA Loom — Console access patterns
date: 2026-05-24
---

# Console access patterns

The Container Apps env is **internal-only** (no public IP, env LB
private in the hub VNet). Five reachability patterns are now wired
into Bicep — pick what matches the deploy.

| # | Pattern | Public? | Flag | Cost / mo | Provision time | Best for |
|---|---|---|---|---|---|---|
| 1 | Bastion → jumpbox → browser | ❌ | always-on | ~$140 (Standard SKU + 1 D2as VM) | already deployed | Federal admin, ATO scope, "no public surface" requirement |
| 2 | P2S VPN Gateway (AAD auth, OpenVPN) | ❌ | `vpnGatewayEnabled` | ~$30 (VpnGw1) + per-conn | 30-45 min | Power users on laptops who don't want Bastion every time |
| 3 | App Gateway v2 + WAF | ✅ | `appGatewayEnabled` | ~$250 | 15-20 min | Single-region public Console, WAF required, App Gateway already standard in environment |
| 4 | Front Door Premium + Private Link to ACA | ✅ | `frontDoorEnabled` | ~$330 | 5-10 min + manual PE approval | Multi-region, global edge, managed cert, best UX |
| 5 | Custom domain on the env | either | (custom-domain Bicep, separate) | $0 extra | minutes | Vanity URL on any of the above |

Bastion (#1) is always provisioned by `network.bicep`. The other three
are gated by flags on the top-level `main.bicep`:

```bash
az deployment sub create \
  --name csa-loom-access-patterns \
  --location eastus2 \
  --template-file platform/fiab/bicep/main.bicep \
  --parameters platform/fiab/bicep/params/commercial.bicepparam \
  --parameters deployAppsEnabled=true \
  --parameters vpnGatewayEnabled=true \
  --parameters appGatewayEnabled=true \
  --parameters frontDoorEnabled=true
```

After the deploy, the relevant outputs surface the public/private
entry points:

```bash
az deployment sub show --name csa-loom-access-patterns \
  --query "properties.outputs.{
    vpnPublicIp:    vpnGatewayPublicIp.value,
    agwPublicFqdn:  appGatewayPublicFqdn.value,
    frontDoorUrl:   frontDoorPublicUrl.value
  }"
```

## #1 Bastion → jumpbox

The hub VNet ships with `AzureBastionSubnet` (10.0.1.0/26) + a
Standard Bastion host (`bastion-csa-loom-<region>`). The UAT jumpbox
(`loom-uat-jumpbox`, AAD-SSH only, no local password) gets you into
the VNet from any browser. From there, `https://loom-console.<env-domain>`
just works.

This is the **federal default** — no public surface to ATO.

## #2 P2S VPN Gateway

`vpn-gateway.bicep` deploys a VpnGw1 (Standard SKU) into the new
`GatewaySubnet` (10.0.7.0/27), authenticated against Entra (Azure AD).
Admins install the [Azure VPN Client](https://learn.microsoft.com/azure/vpn-gateway/openvpn-azure-ad-client) on their laptop, sign in with
their Entra account, and the laptop joins the hub VNet at
172.16.201.0/24 (configurable). Console URL loads directly in their
laptop browser.

Provisioning is **slow** (30-45 min) — Azure VNet Gateways are not fast
resources. Cost is ~$30/mo idle + $0.04/connection-hour.

## #3 App Gateway v2 + WAF

`app-gateway.bicep` deploys WAF_v2 with OWASP 3.2 + Bot Manager rules.
Backend pool points at the ACA env's static IP (10.0.2.85) with a
Host header override so the env routes to the Console app. Public IP
gets a DNS label `loom-<hash>.eastus2.cloudapp.azure.com` — operator
points a custom CNAME at it if they want a real hostname.

App Gateway sits in the new `snet-appgw` subnet (10.0.8.0/24). Cost
~$250/mo. Provisions in ~15-20 min.

## #4 Front Door Premium + Private Link

`front-door.bicep` deploys the Premium SKU and creates a Private Link
shared resource pointing at the Container Apps env. **The first deploy
leaves the PE request in a pending state on the env** — operator must
go to *Container Apps env → Network → Private endpoint connections*
and click **Approve**. After that, traffic flows from any FD edge POP
through the private link into the env's internal LB — no public ACA
exposure.

Public URL surfaces as `https://loom-console-<hash>.z01.azurefd.net`
(or whatever custom domain you bind). Managed cert is free.

## #5 Custom domains

Not in this PR — covered by a separate `custom-domains.bicep` already
in the backlog. Works in front of any of #1-4. For #3 (App Gateway)
or #4 (Front Door), bind the custom hostname on the listener / route
and upload a cert (or use the managed cert on FD).

## Recommended combinations

- **Commercial pilot**: Bastion + Front Door Premium (#1 + #4). Front Door for end users, Bastion for ops.
- **GCC / GCC-High**: Bastion + VPN Gateway (#1 + #2). Front Door isn't in Gov boundaries yet; App Gateway works but has no Private Link to ACA in Gov regions (uses public IP path with NSG restriction).
- **IL5**: Bastion only (#1). Public ingress is generally out of scope; sideline App Gateway in a separate ATO scope if a public surface is required.
- **Dev / sandbox**: Bastion + VPN (#1 + #2). Cheap, fast.

## Notes on routing

Front Door's Private Link path requires the Container Apps env to
allow PE connections (`vnetConfiguration.internal: true` envs do
support this in Commercial as of 2024-11; verify support in your
boundary's API version before turning the flag on).

App Gateway's backend pool uses the env's **internal IP**; the env's
Envoy proxy will receive the request, look at the Host header, and
route to the Console app. Because the Console is **external ingress**
(by Bicep default since PR #328), the env accepts the request even
though it's coming from an in-VNet origin.

VPN clients get a `172.16.201.0/24` IP (configurable via the
`vpnClientAddressPool` parameter on `vpn-gateway.bicep`). DNS over the
tunnel works via the hub VNet's DNS resolver — no extra config needed
if you've already linked the env's private DNS zone to the hub VNet.
