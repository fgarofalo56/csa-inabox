/**
 * Phase 2 — Notebook provisioner.
 *
 * Imports a NotebookContent bundle (cells + defaultLang) as a real, runnable
 * notebook into whichever data engine the Loom is wired to. Three backends, in
 * priority order, each a real REST import — never a mock:
 *
 *   1. Fabric (when target.fabricWorkspaceId is bound)
 *      POST /v1/workspaces/{wsid}/notebooks (create item) then
 *      updateDefinition with the cells inline-base64 as an .ipynb part.
 *      Idempotent: an existing same-named notebook is updateDefinition'd.
 *
 *   2. Azure Synapse Analytics (when LOOM_SYNAPSE_WORKSPACE is set and no
 *      Fabric workspace is bound). PUT
 *      https://{ws}.dev.azuresynapse.net/notebooks/{name}?api-version=2020-12-01
 *      with a Jupyter nbformat-4 notebook artifact (code + markdown cells).
 *      This is the same Synapse Studio notebook artifact you would author in
 *      the portal — fully runnable against a Spark Big Data pool.
 *
 *   3. Azure Databricks (when LOOM_DATABRICKS_HOSTNAME is set and neither
 *      Fabric nor Synapse is configured). POST /api/2.0/workspace/import
 *      with the cells serialized to Databricks SOURCE format
 *      (`# Databricks notebook source`, `# COMMAND ----------` cell
 *      delimiters, `# MAGIC %md` for markdown/non-default-language cells).
 *      Lands a real notebook under /Shared/loom-installs/<displayName>.
 *
 * Honest infra gate (per .claude/rules/no-vaporware.md): only when NONE of
 * the three are configured do we return status:'remediation' naming the
 * exact env var / bind action required. Fabric 401/403 also gates with the
 * verbatim error + the role grant required.
 */
import { createNotebook, listNotebooks, updateNotebookDefinition, FabricError, fabricHint } from '@/lib/azure/fabric-client';
import {
  synapseConfigGate,
  upsertNotebook as upsertSynapseNotebook,
  type SynapseNotebook,
} from '@/lib/azure/synapse-artifacts-client';
import {
  databricksConfigGate,
  importNotebook as importDatabricksNotebook,
  mkdirsWorkspace as mkdirsDatabricksWorkspace,
} from '@/lib/azure/databricks-client';
import type { Provisioner, ProvisionResult } from './types';
import { resolveInfraResidual } from './types';

/** Normalize a bundle cell to { type, lang, sourceLines[] } regardless of the
 * legacy alias used (`type`/`kind`, `lang`/`language`, string|string[] source). */
function normalizeCell(c: any): { isMarkdown: boolean; lang?: string; sourceLines: string[] } {
  const cellType = (c?.type ?? c?.kind) === 'markdown' ? 'markdown' : 'code';
  const isMarkdown = cellType === 'markdown';
  const lang = c?.lang ?? c?.language;
  let sourceLines: string[];
  if (typeof c?.source === 'string') {
    // Split keeping the trailing newline on every line except the last —
    // the standard Jupyter `source` array convention.
    sourceLines = c.source.split('\n').map((line: string, i: number, arr: string[]) =>
      i < arr.length - 1 ? line + '\n' : line,
    );
  } else if (Array.isArray(c?.source)) {
    sourceLines = c.source as string[];
  } else {
    sourceLines = [];
  }
  return { isMarkdown, lang, sourceLines };
}

/** Build a minimal Fabric notebook definition with one cell per bundle cell. */
function buildDefinition(content: any, displayName: string): { format: string; parts: Array<{ path: string; payload: string; payloadType: 'InlineBase64' }> } {
  const defaultLang = content?.defaultLang || 'pyspark';
  const cells: any[] = Array.isArray(content?.cells) ? content.cells : [];
  // Fabric expects a Jupyter-style .ipynb structure: cells[] with cell_type,
  // source (array of strings), language metadata.
  const ipynb = {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: { display_name: 'Synapse Pyspark', language: defaultLang === 'sparksql' ? 'sql' : defaultLang, name: defaultLang },
      language_info: { name: defaultLang === 'sparksql' ? 'sql' : 'python' },
      microsoft: { language: defaultLang, language_group: 'synapse_pyspark' },
    },
    cells: cells.map((c) => {
      // Canonical NotebookCell schema (lib/types/notebook-cell.ts) uses
      // `type` ('code'|'markdown') and `lang`. normalizeCell() also accepts
      // the legacy `kind`/`language` aliases so older bundles keep working.
      const { isMarkdown, lang: cellLang, sourceLines } = normalizeCell(c);
      return {
        cell_type: isMarkdown ? 'markdown' : 'code',
        execution_count: null,
        // Per-cell language metadata only meaningful for code cells.
        metadata: !isMarkdown && cellLang ? { microsoft: { language: cellLang } } : {},
        outputs: isMarkdown ? undefined : [],
        source: sourceLines,
      };
    }),
  };
  const payload = Buffer.from(JSON.stringify(ipynb), 'utf-8').toString('base64');
  return {
    format: 'ipynb',
    parts: [
      {
        path: 'notebook-content.ipynb',
        payload,
        payloadType: 'InlineBase64',
      },
      {
        path: '.platform',
        payload: Buffer.from(JSON.stringify({
          $schema: 'https://developer.microsoft.com/json-schemas/fabric/gitIntegration/platformProperties/2.0.0/schema.json',
          metadata: { type: 'Notebook', displayName },
          config: { version: '2.0' },
        }), 'utf-8').toString('base64'),
        payloadType: 'InlineBase64',
      },
    ],
  };
}

/** Map the bundle's defaultLang to a Synapse kernel language token. */
function synapseKernelLang(defaultLang: string): { kernel: string; languageInfo: string; magicLang: string } {
  // Synapse notebook artifacts carry a kernelspec + language_info.metadata
  // exactly like a Jupyter notebook. PySpark is the Synapse default.
  if (defaultLang === 'sparksql' || defaultLang === 'sql') {
    return { kernel: 'synapse_pyspark', languageInfo: 'sql', magicLang: 'sql' };
  }
  if (defaultLang === 'csharp' || defaultLang === 'spark') {
    return { kernel: 'synapse_pyspark', languageInfo: 'scala', magicLang: 'spark' };
  }
  return { kernel: 'synapse_pyspark', languageInfo: 'python', magicLang: 'pyspark' };
}

/** Build a real Synapse notebook artifact (Jupyter nbformat 4) from the
 * bundle. Code + markdown cells preserved; per-cell language carried in
 * the standard `metadata` so Synapse Studio renders each correctly. */
function buildSynapseNotebook(content: any, name: string, appId: string): SynapseNotebook {
  const defaultLang = content?.defaultLang || 'pyspark';
  const cells: any[] = Array.isArray(content?.cells) ? content.cells : [];
  const { kernel, languageInfo } = synapseKernelLang(defaultLang);
  return {
    name,
    properties: {
      description: `Installed from ${appId}`,
      nbformat: 4,
      nbformat_minor: 2,
      metadata: {
        kernelspec: { name: kernel, display_name: 'Synapse PySpark' },
        language_info: { name: languageInfo },
        microsoft: { language: defaultLang === 'sparksql' ? 'sparksql' : defaultLang },
      },
      cells: cells.map((c) => {
        const { isMarkdown, lang, sourceLines } = normalizeCell(c);
        return {
          cell_type: isMarkdown ? 'markdown' : 'code',
          metadata: !isMarkdown && lang ? { microsoft: { language: lang } } : {},
          source: sourceLines,
          ...(isMarkdown ? {} : { outputs: [], execution_count: null }),
        };
      }),
    },
  };
}

/** Map the bundle's defaultLang to a Databricks SOURCE notebook language. */
function databricksLang(defaultLang: string): { language: 'PYTHON' | 'SQL' | 'SCALA' | 'R'; magic: string } {
  if (defaultLang === 'sparksql' || defaultLang === 'sql') return { language: 'SQL', magic: 'sql' };
  if (defaultLang === 'spark' || defaultLang === 'scala') return { language: 'SCALA', magic: 'scala' };
  if (defaultLang === 'sparkr' || defaultLang === 'r') return { language: 'R', magic: 'r' };
  return { language: 'PYTHON', magic: 'python' };
}

/** Comment prefix for the SOURCE format header/magic lines, per notebook
 * default language (Databricks uses the language's line-comment token). */
function databricksCommentPrefix(language: 'PYTHON' | 'SQL' | 'SCALA' | 'R'): string {
  return language === 'SQL' ? '--' : language === 'SCALA' ? '//' : '#';
}

/**
 * Serialize the bundle cells into Databricks SOURCE format. The format is a
 * single text file the /api/2.0/workspace/import endpoint parses back into
 * cells:
 *   <cmt> Databricks notebook source     (header — sets the notebook language)
 *   <cell-1 source>
 *   <cmt> COMMAND ----------             (cell delimiter)
 *   <cmt> MAGIC %md                      (markdown / non-default-language cell)
 *   <cmt> MAGIC <line>
 *   ...
 * Markdown cells and cells whose language differs from the notebook default
 * are emitted as MAGIC blocks with the right `%<lang>` token so Databricks
 * renders/executes them exactly as authored.
 */
function buildDatabricksSource(content: any, displayName: string): { source: string; language: 'PYTHON' | 'SQL' | 'SCALA' | 'R' } {
  const defaultLang = content?.defaultLang || 'pyspark';
  const cells: any[] = Array.isArray(content?.cells) ? content.cells : [];
  const { language, magic: defaultMagic } = databricksLang(defaultLang);
  const cmt = databricksCommentPrefix(language);

  const cellBlocks: string[] = [];
  for (const c of cells) {
    const { isMarkdown, lang, sourceLines } = normalizeCell(c);
    const body = sourceLines.join('').replace(/\n$/, '');
    const cellMagic = databricksLang(lang || defaultLang).magic;
    // A cell is "native" (no MAGIC needed) when it's a code cell in the
    // notebook's default language. Everything else (markdown or a different
    // language) becomes a MAGIC block.
    const needsMagic = isMarkdown || cellMagic !== defaultMagic;
    if (!needsMagic) {
      cellBlocks.push(body);
    } else {
      const magicToken = isMarkdown ? 'md' : cellMagic;
      const lines = body.split('\n');
      const magicLines = [`${cmt} MAGIC %${magicToken}`, ...lines.map((l) => `${cmt} MAGIC ${l}`)];
      cellBlocks.push(magicLines.join('\n'));
    }
  }

  const header = `${cmt} Databricks notebook source`;
  const delimiter = `\n\n${cmt} COMMAND ----------\n\n`;
  const source = `${header}\n${cellBlocks.join(delimiter)}\n`;
  return { source, language };
}

/**
 * Fall back to the configured Azure-native data engine (Synapse, then
 * Databricks) when no Fabric workspace is bound. Returns a ProvisionResult
 * on success/gate, or null when neither backend is configured (caller emits
 * the combined remediation gate).
 */
async function provisionAzureNative(
  input: { content: unknown; displayName: string; appId: string },
  steps: string[],
): Promise<ProvisionResult | null> {
  const cellCount = (input.content as any)?.cells?.length || 0;

  // Explicit Databricks opt-in. The Azure-native DEFAULT precedence is Synapse
  // Spark (Hive) first, then Databricks — so a Loom with BOTH configured runs
  // notebooks on Synapse. When the operator explicitly selects Databricks
  // (LOOM_NOTEBOOK_BACKEND=databricks) AND Databricks is configured, prefer it
  // so the engine that runs the notebook matches the dialect the sample content
  // bundles emit for Databricks (Unity Catalog SQL). Without this, UC SQL would
  // land on Synapse Spark and fail to parse (the realtime-analytics CATALOG bug).
  const preferDatabricks = process.env.LOOM_NOTEBOOK_BACKEND === 'databricks' && !databricksConfigGate();

  // 1) Synapse dev-plane notebook artifact (skipped when Databricks is the
  //    explicitly selected engine).
  if (!preferDatabricks && !synapseConfigGate()) {
    const ws = process.env.LOOM_SYNAPSE_WORKSPACE!;
    steps.push(`No Fabric workspace bound — importing into Synapse workspace '${ws}'.`);
    // Synapse artifact names disallow spaces and several punctuation chars;
    // normalize to a safe artifact name while keeping it human-readable.
    const safeName = input.displayName.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'loom_notebook';
    const artifact = buildSynapseNotebook(input.content, safeName, input.appId);
    steps.push(`Built Synapse notebook artifact '${safeName}' with ${cellCount} cells.`);
    try {
      const saved = await upsertSynapseNotebook(safeName, artifact);
      steps.push('PUT /notebooks accepted (Synapse Studio artifact created).');
      return {
        status: 'created',
        resourceId: saved.id || `synapse:${ws}/notebooks/${safeName}`,
        secondaryIds: { synapseWorkspace: ws, synapseNotebook: safeName, backend: 'synapse' },
        steps,
      };
    } catch (e: any) {
      const msg = e?.message || String(e);
      if (/\b401\b|\b403\b/.test(msg)) {
        return {
          status: 'remediation',
          gate: {
            reason: `Synapse dev-plane rejected the notebook import: ${msg}`,
            remediation:
              `Grant the Console UAMI the "Synapse Artifact Publisher" (or "Synapse Administrator") Synapse-RBAC role on workspace '${ws}'.`,
            link: `https://web.azuresynapse.net/?workspace=%2Fsubscriptions%2F${process.env.LOOM_SUBSCRIPTION_ID || ''}%2FresourceGroups%2F${process.env.LOOM_DLZ_RG || ''}%2Fproviders%2FMicrosoft.Synapse%2Fworkspaces%2F${ws}`,
          },
          steps,
        };
      }
      return resolveInfraResidual(msg, `Confirm the Synapse workspace '${ws}' exists and grant the Console UAMI the "Synapse Artifact Publisher" (or "Synapse Administrator") Synapse-RBAC role on it.`, { steps });
    }
  }

  // 2) Databricks workspace import (SOURCE format).
  if (!databricksConfigGate()) {
    const host = process.env.LOOM_DATABRICKS_HOSTNAME!;
    steps.push(`No Fabric workspace or Synapse configured — importing into Databricks '${host}'.`);
    const { source, language } = buildDatabricksSource(input.content, input.displayName);
    const safeName = input.displayName.replace(/[\/]+/g, '_').trim() || 'loom-notebook';
    const dir = '/Shared/loom-installs';
    const path = `${dir}/${safeName}`;
    steps.push(`Built Databricks SOURCE notebook (${language}) with ${cellCount} cells → ${path}.`);
    try {
      await mkdirsDatabricksWorkspace(dir);
      await importDatabricksNotebook(path, language, source, true);
      steps.push('POST /api/2.0/workspace/import accepted (notebook landed, overwrite=true).');
      return {
        status: 'created',
        resourceId: `databricks:${host}${path}`,
        secondaryIds: { databricksHost: host, databricksPath: path, backend: 'databricks' },
        steps,
      };
    } catch (e: any) {
      const msg = e?.message || String(e);
      if (/\b401\b|\b403\b/.test(msg)) {
        return {
          status: 'remediation',
          gate: {
            reason: `Databricks rejected the notebook import: ${msg}`,
            remediation:
              `Add the Console UAMI as a workspace user/admin on Databricks '${host}' (SCIM bootstrap) with CAN MANAGE on /Shared.`,
            link: `https://${host}`,
          },
          steps,
        };
      }
      return resolveInfraResidual(msg, `Confirm Databricks workspace '${host}' is reachable and add the Console UAMI as a workspace user/admin (SCIM bootstrap) with CAN MANAGE on /Shared so it can import notebooks.`, { link: `https://${host}`, steps });
    }
  }

  return null;
}

export const notebookProvisioner: Provisioner = async (input): Promise<ProvisionResult> => {
  const steps: string[] = [];
  const ws = input.target.fabricWorkspaceId;
  // Azure-native DEFAULT (Synapse Spark → Databricks), per
  // .claude/rules/no-fabric-dependency.md. A Fabric notebook is used ONLY when
  // explicitly opted into (LOOM_NOTEBOOK_BACKEND=fabric + bound ws) or when it
  // is the only configured backend (ws bound, no Synapse/Databricks). We never
  // require a Fabric workspace.
  const forceFabric = process.env.LOOM_NOTEBOOK_BACKEND === 'fabric';
  const azureConfigured = !!(process.env.LOOM_SYNAPSE_WORKSPACE || process.env.LOOM_DATABRICKS_HOSTNAME);

  if (!(forceFabric && ws) && azureConfigured) {
    const fallback = await provisionAzureNative(
      { content: input.content, displayName: input.displayName, appId: input.appId },
      steps,
    );
    if (fallback) return fallback;
  }

  if (!ws) {
    return {
      status: 'remediation',
      gate: {
        reason: 'No Azure notebook engine configured (no Synapse, no Databricks).',
        remediation:
          'Set LOOM_SYNAPSE_WORKSPACE to import + run as a Synapse Spark notebook, OR set LOOM_DATABRICKS_HOSTNAME to import as a Databricks notebook. (Binding a Fabric workspace is an optional alternative, not required.)',
        link: 'https://learn.microsoft.com/azure/synapse-analytics/spark/apache-spark-development-using-notebooks',
      },
      steps,
    };
  }
  steps.push(forceFabric
    ? `Fabric workspace (opt-in via LOOM_NOTEBOOK_BACKEND=fabric): ${ws}`
    : `No Azure notebook engine configured; using the bound Fabric workspace: ${ws}`);

  const definition = buildDefinition(input.content, input.displayName);
  steps.push(`Built notebook definition with ${(input.content as any)?.cells?.length || 0} cells.`);

  try {
    // Idempotency: see if a notebook with the same displayName already
    // lives in the Fabric workspace.  If so, updateDefinition.  Else
    // POST a new one.
    const existing = await listNotebooks(ws);
    const match = existing.find((n) => (n.displayName || '').toLowerCase() === input.displayName.toLowerCase());
    if (match?.id) {
      steps.push(`Found existing notebook '${match.displayName}' (${match.id}); updating definition.`);
      await updateNotebookDefinition(ws, match.id, definition);
      steps.push('updateDefinition accepted (long-running).');
      return { status: 'exists', resourceId: match.id, secondaryIds: { fabricWorkspaceId: ws }, steps };
    }
    steps.push('Creating new Fabric notebook…');
    const created = await createNotebook(ws, {
      displayName: input.displayName,
      description: `Installed from ${input.appId}`,
      definition,
    });
    steps.push(`Created notebook ${created.id}.`);
    return { status: 'created', resourceId: created.id, secondaryIds: { fabricWorkspaceId: ws }, steps };
  } catch (e: any) {
    if (e instanceof FabricError && (e.status === 401 || e.status === 403)) {
      return {
        status: 'remediation',
        gate: {
          reason: `Fabric ${e.status}: ${e.message}`,
          remediation:
            fabricHint(e.status) ||
            'The Console UAMI must be added to this Fabric workspace as a Contributor.',
          link: `https://app.fabric.microsoft.com/groups/${ws}/settings`,
        },
        steps,
      };
    }
    return resolveInfraResidual(e, fabricHint((e as any)?.status) || 'Add the Console UAMI to this Fabric workspace as a Contributor (and bind it to a capacity) so it can create the notebook.', { link: `https://app.fabric.microsoft.com/groups/${ws}/settings`, steps });
  }
};
