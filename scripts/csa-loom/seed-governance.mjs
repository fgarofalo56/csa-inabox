#!/usr/bin/env node
/**
 * seed-governance.mjs -- post-deploy bootstrap step (deploy-readiness #229, #5368).
 *
 * Makes the governance surfaces POPULATED on first login: idempotently upserts 7 curated
 * GLOBAL docs into the Console `loom` Cosmos DB, which the BFF copies into each tenant's
 * partition on first access (app/api/admin/classifications, sensitivity-labels,
 * governance/domains). Azure-native; no Fabric / Purview dependency.
 *
 *   tenant-settings     classifications:<tenant>, sensitivity-labels:<tenant>
 *   governance-domains  finance, hr, operations, customer, compliance
 *
 * WHY NODE, WHY IN-VNET (#5368): the previous bash version used
 * `az cosmosdb sql container item create`, a command that does not exist in the Azure CLI
 * (the seed had never worked), and ran in the main `bootstrap` job where its (correct) red
 * exit skipped every later step. The Cosmos account blocks public network access, so this
 * runs in the in-VNet `seed-automation-grant` job. Auth and client construction are the
 * same as seed-automation-feature-grant.mjs: an `az` AAD access token over the Cosmos REST
 * API, host from LOOM_COSMOS_ENDPOINT (documents.azure.com or .us), no account keys, no npm
 * install. The deploy identity needs Cosmos DB Built-in Data Contributor scoped to the two
 * containers (loom-console-cosmos.bicep governanceSeedDataAssignments).
 *
 * Failures are FATAL and TRUE: every failed upsert names the container, item id and the HTTP
 * status. A cause is asserted only when the status establishes it; an unknown status asserts
 * none. Secrets (the token) are never printed.
 *
 * Env: LOOM_COSMOS_ENDPOINT (required), LOOM_COSMOS_DATABASE (default loom),
 *      LOOM_SEED_TENANT (default GLOBAL).
 * Exit: 0 all 7 upserted; 2 missing input; 1 any upsert failed.
 */
import { execFileSync } from 'node:child_process';

export const TENANT_SETTINGS = 'tenant-settings';
export const DOMAINS = 'governance-domains';
const SEEDER = 'csa-loom-seed';

/** Shape matches ClassificationRule in app/api/admin/classifications/route.ts. */
export const CLASSIFICATIONS = [
  { id: 'cls-pii', name: 'PII', matchStrategy: 'data-regex', matchValue: '\\b\\d{3}-\\d{2}-\\d{4}\\b', classification: 'MICROSOFT.GOVERNMENT.US_SOCIAL_SECURITY_NUMBER' },
  { id: 'cls-phi', name: 'PHI', matchStrategy: 'column-name-regex', matchValue: '(?i)(diagnosis|patient|mrn|icd10|npi)', classification: 'CUSTOM.PHI' },
  { id: 'cls-pci', name: 'PCI-DSS', matchStrategy: 'data-regex', matchValue: '\\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14})\\b', classification: 'MICROSOFT.FINANCIAL.CREDIT_CARD_NUMBER' },
  { id: 'cls-confidential', name: 'Confidential', matchStrategy: 'column-name-regex', matchValue: '(?i)(secret|confidential|restricted)', classification: 'CUSTOM.CONFIDENTIAL' },
  { id: 'cls-public', name: 'Public', matchStrategy: 'column-name-regex', matchValue: '(?i)(public|open)', classification: 'CUSTOM.PUBLIC' },
  { id: 'cls-cui', name: 'CUI', matchStrategy: 'column-name-regex', matchValue: '(?i)(cui|controlled.?unclassified)', classification: 'CUSTOM.CUI' },
  { id: 'cls-itar', name: 'ITAR', matchStrategy: 'column-name-regex', matchValue: '(?i)(itar|export.?controlled|ear99)', classification: 'CUSTOM.ITAR' },
];

/** Shape matches SensitivityLabel in app/api/admin/sensitivity-labels/route.ts. */
export const LABELS = [
  { id: 'lbl-public', name: 'Public', color: '#107c10', protectionNote: 'No restrictions; safe for external release.' },
  { id: 'lbl-internal', name: 'Internal', color: '#0078d4', protectionNote: 'Organization-internal only; do not share externally.' },
  { id: 'lbl-confidential', name: 'Confidential', color: '#ca5010', protectionNote: 'Need-to-know; encrypt at rest and in transit.' },
  { id: 'lbl-highly-confidential', name: 'Highly Confidential', color: '#a4262c', protectionNote: 'Strict need-to-know; DLP-enforced; audited access.' },
  { id: 'lbl-restricted', name: 'Restricted', color: '#5c2d91', protectionNote: 'Regulated data (CUI/ITAR/PHI); access via approved enclave only.' },
];

/** Shape matches LoomDomain in lib/azure/domains-client.ts. */
export const DOMAIN_SRC = [
  { id: 'finance', name: 'Finance', description: 'Financial reporting, GL, AP/AR, and treasury data products.', color: '#107c10', imageKey: 'icon::finance' },
  { id: 'hr', name: 'Human Resources', description: 'Workforce, payroll, benefits, and talent data products.', color: '#5c2d91', imageKey: 'icon::people' },
  { id: 'operations', name: 'Operations', description: 'Supply chain, logistics, and operational telemetry data products.', color: '#0078d4', imageKey: 'icon::operations' },
  { id: 'customer', name: 'Customer', description: 'Customer 360, CRM, and engagement data products.', color: '#ca5010', imageKey: 'icon::customer' },
  { id: 'compliance', name: 'Compliance', description: 'Regulatory, audit, and governance evidence data products.', color: '#a4262c', imageKey: 'icon::shield' },
];

/** The 7 [container, doc] pairs. Partition key is /tenantId, so pk === doc.tenantId. */
export function buildDocs(tenant = 'GLOBAL', now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')) {
  const stamp = (x) => ({ ...x, createdAt: now, createdBy: SEEDER });
  return [
    [TENANT_SETTINGS, { id: `classifications:${tenant}`, tenantId: tenant, kind: 'classifications', rules: CLASSIFICATIONS.map(stamp), updatedAt: now }],
    [TENANT_SETTINGS, { id: `sensitivity-labels:${tenant}`, tenantId: tenant, kind: 'sensitivity-labels', labels: LABELS.map(stamp), updatedAt: now }],
    ...DOMAIN_SRC.map((d) => [DOMAINS, { ...d, tenantId: tenant, createdBy: SEEDER, createdAt: now, updatedBy: SEEDER, updatedAt: now }]),
  ];
}

/** One line per failed upsert. Names container + id + status; a cause only where the status proves it. */
export function describeFailure(container, id, e, account = '') {
  const status = e && typeof e.code === 'number' ? e.code : undefined;
  const where = `container '${container}' (item '${id}'${account ? `, account '${account}'` : ''})`;
  const said = String((e && e.message) || e).replace(/\s+/g, ' ').slice(0, 300);
  if (status === 403) return `Cosmos returned HTTP 403 (Forbidden) for ${where}. A 403 means the request was refused: either the signed-in identity lacks a data-plane role scoped to '${container}' (needs Cosmos DB Built-in Data Contributor, loom-console-cosmos.bicep governanceSeedDataAssignments), or the account firewall refused this runner. The status alone does not tell which. Cosmos said: ${said}`;
  if (status === 404) return `Cosmos returned HTTP 404 (NotFound) for ${where}. A 404 means the container, database or account was not found by that name. Cosmos said: ${said}`;
  if (status !== undefined) return `Cosmos returned HTTP ${status} for ${where}; no cause is asserted for this status. Cosmos said: ${said}`;
  return `upsert failed for ${where} with no HTTP status (the request may not have reached Cosmos), so no cause is asserted. Error: ${said}`;
}

/** Pure orchestration; `cosmos.upsert(container, pk, doc)` throws an Error carrying `.code` on failure. */
export async function seed({ cosmos, tenant = 'GLOBAL', now, account = '', log = console.log, logError = console.error }) {
  const docs = buildDocs(tenant, now);
  let failed = 0;
  for (const [container, doc] of docs) {
    try {
      await cosmos.upsert(container, doc.tenantId, doc);
      log(`upserted ${container}/${doc.id}`);
    } catch (e) {
      failed += 1;
      logError(`::error::governance seed FAILED: ${describeFailure(container, doc.id, e, account)}`);
    }
  }
  return { failed, total: docs.length };
}

/** Cosmos AAD data-plane over REST (same construction as seed-automation-feature-grant.mjs). */
export function realCosmos(endpoint, db) {
  const host = new URL(endpoint);
  const token = () => execFileSync(process.env.AZ_BIN || 'az',
    ['account', 'get-access-token', '--resource', `${host.protocol}//${host.host}`, '--query', 'accessToken', '-o', 'tsv'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  return {
    async upsert(container, pk, doc) {
      const res = await fetch(`${host.protocol}//${host.host}/dbs/${encodeURIComponent(db)}/colls/${container}/docs`, {
        method: 'POST',
        headers: {
          authorization: encodeURIComponent(`type=aad&ver=1.0&sig=${token()}`),
          'x-ms-date': new Date().toUTCString(),
          'x-ms-version': '2018-12-31',
          'x-ms-documentdb-partitionkey': JSON.stringify([pk]),
          'x-ms-documentdb-is-upsert': 'True',
          'content-type': 'application/json',
        },
        body: JSON.stringify(doc),
      });
      if (res.status === 200 || res.status === 201) return;
      const err = new Error((await res.text()).slice(0, 300));
      err.code = res.status;
      throw err;
    },
  };
}

export async function main(env = process.env, io = {}) {
  const endpoint = (env.LOOM_COSMOS_ENDPOINT || '').trim();
  if (!endpoint) {
    console.error('::error::governance seed FAILED: LOOM_COSMOS_ENDPOINT is not set, so no Cosmos account was resolved. Nothing was written.');
    return 2;
  }
  const cosmos = io.cosmos ?? realCosmos(endpoint, env.LOOM_COSMOS_DATABASE || 'loom');
  const { failed, total } = await seed({ cosmos, tenant: env.LOOM_SEED_TENANT || 'GLOBAL', account: new URL(endpoint).host.split('.')[0] });
  if (failed > 0) {
    console.error(`::error::governance seed did NOT complete: ${failed} of ${total} upserts failed (see the ::error:: lines above). The governance surfaces stay empty until this passes.`);
    return 1;
  }
  console.log(`governance seed complete: ${total} docs upserted (classifications + sensitivity labels + 5 domains).`);
  return 0;
}

if (process.argv[1] && process.argv[1].endsWith('seed-governance.mjs')) {
  process.exit(await main());
}
