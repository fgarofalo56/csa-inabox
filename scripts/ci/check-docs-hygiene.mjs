#!/usr/bin/env node
/**
 * GUARDRAIL: docs-hygiene  (merge-blocker)
 * ------------------------------------------------------------------------
 * RULE (rel-T02 / release-blocker B2): the published MkDocs site must NOT
 *   leak the operator's live Azure estate coordinates or PII. Before public
 *   release the docs carried real subscription / tenant / UAMI / app-client /
 *   service-principal GUIDs, operator object-ids, workspace GUIDs, the live
 *   Front Door + custom-domain hostnames, and operator email domains. Those
 *   were redacted to angle-bracket placeholders; this gate keeps them out.
 *
 * WHAT IT DOES:
 *   Scans docs/ + mkdocs.yml for
 *     1. any LIVE_IDENTIFIER GUID (the operator's real estate coordinates),
 *     2. any operator email / tenant domain (LEAKED_DOMAINS),
 *     3. any live Front Door `*.azurefd.net` hostname,
 *     4. the live Databricks workspace host.
 *   Exits 1 (with file:line for every hit) if anything is found; exits 0 clean.
 *
 * WHAT IS *NOT* A VIOLATION (WELL_KNOWN):
 *   Azure built-in role-definition GUIDs, Microsoft first-party app IDs, and
 *   Graph API permission (AppRole) IDs are PUBLIC CONSTANTS — docs legitimately
 *   cite them (e.g. "grant Storage Blob Data Contributor
 *   `ba92f5b4-2d11-453d-a403-e96b0029c9fe`"). They are enumerated in WELL_KNOWN
 *   below so a maintainer can see they were considered-and-kept, and so a
 *   startup assertion guarantees a WELL_KNOWN constant is never accidentally
 *   added to LIVE_IDENTIFIER.
 *
 * HOW TO EXTEND:
 *   - New live estate GUID leaks in? Redact it in docs, then add its full
 *     lowercase value to LIVE_IDENTIFIER with a `// what it is` note.
 *   - A doc legitimately needs a NEW Microsoft constant GUID? It already passes
 *     (the gate only flags LIVE_IDENTIFIER); optionally record it in WELL_KNOWN
 *     for the next reader.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DOCS_ROOT = path.join(REPO_ROOT, 'docs');
const MKDOCS_YML = path.join(REPO_ROOT, 'mkdocs.yml');

// ── Live estate identifiers (operator's real coordinates) — full lowercase. ──
// Any occurrence in docs/ or mkdocs.yml is a leak. Replace with the placeholder
// shown in the comment.
const LIVE_IDENTIFIER = {
  // subscriptions -> <subscription-id>
  'e093f4fd-5047-4ee4-968d-a56942c665f3': 'subscription (DMLZ/console)',
  '363ef5d1-0e77-4594-a530-f51af23dbf8c': 'subscription (bureau DLZ)',
  'ca2b3e6b-f892-4c57-b9d8-b64e5799f9ea': 'subscription (2nd demo)',
  'a60a2fdd-c133-4845-9beb-31f470bf3ef5': 'subscription (ALZ/connectivity)',
  // tenant -> <tenant-id>
  'd1fc0498-f208-4b49-8376-beb9293acdf6': 'tenant (FedCiv DLZ)',
  // UAMI principal object-ids -> <uami-principal-id>
  '41d32562-f864-4450-8b84-cd3d59f58bf4': 'console UAMI principalId (centralus)',
  'e61f3eb3-c646-4183-8198-4c4a34cd9a01': 'console UAMI principalId (eastus2)',
  // UAMI / app client-ids -> <uami-client-id> / <app-client-id>
  'a654ed98-e060-490f-af5b-734dc17c5693': 'console UAMI clientId (centralus)',
  'c6272de5-3c4e-4b72-8b57-71b2e950209b': 'console UAMI clientId (eastus2)',
  '9844c28c-3b3a-4949-8d63-9eefa3b50a9d': 'Entra app (MSAL/Dataverse) clientId',
  // deploy service-principal appId -> <sp-client-id>
  '95ca491e-f841-43ba-93f2-3315804f55e7': 'limitlessdata_deploy SP appId',
  // operator object-ids -> <operator-object-id>
  'b9c3cc65-522e-49c9-ad02-914676aa5a6b': 'operator OID (Synapse initial admin)',
  '866a2e12-0fee-4c99-923c-7cdfd61e08cd': 'operator OID (UAT_OID)',
  // workspace GUIDs -> <workspace-id> / <log-analytics-workspace-id>
  '0e377570-846d-4cf3-a3cf-15cf5dbae5be': 'Loom workspace-under-test GUID',
  '01273839-800f-4fef-86bf-85e94cdf3a65': 'Log Analytics workspace customerId',
};

// ── Public Microsoft constants — legitimately present in docs, NOT leaks. ──
const WELL_KNOWN = new Set([
  '00000000-0000-0000-0000-000000000000', // null GUID / placeholder
  // Azure built-in role-definition IDs
  'ba92f5b4-2d11-453d-a403-e96b0029c9fe', // Storage Blob Data Contributor
  'b24988ac-6180-42a0-ab88-20f7382dd24c', // Contributor
  'acdd72a7-3385-48ef-bd42-f606fba81ae7', // Reader
  '4633458b-17de-408a-b874-0445c86b69e6', // Key Vault Secrets User
  '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd', // Cognitive Services OpenAI User
  'a97b65f3-24c7-4388-baec-2e87135dc908', // Cognitive Services User
  '5bd9cd88-fe45-4216-938b-f97437e15450', // DocumentDB Account Contributor
  '749f88ad-0bdc-4e1b-a8b6-bfb96b995e05', // Monitoring Contributor
  '73c42c96-874c-492b-b04d-ab87d138a893', // Log Analytics Reader
  '43d0d8ad-25c7-4714-9337-8ba259a9fe05', // Monitoring Reader
  '72fafb9e-0641-4937-9268-a91bfd8191a3', // Cost Management Reader
  '9b7fa17d-e63e-47b0-bb0a-15c516ac86ec', // SQL DB Contributor
  '17d1049b-9a84-46fb-8f53-869881c3d3ab', // Storage Account Contributor
  'a638d3c7-ab3a-418d-83e6-5f17a39d4fde', // Azure Event Hubs Data Receiver
  '5dffeca3-4936-4216-b2bc-10343a5abb25', // Azure Event Hubs Data Owner
  'f58310d9-a9f6-439a-9e8d-f62e7b41a168', // Storage Blob Data Owner
  'db79e9a7-68ee-4b58-9aeb-b90e7c24fcba', // Key Vault Crypto Officer
  '1ec5b3c1-b17e-4e25-8312-2acb3c3c5abf', // Automation/runbook role constant
  '6e4bf58a-b8e1-4cc3-bbf9-d73143322b78', // Synapse SQL Administrator constant
  // Microsoft first-party application IDs
  '00000003-0000-0000-c000-000000000000', // Microsoft Graph
  '797f4846-ba00-4fd7-ba43-dac1f8f63013', // Windows Azure Service Management API
  '1950a258-227b-4e31-a9cf-717495945fc2', // Azure PowerShell
  // Microsoft Graph API permission (AppRole) IDs
  '19da66cb-0fb0-4390-b071-ebc76a349482', // InformationProtectionPolicy.Read.All
  '57f0b71b-a759-45a0-9a0f-cc099fbd9a44', // SensitivityLabel.Evaluate
  'bf394140-e372-4bf9-a898-299cfc7564e5', // SecurityAlert.Read.All
  '246dd0d5-5bd0-4def-940b-0421030a5b68', // Policy.Read.All
]);

// Operator email / tenant domains — no placeholder form is ever legitimate.
const LEAKED_DOMAINS = [/housegarofalo\.com/gi, /limitlessdata\.ai/gi];
// Live Front Door hostnames (a label before .azurefd.net); bare "azurefd.net"
// meta-mentions in prose are intentionally NOT matched.
const AZUREFD_HOST = /[A-Za-z0-9][A-Za-z0-9-]*\.azurefd\.net/gi;
// Live Databricks workspace host.
const DATABRICKS_HOST = /adb-7405613013893759\.\d+\.azuredatabricks\.net/gi;

const liveGuidRes = Object.keys(LIVE_IDENTIFIER).map((g) => ({ g, re: new RegExp(g, 'gi') }));

function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'site') continue;
      walk(full, out);
    } else {
      out.push(full);
    }
  }
  return out;
}

function rel(f) { return path.relative(REPO_ROOT, f).split(path.sep).join('/'); }

function scanFile(abs, violations) {
  let src;
  try { src = fs.readFileSync(abs, 'utf8'); } catch { return; }
  const lines = src.split('\n');
  lines.forEach((line, i) => {
    const record = (kind, match) => violations.push({ file: rel(abs), line: i + 1, kind, match });
    for (const { g } of liveGuidRes) {
      if (line.toLowerCase().includes(g)) record(`live ${LIVE_IDENTIFIER[g]}`, g);
    }
    for (const re of LEAKED_DOMAINS) { re.lastIndex = 0; let m; while ((m = re.exec(line)) !== null) record('operator domain', m[0]); }
    AZUREFD_HOST.lastIndex = 0; let m;
    while ((m = AZUREFD_HOST.exec(line)) !== null) record('front-door host', m[0]);
    DATABRICKS_HOST.lastIndex = 0;
    while ((m = DATABRICKS_HOST.exec(line)) !== null) record('databricks host', m[0]);
  });
}

function main() {
  // Sanity: a public constant must never be misclassified as a live leak.
  const overlap = Object.keys(LIVE_IDENTIFIER).filter((g) => WELL_KNOWN.has(g));
  if (overlap.length) {
    console.error('[docs-hygiene] FAIL — WELL_KNOWN constants misfiled as LIVE_IDENTIFIER:');
    for (const g of overlap) console.error(`  - ${g}`);
    process.exit(1);
  }

  const files = [MKDOCS_YML, ...walk(DOCS_ROOT)];
  const violations = [];
  for (const f of files) scanFile(f, violations);

  console.log(`[docs-hygiene] files scanned: ${files.length}`);
  console.log(`[docs-hygiene] live identifiers tracked: ${liveGuidRes.length}  well-known constants: ${WELL_KNOWN.size}`);

  if (violations.length) {
    console.error(`\n[docs-hygiene] FAIL — ${violations.length} live estate identifier / PII leak(s) in the docs site:`);
    for (const v of violations) console.error(`  ${v.file}:${v.line}  [${v.kind}]  ${v.match}`);
    console.error('\nFix: replace each with an angle-bracket placeholder');
    console.error('(<subscription-id> / <tenant-id> / <uami-principal-id> / <uami-client-id> /');
    console.error(' <app-client-id> / <sp-client-id> / <operator-object-id> / <workspace-id> /');
    console.error(' <your-console-hostname> / admin@contoso.gov). See scripts/ci/check-docs-hygiene.mjs.');
    process.exit(1);
  }

  console.log('[docs-hygiene] OK — no live estate identifiers or operator PII in docs/ or mkdocs.yml.');
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
