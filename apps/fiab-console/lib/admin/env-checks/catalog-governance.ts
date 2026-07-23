/**
 * R30 fragment — the 'catalog-governance' domain slice of ENV_CHECKS (formerly part of the
 * lib/admin/env-checks.ts monolith). An env-adding item edits ONLY its own
 * domain fragment; ./index.ts merges every fragment into the same exported
 * ENV_CHECKS array (public API unchanged). Import ONLY from './core' here —
 * never './index' (barrel-cycle rule, WS-E1 gotcha).
 */
import type { EnvSpec } from './core';

export const CATALOG_GOVERNANCE_ENV_CHECKS: EnvSpec[] = [

  // ── catalog & governance backends (new surfaces) ──
  {
    id: 'svc-deploy-planner', category: 'catalog-governance', title: 'Deployment planner — plan store (Cosmos)', severity: 'optional',
    // Plans live in the tenant-settings container (doc id deploy-plan:<tenant>),
    // so the Cosmos config + probe cover reachability. This check confirms the
    // Loom store is configured (the only requirement for the planner to persist).
    anyOf: [['LOOM_COSMOS_ENDPOINT', 'COSMOS_ENDPOINT']], warnOnMiss: true,
    remediation: 'The Deployment planner saves the subscription + service plan to the Loom store (Cosmos tenant-settings container, doc deploy-plan:<tenant>). It requires only a reachable Cosmos account — see the "Cosmos DB (Loom store)" check. No extra env.',
    provisionedBy: 'modules/landing-zone/main.bicep (cosmos account) → apps[] env LOOM_COSMOS_ENDPOINT',
    role: 'Cosmos DB Built-in Data Contributor (UAMI)',
  },
  {
    id: 'svc-org-visuals', category: 'catalog-governance', title: 'Organizational visuals — Blob store + metadata', severity: 'optional',
    // Metadata + enabled toggle live in the org-visuals Cosmos container; the
    // bundle bytes live in the org-visuals Blob container (LOOM_ORG_VISUALS_URL,
    // auto-derived by bicep). Without the Blob URL, listing/metadata still works
    // Loom-native but uploads have nowhere to land.
    required: ['LOOM_ORG_VISUALS_URL'], warnOnMiss: true,
    remediation: 'Set LOOM_ORG_VISUALS_URL (the org-visuals Blob container URL) so custom-visual (.pbiviz) uploads have a backing store; metadata + the enabled toggle persist in the org-visuals Cosmos container regardless. Bicep auto-derives this from the DLZ storage account on a push-button deploy.',
    provisionedBy: 'modules/admin-plane/main.bicep (derived from loomStorageAccount) + landing-zone/org-visuals-rbac.bicep',
    role: 'Storage Blob Data Contributor (UAMI) on the org-visuals container',
  },
  {
    id: 'svc-purview-uc', category: 'catalog-governance', title: 'Purview Unified Catalog endpoint', severity: 'optional',
    required: ['LOOM_PURVIEW_UC_ENDPOINT'], warnOnMiss: true,
    remediation: 'Set LOOM_PURVIEW_UC_ENDPOINT (https://<account>.purview.azure.com) so unified-catalog surfaces call the Purview UC data plane. The classic Data Map path (LOOM_PURVIEW_ACCOUNT) works without it.',
    provisionedBy: 'main.bicep (purviewEnabled) → admin-plane apps[] env',
    role: 'Purview Data Map role (Console UAMI) on the root collection',
  },
  // L2 — Synapse-Spark OpenLineage column-lineage feed (loom-next-level WS-L).
  // ADDITIVE source: the auth-mode var is bicep-emitted (entra default), but the
  // per-pool credential + listener jar are a pool-config step (the pool-setup
  // script / Fix-it wizard) — until then the OpenLineage source is silently
  // absent while UC / dbt / ADF column lineage keep flowing (default-ON).
  {
    id: 'svc-openlineage', category: 'catalog-governance',
    title: 'Spark column lineage (OpenLineage)', severity: 'optional',
    required: ['LOOM_OPENLINEAGE_AUTH_MODE'], warnOnMiss: true,
    optionalDefault: true,
    availability: { commercial: 'ga', gccHigh: 'ga', il5: 'ga' },   // X2 field
    optionalDefaultDetail: 'Column lineage still flows from Databricks UC, dbt, and ADF Copy mappings; the Synapse-Spark OpenLineage feed is an additive source.',
    remediation: 'Run scripts/csa-loom/openlineage-pool-setup.sh to install the listener + mint the per-pool credential on the Spark pool.',
    provisionedBy: 'modules/landing-zone/synapse-spark-pools.bicep (sparkConfigProperties + workspace library) → apps[] env',
    role: 'Synapse Spark pool contributor (to upload the workspace library)',
  },
];
