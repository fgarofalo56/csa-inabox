# workspace-egress — parity with Microsoft Fabric workspace outbound access protection

**Loom surface:** `/governance/workspace-egress` (rel-T89)
**Source UI:** Microsoft Fabric — *Workspace settings → Network security → Outbound access protection* (GA March 2026)
Learn:
- https://learn.microsoft.com/fabric/security/workspace-outbound-access-protection-overview
- https://learn.microsoft.com/azure/virtual-network/network-security-groups-overview
- https://learn.microsoft.com/azure/virtual-network/service-tags-overview
- https://learn.microsoft.com/rest/api/virtualnetwork/security-rules/create-or-update

Azure-native, **no Microsoft Fabric / Power BI dependency** (`no-fabric-dependency.md`).
Fabric enforces outbound protection on its managed workspace compute; the Loom
one-for-one enforces the same intent on the workspace's **data-plane compute
subnet** using real Azure **Network Security Group** outbound rules (service tags
+ IP), with FQDN destinations surfaced as an honest Azure-Firewall gate.

## Fabric / Azure feature inventory (grounded in Learn)

| # | Capability in Fabric's outbound access protection | Notes |
|---|----|----|
| 1 | Per-workspace toggle for outbound access protection | Workspace-scoped setting |
| 2 | Define an **allow-list** of outbound destinations for workspace compute | The core control |
| 3 | Destination kinds: **Azure resources / service endpoints, FQDNs** | Tag/host-based allow entries |
| 4 | **Deny by default** — only allow-listed destinations are reachable | Exfiltration protection |
| 5 | Managed private endpoints as the private-connectivity path | Approved outbound to Azure PaaS |
| 6 | Edit / add / remove allow-list entries; see current rules | CRUD over the rule set |
| 7 | State/status of enforcement per workspace | Which rules are live |

## Loom coverage

| # | Capability | Status | Loom implementation |
|---|----|----|----|
| 1 | Per-workspace policy | ✅ built | One `WorkspaceEgressPolicy` per workspace (Cosmos `workspace-egress-policies`, PK `/workspaceId`) |
| 2 | Outbound allow-list | ✅ built | `destinations[]` on the policy; New/Edit dialog builds it with dropdowns + validated inputs (no freeform) |
| 3 | Destination kinds | ✅ built (tag/IP) · ⚠️ honest-gate (FQDN) | **service-tag** → Allow Outbound rule (dest = Azure service tag); **ip** → Allow Outbound rule (CIDR); **fqdn** → saved + reported as needing an Azure Firewall application rule (NSGs can't match hostnames) |
| 4 | Deny by default | ✅ built | `defaultDeny` writes a final Deny-Outbound-to-`Internet` rule (priority 4000+) so allow rules (300+) win and everything else is blocked |
| 5 | Managed private endpoints | ✅ built (sibling) | Loom's F15 Advanced-networking "Outbound access rules" (`networking-client.ts` `addOutboundPeRule`) already creates real managed private endpoints; this surface complements it with subnet-level egress firewalling |
| 6 | CRUD + view rules | ✅ built | GET list, POST upsert+reconcile, `[id]` GET (compile preview) + DELETE (revoke rules). Reconcile is idempotent (reuses existing rule priorities; revokes stale `loom-egress-*` rules) |
| 7 | Enforcement status | ✅ built | Every reconcile returns a receipt (converged / partial / gated) written to `_auditLog`; per-card status badge + last-reconcile MessageBar |

Zero ❌. FQDN is a documented honest gate (⚠️), not a stub — the destination is
persisted and the receipt names the exact remediation (Azure Firewall).

## Backend per control (real Azure REST — no mocks)

| Control | Backend call |
|---|----|
| List NSGs (compute-subnet picker) | `listNetworkSecurityGroups()` → `GET .../Microsoft.Network/networkSecurityGroups?api-version=2024-05-01` (Reader) |
| Save + reconcile allow-list | For each service-tag/IP destination: `PUT .../networkSecurityGroups/{nsg}/securityRules/{loom-egress-*}?api-version=2024-05-01` (Outbound Allow). Default-deny: `PUT` a final Outbound Deny to `Internet` |
| Read live rules (idempotent converge) | `GET .../networkSecurityGroups/{nsg}/securityRules` |
| Revoke stale / delete policy | `DELETE .../networkSecurityGroups/{nsg}/securityRules/{name}` for `loom-egress-*` rules no longer targeted |
| Reconcile receipt | `_auditLog` upsert (`kind: workspace-egress-reconcile`) |

**Auth / RBAC:** `ChainedTokenCredential(AcaManagedIdentity → UAMI → Default)` on
the ARM scope. The Console UAMI needs **Network Contributor**
(`4d97b98b-1d4f-4787-a291-c67834d212e7`) on the RG owning the chosen NSG —
already granted on the admin networking RG by
`platform/fiab/bicep/modules/admin-plane/network.bicep` (F15). A 403 surfaces as
an honest MessageBar naming the exact role; a Reader gap on NSG discovery
degrades to an honest "grant Reader" note without blanking the surface.

**Env:** reuses `LOOM_SUBSCRIPTION_ID` + `LOOM_NETWORKING_RG` (both already
emitted by admin-plane bicep) + `LOOM_COSMOS_ENDPOINT`. No new env vars, no new
bicep params (256-param ceiling respected).

## Verification (real-data-or-honest-gate)

- With Network Contributor present: POST `/api/governance/workspace-egress` with a
  service-tag + CIDR allow-list writes real `loom-egress-*` outbound rules to the
  picked NSG (visible in the Azure portal NSG → Outbound security rules) and, with
  default-deny on, the final Deny-to-Internet rule. Receipt = `converged`,
  `rulesWritten` > 0.
- Without the role: receipt = `gated` with the exact "grant Network Contributor"
  message — the full surface still renders.
- FQDN destination: saved on the policy, returned under `firewallRequired`, badged
  "FQDN · firewall" — honest gate, no silent no-op.
