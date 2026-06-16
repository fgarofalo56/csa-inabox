/**
 * Multi-Agency Onboarding — app-install content bundle.
 *
 * Reproduces the operational + governance analytics estate behind the
 * "Multi-Agency Onboarding" use case (docs/fiab/use-cases/multi-agency-onboarding.md
 * and its sibling docs/fiab/use-cases/federal-data-mesh.md): a federal
 * department onboarding additional agencies as Data Landing Zones (DLZs)
 * under a central Loom Admin Plane governance plane.
 *
 * Every object the runbook calls out has a home here:
 *   - Setup-Wizard "Add Data Landing Zone" interview  → DlzOnboardingRegistry
 *     warehouse (agencies, subscriptions, VNet peerings, capacity SKUs,
 *     Domain-Steward groups, onboarding task checklist).
 *   - PIM-for-Groups activation + Bicep submit + ARG inventory + smoke test
 *     → "DLZ Onboarding Orchestrator" notebook (real Microsoft Graph
 *     privilegedAccess/group eligibility-schedule calls, az deployment sub
 *     create, Azure Resource Graph subscription/peering inventory).
 *   - The provisioning + post-deploy validation flow → "DLZ Provision +
 *     Validate" data-pipeline (Web/ARM activities + peering + catalog-scan
 *     register + smoke-test).
 *   - Federation governance lake (cross-domain Marketplace data products,
 *     Delta-Sharing access grants, catalog-scan registrations, audit
 *     events) → FederationGovernance lakehouse delta tables.
 *   - Onboarding + federation telemetry (deployment events, PIM
 *     activations, peering state, smoke-test results) → OnboardingTelemetry
 *     KQL database with helper functions + analyst queries.
 *   - Department-CIO cockpit → Federation Governance semantic model + the
 *     "Multi-Agency Onboarding Cockpit" report.
 *   - Stalled-deployment / failed-peering alerting → "DLZ Deployment
 *     Health" Activator rule.
 *
 * All Azure/Graph details are grounded in Microsoft Learn:
 *   - PIM for Groups eligibility-schedule requests (Graph
 *     /identityGovernance/privilegedAccess/group/...): https://learn.microsoft.com/graph/api/resources/privilegedidentitymanagement-for-groups-api-overview
 *   - VNet peering across subscriptions
 *     (Microsoft.Network/virtualNetworks/virtualNetworkPeerings): https://learn.microsoft.com/azure/virtual-network/create-peering-different-subscriptions
 *   - Azure Resource Graph subscription/VNet inventory (resourcecontainers,
 *     Resources): https://learn.microsoft.com/azure/governance/resource-graph/samples/starter
 *
 * itemTypes used all exist in lib/editors/registry.ts. Provisioner status:
 *   warehouse ✅, lakehouse ✅, kql-database ✅, notebook ✅,
 *   data-pipeline ✅, semantic-model ✅, activator ✅. The `report` item
 *   has an editor but no Phase-2 provisioner yet (verify pass will flag
 *   the gap); it is included for use-case completeness.
 */

import type { AppBundle } from './types';
import type { NotebookCell } from '@/lib/types/notebook-cell';
import { armBase } from '@/lib/azure/cloud-endpoints';

// ─── Warehouse: DLZ Onboarding Registry ─────────────────────────────────
// Operational system-of-record for the onboarding workflow the Setup
// Wizard drives. Each prerequisite + procedure + validation row from the
// runbook becomes a column/table. Seeded with three sample agencies
// (Mission Operations live, Field Services in-flight, Inspector General
// queued) so the registry renders with real rows on first open.

// IDEMPOTENT by construction: this DDL is split on ';\\n' and each batch is
// run independently by warehouse.ts; it must survive re-install AND a shared
// dedicated-pool backing (another DLZ app may already own the `onboarding`
// schema). T-SQL has no CREATE SCHEMA/TABLE IF NOT EXISTS, so:
//   - CREATE SCHEMA is guarded by sys.schemas + run via EXEC() so it executes
//     in its own batch (Microsoft Learn: "You must execute this statement as
//     a separate batch"). https://learn.microsoft.com/sql/t-sql/statements/create-schema-transact-sql
//   - Each CREATE TABLE is guarded by IF OBJECT_ID(..,'U') IS NULL BEGIN..END.
//   - Each seed INSERT is guarded by IF NOT EXISTS so re-install never double-seeds.
const WAREHOUSE_DDL = `-- DLZ Onboarding Registry — operational system-of-record for the
-- Multi-Agency Onboarding Setup-Wizard workflow (single Entra tenant,
-- one row per onboarded / in-flight / queued agency DLZ). Idempotent.

IF NOT EXISTS (SELECT 1 FROM sys.schemas WHERE name = 'onboarding')
    EXEC('CREATE SCHEMA onboarding');
GO

-- Departments owning an Admin Plane (the central governance plane).
IF OBJECT_ID(N'onboarding.Department', N'U') IS NULL
BEGIN
CREATE TABLE onboarding.Department (
    DepartmentId        INT            NOT NULL,
    DepartmentName      VARCHAR(128)   NOT NULL,
    EntraTenantId       VARCHAR(36)    NOT NULL,   -- single tenant for all subs (v1 constraint)
    AdminPlaneSubId     VARCHAR(36)    NOT NULL,
    AdminPlaneRegion    VARCHAR(32)    NOT NULL,
    CloudBoundary       VARCHAR(24)    NOT NULL,   -- commercial | gcc-high | il5
    DeploymentMode      VARCHAR(16)    NOT NULL,   -- single-sub | multi-sub
    DepartmentCdoEmail  VARCHAR(256)   NULL,
    CONSTRAINT PK_Department PRIMARY KEY NONCLUSTERED (DepartmentId) NOT ENFORCED
)
END;
GO

-- One row per agency DLZ being onboarded under a Department.
IF OBJECT_ID(N'onboarding.AgencyDlz', N'U') IS NULL
BEGIN
CREATE TABLE onboarding.AgencyDlz (
    DlzId                  INT           NOT NULL,
    DepartmentId           INT           NOT NULL,
    AgencyName             VARCHAR(128)  NOT NULL,
    MissionDomain          VARCHAR(128)  NOT NULL,   -- catalog domain tag
    SubscriptionId         VARCHAR(36)   NOT NULL,   -- new per-agency sub
    Region                 VARCHAR(32)   NOT NULL,
    SpokeVnetCidr          VARCHAR(20)   NOT NULL,   -- e.g. 10.20.0.0/16
    CapacitySku            VARCHAR(8)    NOT NULL,   -- F4 | F8 | F32 | F64
    DomainStewardGroupId   VARCHAR(36)   NOT NULL,   -- Entra group object id
    DomainStewardGroupName VARCHAR(128)  NOT NULL,
    WorkspaceIdentityConv  VARCHAR(64)   NOT NULL,   -- naming convention
    OnboardingPattern      VARCHAR(40)   NOT NULL,   -- A-dept-many-agencies | B-joint-program | C-contractor-consortium
    Status                 VARCHAR(24)   NOT NULL,   -- queued | bicep-rendered | deploying | active | failed
    RequestedUtc           DATETIME2     NOT NULL,
    DeployedUtc            DATETIME2     NULL,
    CONSTRAINT PK_AgencyDlz PRIMARY KEY NONCLUSTERED (DlzId) NOT ENFORCED
)
END;
GO

-- Hub<->spoke VNet peering state (Admin Plane hub peered to each DLZ spoke,
-- Microsoft.Network/virtualNetworks/virtualNetworkPeerings, cross-sub same
-- tenant). https://learn.microsoft.com/azure/virtual-network/create-peering-different-subscriptions
IF OBJECT_ID(N'onboarding.VnetPeering', N'U') IS NULL
BEGIN
CREATE TABLE onboarding.VnetPeering (
    PeeringId          INT           NOT NULL,
    DlzId              INT           NOT NULL,
    HubVnetResourceId  VARCHAR(400)  NOT NULL,
    SpokeVnetResourceId VARCHAR(400) NOT NULL,
    PeeringState       VARCHAR(24)   NOT NULL,   -- Initiated | Connected | Disconnected
    AllowForwardedTraffic BIT        NOT NULL,
    UseRemoteGateways  BIT           NOT NULL,
    CheckedUtc         DATETIME2     NOT NULL,
    CONSTRAINT PK_VnetPeering PRIMARY KEY NONCLUSTERED (PeeringId) NOT ENFORCED
)
END;
GO

-- Purview catalog scan registrations created for each DLZ's ADLS accounts
-- (post-deploy validation: "Catalog scans registered for new DLZ").
IF OBJECT_ID(N'onboarding.CatalogScanRegistration', N'U') IS NULL
BEGIN
CREATE TABLE onboarding.CatalogScanRegistration (
    ScanId          INT           NOT NULL,
    DlzId           INT           NOT NULL,
    AdlsAccountName VARCHAR(64)   NOT NULL,
    ScanRuleSet     VARCHAR(64)   NOT NULL,   -- AdlsGen2 | System default
    ScheduleCron    VARCHAR(64)   NOT NULL,
    LastRunUtc      DATETIME2     NULL,
    LastRunStatus   VARCHAR(24)   NULL,       -- Succeeded | Failed | Running
    AssetsDiscovered INT          NULL,
    CONSTRAINT PK_CatalogScan PRIMARY KEY NONCLUSTERED (ScanId) NOT ENFORCED
)
END;
GO

-- The per-DLZ onboarding checklist (mirrors the runbook Procedure +
-- Post-deploy validation + Hand-off steps, one row per step per DLZ).
IF OBJECT_ID(N'onboarding.OnboardingTask', N'U') IS NULL
BEGIN
CREATE TABLE onboarding.OnboardingTask (
    TaskId        INT           NOT NULL,
    DlzId         INT           NOT NULL,
    Phase         VARCHAR(24)   NOT NULL,   -- prerequisite | procedure | validation | handoff
    StepName      VARCHAR(160)  NOT NULL,
    OwnerRole     VARCHAR(64)   NOT NULL,   -- Loom Admin | MCP | Domain Steward | Procurement
    Status        VARCHAR(16)   NOT NULL,   -- todo | doing | done | blocked
    CompletedUtc  DATETIME2     NULL,
    Notes         VARCHAR(400)  NULL,
    CONSTRAINT PK_OnboardingTask PRIMARY KEY NONCLUSTERED (TaskId) NOT ENFORCED
)
END;
GO`;

// ─── Warehouse seed rows (structured) ───────────────────────────────────
// Synapse dedicated SQL pool does NOT support the multi-row table value
// constructor (INSERT … VALUES (..),(..) → "Incorrect syntax near ','";
// Microsoft Learn: "Table value constructor is not supported in Azure
// Synapse Analytics"). The raw embedded INSERTs that used to live in
// WAREHOUSE_DDL are therefore moved here into the structured sampleRows
// mechanism so warehouse.ts emits a backend-correct seed and verifies with
// a COUNT. The provisioner skips tables that already hold rows, so this is
// idempotent across re-install (replaces the old IF NOT EXISTS guards).
//   https://learn.microsoft.com/sql/t-sql/statements/insert-transact-sql#arguments
const WAREHOUSE_SAMPLE_ROWS: { table: string; columns?: string[]; rows: any[][] }[] = [
  {
    table: 'onboarding.Department',
    columns: ['DepartmentId', 'DepartmentName', 'EntraTenantId', 'AdminPlaneSubId', 'AdminPlaneRegion', 'CloudBoundary', 'DeploymentMode', 'DepartmentCdoEmail'],
    rows: [
      [1, 'Department of Mission Affairs', '11111111-1111-1111-1111-111111111111', 'aaaa0000-0000-0000-0000-00000000aaaa', 'usgovvirginia', 'gcc-high', 'multi-sub', 'cdo@mission-affairs.gov'],
    ],
  },
  {
    table: 'onboarding.AgencyDlz',
    columns: ['DlzId', 'DepartmentId', 'AgencyName', 'MissionDomain', 'SubscriptionId', 'Region', 'SpokeVnetCidr', 'CapacitySku', 'DomainStewardGroupId', 'DomainStewardGroupName', 'WorkspaceIdentityConv', 'OnboardingPattern', 'Status', 'RequestedUtc', 'DeployedUtc'],
    rows: [
      [101, 1, 'Mission Operations', 'Mission Operations', 'bbbb1111-1111-1111-1111-1111111111bb', 'usgovvirginia', '10.20.0.0/16', 'F64', 'd1111111-1111-1111-1111-111111111111', 'Stewards-MissionOps', 'mi-${domain}-${workspace}', 'A-dept-many-agencies', 'active', '2026-05-10T13:00:00Z', '2026-05-10T13:34:00Z'],
      [102, 1, 'Field Services', 'Field Services', 'cccc2222-2222-2222-2222-2222222222cc', 'usgovtexas', '10.21.0.0/16', 'F32', 'd2222222-2222-2222-2222-222222222222', 'Stewards-FieldSvc', 'mi-${domain}-${workspace}', 'A-dept-many-agencies', 'deploying', '2026-05-31T09:15:00Z', null],
      [103, 1, 'Inspector General', 'Oversight', 'dddd3333-3333-3333-3333-3333333333dd', 'usgovvirginia', '10.22.0.0/16', 'F8', 'd3333333-3333-3333-3333-333333333333', 'Stewards-IG', 'mi-${domain}-${workspace}', 'B-joint-program', 'queued', '2026-05-31T16:40:00Z', null],
    ],
  },
  {
    table: 'onboarding.VnetPeering',
    columns: ['PeeringId', 'DlzId', 'HubVnetResourceId', 'SpokeVnetResourceId', 'PeeringState', 'AllowForwardedTraffic', 'UseRemoteGateways', 'CheckedUtc'],
    rows: [
      [1, 101, '/subscriptions/aaaa0000-0000-0000-0000-00000000aaaa/resourceGroups/rg-adminplane-hub/providers/Microsoft.Network/virtualNetworks/vnet-hub', '/subscriptions/bbbb1111-1111-1111-1111-1111111111bb/resourceGroups/rg-dlz-missionops/providers/Microsoft.Network/virtualNetworks/vnet-spoke', 'Connected', 1, 1, '2026-05-31T17:00:00Z'],
      [2, 102, '/subscriptions/aaaa0000-0000-0000-0000-00000000aaaa/resourceGroups/rg-adminplane-hub/providers/Microsoft.Network/virtualNetworks/vnet-hub', '/subscriptions/cccc2222-2222-2222-2222-2222222222cc/resourceGroups/rg-dlz-fieldsvc/providers/Microsoft.Network/virtualNetworks/vnet-spoke', 'Initiated', 1, 0, '2026-05-31T17:00:00Z'],
    ],
  },
  {
    table: 'onboarding.CatalogScanRegistration',
    columns: ['ScanId', 'DlzId', 'AdlsAccountName', 'ScanRuleSet', 'ScheduleCron', 'LastRunUtc', 'LastRunStatus', 'AssetsDiscovered'],
    rows: [
      [1, 101, 'stmissionopsbronze', 'AdlsGen2', '0 2 * * *', '2026-05-31T02:00:00Z', 'Succeeded', 1842],
      [2, 101, 'stmissionopsgold', 'AdlsGen2', '0 3 * * *', '2026-05-31T03:00:00Z', 'Succeeded', 311],
      [3, 102, 'stfieldsvcbronze', 'AdlsGen2', '0 2 * * *', null, null, null],
    ],
  },
  {
    table: 'onboarding.OnboardingTask',
    columns: ['TaskId', 'DlzId', 'Phase', 'StepName', 'OwnerRole', 'Status', 'CompletedUtc', 'Notes'],
    rows: [
      [1, 102, 'prerequisite', 'Procure new Azure subscription for agency', 'Procurement', 'done', '2026-05-29T12:00:00Z', 'Sub cccc2222 created under dept tenant'],
      [2, 102, 'prerequisite', 'Confirm single Entra tenant (no cross-tenant multi-sub)', 'Loom Admin', 'done', '2026-05-29T12:10:00Z', 'Tenant 11111111 verified'],
      [3, 102, 'prerequisite', 'Pick non-overlapping /16 CIDR (10.21.0.0/16)', 'Loom Admin', 'done', '2026-05-29T12:20:00Z', 'No overlap with hub 10.0.0.0/16 or 10.20.0.0/16'],
      [4, 102, 'prerequisite', 'Domain Stewards Entra group created', 'Domain Steward', 'done', '2026-05-29T13:00:00Z', 'Stewards-FieldSvc d2222222'],
      [5, 102, 'procedure', 'Setup Wizard: Add Data Landing Zone interview', 'Loom Admin', 'done', '2026-05-31T09:10:00Z', null],
      [6, 102, 'procedure', 'Render + confirm .bicepparam', 'Loom Admin', 'done', '2026-05-31T09:14:00Z', null],
      [7, 102, 'procedure', 'PIM-for-Groups activate Contributor on new sub', 'MCP', 'done', '2026-05-31T09:15:00Z', 'eligibilityScheduleRequest selfActivate 8h'],
      [8, 102, 'procedure', 'Submit Bicep sub deployment (~25-40 min)', 'MCP', 'doing', null, 'az deployment sub create in progress'],
      [9, 102, 'validation', 'New DLZ visible in Workspaces pane', 'Loom Admin', 'todo', null, null],
      [10, 102, 'validation', 'VNet peering hub<->spoke Connected', 'Loom Admin', 'doing', null, 'Peering state Initiated'],
      [11, 102, 'validation', 'Catalog scans registered for DLZ ADLS accounts', 'Loom Admin', 'todo', null, null],
      [12, 102, 'validation', 'Smoke test: create ws, ingest sample, run query', 'Loom Admin', 'todo', null, null],
      [13, 102, 'handoff', 'Add agency-specific Workspace Admin groups', 'Domain Steward', 'todo', null, null],
      [14, 102, 'handoff', 'Set per-agency OAP (Outbound Access Protection) rules', 'Domain Steward', 'todo', null, null],
      [15, 102, 'handoff', 'Document per-agency cost allocation', 'Domain Steward', 'todo', null, null],
    ],
  },
];

// ─── Notebook cells: DLZ Onboarding Orchestrator ────────────────────────
// Real, runnable cells implementing the Setup-Wizard / MCP path:
//   1. render .bicepparam from the interview answers,
//   2. PIM-for-Groups self-activate Contributor on the new sub (Graph),
//   3. submit the Bicep sub deployment,
//   4. ARG inventory of the new sub + peering,
//   5. register Purview catalog scans,
//   6. smoke-test query,
//   7. write the run back to the onboarding registry.

const NB_CELLS: NotebookCell[] = [
  {
    id: 'cell-md-intro',
    type: 'markdown',
    source:
      '# DLZ Onboarding Orchestrator\n\n' +
      'Drives the **Add Data Landing Zone** workflow from the ' +
      '[multi-agency onboarding runbook](../runbooks/dlz-onboard-new-domain.md).\n\n' +
      'Single Entra tenant; one new subscription per agency DLZ. The notebook:\n\n' +
      '1. Renders a `.bicepparam` from the wizard interview answers\n' +
      '2. PIM-for-Groups self-activates **Contributor** on the new sub ' +
      '(Microsoft Graph privilegedAccess/group eligibility-schedule request)\n' +
      '3. Submits the Bicep **subscription** deployment (`az deployment sub create`)\n' +
      '4. Inventories the new sub + hub↔spoke peering via **Azure Resource Graph**\n' +
      '5. Registers Purview **catalog scans** for the DLZ ADLS accounts\n' +
      '6. Runs the **smoke test** and writes the run back to `onboarding.AgencyDlz`\n\n' +
      '> Grounding: [PIM for Groups APIs]' +
      '(https://learn.microsoft.com/graph/api/resources/privilegedidentitymanagement-for-groups-api-overview), ' +
      '[cross-sub VNet peering]' +
      '(https://learn.microsoft.com/azure/virtual-network/create-peering-different-subscriptions), ' +
      '[Azure Resource Graph starter queries]' +
      '(https://learn.microsoft.com/azure/governance/resource-graph/samples/starter).',
  },
  {
    id: 'cell-params',
    type: 'code',
    lang: 'python',
    source:
      '# Wizard interview answers — the six prompts the Setup Wizard collects.\n' +
      '# In Loom these are bound from the wizard form; here they are the\n' +
      '# notebook parameters (override per-agency at run time).\n' +
      'interview = {\n' +
      '    "department_name":        "Department of Mission Affairs",\n' +
      '    "entra_tenant_id":        "11111111-1111-1111-1111-111111111111",\n' +
      '    "target_subscription_id": "cccc2222-2222-2222-2222-2222222222cc",  # new per-agency sub\n' +
      '    "domain_name":            "Field Services",\n' +
      '    "region":                 "usgovtexas",\n' +
      '    "capacity_sku":           "F32",          # F4 | F8 | F32 | F64\n' +
      '    "domain_steward_group_id":"d2222222-2222-2222-2222-222222222222",\n' +
      '    "spoke_vnet_cidr":        "10.21.0.0/16", # next non-overlapping /16\n' +
      '    "workspace_identity_conv":"mi-${domain}-${workspace}",\n' +
      '    "onboarding_pattern":     "A-dept-many-agencies",\n' +
      '}\n' +
      '\n' +
      '# Admin Plane (governance plane) context — read from Loom config.\n' +
      'admin_plane = {\n' +
      '    "subscription_id": "aaaa0000-0000-0000-0000-00000000aaaa",\n' +
      '    "hub_vnet_rid": "/subscriptions/aaaa0000-0000-0000-0000-00000000aaaa/resourceGroups/rg-adminplane-hub/providers/Microsoft.Network/virtualNetworks/vnet-hub",\n' +
      '    "cloud_boundary": "gcc-high",\n' +
      '}\n' +
      'print("Interview ready for", interview["domain_name"], "->", interview["target_subscription_id"])',
  },
  {
    id: 'cell-cidr-check',
    type: 'code',
    lang: 'python',
    source:
      '# Guard against the #1 common issue: VNet CIDR conflict.\n' +
      'import ipaddress\n' +
      '\n' +
      'existing_cidrs = ["10.0.0.0/16", "10.20.0.0/16"]  # hub + already-onboarded spokes\n' +
      'new_net = ipaddress.ip_network(interview["spoke_vnet_cidr"])\n' +
      'overlaps = [c for c in existing_cidrs if new_net.overlaps(ipaddress.ip_network(c))]\n' +
      'assert not overlaps, f"CIDR {new_net} overlaps existing {overlaps} — pick another /16"\n' +
      'print(f"CIDR {new_net} is non-overlapping. OK to proceed.")',
  },
  {
    id: 'cell-bicepparam',
    type: 'code',
    lang: 'python',
    source:
      '# Step 1 — render the .bicepparam the wizard shows for review/confirm.\n' +
      'bicepparam = f"""using \'platform/fiab/bicep/dlz/dlz.bicep\'\n' +
      '\n' +
      'param departmentName       = \'{interview["department_name"]}\'\n' +
      'param entraTenantId        = \'{interview["entra_tenant_id"]}\'\n' +
      'param dlzSubscriptionId    = \'{interview["target_subscription_id"]}\'\n' +
      'param domainName           = \'{interview["domain_name"]}\'\n' +
      'param location             = \'{interview["region"]}\'\n' +
      'param capacitySku          = \'{interview["capacity_sku"]}\'\n' +
      'param domainStewardGroupId = \'{interview["domain_steward_group_id"]}\'\n' +
      'param spokeVnetCidr        = \'{interview["spoke_vnet_cidr"]}\'\n' +
      'param hubVnetResourceId    = \'{admin_plane["hub_vnet_rid"]}\'\n' +
      'param workspaceIdentityConvention = \'{interview["workspace_identity_conv"]}\'\n' +
      'param cloudBoundary        = \'{admin_plane["cloud_boundary"]}\'\n' +
      '"""\n' +
      'print(bicepparam)',
  },
  {
    id: 'cell-pim',
    type: 'code',
    lang: 'python',
    source:
      '# Step 2 — PIM-for-Groups: self-activate Contributor on the new sub.\n' +
      '# The Loom MCP MI is an *eligible* member of the "Loom MCP Operators"\n' +
      '# group which holds an active Contributor assignment on the DLZ sub.\n' +
      '# Activating group membership grants just-in-time Contributor (max 8h).\n' +
      '# Graph: POST /identityGovernance/privilegedAccess/group/eligibilityScheduleRequests\n' +
      '# https://learn.microsoft.com/graph/api/privilegedaccessgroup-post-eligibilityschedulerequests\n' +
      'import os, requests, datetime as dt\n' +
      '\n' +
      'GRAPH = os.environ.get("LOOM_GRAPH_BASE", "https://graph.microsoft.com/v1.0")\n' +
      'token = os.environ["LOOM_GRAPH_TOKEN"]  # MI token, scope GroupMember.ReadWrite.All\n' +
      'MCP_PRINCIPAL_ID = os.environ["LOOM_MCP_PRINCIPAL_ID"]\n' +
      'MCP_OPERATORS_GROUP_ID = os.environ["LOOM_MCP_OPERATORS_GROUP_ID"]\n' +
      '\n' +
      'body = {\n' +
      '    "accessId": "member",\n' +
      '    "principalId": MCP_PRINCIPAL_ID,\n' +
      '    "groupId": MCP_OPERATORS_GROUP_ID,\n' +
      '    "action": "selfActivate",\n' +
      '    "justification": f"Onboard DLZ for {interview[\'domain_name\']} ({interview[\'target_subscription_id\']})",\n' +
      '    "scheduleInfo": {\n' +
      '        "startDateTime": dt.datetime.utcnow().isoformat() + "Z",\n' +
      '        "expiration": {"type": "afterDuration", "duration": "PT8H"},\n' +
      '    },\n' +
      '}\n' +
      'r = requests.post(\n' +
      '    f"{GRAPH}/identityGovernance/privilegedAccess/group/eligibilityScheduleRequests",\n' +
      '    headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},\n' +
      '    json=body, timeout=60)\n' +
      'r.raise_for_status()\n' +
      'print("PIM activation status:", r.json().get("status"))',
  },
  {
    id: 'cell-deploy',
    type: 'code',
    lang: 'python',
    source:
      '# Step 3 — submit the Bicep *subscription* deployment for the DLZ.\n' +
      '# Subscription-scope deployment because a DLZ provisions resource\n' +
      '# groups + spoke VNet + capacity + identities in the new sub.\n' +
      'import json, subprocess, tempfile, pathlib\n' +
      '\n' +
      'param_path = pathlib.Path(tempfile.gettempdir()) / "dlz.bicepparam"\n' +
      'param_path.write_text(bicepparam)\n' +
      '\n' +
      'deploy_name = f"dlz-{interview[\'domain_name\'].lower().replace(\' \', \'-\')}-{dt.datetime.utcnow():%Y%m%d%H%M}"\n' +
      'cmd = [\n' +
      '    "az", "deployment", "sub", "create",\n' +
      '    "--name", deploy_name,\n' +
      '    "--location", interview["region"],\n' +
      '    "--subscription", interview["target_subscription_id"],\n' +
      '    "--template-file", "platform/fiab/bicep/dlz/dlz.bicep",\n' +
      '    "--parameters", str(param_path),\n' +
      '    "--output", "json",\n' +
      ']\n' +
      'print("Submitting:", deploy_name, "(~25-40 min)")\n' +
      'proc = subprocess.run(cmd, capture_output=True, text=True)\n' +
      'if proc.returncode != 0:\n' +
      '    raise RuntimeError(f"az deployment sub create failed:\\n{proc.stderr}")\n' +
      'deployment = json.loads(proc.stdout)\n' +
      'print("Provisioning state:", deployment["properties"]["provisioningState"])',
  },
  {
    id: 'cell-arg-inventory',
    type: 'code',
    lang: 'python',
    source:
      '# Step 4 — Azure Resource Graph inventory of the new sub + peering.\n' +
      '# Confirms the DLZ resources landed and the hub<->spoke peering is\n' +
      '# Connected (post-deploy validation gate).\n' +
      '# https://learn.microsoft.com/azure/governance/resource-graph/samples/starter\n' +
      'arg_token = os.environ["LOOM_ARM_TOKEN"]  # ARM .default scope (sovereign-cloud aware)\n' +
      'ARM = os.environ["LOOM_ARM_BASE"]  # ARM base set by the deploy per cloud (Commercial / Gov)\n' +
      'sub = interview["target_subscription_id"]\n' +
      '\n' +
      'def arg_query(kql: str):\n' +
      '    res = requests.post(\n' +
      '        f"{ARM}/providers/Microsoft.ResourceGraph/resources?api-version=2022-10-01",\n' +
      '        headers={"Authorization": f"Bearer {arg_token}", "Content-Type": "application/json"},\n' +
      '        json={"subscriptions": [sub], "query": kql}, timeout=60)\n' +
      '    res.raise_for_status()\n' +
      '    return res.json()["data"]\n' +
      '\n' +
      '# 4a. spoke VNets + their address space in the new sub\n' +
      'vnets = arg_query(\n' +
      '    "Resources | where type == \'microsoft.network/virtualnetworks\' "\n' +
      '    "| project name, addressSpace=properties.addressSpace.addressPrefixes, resourceGroup, location")\n' +
      'print("Spoke VNets:", vnets)\n' +
      '\n' +
      '# 4b. peering state hub<->spoke\n' +
      'peerings = arg_query(\n' +
      '    "Resources | where type == \'microsoft.network/virtualnetworks/virtualnetworkpeerings\' "\n' +
      '    "| project name, peeringState=properties.peeringState, remoteId=properties.remoteVirtualNetwork.id")\n' +
      'print("Peerings:", peerings)\n' +
      'assert all(p.get("peeringState") == "Connected" for p in peerings), "Peering not yet Connected — re-run validation"',
  },
  {
    id: 'cell-catalog-scan',
    type: 'code',
    lang: 'python',
    source:
      '# Step 5 — register Purview catalog scans for the DLZ ADLS accounts.\n' +
      '# Post-deploy validation: "Catalog scans registered for new DLZ\'s\n' +
      '# ADLS accounts". One scan per (bronze, silver, gold) storage account.\n' +
      'purview = os.environ["LOOM_PURVIEW_ACCOUNT"]  # e.g. pview-missionaffairs\n' +
      'scan_token = os.environ["LOOM_PURVIEW_TOKEN"]  # scope https://purview.azure.net/.default\n' +
      'PURVIEW = f"https://{purview}.purview.azure.com/scan"\n' +
      'data_source = f"adls-{interview[\'domain_name\'].lower().replace(\' \', \'\')}"\n' +
      '\n' +
      'scan_body = {\n' +
      '    "kind": "AdlsGen2Msi",\n' +
      '    "properties": {\n' +
      '        "scanRulesetName": "AdlsGen2",\n' +
      '        "scanRulesetType": "System",\n' +
      '        "collection": {"referenceName": interview["domain_name"], "type": "CollectionReference"},\n' +
      '    },\n' +
      '}\n' +
      'r = requests.put(\n' +
      '    f"{PURVIEW}/datasources/{data_source}/scans/nightly?api-version=2022-07-01-preview",\n' +
      '    headers={"Authorization": f"Bearer {scan_token}", "Content-Type": "application/json"},\n' +
      '    json=scan_body, timeout=60)\n' +
      'r.raise_for_status()\n' +
      'print("Registered catalog scan for", data_source, "->", r.status_code)',
  },
  {
    id: 'cell-smoke-test',
    type: 'code',
    lang: 'pyspark',
    source:
      '# Step 6 — smoke test: create a test workspace, ingest sample data,\n' +
      '# run a query. Proves the freshly-deployed DLZ analytics plane works.\n' +
      'from pyspark.sql import functions as F\n' +
      '\n' +
      'sample = spark.createDataFrame(\n' +
      '    [(1, "alpha", 10.0), (2, "bravo", 20.5), (3, "charlie", 30.25)],\n' +
      '    ["id", "label", "value"],\n' +
      ')\n' +
      'smoke_path = f"Tables/smoke_{interview[\'domain_name\'].lower().replace(\' \', \'_\')}"\n' +
      'sample.write.mode("overwrite").format("delta").save(smoke_path)\n' +
      '\n' +
      'check = spark.read.format("delta").load(smoke_path).agg(\n' +
      '    F.count("*").alias("rows"), F.sum("value").alias("total")\n' +
      ').collect()[0]\n' +
      'assert check["rows"] == 3, "Smoke test failed: unexpected row count"\n' +
      'print(f"Smoke test PASSED — {check[\'rows\']} rows, total={check[\'total\']}")',
  },
  {
    id: 'cell-register',
    type: 'code',
    lang: 'sparksql',
    source:
      '-- Step 7 — write the completed onboarding run back to the registry\n' +
      "-- so the Workspaces pane + cockpit report reflect the new DLZ.\n" +
      'MERGE INTO onboarding.AgencyDlz AS tgt\n' +
      'USING (\n' +
      "    SELECT 102 AS DlzId, 'active' AS Status, current_timestamp() AS DeployedUtc\n" +
      ') AS src\n' +
      'ON tgt.DlzId = src.DlzId\n' +
      'WHEN MATCHED THEN UPDATE SET\n' +
      '    tgt.Status = src.Status,\n' +
      '    tgt.DeployedUtc = src.DeployedUtc;',
  },
];

// ─── Lakehouse: Federation Governance ───────────────────────────────────
// The central governance plane's data: cross-domain Marketplace data
// products, Delta-Sharing access grants, catalog-scan rollups, and the
// audit-event stream Sentinel consumes. Seeded so the lake renders with
// real cross-domain marketplace + grant rows.

const LH_DATAPRODUCTS_DDL = `CREATE TABLE marketplace_data_product (
    product_id        STRING,
    publishing_dlz_id INT,
    publishing_agency STRING,
    product_name      STRING,
    classification    STRING,   -- CUI | Restricted-PII | Restricted-PHI | Internal
    endorsement       STRING,   -- promoted | certified | null
    delta_share_name  STRING,
    description        STRING,
    published_utc      TIMESTAMP
) USING DELTA`;

const LH_GRANTS_DDL = `CREATE TABLE cross_domain_access_grant (
    grant_id            STRING,
    product_id          STRING,
    requesting_dlz_id   INT,
    requesting_agency   STRING,
    use_case            STRING,
    status              STRING,   -- requested | approved | denied | expired
    approver_steward    STRING,
    window_days         INT,
    granted_utc          TIMESTAMP,
    expires_utc          TIMESTAMP
) USING DELTA`;

const LH_AUDIT_DDL = `CREATE TABLE federation_audit_event (
    event_id        STRING,
    event_time      TIMESTAMP,
    actor_upn       STRING,
    actor_dlz_id    INT,
    action          STRING,   -- cross-dlz-read | grant-approve | dlz-onboard | label-violation
    target_product  STRING,
    rows_accessed   BIGINT,
    sensitivity_label STRING,
    sentinel_forwarded BOOLEAN
) USING DELTA`;

const LH_CATALOGSCAN_DDL = `CREATE TABLE dlz_catalog_scan_rollup (
    dlz_id            INT,
    agency            STRING,
    adls_accounts     INT,
    assets_discovered INT,
    classified_assets INT,
    last_scan_utc      TIMESTAMP,
    scan_health       STRING    -- green | yellow | red
) USING DELTA`;

// ─── KQL Database: Onboarding Telemetry ─────────────────────────────────

const KQL_FN_ONBOARDING_DURATION = `// Onboarding duration (minutes) per DLZ from RequestedUtc to the first
// successful 'active' DeploymentEvent. Powers the cockpit SLA tile.
.create-or-alter function onboarding_duration_minutes() {
    DeploymentEvent
    | where event_type in ('requested', 'active', 'failed')
    | summarize
        requested = minif(event_time, event_type == 'requested'),
        completed = minif(event_time, event_type == 'active')
        by dlz_id, agency
    | where isnotnull(completed)
    | extend duration_min = datetime_diff('minute', completed, requested)
    | project dlz_id, agency, requested, completed, duration_min
}`;

const KQL_FN_STALLED = `// DLZ deployments that have been 'deploying' for longer than the SLA
// (default 45 min) without reaching 'active' or 'failed'. Drives the
// Activator alert + cockpit "at-risk onboardings" tile.
.create-or-alter function stalled_deployments(SlaMinutes: long = 45) {
    DeploymentEvent
    | summarize arg_max(event_time, event_type) by dlz_id, agency
    | where event_type == 'deploying'
    | extend stalled_min = datetime_diff('minute', now(), event_time)
    | where stalled_min > SlaMinutes
    | project dlz_id, agency, last_state = event_type, since = event_time, stalled_min
}`;

const KQL_Q_ONBOARD_FUNNEL = `// Onboarding funnel: how many DLZs are in each lifecycle state right now.
DeploymentEvent
| summarize arg_max(event_time, event_type) by dlz_id, agency
| summarize dlz_count = dcount(dlz_id) by current_state = event_type
| order by current_state asc`;

const KQL_Q_PIM_ACTIVATIONS = `// PIM-for-Groups activations in the last 24h, by operator + sub.
// Audit surface for just-in-time Contributor grants on DLZ subs.
PimActivation
| where activated_utc > ago(24h)
| project activated_utc, principal_id, group_name, target_subscription_id,
          duration_hours, justification
| order by activated_utc desc`;

const KQL_Q_PEERING_HEALTH = `// Latest hub<->spoke peering state per DLZ. RED if not Connected.
PeeringState
| summarize arg_max(checked_utc, peering_state) by dlz_id, agency
| extend health = iff(peering_state == 'Connected', 'GREEN', 'RED')
| project dlz_id, agency, peering_state, checked_utc, health
| order by health desc, agency asc`;

const KQL_Q_SMOKE = `// Smoke-test pass/fail history per DLZ (last 7 days). A failed smoke
// test blocks hand-off to the agency Domain Steward.
SmokeTest
| where run_utc > ago(7d)
| summarize
    runs = count(),
    passes = countif(passed == true),
    (last_run, last_passed) = arg_max(run_utc, passed)
    by dlz_id, agency
| extend pass_rate = round(100.0 * passes / runs, 1)
| project dlz_id, agency, runs, pass_rate, last_run, last_passed`;

// ─── Data Pipeline: DLZ Provision + Validate ────────────────────────────

const PIPELINE_ACTIVITIES = [
  {
    name: 'ActivatePimContributor',
    type: 'WebActivity',
    config: {
      url: "@concat(pipeline().parameters.graphBase, '/identityGovernance/privilegedAccess/group/eligibilityScheduleRequests')",
      method: 'POST',
      authentication: { type: 'MSI', resource: 'https://graph.microsoft.com' },
      body: {
        accessId: 'member',
        principalId: '@pipeline().parameters.mcpPrincipalId',
        groupId: '@pipeline().parameters.mcpOperatorsGroupId',
        action: 'selfActivate',
        justification: "@concat('Onboard DLZ ', pipeline().parameters.domainName)",
        scheduleInfo: { expiration: { type: 'afterDuration', duration: 'PT8H' } },
      },
      description:
        'PIM-for-Groups self-activate Contributor on the new DLZ subscription ' +
        '(Microsoft Graph). https://learn.microsoft.com/graph/api/privilegedaccessgroup-post-eligibilityschedulerequests',
    },
  },
  {
    name: 'DeployDlzBicep',
    type: 'WebActivity',
    dependsOn: ['ActivatePimContributor'],
    config: {
      url: "@concat(pipeline().parameters.armBase, '/subscriptions/', pipeline().parameters.dlzSubscriptionId, '/providers/Microsoft.Resources/deployments/', pipeline().parameters.deploymentName, '?api-version=2021-04-01')",
      method: 'PUT',
      authentication: { type: 'MSI', resource: armBase() },
      body: {
        location: '@pipeline().parameters.region',
        properties: {
          mode: 'Incremental',
          templateLink: { uri: '@pipeline().parameters.dlzTemplateUri' },
          parameters: '@pipeline().parameters.dlzParameters',
        },
      },
      description:
        'Subscription-scope ARM deployment of the DLZ (spoke VNet, capacity, ' +
        'identities, ADLS). https://learn.microsoft.com/azure/azure-resource-manager/templates/deploy-to-subscription',
    },
  },
  {
    name: 'WaitForDeployment',
    type: 'UntilActivity',
    dependsOn: ['DeployDlzBicep'],
    config: {
      expression: "@equals(activity('PollDeploymentState').output.properties.provisioningState, 'Succeeded')",
      timeout: '0.01:00:00',
      activities: ['PollDeploymentState'],
      description: 'Poll ARM deployment state every 60s until Succeeded (~25-40 min).',
    },
  },
  {
    name: 'VerifyPeering',
    type: 'WebActivity',
    dependsOn: ['WaitForDeployment'],
    config: {
      url: "@concat(pipeline().parameters.armBase, '/providers/Microsoft.ResourceGraph/resources?api-version=2022-10-01')",
      method: 'POST',
      authentication: { type: 'MSI', resource: armBase() },
      body: {
        subscriptions: ['@pipeline().parameters.dlzSubscriptionId'],
        query:
          "Resources | where type == 'microsoft.network/virtualnetworks/virtualnetworkpeerings' " +
          '| project name, peeringState=properties.peeringState',
      },
      description:
        'Azure Resource Graph check that hub<->spoke peering is Connected. ' +
        'https://learn.microsoft.com/azure/governance/resource-graph/samples/starter',
    },
  },
  {
    name: 'RegisterCatalogScan',
    type: 'WebActivity',
    dependsOn: ['VerifyPeering'],
    config: {
      url: "@concat('https://', pipeline().parameters.purviewAccount, '.purview.azure.com/scan/datasources/', pipeline().parameters.dataSourceName, '/scans/nightly?api-version=2022-07-01-preview')",
      method: 'PUT',
      authentication: { type: 'MSI', resource: 'https://purview.azure.net' },
      body: {
        kind: 'AdlsGen2Msi',
        properties: { scanRulesetName: 'AdlsGen2', scanRulesetType: 'System' },
      },
      description: 'Register a nightly Purview catalog scan for the DLZ ADLS accounts.',
    },
  },
  {
    name: 'RunSmokeTest',
    type: 'TridentNotebook',
    dependsOn: ['RegisterCatalogScan'],
    config: {
      notebookId: 'DLZ Onboarding Orchestrator',
      parameters: { mode: { value: 'smoke-test-only', type: 'string' } },
      description: 'Execute the smoke-test cells of the orchestrator notebook against the new DLZ.',
    },
  },
];

// ─── Semantic Model + Report measures ───────────────────────────────────

const bundle: AppBundle = {
  appId: 'app-multi-agency-onboarding',
  intro:
    '# Multi-Agency Onboarding\n\n' +
    'The operational + governance analytics estate for onboarding additional ' +
    'agencies to a federal department\'s CSA Loom deployment as **Data Landing ' +
    'Zones (DLZs)** under a central Admin Plane — per the ' +
    '[multi-agency onboarding use case](../use-cases/multi-agency-onboarding.md) ' +
    'and the [federal data mesh](../use-cases/federal-data-mesh.md) pattern.\n\n' +
    '**What gets provisioned**\n\n' +
    '- **DLZ Onboarding Registry** (warehouse) — system-of-record for the ' +
    'Setup-Wizard "Add Data Landing Zone" workflow: agencies, per-agency ' +
    'subscriptions, hub↔spoke VNet peerings, capacity SKUs, Domain-Steward ' +
    'groups, and the prerequisite→procedure→validation→hand-off checklist. ' +
    'Seeded with one department + three agency DLZs (live / in-flight / queued).\n' +
    '- **DLZ Onboarding Orchestrator** (notebook) — runnable cells that render ' +
    'the `.bicepparam`, PIM-for-Groups self-activate Contributor on the new ' +
    'sub (Microsoft Graph), submit the Bicep subscription deployment, ' +
    'inventory the sub + peering via Azure Resource Graph, register Purview ' +
    'catalog scans, run the smoke test, and write the run back to the registry.\n' +
    '- **DLZ Provision + Validate** (data pipeline) — the same flow as an ' +
    'orchestrated activity graph (PIM → ARM deploy → poll → peering check → ' +
    'catalog-scan register → smoke test).\n' +
    '- **Federation Governance** (lakehouse) — cross-domain Marketplace data ' +
    'products, Delta-Sharing access grants, catalog-scan rollups, and the ' +
    'Sentinel-bound audit-event stream.\n' +
    '- **Onboarding Telemetry** (KQL database) — deployment events, PIM ' +
    'activations, peering state, and smoke-test results with duration / ' +
    'stalled-deployment functions and analyst queries.\n' +
    '- **Federation Governance Model + Cockpit report** — the Department-CIO ' +
    'cross-DLZ rollup view (onboarding funnel, SLA, peering health, cost share).\n' +
    '- **DLZ Deployment Health** (Activator) — alerts the Loom Admin when a ' +
    'DLZ deployment stalls past the 45-minute SLA.\n\n' +
    '> **Single-tenant constraint (v1):** all subs must live in one Entra ' +
    'tenant. Cross-tenant multi-sub is not supported in v1 — bridge separate ' +
    'tenants via Marketplace + Delta Sharing.',
  sourceDocs: [
    'docs/fiab/use-cases/multi-agency-onboarding.md',
    'docs/fiab/use-cases/federal-data-mesh.md',
    'docs/fiab/runbooks/dlz-onboard-new-domain.md',
  ],
  items: [
    // 1) Onboarding registry — warehouse with seeded sample rows.
    {
      itemType: 'warehouse',
      displayName: 'DLZ Onboarding Registry',
      description:
        'Operational system-of-record for the Setup-Wizard "Add Data Landing ' +
        'Zone" workflow: Department, AgencyDlz, VnetPeering, ' +
        'CatalogScanRegistration, and the OnboardingTask checklist (prereq → ' +
        'procedure → validation → hand-off). Seeded with one department and ' +
        'three agency DLZs at different lifecycle stages.',
      learnDoc: 'fiab/use-cases/multi-agency-onboarding',
      content: {
        kind: 'warehouse',
        ddl: WAREHOUSE_DDL,
        sampleRows: WAREHOUSE_SAMPLE_ROWS,
        starterQueries: [
          {
            name: 'Onboarding funnel (count by status)',
            sql:
              'SELECT Status, COUNT(*) AS dlz_count\n' +
              'FROM onboarding.AgencyDlz\n' +
              'GROUP BY Status\n' +
              'ORDER BY dlz_count DESC;',
          },
          {
            name: 'In-flight onboarding checklist (Field Services)',
            sql:
              'SELECT t.Phase, t.StepName, t.OwnerRole, t.Status, t.Notes\n' +
              'FROM onboarding.OnboardingTask t\n' +
              'JOIN onboarding.AgencyDlz d ON d.DlzId = t.DlzId\n' +
              "WHERE d.AgencyName = 'Field Services'\n" +
              'ORDER BY t.TaskId;',
          },
          {
            name: 'Peering health per DLZ',
            sql:
              'SELECT d.AgencyName, p.PeeringState, p.CheckedUtc\n' +
              'FROM onboarding.VnetPeering p\n' +
              'JOIN onboarding.AgencyDlz d ON d.DlzId = p.DlzId\n' +
              'ORDER BY p.PeeringState ASC;',
          },
          {
            name: 'CIDR allocation map (detect overlaps before onboarding)',
            sql:
              'SELECT AgencyName, SpokeVnetCidr, Region, Status\n' +
              'FROM onboarding.AgencyDlz\n' +
              'ORDER BY SpokeVnetCidr;',
          },
          {
            name: 'Catalog-scan coverage per DLZ',
            sql:
              'SELECT d.AgencyName, COUNT(s.ScanId) AS scans,\n' +
              '       SUM(COALESCE(s.AssetsDiscovered, 0)) AS assets\n' +
              'FROM onboarding.AgencyDlz d\n' +
              'LEFT JOIN onboarding.CatalogScanRegistration s ON s.DlzId = d.DlzId\n' +
              'GROUP BY d.AgencyName\n' +
              'ORDER BY assets DESC;',
          },
        ],
      },
    },

    // 2) Orchestrator notebook — real runnable onboarding logic.
    {
      itemType: 'notebook',
      displayName: 'DLZ Onboarding Orchestrator',
      description:
        'Runnable orchestration of the Add-DLZ workflow: render .bicepparam, ' +
        'PIM-for-Groups self-activate Contributor (Microsoft Graph), submit the ' +
        'Bicep subscription deployment, Azure-Resource-Graph inventory + peering ' +
        'check, register Purview catalog scans, run the smoke test, and write ' +
        'the run back to the onboarding registry.',
      learnDoc: 'fiab/runbooks/dlz-onboard-new-domain',
      content: {
        kind: 'notebook',
        defaultLang: 'pyspark',
        cells: NB_CELLS,
      },
    },

    // 3) Provision + validate pipeline.
    {
      itemType: 'data-pipeline',
      displayName: 'DLZ Provision + Validate',
      description:
        'Orchestrated DLZ provisioning + post-deploy validation: PIM-for-Groups ' +
        'Contributor activation → ARM subscription deployment → poll-until-' +
        'succeeded → Azure-Resource-Graph peering check → Purview catalog-scan ' +
        'registration → smoke-test notebook.',
      learnDoc: 'fiab/runbooks/dlz-onboard-new-domain',
      content: {
        kind: 'adf-pipeline',
        parameters: {
          graphBase: { type: 'string', defaultValue: 'https://graph.microsoft.com/v1.0' },
          armBase: { type: 'string', defaultValue: armBase() },
          dlzSubscriptionId: { type: 'string', defaultValue: 'cccc2222-2222-2222-2222-2222222222cc' },
          domainName: { type: 'string', defaultValue: 'Field Services' },
          region: { type: 'string', defaultValue: 'usgovtexas' },
          deploymentName: { type: 'string', defaultValue: 'dlz-field-services-20260531' },
          dlzTemplateUri: { type: 'string', defaultValue: 'https://raw.githubusercontent.com/example/dlz/main/dlz.json' },
          dlzParameters: { type: 'object', defaultValue: {} },
          mcpPrincipalId: { type: 'string', defaultValue: '00000000-0000-0000-0000-000000000000' },
          mcpOperatorsGroupId: { type: 'string', defaultValue: '00000000-0000-0000-0000-000000000000' },
          purviewAccount: { type: 'string', defaultValue: 'pview-missionaffairs' },
          dataSourceName: { type: 'string', defaultValue: 'adls-fieldservices' },
        },
        activities: PIPELINE_ACTIVITIES,
      },
    },

    // 4) Federation governance lakehouse — seeded delta tables.
    {
      itemType: 'lakehouse',
      displayName: 'Federation Governance',
      description:
        'Central governance-plane data: cross-domain Marketplace data products, ' +
        'Delta-Sharing access grants, per-DLZ catalog-scan rollups, and the ' +
        'Sentinel-bound federation audit-event stream. Seeded with cross-agency ' +
        'marketplace + grant + audit rows.',
      learnDoc: 'fiab/use-cases/federal-data-mesh',
      content: {
        kind: 'lakehouse',
        folders: [
          { path: 'Files/marketplace', description: 'Published cross-domain data product manifests + Delta-Sharing profiles.' },
          { path: 'Files/grants', description: 'Cross-domain access-grant requests + approvals (90-day windows).' },
          { path: 'Files/audit', description: 'Federation audit events forwarded to Sentinel.' },
          { path: 'Files/catalog', description: 'Per-DLZ Purview catalog-scan rollups.' },
        ],
        // Self-contained: the install uploads a repo-hosted catalog-overlay
        // sample into THIS tenant's ADLS and registers a real queryable
        // shortcut. The prior `catalog@{{ADLS_ACCOUNT}}/overlay` target did not
        // exist on a fresh install (vaporware); replaced per no-vaporware.md.
        shortcuts: [
          {
            name: 'admin_plane_catalog',
            repoDataset: 'samples/app-data/multi-agency-onboarding/admin-plane-catalog-overlay.csv',
            format: 'csv',
            kind: 'files',
            description: 'Admin Plane catalog overlay (department-wide domain hierarchy + policies). Repo-hosted sample uploaded into this lakehouse on install.',
          },
        ],
        deltaTables: [
          {
            name: 'marketplace_data_product',
            ddl: LH_DATAPRODUCTS_DDL,
            sampleRows: [
              ['dp-perf-metrics', 101, 'Mission Operations', 'Agency Performance Metrics', 'CUI', 'certified', 'share_missionops_perf', 'Monthly agency performance KPIs published cross-department.', '2026-05-12T10:00:00Z'],
              ['dp-field-incidents', 102, 'Field Services', 'Field Incident Feed', 'Restricted-PII', 'promoted', 'share_fieldsvc_incidents', 'Near-real-time field incident records (PII-redacted view).', '2026-05-30T14:30:00Z'],
              ['dp-oversight-findings', 103, 'Inspector General', 'Oversight Findings', 'CUI', null, 'share_ig_findings', 'Published audit findings for cross-agency remediation tracking.', '2026-05-31T08:00:00Z'],
            ],
          },
          {
            name: 'cross_domain_access_grant',
            ddl: LH_GRANTS_DDL,
            sampleRows: [
              ['g-0001', 'dp-perf-metrics', 102, 'Field Services', 'Cross-agency performance dashboards', 'approved', 'Stewards-MissionOps', 90, '2026-05-15T09:00:00Z', '2026-08-13T09:00:00Z'],
              ['g-0002', 'dp-perf-metrics', 103, 'Inspector General', 'Oversight trend analysis', 'requested', null, 90, null, null],
              ['g-0003', 'dp-field-incidents', 101, 'Mission Operations', 'Mission situational awareness', 'approved', 'Stewards-FieldSvc', 30, '2026-05-31T10:00:00Z', '2026-06-30T10:00:00Z'],
            ],
          },
          {
            name: 'federation_audit_event',
            ddl: LH_AUDIT_DDL,
            sampleRows: [
              ['ae-0001', '2026-05-31T11:02:00Z', 'analyst1@fieldsvc.gov', 102, 'cross-dlz-read', 'dp-perf-metrics', 4210, 'CUI', true],
              ['ae-0002', '2026-05-31T11:10:00Z', 'steward@missionops.gov', 101, 'grant-approve', 'dp-field-incidents', 0, 'Restricted-PII', true],
              ['ae-0003', '2026-05-31T09:34:00Z', 'mcp@mission-affairs.gov', 102, 'dlz-onboard', null, 0, 'Internal', true],
              ['ae-0004', '2026-05-31T12:45:00Z', 'analyst2@ig.gov', 103, 'label-violation', 'dp-perf-metrics', 98000, 'CUI', true],
            ],
          },
          {
            name: 'dlz_catalog_scan_rollup',
            ddl: LH_CATALOGSCAN_DDL,
            sampleRows: [
              [101, 'Mission Operations', 2, 2153, 1980, '2026-05-31T03:00:00Z', 'green'],
              [102, 'Field Services', 1, 0, 0, null, 'yellow'],
              [103, 'Inspector General', 0, 0, 0, null, 'red'],
            ],
          },
        ],
      },
    },

    // 5) Onboarding telemetry KQL database — seeded + functions + queries.
    {
      itemType: 'kql-database',
      displayName: 'Onboarding Telemetry',
      description:
        'ADX database for the onboarding control loop: DeploymentEvent (state ' +
        'transitions), PimActivation (just-in-time Contributor grants), ' +
        'PeeringState (hub↔spoke), and SmokeTest results. Includes ' +
        'onboarding_duration_minutes / stalled_deployments functions and ' +
        'analyst queries for funnel, PIM audit, peering, and smoke-test health.',
      learnDoc: 'fiab/runbooks/dlz-onboard-new-domain',
      content: {
        kind: 'kql-database',
        tables: [
          {
            name: 'DeploymentEvent',
            columns: [
              { name: 'event_time', type: 'datetime' },
              { name: 'dlz_id', type: 'int' },
              { name: 'agency', type: 'string' },
              { name: 'event_type', type: 'string' },
              { name: 'subscription_id', type: 'string' },
              { name: 'deployment_name', type: 'string' },
              { name: 'provisioning_state', type: 'string' },
              { name: 'message', type: 'string' },
            ],
            sample: [
              ['2026-05-10T13:00:00Z', 101, 'Mission Operations', 'requested', 'bbbb1111-1111-1111-1111-1111111111bb', 'dlz-mission-operations-20260510', 'Accepted', 'Wizard interview confirmed'],
              ['2026-05-10T13:34:00Z', 101, 'Mission Operations', 'active', 'bbbb1111-1111-1111-1111-1111111111bb', 'dlz-mission-operations-20260510', 'Succeeded', 'DLZ live'],
              ['2026-05-31T09:15:00Z', 102, 'Field Services', 'requested', 'cccc2222-2222-2222-2222-2222222222cc', 'dlz-field-services-20260531', 'Accepted', 'Wizard interview confirmed'],
              ['2026-05-31T09:16:00Z', 102, 'Field Services', 'deploying', 'cccc2222-2222-2222-2222-2222222222cc', 'dlz-field-services-20260531', 'Running', 'az deployment sub create submitted'],
            ],
          },
          {
            name: 'PimActivation',
            columns: [
              { name: 'activated_utc', type: 'datetime' },
              { name: 'principal_id', type: 'string' },
              { name: 'group_name', type: 'string' },
              { name: 'target_subscription_id', type: 'string' },
              { name: 'duration_hours', type: 'int' },
              { name: 'justification', type: 'string' },
              { name: 'request_status', type: 'string' },
            ],
            sample: [
              ['2026-05-10T12:58:00Z', '00000000-0000-0000-0000-000000000000', 'Loom MCP Operators', 'bbbb1111-1111-1111-1111-1111111111bb', 8, 'Onboard DLZ Mission Operations', 'Provisioned'],
              ['2026-05-31T09:14:30Z', '00000000-0000-0000-0000-000000000000', 'Loom MCP Operators', 'cccc2222-2222-2222-2222-2222222222cc', 8, 'Onboard DLZ Field Services', 'Provisioned'],
            ],
          },
          {
            name: 'PeeringState',
            columns: [
              { name: 'checked_utc', type: 'datetime' },
              { name: 'dlz_id', type: 'int' },
              { name: 'agency', type: 'string' },
              { name: 'peering_state', type: 'string' },
              { name: 'remote_vnet_id', type: 'string' },
            ],
            sample: [
              ['2026-05-31T17:00:00Z', 101, 'Mission Operations', 'Connected', '/subscriptions/bbbb1111-1111-1111-1111-1111111111bb/resourceGroups/rg-dlz-missionops/providers/Microsoft.Network/virtualNetworks/vnet-spoke'],
              ['2026-05-31T17:00:00Z', 102, 'Field Services', 'Initiated', '/subscriptions/cccc2222-2222-2222-2222-2222222222cc/resourceGroups/rg-dlz-fieldsvc/providers/Microsoft.Network/virtualNetworks/vnet-spoke'],
            ],
          },
          {
            name: 'SmokeTest',
            columns: [
              { name: 'run_utc', type: 'datetime' },
              { name: 'dlz_id', type: 'int' },
              { name: 'agency', type: 'string' },
              { name: 'passed', type: 'bool' },
              { name: 'rows_written', type: 'long' },
              { name: 'query_latency_ms', type: 'int' },
              { name: 'detail', type: 'string' },
            ],
            sample: [
              ['2026-05-10T13:36:00Z', 101, 'Mission Operations', true, 3, 412, 'create ws + ingest + query OK'],
              ['2026-05-31T13:40:00Z', 101, 'Mission Operations', true, 3, 388, 'nightly re-validation'],
            ],
          },
        ],
        functions: [
          { name: 'onboarding_duration_minutes', body: KQL_FN_ONBOARDING_DURATION },
          { name: 'stalled_deployments', body: KQL_FN_STALLED },
        ],
        ingestionPolicies: [
          {
            table: 'DeploymentEvent',
            // Retention supports `.alter-merge` (merge into the existing
            // retention policy bag). Caching does NOT — its supported form is
            // `.alter table T policy caching hot = <span>` (no merge variant);
            // `.alter-merge … policy caching hot = 30d` is rejected SYN0002.
            // https://learn.microsoft.com/kusto/management/alter-table-cache-policy-command
            // https://learn.microsoft.com/kusto/management/alter-merge-table-retention-policy-command
            policy:
              '.alter-merge table DeploymentEvent policy retention softdelete = 365d\n' +
              '.alter table DeploymentEvent policy caching hot = 30d',
          },
        ],
        starterQueries: [
          { name: 'Onboarding funnel (current state)', kql: KQL_Q_ONBOARD_FUNNEL },
          { name: 'PIM activations (last 24h)', kql: KQL_Q_PIM_ACTIVATIONS },
          { name: 'Peering health per DLZ', kql: KQL_Q_PEERING_HEALTH },
          { name: 'Smoke-test pass rate (last 7d)', kql: KQL_Q_SMOKE },
        ],
      },
    },

    // 6) Federation governance semantic model.
    {
      itemType: 'semantic-model',
      displayName: 'Federation Governance Model',
      description:
        'Department-CIO cross-DLZ rollup star schema: DimAgency, DimDate, ' +
        'FactOnboarding (one row per DLZ onboarding), FactCrossDomainGrant, and ' +
        'FactDlzCost, with DAX measures for onboarding SLA, active-DLZ count, ' +
        'grant approval rate, and per-agency cost share.',
      learnDoc: 'fiab/use-cases/federal-data-mesh',
      content: {
        kind: 'semantic-model',
        tables: [
          {
            name: 'DimAgency',
            columns: [
              { name: 'AgencyKey', dataType: 'Int64' },
              { name: 'DlzId', dataType: 'Int64' },
              { name: 'AgencyName', dataType: 'String' },
              { name: 'MissionDomain', dataType: 'String' },
              { name: 'SubscriptionId', dataType: 'String' },
              { name: 'Region', dataType: 'String' },
              { name: 'CapacitySku', dataType: 'String' },
              { name: 'OnboardingPattern', dataType: 'String' },
              { name: 'Status', dataType: 'String' },
            ],
          },
          {
            name: 'DimDate',
            columns: [
              { name: 'DateKey', dataType: 'Int64' },
              { name: 'Date', dataType: 'Date' },
              { name: 'Year', dataType: 'Int64' },
              { name: 'Quarter', dataType: 'Int64' },
              { name: 'Month', dataType: 'Int64' },
              { name: 'MonthName', dataType: 'String' },
              { name: 'IsFederalFiscalQ', dataType: 'Boolean' },
            ],
          },
          {
            name: 'FactOnboarding',
            columns: [
              { name: 'OnboardingKey', dataType: 'Int64' },
              { name: 'AgencyKey', dataType: 'Int64' },
              { name: 'RequestedDateKey', dataType: 'Int64' },
              { name: 'DeployedDateKey', dataType: 'Int64' },
              { name: 'DurationMinutes', dataType: 'Int64' },
              { name: 'SmokeTestPassed', dataType: 'Boolean' },
              { name: 'PeeringConnected', dataType: 'Boolean' },
              { name: 'IsActive', dataType: 'Boolean' },
            ],
          },
          {
            name: 'FactCrossDomainGrant',
            columns: [
              { name: 'GrantKey', dataType: 'Int64' },
              { name: 'PublishingAgencyKey', dataType: 'Int64' },
              { name: 'RequestingAgencyKey', dataType: 'Int64' },
              { name: 'RequestedDateKey', dataType: 'Int64' },
              { name: 'WindowDays', dataType: 'Int64' },
              { name: 'IsApproved', dataType: 'Boolean' },
              { name: 'Classification', dataType: 'String' },
            ],
          },
          {
            name: 'FactDlzCost',
            columns: [
              { name: 'CostKey', dataType: 'Int64' },
              { name: 'AgencyKey', dataType: 'Int64' },
              { name: 'DateKey', dataType: 'Int64' },
              { name: 'AzureCostUsd', dataType: 'Decimal' },
              { name: 'CapacityCostUsd', dataType: 'Decimal' },
              { name: 'StorageCostUsd', dataType: 'Decimal' },
            ],
          },
        ],
        measures: [
          {
            table: 'FactOnboarding',
            name: 'Active DLZs',
            expression: "CALCULATE ( DISTINCTCOUNT ( DimAgency[DlzId] ), DimAgency[Status] = \"active\" )",
            formatString: '#,0',
          },
          {
            table: 'FactOnboarding',
            name: 'In-Flight Onboardings',
            expression: "CALCULATE ( DISTINCTCOUNT ( DimAgency[DlzId] ), DimAgency[Status] IN { \"queued\", \"bicep-rendered\", \"deploying\" } )",
            formatString: '#,0',
          },
          {
            table: 'FactOnboarding',
            name: 'Avg Onboarding Minutes',
            expression: "AVERAGE ( FactOnboarding[DurationMinutes] )",
            formatString: '#,0',
          },
          {
            table: 'FactOnboarding',
            name: 'Onboarding SLA Met %',
            expression:
              "VAR _met = CALCULATE ( COUNTROWS ( FactOnboarding ), FactOnboarding[DurationMinutes] <= 45 ) " +
              "VAR _total = CALCULATE ( COUNTROWS ( FactOnboarding ), NOT ISBLANK ( FactOnboarding[DurationMinutes] ) ) " +
              "RETURN DIVIDE ( _met, _total )",
            formatString: '0.0%;-0.0%;0.0%',
          },
          {
            table: 'FactOnboarding',
            name: 'Smoke-Test Pass %',
            expression: "DIVIDE ( CALCULATE ( COUNTROWS ( FactOnboarding ), FactOnboarding[SmokeTestPassed] = TRUE() ), COUNTROWS ( FactOnboarding ) )",
            formatString: '0.0%;-0.0%;0.0%',
          },
          {
            table: 'FactCrossDomainGrant',
            name: 'Grant Approval Rate',
            expression: "DIVIDE ( CALCULATE ( COUNTROWS ( FactCrossDomainGrant ), FactCrossDomainGrant[IsApproved] = TRUE() ), COUNTROWS ( FactCrossDomainGrant ) )",
            formatString: '0.0%;-0.0%;0.0%',
          },
          {
            table: 'FactCrossDomainGrant',
            name: 'Open Grant Requests',
            expression: "CALCULATE ( COUNTROWS ( FactCrossDomainGrant ), FactCrossDomainGrant[IsApproved] = FALSE() )",
            formatString: '#,0',
          },
          {
            table: 'FactDlzCost',
            name: 'Total DLZ Cost',
            expression: "SUM ( FactDlzCost[AzureCostUsd] )",
            formatString: '"$"#,0;("$"#,0);"$"#,0',
          },
          {
            table: 'FactDlzCost',
            name: 'Cost Share %',
            expression: "DIVIDE ( [Total DLZ Cost], CALCULATE ( [Total DLZ Cost], ALL ( DimAgency ) ) )",
            formatString: '0.0%;-0.0%;0.0%',
          },
        ],
        relationships: [
          { from: 'FactOnboarding.AgencyKey', to: 'DimAgency.AgencyKey', cardinality: '1:many' },
          { from: 'FactOnboarding.RequestedDateKey', to: 'DimDate.DateKey', cardinality: '1:many' },
          { from: 'FactCrossDomainGrant.PublishingAgencyKey', to: 'DimAgency.AgencyKey', cardinality: '1:many' },
          { from: 'FactCrossDomainGrant.RequestedDateKey', to: 'DimDate.DateKey', cardinality: '1:many' },
          { from: 'FactDlzCost.AgencyKey', to: 'DimAgency.AgencyKey', cardinality: '1:many' },
          { from: 'FactDlzCost.DateKey', to: 'DimDate.DateKey', cardinality: '1:many' },
        ],
      },
    },

    // 7) Cockpit report (editor exists; provisioner gap flagged in header).
    {
      itemType: 'report',
      displayName: 'Multi-Agency Onboarding Cockpit',
      description:
        'Department-CIO cockpit over the Federation Governance Model: onboarding ' +
        'funnel + SLA, DLZ inventory + peering health, cross-domain Marketplace ' +
        'grants, and per-agency cost share.',
      learnDoc: 'fiab/use-cases/multi-agency-onboarding',
      content: {
        kind: 'report',
        pages: [
          {
            name: 'Onboarding Funnel',
            visuals: [
              { type: 'card', title: 'Active DLZs', field: 'Active DLZs' },
              { type: 'card', title: 'In-Flight Onboardings', field: 'In-Flight Onboardings' },
              { type: 'card', title: 'Onboarding SLA Met %', field: 'Onboarding SLA Met %' },
              { type: 'card', title: 'Avg Onboarding Minutes', field: 'Avg Onboarding Minutes' },
              { type: 'funnel', title: 'DLZs by lifecycle state', field: 'DimAgency[Status]' },
              { type: 'columnChart', title: 'Avg onboarding minutes by agency', config: { axis: 'DimAgency[AgencyName]', value: 'Avg Onboarding Minutes' } },
            ],
          },
          {
            name: 'DLZ Inventory + Peering',
            visuals: [
              { type: 'table', title: 'DLZ inventory', config: { columns: ['DimAgency[AgencyName]', 'DimAgency[Region]', 'DimAgency[CapacitySku]', 'DimAgency[Status]'] } },
              { type: 'card', title: 'Smoke-Test Pass %', field: 'Smoke-Test Pass %' },
              { type: 'matrix', title: 'Peering connected by agency', config: { rows: 'DimAgency[AgencyName]', value: 'FactOnboarding[PeeringConnected]' } },
              { type: 'map', title: 'DLZ regions', config: { location: 'DimAgency[Region]' } },
            ],
          },
          {
            name: 'Cross-Domain Marketplace',
            visuals: [
              { type: 'card', title: 'Open Grant Requests', field: 'Open Grant Requests' },
              { type: 'card', title: 'Grant Approval Rate', field: 'Grant Approval Rate' },
              { type: 'table', title: 'Grants by publishing→requesting agency', config: { columns: ['Publishing', 'Requesting', 'Classification', 'IsApproved', 'WindowDays'] } },
              { type: 'pieChart', title: 'Grants by classification', config: { legend: 'FactCrossDomainGrant[Classification]', value: 'count' } },
            ],
          },
          {
            name: 'Cost Allocation',
            visuals: [
              { type: 'card', title: 'Total DLZ Cost', field: 'Total DLZ Cost' },
              { type: 'donutChart', title: 'Cost share by agency', config: { legend: 'DimAgency[AgencyName]', value: 'Total DLZ Cost' } },
              { type: 'lineChart', title: 'DLZ cost over time', config: { axis: 'DimDate[Date]', value: 'Total DLZ Cost', series: 'DimAgency[AgencyName]' } },
            ],
          },
        ],
      },
    },

    // 8) Deployment-health Activator rule.
    {
      itemType: 'activator',
      displayName: 'DLZ Deployment Health',
      description:
        'Fires when a DLZ deployment has been "deploying" longer than the ' +
        '45-minute SLA without reaching active/failed (via the ' +
        'stalled_deployments KQL function), so the Loom Admin can investigate ' +
        'a stuck Bicep run or quota/peering issue before hand-off.',
      learnDoc: 'fiab/runbooks/dlz-onboard-new-domain',
      content: {
        kind: 'activator',
        rule: {
          name: 'DLZ deployment stalled past SLA',
          condition: { metric: 'stalled_deployments().stalled_min', op: '>', threshold: 45 },
          window: 'PT5M',
          action: {
            kind: 'teams',
            config: {
              channel: 'Loom Admins',
              title: 'DLZ onboarding stalled',
              message:
                'A DLZ deployment has been in the "deploying" state past the ' +
                '45-minute SLA. Check the Bicep deployment, Databricks Premium ' +
                'capacity quota in the target region, and hub↔spoke peering. ' +
                'See runbook docs/fiab/runbooks/dlz-onboard-new-domain.md.',
            },
          },
        },
      },
    },
  ],
};

export default bundle;
