# powerplatform-environment — parity with the Power Platform admin center

Source UI: Power Platform admin center (`admin.powerplatform.microsoft.com → Environments`).
Learn: <https://learn.microsoft.com/power-platform/admin/environments-overview>

## Feature inventory

1. List environments (display name, SKU, state, location, default).
2. Environment detail (Dataverse domain, instance URL, capacity, security group).
3. Create / delete environment — admin-center-only.

## Loom coverage

| Row | Status | Notes |
| --- | --- | --- |
| List | built ✅ | BAP admin environments |
| Detail | built ✅ | metadata grid (SKU, state, location, default, Dataverse domain, instance URL) |
| Create/delete | honest-gate ⚠️ | MessageBar + admin-center deep-link (provisioning is out-of-band) |

Capacity/security-group/DLP fields show when the SP holds the Power Platform Admins role (honest "—" otherwise).

## Backend per control

- List → `listEnvironments`; Detail → `getEnvironment` (BAP admin API).
