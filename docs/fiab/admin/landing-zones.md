# Landing zones admin page

> **Surface:** `/admin/landing-zones` (+ the `/admin/add-landing-zone` attach flow)
> **Stores:** Cosmos `landing-zones` + `attached-services` + `tenant-topology` (PK `/tenantId`)

The **Landing zones** page shows, visualizes and manages every Data Landing Zone
(DLZ) attached to your hub, and attaches new ones via the **dlz-attach** flow. An
attached zone inherits the hub's boundary, region and coordinates — a second
Console can **not** be deployed from here; this is about federating data estates
into one hub, not standing up parallel control planes.

## What you can do

- **See & visualize** — every DLZ attached to the hub, its region, and the Azure
  services registered under it.
- **Attach a landing zone** — the `add-landing-zone` wizard runs dlz-attach:
  discover an existing zone's services (via Resource Graph) or register a
  lightweight logical zone, then bind them to the hub.
- **Manage** — review the services each zone contributes and their governance
  state.

## Backend

| Control | Backend |
|---|---|
| Logical zones | Cosmos `landing-zones` (PK `/tenantId`) |
| Attached services | Cosmos `attached-services` (PK `/tenantId`) — the convergence point for BYO + attach |
| Hub coordinates | Cosmos `tenant-topology` (read so coordinates are never free-typed) |
| Discovery | Azure Resource Graph over the target subscription |

## RBAC & honest gates

Tenant-admin, with the Console UAMI holding **Reader** on the target
subscription for discovery. A zone whose services aren't reachable is recorded
with an honest gate rather than assumed healthy.

## Related

- [Workspaces](workspaces.md) · [Deployment planner](deploy-planner.md)
