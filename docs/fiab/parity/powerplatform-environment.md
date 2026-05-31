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

---

## Environment navigator — parity wave 11 (left-pane Tree)

Source UI: Power Platform admin center + `make.powerapps.com` left rail —
Environments → Apps / Cloud flows / Connections / Connectors / Tables.
Learn:

- Environments: <https://learn.microsoft.com/power-platform/admin/environments-overview>
- List environments (BAP): <https://learn.microsoft.com/power-platform/admin/list-environments>
- Programmability auth (SP allow group): <https://learn.microsoft.com/power-platform/admin/programmability-authentication>
- Power Apps / Power Automate admin (connections, connectors, DLP): <https://learn.microsoft.com/power-platform/admin/powerapps-powershell>
- Dataverse Web API (EntityDefinitions): <https://learn.microsoft.com/power-apps/developer/data-platform/webapi/overview>
- DLP data policies: <https://learn.microsoft.com/power-platform/admin/wp-data-loss-prevention>

Component: `lib/components/powerplatform/powerplatform-tree.tsx`. Wired as the
`leftPanel` of `PowerPlatformEnvironmentEditor`. Lazily loads each
environment's content on expand.

### Feature inventory (admin centre / maker left rail)

1. Environments tree (display name, SKU, default badge) — open admin-centre hub.
2. Apps in an environment (canvas / model-driven) — open in editor/maker, delete.
3. Cloud flows — turn on / off, open, delete.
4. Connections (API connections under Dataverse → Connections) — manage, delete.
5. Connectors (built-in + custom; custom flagged) — manage / author in maker.
6. Dataverse tables (custom + key system) — open in maker/editor.
7. Solutions / ALM import.
8. DLP data policies (tenant governance).
9. New app / new flow / new custom connector / new environment authoring.

### Loom coverage

| Row | Status | Notes |
| --- | --- | --- |
| Environments tree | built ✅ | `/api/powerplatform/environments` (BAP admin), live, filter, admin-hub deep-link |
| Apps | built ✅ | `/api/powerplatform/apps` — list + open (editor/maker) + **delete** (real REST) |
| Cloud flows | built ✅ | `/api/powerplatform/flows` — list + **turn on/off** + **delete** (real REST) |
| Connections | built ✅ | `/api/powerplatform/connections` — list + **delete** (real REST) |
| Connectors | built ✅ | `/api/powerplatform/connectors` — list, custom flagged; authoring → maker |
| Dataverse tables | built ✅ / honest-gate ⚠️ | `/api/powerplatform/tables` — list; **sub-gate** when `LOOM_DATAVERSE_CLIENT_ID/_SECRET` unset (UAMI tokens aren't valid Dataverse Application Users) |
| New app / flow / connector / table | honest-route ⚠️ | maker portal deep-link (`make.powerapps.com` / `make.powerautomate.com`) — authoring is the real maker surface, not faked |
| New environment | honest-route ⚠️ | admin-centre deep-link (provisioning is out-of-band) |
| Solutions / import | honest-gate ⚠️ | maker-portal deep-link row; Dataverse `solutions` is already read in `listSolutions` — dedicated navigator group tracked for follow-up |
| DLP data policies | honest-gate ⚠️ | admin-centre deep-link row; needs the **Power Platform Administrator** role (BAP `providers/PowerPlatform.Governance` policies) — distinct from the "use Power Platform APIs" allow group; governance navigator tracked for follow-up |

Zero ❌. Zero dead buttons — every control either calls real REST or honestly
opens the real maker/admin surface.

### Backend per control

| Control | Client fn | REST |
| --- | --- | --- |
| Environments | `listEnvironments` | `GET api.bap.microsoft.com/.../scopes/admin/environments` (scope `api.bap.microsoft.com/.default`) |
| Apps list / delete | `listPowerApps` / `deletePowerApp` | `GET\|DELETE api.powerapps.com/.../scopes/admin/environments/{env}/apps` (scope `service.powerapps.com/.default`) |
| Flows list / start / stop / delete | `listFlows` / `setFlowState` / `deleteFlow` | `api.flow.microsoft.com/.../scopes/admin/environments/{env}/flows[/start\|/stop]` (scope `service.flow.microsoft.com/.default`) |
| Connections list / delete | `listConnections` / `deleteConnection` | `api.powerapps.com/.../scopes/admin/environments/{env}/connections` |
| Connectors list | `listConnectors` | `api.powerapps.com/.../scopes/admin/environments/{env}/apis` |
| Tables list | `listTables` | `GET <org>.crm.dynamics.com/api/data/v9.2/EntityDefinitions` (scope `<org-url>/.default`) |

### Auth reachability (be honest)

- **BAP / Power Apps / Power Automate control plane** — reachable with the
  Console **UAMI** (`LOOM_UAMI_CLIENT_ID`) once its SP is added to the
  **"Service principals can use Power Platform APIs"** allow group (tenant
  setting). Honest gate: missing `LOOM_UAMI_CLIENT_ID` → 503 `not_configured`.
- **Dataverse Web API (tables)** — **NOT reachable with the UAMI**. Dataverse
  refuses UAMI-issued tokens because a managed identity can't be a Dataverse
  Application User. Requires a dedicated MSAL Web-App SP
  (`LOOM_DATAVERSE_CLIENT_ID` / `_CLIENT_SECRET` / `_TENANT_ID`) registered as
  an **Application User** with the System Administrator security role on each
  environment. Honest **sub-gate** row in the Tables group (the rest of the
  tree still works).
- **DLP data policies** — need the **Power Platform Administrator** directory
  role, which is a *higher* privilege than the API allow group. Honest-gated as
  a "needs admin role" row deep-linking the admin centre rather than faked.
