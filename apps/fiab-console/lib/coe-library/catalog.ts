// AUTO-GENERATED from docs/fiab/org-visuals/coe-library/catalog.json by temp/gen-coe.mjs.
// The Org Visuals BFF reads this bundled copy (docs/ is not in the standalone image).
// A drift test (lib/coe-library/__tests__/catalog-parity.test.ts) asserts it equals catalog.json.
import type { CoeCatalog } from './types';

export const COE_CATALOG: CoeCatalog = {
  "$schema": "./catalog.schema.json",
  "version": "1.0.0",
  "generator": "csa-loom coe-library",
  "description": "Default Cloud Center of Excellence (CoE) Power BI report templates for the Organizational Visuals library. Each entry is a version-controlled PBIP (PBIR + TMDL) you can preview, clone, and rebrand.",
  "templates": [
    {
      "id": "coe-adoption-maturity",
      "title": "CoE Adoption & Maturity Scorecard",
      "description": "Track cloud operating-model maturity by pillar against target levels, plus platform adoption signals (active users, workloads onboarded).",
      "category": "Adoption & Maturity",
      "kind": "pbip-report",
      "thumbnail": "thumbnails/coe-adoption-maturity.svg",
      "pbipPath": "coe-adoption-maturity/CoEAdoptionMaturity.pbip",
      "reportPath": "coe-adoption-maturity/CoEAdoptionMaturity.Report",
      "semanticModelPath": "coe-adoption-maturity/CoEAdoptionMaturity.SemanticModel",
      "pages": [
        "Maturity Scorecard"
      ],
      "measures": 6,
      "dataSources": [
        "CoE scorecard (SharePoint/Dataverse/Cosmos)",
        "Azure Monitor / Log Analytics"
      ],
      "requiredRoles": [
        "Reader on the assessment source",
        "Log Analytics Reader"
      ],
      "parameters": [
        "TenantId",
        "SubscriptionId",
        "BillingScope",
        "LogAnalyticsWorkspaceId",
        "ManagementApiBase"
      ],
      "sampleData": true
    },
    {
      "id": "cloud-cost-finops",
      "title": "Cloud Cost / FinOps",
      "description": "Amortized spend by subscription, resource group, service and cost-center tag, with budget variance and untagged-spend leakage.",
      "category": "FinOps",
      "kind": "pbip-report",
      "thumbnail": "thumbnails/cloud-cost-finops.svg",
      "pbipPath": "cloud-cost-finops/CloudCostFinOps.pbip",
      "reportPath": "cloud-cost-finops/CloudCostFinOps.Report",
      "semanticModelPath": "cloud-cost-finops/CloudCostFinOps.SemanticModel",
      "pages": [
        "Cost & FinOps"
      ],
      "measures": 6,
      "dataSources": [
        "Azure Cost Management",
        "Microsoft.Consumption budgets"
      ],
      "requiredRoles": [
        "Cost Management Reader",
        "Billing account reader (for billing-account scope)"
      ],
      "parameters": [
        "TenantId",
        "SubscriptionId",
        "BillingScope",
        "LogAnalyticsWorkspaceId",
        "ManagementApiBase"
      ],
      "sampleData": true
    },
    {
      "id": "security-compliance-posture",
      "title": "Security & Compliance Posture",
      "description": "Defender for Cloud secure score plus Azure Policy regulatory-compliance (MCSB, NIST, CIS) by initiative and subscription.",
      "category": "Security & Compliance",
      "kind": "pbip-report",
      "thumbnail": "thumbnails/security-compliance-posture.svg",
      "pbipPath": "security-compliance-posture/SecurityCompliancePosture.pbip",
      "reportPath": "security-compliance-posture/SecurityCompliancePosture.Report",
      "semanticModelPath": "security-compliance-posture/SecurityCompliancePosture.SemanticModel",
      "pages": [
        "Security Posture"
      ],
      "measures": 4,
      "dataSources": [
        "Azure Resource Graph (securityresources, policyresources)",
        "Microsoft Defender for Cloud"
      ],
      "requiredRoles": [
        "Security Reader",
        "Reader (subscription/MG)"
      ],
      "parameters": [
        "TenantId",
        "SubscriptionId",
        "BillingScope",
        "LogAnalyticsWorkspaceId",
        "ManagementApiBase"
      ],
      "sampleData": true
    },
    {
      "id": "resource-inventory-sprawl",
      "title": "Resource Inventory & Sprawl",
      "description": "Full estate inventory from Azure Resource Graph: counts by type, region and subscription, untagged-resource gaps, and orphaned-resource waste.",
      "category": "Inventory & Optimization",
      "kind": "pbip-report",
      "thumbnail": "thumbnails/resource-inventory-sprawl.svg",
      "pbipPath": "resource-inventory-sprawl/ResourceInventorySprawl.pbip",
      "reportPath": "resource-inventory-sprawl/ResourceInventorySprawl.Report",
      "semanticModelPath": "resource-inventory-sprawl/ResourceInventorySprawl.SemanticModel",
      "pages": [
        "Inventory & Sprawl"
      ],
      "measures": 7,
      "dataSources": [
        "Azure Resource Graph"
      ],
      "requiredRoles": [
        "Reader (subscription/MG)"
      ],
      "parameters": [
        "TenantId",
        "SubscriptionId",
        "BillingScope",
        "LogAnalyticsWorkspaceId",
        "ManagementApiBase"
      ],
      "sampleData": true
    },
    {
      "id": "identity-access-governance",
      "title": "Identity & Access Governance",
      "description": "Azure RBAC assignment surface, privileged-role concentration, and PIM just-in-time vs standing-access coverage.",
      "category": "Identity & Access",
      "kind": "pbip-report",
      "thumbnail": "thumbnails/identity-access-governance.svg",
      "pbipPath": "identity-access-governance/IdentityAccessGovernance.pbip",
      "reportPath": "identity-access-governance/IdentityAccessGovernance.Report",
      "semanticModelPath": "identity-access-governance/IdentityAccessGovernance.SemanticModel",
      "pages": [
        "Identity & Access"
      ],
      "measures": 6,
      "dataSources": [
        "Azure Resource Graph (authorizationresources)",
        "Microsoft Graph (PIM/role management)"
      ],
      "requiredRoles": [
        "Reader (subscription/MG)",
        "Microsoft Graph RoleManagement.Read.Directory"
      ],
      "parameters": [
        "TenantId",
        "SubscriptionId",
        "BillingScope",
        "LogAnalyticsWorkspaceId",
        "ManagementApiBase"
      ],
      "sampleData": true
    },
    {
      "id": "data-estate-governance",
      "title": "Data Estate & Governance",
      "description": "Microsoft Purview catalog coverage: cataloged assets by collection/type, classification and ownership coverage, and pipeline lineage completeness.",
      "category": "Data Governance",
      "kind": "pbip-report",
      "thumbnail": "thumbnails/data-estate-governance.svg",
      "pbipPath": "data-estate-governance/DataEstateGovernance.pbip",
      "reportPath": "data-estate-governance/DataEstateGovernance.Report",
      "semanticModelPath": "data-estate-governance/DataEstateGovernance.SemanticModel",
      "pages": [
        "Data Estate"
      ],
      "measures": 6,
      "dataSources": [
        "Microsoft Purview (catalog + lineage APIs)"
      ],
      "requiredRoles": [
        "Purview Data Reader",
        "Purview Data Curator (for lineage)"
      ],
      "parameters": [
        "TenantId",
        "SubscriptionId",
        "BillingScope",
        "LogAnalyticsWorkspaceId",
        "ManagementApiBase"
      ],
      "sampleData": true
    },
    {
      "id": "operational-health-sla",
      "title": "Operational Health / SLA",
      "description": "Composite service availability vs SLA targets, uptime trend, incident volume by severity/service, and MTTR.",
      "category": "Operations",
      "kind": "pbip-report",
      "thumbnail": "thumbnails/operational-health-sla.svg",
      "pbipPath": "operational-health-sla/OperationalHealthSla.pbip",
      "reportPath": "operational-health-sla/OperationalHealthSla.Report",
      "semanticModelPath": "operational-health-sla/OperationalHealthSla.SemanticModel",
      "pages": [
        "Operational Health"
      ],
      "measures": 6,
      "dataSources": [
        "Azure Monitor / Log Analytics (Heartbeat, Alerts)"
      ],
      "requiredRoles": [
        "Log Analytics Reader",
        "Monitoring Reader"
      ],
      "parameters": [
        "TenantId",
        "SubscriptionId",
        "BillingScope",
        "LogAnalyticsWorkspaceId",
        "ManagementApiBase"
      ],
      "sampleData": true
    },
    {
      "id": "landing-zone-conformance",
      "title": "Landing-Zone Conformance",
      "description": "Azure Landing Zone design-area conformance from policy compliance, scored by design area and per subscription/management group.",
      "category": "Platform & Governance",
      "kind": "pbip-report",
      "thumbnail": "thumbnails/landing-zone-conformance.svg",
      "pbipPath": "landing-zone-conformance/LandingZoneConformance.pbip",
      "reportPath": "landing-zone-conformance/LandingZoneConformance.Report",
      "semanticModelPath": "landing-zone-conformance/LandingZoneConformance.SemanticModel",
      "pages": [
        "Landing-Zone Conformance"
      ],
      "measures": 5,
      "dataSources": [
        "Azure Resource Graph (policyresources, ResourceContainers)",
        "Azure Policy"
      ],
      "requiredRoles": [
        "Reader (management group)",
        "Resource Policy Contributor (read)"
      ],
      "parameters": [
        "TenantId",
        "SubscriptionId",
        "BillingScope",
        "LogAnalyticsWorkspaceId",
        "ManagementApiBase"
      ],
      "sampleData": true
    }
  ]
} as const;
