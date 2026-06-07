/**
 * Pure (React-free) validation helpers for the Lakehouse settings Spark
 * configuration editor + the Fabric-only acceleration disclosures.
 *
 * Kept out of lakehouse-editor.tsx so they can be unit-tested without pulling
 * in Fluent UI / Next. The editor imports `sparkConfigWarnings` and
 * `cloudFabricNote` from here.
 */

export type SparkConfWarn = { intent: 'warning' | 'error'; title: string; body: string };

export type CloudBoundary = 'commercial' | 'gcc' | 'gcch' | 'il5';

// Common Spark conf typos → the correct key + a short hint. Matched on the
// KEY (left of the first '='), case-insensitively where the casing isn't the
// point of the typo.
const SPARK_CONF_TYPOS: Array<[RegExp, string, string]> = [
  [/^spark\.shufflePartitions$/i, 'spark.sql.shuffle.partitions', 'Missing "spark.sql." prefix.'],
  [/^shuffle\.partitions$/i, 'spark.sql.shuffle.partitions', 'Missing "spark.sql." prefix.'],
  [/^spark\.sql\.shufflePartitions$/i, 'spark.sql.shuffle.partitions', 'Use dotted "shuffle.partitions".'],
  [/^spark\.sql\.autoBroadCastJoinThreshold$/i, 'spark.sql.autoBroadcastJoinThreshold', 'Capital "C" in "BroadCast" — should be lowercase.'],
  [/^spark\.executor\.mem$/i, 'spark.executor.memory', 'Abbreviated key — use the full "memory".'],
  [/^spark\.driver\.mem$/i, 'spark.driver.memory', 'Abbreviated key — use the full "memory".'],
  [/^spark\.executor\.core$/i, 'spark.executor.cores', 'Plural "cores".'],
  [/^spark\.sql\.adaptive\.enable$/i, 'spark.sql.adaptive.enabled', 'Key ends in "enabled", not "enable".'],
  [/^spark\.sql\.parquet\.vorder\.enable$/i, 'spark.sql.parquet.vorder.default', 'Renamed — use "spark.sql.parquet.vorder.default".'],
  [/^spark\.ms\.autotune\.enable$/i, 'spark.ms.autotune.enabled', 'Key ends in "enabled", not "enable".'],
];

const SPARK_CONF_FABRIC_ONLY_PREFIXES = ['spark.ms.', 'spark.sql.parquet.vorder.', 'spark.native.', 'spark.gluten.'];

/**
 * Validate a freeform KEY=VALUE-per-line Spark conf blob. Flags common typos
 * (error) and Fabric-only keys that silently no-op on the Azure-native Spark
 * path (warning). Lines starting with '#' or blank are ignored. No fabricated
 * errors — only known-bad keys produce output.
 */
export function sparkConfigWarnings(text: string): SparkConfWarn[] {
  const out: SparkConfWarn[] = [];
  const seen = new Set<string>();
  for (const line of (text || '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const idx = t.indexOf('=');
    const key = (idx > 0 ? t.slice(0, idx) : t).trim();
    if (!key) continue;
    for (const [re, correct, hint] of SPARK_CONF_TYPOS) {
      if (re.test(key) && key !== correct) {
        const k = `typo:${key}`;
        if (!seen.has(k)) {
          seen.add(k);
          out.push({ intent: 'error', title: `Possible typo: ${key}`, body: `Did you mean ${correct}? ${hint}` });
        }
      }
    }
    if (SPARK_CONF_FABRIC_ONLY_PREFIXES.some((p) => key.toLowerCase().startsWith(p))) {
      const k = `fabric:${key}`;
      if (!seen.has(k)) {
        seen.add(k);
        out.push({
          intent: 'warning',
          title: `Fabric-only key: ${key}`,
          body: 'This Spark configuration key only takes effect on Fabric Spark runtimes (Runtime 1.x / 2.x). It is silently ignored on Azure Synapse Spark pools and Databricks clusters.',
        });
      }
    }
  }
  return out;
}

/**
 * Extra honest disclosure for the Fabric-only acceleration toggles in clouds
 * that don't have Fabric F-SKU capacities at all. Empty string in Commercial
 * (where Fabric F-SKUs exist and the feature is opt-in).
 */
export function cloudFabricNote(cloud: CloudBoundary): string {
  switch (cloud) {
    case 'gcc':
      return ' This environment is GCC, which has no Fabric F-SKU capacities — there is no Fabric Spark path here, so this preference is recorded but has no runtime effect anywhere in GCC.';
    case 'gcch':
      return ' This environment is GCC-High, where Fabric Spark is not available — this preference is recorded but has no runtime effect.';
    case 'il5':
      return ' This environment is IL5 (DoD), where Fabric is not available — this preference is recorded but has no runtime effect.';
    default:
      return '';
  }
}
