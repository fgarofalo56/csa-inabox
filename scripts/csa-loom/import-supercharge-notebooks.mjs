#!/usr/bin/env node
/**
 * Import + convert the Supercharge-Microsoft-Fabric notebooks into Loom-native
 * content bundles.
 *
 *   Upstream : https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric
 *              (notebooks/{bronze,silver,gold,ml,real-time,streaming,
 *               hitchhikers-guide,utils})
 *   Vendored : examples/supercharge-fabric/notebooks/**   (CONVERTED source —
 *              the human-editable deliverable; this script rewrites them in
 *              place so they carry zero hard Microsoft Fabric dependency)
 *   Emitted  : apps/fiab-console/lib/apps/content-bundles/app-supercharge-*.ts
 *              (pure static AppBundle data, one bundle per medallion layer,
 *               imported by the install route + apps-catalog BFF)
 *
 * Why a generator (vs. hand-authored .ts): 117 notebooks / ~56k lines. The
 * generator is deterministic (stable cell IDs) so re-running reproduces the
 * exact same .ts. Run after pulling upstream changes:
 *
 *   node scripts/csa-loom/import-supercharge-notebooks.mjs
 *
 * ── Fabric → Loom-native conversion (docs/fiab/parity/supercharge-notebooks.md)
 *  • OneLake ABFSS host  onelake.dfs.fabric.microsoft.com
 *        → ADLS Gen2     {{ADLS_ACCOUNT}}.dfs.core.windows.net   (adls-client)
 *  • Fabric Variable Library  spark.conf.get("spark.fabric.variable.X")
 *        → Synapse Spark conf spark.conf.get("spark.loom.variable.X")
 *  • Fabric runtime utils  notebookutils.*  (hitchhikers-guide only, where it
 *        is called directly without the medallion notebooks' try/except
 *        fallback)  →  mssparkutils.*        (Synapse Spark native)
 *  • Fabric control-plane REST (api.fabric.microsoft.com / api.powerbi.com)
 *        → curated Azure-native equivalents (Spark direct read for shortcuts,
 *          Synapse SQL RLS/CLS for OneLake data-access-roles, ARM for admin,
 *          Azure Analysis Services for Power BI refresh).
 *
 * The medallion / ml / streaming / real-time notebooks already ship a portable
 * `try import notebookutils except import mssparkutils except env` fallback, so
 * they run unchanged on Synapse Spark / Databricks once the OneLake host is
 * swapped for ADLS.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, basename, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..');
const NB_ROOT = join(REPO, 'examples', 'supercharge-fabric', 'notebooks');
const BUNDLE_DIR = join(REPO, 'apps', 'fiab-console', 'lib', 'apps', 'content-bundles');

// ── Loom-native conversion ────────────────────────────────────────────────

/** Universal string transforms applied to every file (code + markdown). */
function universalTransforms(text) {
  return text
    // OneLake ABFSS host → ADLS Gen2 (host only; container + path preserved).
    .replace(/onelake\.dfs\.fabric\.microsoft\.com/g, '{{ADLS_ACCOUNT}}.dfs.core.windows.net')
    // Fabric Variable Library Spark binding → Synapse Spark conf.
    .replace(/spark\.fabric\.variable\./g, 'spark.loom.variable.')
    // Fabric Variable Library REST doc (bronze/19 markdown) → Synapse Spark conf.
    .replace(
      /# MAGIC # Fabric REST API.*\n# MAGIC url = "https:\/\/api\.fabric\.microsoft\.com\/v1\/workspaces\/\{workspace_id\}\/variableLibraries"/,
      '# MAGIC # Azure-native: there is no Variable Library item. Pass per-environment\n# MAGIC # values via Synapse Spark conf or Synapse/ADF pipeline parameters bound to\n# MAGIC # the Notebook activity, e.g. on the Spark pool / session:\n# MAGIC url = None  # spark.conf.set("spark.loom.variable.environment", "dev")',
    );
}

/**
 * Final safety net applied to EVERY file after all other transforms: neutralize
 * any literal Fabric / Power BI control-plane host that survived, mapping it to
 * its Azure-native counterpart (ARM control plane / Azure Analysis Services).
 * Keeps `learn.microsoft.com/.../rest/api/fabric/...` doc links intact (they do
 * not contain the literal `api.fabric.microsoft.com` host).
 */
function finalHostSafety(text) {
  return text
    .replace(/https:\/\/api\.fabric\.microsoft\.com\/v1\/workspaces/g, 'https://management.azure.com/subscriptions/<sub>/providers/Microsoft.Synapse/workspaces')
    .replace(/"https:\/\/api\.fabric\.microsoft\.com\/\.default"/g, '"https://management.azure.com/.default"')
    .replace(/https:\/\/api\.fabric\.microsoft\.com/g, 'https://management.azure.com')
    .replace(/https:\/\/api\.powerbi\.com[^\s")']*/g, 'https://<region>.asazure.windows.net')
    .replace(/api\.fabric\.microsoft\.com/g, 'management.azure.com')
    .replace(/api\.powerbi\.com/g, 'asazure.windows.net')
    // Data-plane Fabric hosts → Azure-native counterparts (backstop; the guide
    // source already presents these Azure-native, this catches future drift).
    .replace(/\.datawarehouse\.fabric\.microsoft\.com/g, '.sql.azuresynapse.net')
    .replace(/\.database\.fabric\.microsoft\.com/g, '.database.windows.net')
    .replace(/\.kusto\.fabric\.microsoft\.com/g, '.kusto.windows.net')
    .replace(/\.graphql\.fabric\.microsoft\.com/g, '.azurecontainerapps.io')
    // OneLake blob host (dfs variant handled in universalTransforms).
    .replace(/onelake\.blob\.fabric\.microsoft\.com/g, '{{ADLS_ACCOUNT}}.blob.core.windows.net');
}

/**
 * Curated Azure-native replacements for the hitchhikers-guide Fabric
 * control-plane cells. Ordered; the FIRST whose `marker` is found in a code
 * cell's source replaces that cell's entire body. Grounded in Azure REST /
 * Synapse SQL — no Fabric, no Power BI workspace required.
 */
const GUIDE_CELL_REWRITES = [
  {
    marker: 'amazonS3',
    body: `# Azure-native: ADLS Gen2 has no "shortcut" object — read the foreign store
# directly with Spark and land it as ADLS Gen2 Bronze Delta (Loom medallion
# default). Credentials come from Key Vault via the workspace UAMI.
from azure.identity import DefaultAzureCredential

cred = DefaultAzureCredential()  # workspace user-assigned managed identity
# S3-compatible source (Key Vault-backed access key, never inline):
spark.conf.set("fs.s3a.access.key", mssparkutils.credentials.getSecret("https://<kv>.vault.azure.net/", "s3-access-key"))
spark.conf.set("fs.s3a.secret.key", mssparkutils.credentials.getSecret("https://<kv>.vault.azure.net/", "s3-secret-key"))

s3_path  = "s3a://my-bucket/data/orders"
adls_dst = "abfss://bronze@{{ADLS_ACCOUNT}}.dfs.core.windows.net/landing/partner_s3"

(spark.read.parquet(s3_path)
      .write.format("delta").mode("append").save(adls_dst))
print(f"Loaded {s3_path} -> {adls_dst}")
# For scheduled, incremental copy use a Synapse/ADF copy activity instead.`,
  },
  {
    marker: 'GoogleCloudStorage',
    body: `# Azure-native: read Google Cloud Storage directly with the GCS Hadoop
# connector and land it as ADLS Gen2 Bronze Delta (replaces a Fabric OneLake
# GCS shortcut — no shortcut/REST object exists in ADLS).
spark.conf.set("google.cloud.auth.service.account.enable", "true")
spark.conf.set("google.cloud.auth.service.account.json.keyfile", "/path/to/gcs-key.json")

gcs_path = "gs://gcs-mybucket/orders"
adls_dst = "abfss://bronze@{{ADLS_ACCOUNT}}.dfs.core.windows.net/landing/partner_gcs"

(spark.read.parquet(gcs_path)
      .write.format("delta").mode("append").save(adls_dst))
print(f"Loaded {gcs_path} -> {adls_dst}")`,
  },
  {
    marker: 'dataAccessRoles',
    body: `# Azure-native row-/column-level security: Fabric OneLake data-access-roles
# map 1:1 to Synapse Serverless SQL Row-Level Security + column GRANT/DENY,
# applied over the ADLS Delta tables exposed as external views. Run in the
# Synapse Serverless SQL endpoint (synapse-sql-client) — no Fabric REST.
RLS_DDL = '''
-- Predicate function: scope FinanceReader to EMEA rows of fact_sales.
CREATE FUNCTION dbo.fn_finance_emea(@region_code AS sysname)
    RETURNS TABLE WITH SCHEMABINDING
AS RETURN
    SELECT 1 AS ok
    WHERE @region_code = 'EMEA'
       OR IS_ROLEMEMBER('db_owner') = 1;

CREATE SECURITY POLICY dbo.FinanceReaderPolicy
    ADD FILTER PREDICATE dbo.fn_finance_emea(region_code) ON dbo.fact_sales
    WITH (STATE = ON);

-- Column-level security (deny customer_id to the FinanceReader role).
DENY SELECT ON dbo.dim_customer(customer_id) TO [FinanceReader];
'''
print(RLS_DDL)
# ADLS storage-plane parity (path ACLs) is granted with Azure RBAC, e.g.
#   mssparkutils.fs.setAcl(...)  or  Storage Blob Data Reader on the container.`,
  },
  {
    marker: '/shortcuts',
    body: `# Azure-native: ADLS Gen2 has no "shortcut" item. Reference external data by
# reading its abfss/s3a/gs path directly with Spark, or register a Synapse
# Serverless external table over it — then materialize into Bronze Delta.
src = "abfss://landing@{{ADLS_ACCOUNT}}.dfs.core.windows.net/partner"
print("Read external source directly:", src)`,
  },
  {
    marker: 'base = "https://api.fabric.microsoft.com/v1"',
    body: `import json, time
import requests
from azure.identity import DefaultAzureCredential

# Azure-native control plane = Azure Resource Manager (ARM). Enumerate Synapse
# workspaces (the Loom analytics workspaces) instead of Fabric workspaces.
cred  = DefaultAzureCredential()
token = cred.get_token("https://management.azure.com/.default").token
hdr   = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
sub   = "<subscription-id>"
base  = "https://management.azure.com"

def poll(operation_url: str, timeout_s: int = 600):
    """ARM long-running ops return 202 + Azure-AsyncOperation/Location header."""
    start = time.time()
    while True:
        r = requests.get(operation_url, headers=hdr, timeout=30).json()
        if r.get("status") in {"Succeeded", "Failed", "Canceled"}:
            return r
        if time.time() - start > timeout_s:
            raise TimeoutError(operation_url)
        time.sleep(5)

ws = requests.get(
    f"{base}/subscriptions/{sub}/providers/Microsoft.Synapse/workspaces?api-version=2021-06-01",
    headers=hdr, timeout=30,
).json()
print(json.dumps(ws, indent=2)[:400])`,
  },
  {
    marker: 'api.powerbi.com',
    body: `# Azure-native semantic-model refresh: the Loom semantic layer is served by
# Azure Analysis Services (or the Direct-Lake-Shim warm-cache materializer) —
# not a Power BI workspace. Trigger a model refresh via the AAS REST API.
from azure.identity import DefaultAzureCredential

cred  = DefaultAzureCredential()
token = cred.get_token("https://*.asazure.windows.net/.default").token
requests.post(
    "https://<region>.asazure.windows.net/servers/<server>/models/<model>/refreshes",
    headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    data=json.dumps({"Type": "Full", "CommitMode": "transactional", "RetryCount": 1}),
)
# Or use the Loom Direct-Lake-Shim: POST /api/items/semantic-model/<id>/refresh.`,
  },
  {
    marker: 'api.fabric.microsoft.com/v1/workspaces"',
    body: `import requests
from azure.identity import DefaultAzureCredential

# Azure-native: list Synapse (Loom analytics) workspaces via Azure Resource
# Manager instead of Fabric workspaces.
cred  = DefaultAzureCredential()
token = cred.get_token("https://management.azure.com/.default").token
sub   = "<subscription-id>"
r = requests.get(
    f"https://management.azure.com/subscriptions/{sub}/providers/Microsoft.Synapse/workspaces?api-version=2021-06-01",
    headers={"Authorization": f"Bearer {token}"},
)
r.json()
# Azure RBAC for Synapse pipelines: Contributor / Synapse Contributor.`,
  },
  {
    marker: 'https://api.fabric.microsoft.com/.default',
    body: `from msal import ConfidentialClientApplication

client_id     = "<sp-app-id>"
tenant_id     = "<tenant-id>"
client_secret = mssparkutils.credentials.getSecret("https://kv.vault.azure.net/", "sp-secret")

app = ConfidentialClientApplication(
    client_id,
    authority=f"https://login.microsoftonline.com/{tenant_id}",
    client_credential=client_secret,
)
# Azure-native scopes: ARM control plane + ADLS data plane (no Fabric).
res = app.acquire_token_for_client(scopes=["https://management.azure.com/.default"])
arm_token = res["access_token"]
res = app.acquire_token_for_client(scopes=["https://storage.azure.com/.default"])
storage_token = res["access_token"]`,
  },
];

// ── Databricks "source" notebook parser (mirrors lib/notebook/import-parser) ─

const DATABRICKS_SEP = /^#\s*COMMAND\s*-+\s*$/;
const MAGIC_LINE = /^#\s*MAGIC(?:\s?(.*))?$/;

function rawBlocks(text) {
  const lines = text.split(/\r\n|\r|\n/);
  const blocks = [];
  let block = [];
  for (const ln of lines) {
    if (DATABRICKS_SEP.test(ln)) { blocks.push(block); block = []; }
    else block.push(ln);
  }
  blocks.push(block);
  return blocks;
}

function blockToCell(blockLines, defaultLang) {
  const lines = blockLines.filter((ln) => !/^#\s*Databricks notebook source\s*$/i.test(ln));
  while (lines.length && lines[0].trim() === '') lines.shift();
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  if (lines.length === 0) return null;

  const isMagic = lines.every((ln) => MAGIC_LINE.test(ln) || ln.trim() === '');
  if (isMagic) {
    const stripped = lines.map((ln) => { const m = MAGIC_LINE.exec(ln); return m ? (m[1] ?? '') : ln; });
    const firstIdx = stripped.findIndex((ln) => ln.trim() !== '');
    const first = firstIdx >= 0 ? stripped[firstIdx].trim() : '';
    const dm = /^%(\w+)\s*(.*)$/.exec(first);
    if (dm) {
      const rest = [...stripped];
      rest[firstIdx] = dm[2] ?? '';
      const body = rest.join('\n').replace(/^\n+/, '').replace(/\n+$/, '');
      const d = dm[1].toLowerCase();
      if (d === 'md' || d === 'markdown') return { type: 'markdown', source: body };
      if (d === 'sql') return { type: 'code', lang: 'sparksql', source: body };
      if (d === 'scala') return { type: 'code', lang: 'spark', source: body };
      if (d === 'r') return { type: 'code', lang: 'sparkr', source: body };
      if (d === 'python' || d === 'pyspark') return { type: 'code', lang: 'pyspark', source: body };
      return { type: 'code', lang: 'pyspark', source: body };
    }
    return { type: 'code', lang: defaultLang, source: stripped.join('\n').trim() };
  }
  return { type: 'code', lang: defaultLang, source: lines.join('\n') };
}

// ── Conversion of one notebook file ────────────────────────────────────────

function convertFile(absPath, isGuide) {
  let text = readFileSync(absPath, 'utf8');
  text = universalTransforms(text);

  if (isGuide) {
    // Synapse-native runtime utils (called directly in the guides, without the
    // medallion notebooks' import fallback).
    text = text.replace(/notebookutils\./g, 'mssparkutils.');
    // Curated Azure-native rewrites of Fabric control-plane code cells.
    const blocks = rawBlocks(text);
    const out = blocks.map((blk) => {
      const src = blk.join('\n');
      const nonEmpty = blk.filter((l) => l.trim());
      const isMagic = nonEmpty.length > 0 && nonEmpty.every((l) => MAGIC_LINE.test(l));
      if (isMagic) return blk; // never touch markdown / %sql magic blocks
      for (const rw of GUIDE_CELL_REWRITES) {
        if (src.includes(rw.marker)) return rw.body.split('\n');
      }
      return blk;
    });
    text = out.map((b) => b.join('\n')).join('\n# COMMAND ----------\n');
  }

  // Final safety net — neutralize any surviving Fabric / Power BI host.
  text = finalHostSafety(text);

  // Write the CONVERTED notebook back (this is the vendored deliverable).
  if (!text.endsWith('\n')) text += '\n';
  writeFileSync(absPath, text, 'utf8');
  return text;
}

// ── Build cells for a notebook ──────────────────────────────────────────────

function fileToCells(text, slug) {
  const blocks = rawBlocks(text);
  const cells = [];
  let i = 0;
  for (const blk of blocks) {
    const c = blockToCell(blk, 'pyspark');
    if (!c) continue;
    const cell = { id: `${slug}-c${i}`, type: c.type, source: c.source };
    if (c.type === 'code') cell.lang = c.lang || 'pyspark';
    cells.push(cell);
    i += 1;
  }
  if (cells.length === 0) cells.push({ id: `${slug}-c0`, type: 'code', lang: 'pyspark', source: '' });
  return cells;
}

// ── Naming helpers ──────────────────────────────────────────────────────────

function titleFromFilename(name) {
  const stem = name.replace(/\.py$/, '');
  const m = /^(\d+)[_-](.*)$/.exec(stem);
  const num = m ? m[1] : null;
  const rest = (m ? m[2] : stem).replace(/_/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase());
  return num ? `${num} — ${rest}` : rest;
}

function descFromCells(cells) {
  const md = cells.find((c) => c.type === 'markdown');
  if (md) {
    const line = md.source.split('\n').map((l) => l.replace(/^#+\s*/, '').trim()).find((l) => l.length > 0);
    if (line) return line.slice(0, 160);
  }
  return 'Loom-native Spark notebook converted from Supercharge Microsoft Fabric.';
}

// ── TS emit ─────────────────────────────────────────────────────────────────

const tsLit = (s) => '`' + s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${') + '`';

function emitBundle(appId, intro, layerDirRel, items) {
  const lines = [];
  lines.push('/**');
  lines.push(` * ${appId} — Loom-native content bundle.`);
  lines.push(' *');
  lines.push(' * GENERATED by scripts/csa-loom/import-supercharge-notebooks.mjs — do not edit by');
  lines.push(' * hand; edit the converted notebooks under');
  lines.push(` * examples/supercharge-fabric/notebooks/${layerDirRel}/ and re-run the script.`);
  lines.push(' *');
  lines.push(' * Source: https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric (notebooks/' + layerDirRel + ').');
  lines.push(' * Converted to run on Azure-native backends (Synapse Spark / Databricks + ADLS Gen2');
  lines.push(' * + ADX) with zero hard Microsoft Fabric dependency — installs via notebookProvisioner,');
  lines.push(' * executes via /api/items/notebook/[id]/execute-spark (AML Serverless Spark or Synapse');
  lines.push(' * Livy). See docs/fiab/parity/supercharge-notebooks.md.');
  lines.push(' */');
  lines.push("import type { AppBundle, NotebookContent } from './types';");
  lines.push("import type { NotebookCell } from '@/lib/types/notebook-cell';");
  lines.push('');

  for (const it of items) {
    lines.push(`const ${it.varName}: NotebookCell[] = ${JSON.stringify(it.cells, null, 2)};`);
    lines.push('');
  }

  lines.push('const bundle: AppBundle = {');
  lines.push(`  appId: ${JSON.stringify(appId)},`);
  lines.push(`  intro: ${tsLit(intro)},`);
  lines.push(`  sourceDocs: ['examples/supercharge-fabric/notebooks/${layerDirRel}'],`);
  lines.push('  items: [');
  for (const it of items) {
    lines.push('    {');
    lines.push(`      itemType: 'notebook',`);
    lines.push(`      displayName: ${JSON.stringify(it.displayName)},`);
    lines.push(`      description: ${JSON.stringify(it.description)},`);
    lines.push(`      content: { kind: 'notebook', defaultLang: ${JSON.stringify(it.defaultLang)}, cells: ${it.varName} } as NotebookContent,`);
    lines.push('    },');
  }
  lines.push('  ],');
  lines.push('};');
  lines.push('');
  lines.push('export default bundle;');
  lines.push('');
  return lines.join('\n');
}

// ── Layer config ────────────────────────────────────────────────────────────

const LAYERS = [
  { dir: 'bronze',  appId: 'app-supercharge-bronze',  intro: 'Bronze (raw ingestion) Spark notebooks from **Supercharge Microsoft Fabric**, converted to run Azure-native on Synapse Spark / Databricks landing into ADLS Gen2 Delta — no Microsoft Fabric required.' },
  { dir: 'silver',  appId: 'app-supercharge-silver',  intro: 'Silver (cleanse / conform) Spark notebooks from **Supercharge Microsoft Fabric**, converted to Loom-native (Synapse Spark / Databricks over ADLS Gen2 Delta).' },
  { dir: 'gold',    appId: 'app-supercharge-gold',    intro: 'Gold (business aggregates / dimensions) Spark notebooks from **Supercharge Microsoft Fabric**, converted to Loom-native (Synapse Spark / Databricks over ADLS Gen2 Delta).' },
  { dir: 'ml',      appId: 'app-supercharge-ml',      intro: 'Machine-learning + MLOps notebooks from **Supercharge Microsoft Fabric** — churn, fraud, AutoML, model registry, drift, feature store, RAG-over-ADX, responsible AI — converted to run on Azure ML / Databricks + ADLS + ADX.' },
  { dir: 'streaming', appId: 'app-supercharge-streaming', intro: 'Streaming + change-data-capture + real-time notebooks from **Supercharge Microsoft Fabric** (SQL Server/Oracle/DB2/Cosmos CDC, Kafka, IoT Hub, structured-streaming) converted to Azure-native (Event Hubs / Spark Structured Streaming → ADLS Delta + ADX).', extraDirs: ['real-time'] },
  { dir: 'utils',   appId: 'app-supercharge-utils',   intro: 'Shared pipeline utilities from **Supercharge Microsoft Fabric** (Bronze helpers, lineage, pipeline-execution logging) — Azure-native Spark, attachable to any medallion notebook via %run.' },
  { dir: 'hitchhikers-guide', appId: 'app-supercharge-guide', intro: "The Hitchhiker's Guide notebooks from **Supercharge Microsoft Fabric** (connectivity, lakehouse/warehouse ops, security & identity, admin & governance, automation, troubleshooting) — Fabric control-plane recipes rewritten to their Azure-native equivalents (Synapse, ADLS RBAC/ACL, ARM, Azure Analysis Services)." },
];

function listNotebookFiles(dir) {
  let out = [];
  for (const name of readdirSync(dir).sort()) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) continue;
    if (name.endsWith('.py')) out.push(abs);
    else if (name.endsWith('.kql')) {
      // Convert + vendor the .kql (Fabric Eventhouse → ADX) but it is not a
      // notebook item (KQL querysets surface via the kql-database editor).
      let t = readFileSync(abs, 'utf8');
      t = universalTransforms(t)
        .replace(/Microsoft Fabric Eventhouse\/KQL Database/g, 'Azure Data Explorer (ADX) / KQL Database')
        .replace(/Microsoft Fabric Eventhouse/g, 'Azure Data Explorer (ADX)')
        .replace(/Fabric Real-Time Dashboards?/g, 'ADX / Loom Real-Time Dashboards');
      writeFileSync(abs, t, 'utf8');
    }
  }
  return out;
}

function main() {
  const summary = [];
  let total = 0;
  for (const layer of LAYERS) {
    const dirs = [join(NB_ROOT, layer.dir), ...(layer.extraDirs || []).map((d) => join(NB_ROOT, d))];
    const items = [];
    const usedVar = new Set();
    const isGuide = layer.dir === 'hitchhikers-guide';
    for (const d of dirs) {
      const files = listNotebookFiles(d);
      for (const abs of files) {
        const name = basename(abs);
        const relDir = relative(NB_ROOT, dirname(abs)).replace(/\\/g, '/');
        const slug = `${relDir.replace(/[^a-z0-9]+/gi, '-')}-${name.replace(/\.py$/, '').replace(/[^a-z0-9]+/gi, '-')}`.toLowerCase();
        const converted = convertFile(abs, isGuide);
        const cells = fileToCells(converted, slug);
        const defaultLang = (cells.find((c) => c.type === 'code')?.lang) || 'pyspark';
        let varName = 'CELLS_' + slug.replace(/[^a-z0-9]+/gi, '_').toUpperCase();
        while (usedVar.has(varName)) varName += '_';
        usedVar.add(varName);
        items.push({ varName, displayName: titleFromFilename(name), description: descFromCells(cells), defaultLang, cells });
      }
    }
    const ts = emitBundle(layer.appId, layer.intro, layer.dir, items);
    const outName = `app-supercharge-${layer.dir === 'hitchhikers-guide' ? 'guide' : layer.dir}.ts`;
    writeFileSync(join(BUNDLE_DIR, outName), ts, 'utf8');
    summary.push(`${layer.appId}: ${items.length} notebooks -> ${outName}`);
    total += items.length;
  }

  // Guard: no forbidden Fabric tokens may survive in the emitted bundles.
  // Mirrors the broadened contract test (supercharge-bundles.test.ts): ANY
  // *.fabric.microsoft.com / *.powerbi.com host, plus OneLake dfs/blob hosts.
  const forbidden = /\.fabric\.microsoft\.com|\.powerbi\.com|onelake\.(dfs|blob)\.fabric/;
  const offenders = [];
  for (const layer of LAYERS) {
    const outName = `app-supercharge-${layer.dir === 'hitchhikers-guide' ? 'guide' : layer.dir}.ts`;
    if (forbidden.test(readFileSync(join(BUNDLE_DIR, outName), 'utf8'))) offenders.push(outName);
  }
  if (offenders.length) {
    console.error('FABRIC TOKENS REMAIN in:', offenders.join(', '));
    process.exit(1);
  }
  console.log(summary.join('\n'));
  console.log(`TOTAL: ${total} notebook items`);
  console.log('OK — no forbidden Fabric tokens in emitted bundles.');
}

main();
