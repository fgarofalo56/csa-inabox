# Network / Private DNS (admin)

> **Surface:** `/admin/network` (`apps/fiab-console/app/admin/network/page.tsx`)
> **BFF route:** `GET /api/network/private-endpoints`
> **Client:** `apps/fiab-console/lib/azure/network-discovery.ts`

## Purpose

The CSA Loom DLZ runs Azure data services with **public network access
disabled** — they're reachable only over private endpoints on the spoke VNet.
This admin page helps a developer on the VPN reach those (Synapse, Storage,
Cosmos, ADX, Key Vault, etc.) by surfacing, from **real ARM**:

- every **private endpoint** the Console identity can read, with its
  `FQDN → private IP → privatelink zone` mapping;
- the authoritative `FQDN → IP` A-records from the discovered **private DNS
  zones** (covers private-only services that didn't echo an IP);
- the **virtual networks / subnets** for the topology view;
- a **ready-to-paste hosts-file block** and the de-duplicated set of
  **privatelink zones** the enterprise DNS must resolve.

## Real backend

`GET /api/network/private-endpoints` → `network-discovery.ts`:
`listPrivateEndpoints` + `listPrivateDnsZones` + `listVirtualNetworks` +
`buildHostsBlock`. DNS zones / vNets are best-effort — a missing Reader on those
scopes degrades the topology but never blanks the private-endpoint list.

## Honest gate

When the identity can't enumerate subscriptions or read private endpoints, the
route returns `ok:false` with the exact **Reader** role to grant; the page shows
a warning MessageBar rather than a blank table (per `no-vaporware.md`).
