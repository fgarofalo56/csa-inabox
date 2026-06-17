/**
 * Pure helpers for inline code completion (ghost text) — extracted from the
 * /api/copilot/complete route so they can be unit-tested without spinning up
 * Next.js or Azure OpenAI.
 *
 * - buildInlineMessages: assembles the AOAI chat-completions system+user pair
 *   from the code prefix, language, up-to-3 prior cells, and schema context.
 * - cleanInlineCompletion: strips stray markdown fences and trims any overlap
 *   where the model echoed the tail of the prefix.
 */

export const INLINE_LANG_LABEL: Record<string, string> = {
  pyspark: 'PySpark (Python)',
  python: 'Python',
  spark: 'Spark (Scala)',
  scala: 'Spark (Scala)',
  sql: 'Spark SQL',
  sparksql: 'Spark SQL',
  tsql: 'T-SQL',
  sparkr: 'SparkR (R)',
  csharp: '.NET for Spark (C#)',
};

export interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

/**
 * Cluster-runtime grounding for ghost-text completion. Kept in sync with
 * lib/components/editor/cluster-runtime.copilotRuntimeDirective (that module is
 * client-only / React-adjacent; this server-pure copy avoids importing it).
 */
function inlineRuntimeDirective(runtime?: string): string {
  switch (runtime) {
    case 'databricks':
      return (
        ' The notebook is attached to a DATABRICKS Spark cluster — complete with ' +
        'Databricks APIs (`dbutils.fs`/`dbutils.secrets`/`dbutils.widgets`/' +
        '`dbutils.notebook`, `display(df)`, Unity Catalog `catalog.schema.table` ' +
        'names, %sql/%md/%run/%pip magics). Do NOT emit mssparkutils/notebookutils.'
      );
    case 'azure-ml':
      return (
        ' The notebook runs on an AZURE MACHINE LEARNING Compute Instance (plain ' +
        'Python, no implicit Spark) — complete with the Azure ML SDK v2 ' +
        '(`azure.ai.ml` MLClient/command/automl) and `mlflow`. Do NOT assume a ' +
        '`spark`/`dbutils`/`mssparkutils` global exists.'
      );
    case 'synapse-spark':
    default:
      return (
        ' The notebook is attached to an AZURE SYNAPSE Spark pool — complete with ' +
        '`mssparkutils`/`notebookutils` (fs/credentials/env/runtime/notebook) and ' +
        '%%pyspark/%%spark/%%sql cell magics. Do NOT emit Databricks ' +
        '`dbutils`/`display()` or the Azure ML SDK.'
      );
  }
}

export function buildInlineMessages(
  prefix: string,
  lang: string,
  priorCells: string[],
  schema: string,
  runtime?: string,
): ChatMessage[] {
  const langName = INLINE_LANG_LABEL[lang] || lang;
  const schemaSection = schema.trim()
    ? `\n\nLakehouse schema context (ground completions in these — do not invent table/container names):\n${schema}`
    : '';

  const system =
    `You are an inline code-completion engine for the CSA Loom platform. ` +
    `The active cell is written in ${langName}.` +
    inlineRuntimeDirective(runtime) +
    ` The user has ` +
    `typed the PREFIX shown last. Continue the code from EXACTLY where the ` +
    `PREFIX ends. Return ONLY the new characters to insert after the cursor — ` +
    `do NOT repeat any of the prefix, do NOT wrap in markdown fences, do NOT ` +
    `add explanations or a language tag. Keep the suggestion focused (a single ` +
    `statement or a few lines). If you cannot produce a meaningful ` +
    `continuation, return an empty string.` +
    schemaSection;

  const cleanedPrior = (priorCells || [])
    .slice(-3)
    .map((c) => (c ?? '').trim())
    .filter(Boolean);
  const priorSection = cleanedPrior.length
    ? cleanedPrior.join('\n\n# --- previous cell ---\n') + '\n\n# --- current cell ---\n'
    : '';

  return [
    { role: 'system', content: system },
    { role: 'user', content: `${priorSection}${prefix}` },
  ];
}

/**
 * Strip a markdown fence the model may have added despite instructions, and
 * trim any overlap where the completion repeats the tail of the prefix.
 */
export function cleanInlineCompletion(raw: string, prefix: string): string {
  let out = raw
    .replace(/^\s*```[a-zA-Z0-9_+-]*\s*\n?/, '')
    .replace(/\n?```\s*$/, '');
  const tail = prefix.slice(-80);
  for (let n = Math.min(tail.length, out.length); n > 0; n--) {
    if (out.startsWith(tail.slice(tail.length - n))) {
      out = out.slice(n);
      break;
    }
  }
  return out;
}
