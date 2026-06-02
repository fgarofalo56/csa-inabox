# Networking & Private DNS — reaching Loom's Azure services directly

CSA Loom deploys its backing Azure services (Synapse, SQL, Storage/ADLS, Key
Vault, ACR, AI Search, Azure OpenAI / AI Foundry, Cosmos, Event Hubs, ADF,
Container Apps, etc.) with **`publicNetworkAccess` disabled** and a **private
endpoint** + **private DNS zone** for each. The console reaches them privately
because the `privatelink.*` zones are linked to the hub VNet it runs in.

This guide covers how a **developer or operator** reaches those same services
**directly** — Synapse Studio, SSMS/`sqlcmd`, Storage Explorer, `az` / REST —
from a workstation on the corporate VPN, without re-enabling public access.

> In the console: **Network & DNS** (left nav) renders the live private-endpoint
> inventory, a copy/paste hosts-file block, and the enterprise-DNS guidance
> below, populated from your deployment via ARM.

## The model

A private endpoint gives the service a **private IP** in the VNet and a DNS
record in a `privatelink.<service>` zone. Clients keep using the **public FQDN**
(e.g. `myws.sql.azuresynapse.net`); a CNAME points it at the `privatelink` zone,
which resolves to the private IP. So the only thing a remote client needs is for
**DNS to return the private IP** for those FQDNs — the network path is the VPN /
ExpressRoute.

## Option 1 — Local hosts-file override (single developer, quick)

The **Network & DNS** page emits a ready block:

```
# CSA Loom — Azure private endpoints (dev hosts override)
10.x.x.x   myws.dev.azuresynapse.net
10.x.x.x   myws.sql.azuresynapse.net
10.x.x.x   myacct.blob.core.windows.net
...
```

Paste into `C:\Windows\System32\drivers\etc\hosts` (Windows, elevated) or
`/etc/hosts` (macOS/Linux) **while on the VPN**. Stop-gap only: it's per-machine,
has no wildcard support, and breaks if a private endpoint is re-created (the IP
changes). For anything shared, use Option 2.

## Option 2 — Enterprise DNS (recommended, everyone)

Make corporate DNS resolve every Azure private-link domain to the private IPs.

### 2a · Azure DNS Private Resolver + conditional forwarders (recommended)

1. Deploy an **Azure DNS Private Resolver** with an **inbound endpoint** in the
   hub VNet (the VNet the `privatelink.*` zones are linked to). Note its inbound
   IP.
2. Confirm every `privatelink.*` zone is linked to that VNet — Loom's bicep
   (`platform/fiab/bicep/modules/admin-plane/network.bicep`) already links them
   to the hub.
3. On corporate DNS (Windows DNS / Infoblox / BIND / Azure Firewall DNS proxy),
   add a **conditional forwarder** for each public parent domain → the resolver
   inbound IP. The page lists the exact domains, e.g.:
   - `dev.azuresynapse.net`, `sql.azuresynapse.net`
   - `blob.core.windows.net`, `dfs.core.windows.net`
   - `vaultcore.azure.net`, `azurecr.io`, `search.windows.net`
   - `documents.azure.com`, `servicebus.windows.net`, `cognitiveservices.azure.com`,
     `openai.azure.com`, `adf.azure.com`, … (Gov uses the `.us` variants)
4. Route the resolver inbound IP over the VPN/ExpressRoute so on-prem clients
   reach it.

Queries for any `*.privatelink.*` then resolve to the private IPs automatically —
no per-record maintenance.

### 2b · Host the zones on-prem (no resolver)

Create each `privatelink.*` zone on your own DNS and add the A records from the
inventory. Works, but you own every record and must update them on PE changes —
prefer 2a.

## VPN client notes

- Use a VPN that **pushes corporate DNS** (or the resolver inbound IP) to
  clients so split-tunnel DNS resolves `*.privatelink.*` privately.
- If split-tunneling, include the private-endpoint subnet ranges and the
  resolver IP in the tunnel routes.
- Verify: `nslookup <service-fqdn>` must return the **private** IP (10.x), not a
  public one. On Windows, `Resolve-DnsName <fqdn>` shows the CNAME chain ending
  at the `privatelink` zone.

## Synapse (public access disabled)

The Synapse workspace runs `publicNetworkAccess: Disabled` with private endpoints
for its **Dev** (`*.dev.azuresynapse.net` — Studio + artifact REST), **SQL**
(dedicated pools) and **SqlOnDemand** (serverless) sub-resources, registered in
`privatelink.dev.azuresynapse.net` / `privatelink.sql.azuresynapse.net` (linked
to the hub VNet).

**This does not break the Synapse-backed Loom apps.** The console resolves those
FQDNs through the hub-linked zones and authors/runs pipelines privately. Pipeline
problems seen in apps were artifact-commit issues (long-running PUT not awaited /
unresolved dataset references), not connectivity. *Synapse Link* (HTAP for
Cosmos/SQL/Dataverse) is unrelated — what matters here, **Private Link**, is
already configured. To open Synapse Studio yourself, add the two `azuresynapse`
hosts entries (or the conditional forwarders) and browse `web.azuresynapse.net`
on the VPN.

## Bicep references

- Private DNS zones + hub VNet links: `platform/fiab/bicep/modules/admin-plane/network.bicep`
- Synapse PEs + DNS zone groups: `platform/fiab/bicep/modules/landing-zone/synapse.bicep`
- Per-service PEs: the `*.bicep` modules under `admin-plane/` and `landing-zone/`

## Permissions

The **Network & DNS** inventory reads `Microsoft.Network/privateEndpoints` via
the Console identity (UAMI). It needs **Reader** on the subscription (or the RGs
holding the endpoints). Without it the page shows a warning naming the exact
role to grant; the enterprise-DNS guidance still renders (it's
deployment-independent).
