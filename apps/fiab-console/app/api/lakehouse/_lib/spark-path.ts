/**
 * The Spark boundary for a lakehouse path: the ONE place a scoped
 * container + path is turned into the `abfss://` URI a Spark reader loads.
 *
 * Two rules apply here and nowhere earlier:
 *
 *   1. Spark (Hadoop) readers treat `{ } [ ] * ?` and `\` in a path as GLOB
 *      syntax, so `a/{b,c}/t.parquet` reads two directories and `*` reads many.
 *      The storage REST routes take those characters literally — braces are
 *      legal in ADLS names and `pathSegments` accepts them — but a path handed
 *      to Spark must name exactly the file or table that was scoped. A path
 *      carrying any of them is refused here (`sparkGlobRefusal`) rather than
 *      escaped: Hadoop escaping differs between reader formats, and a refusal
 *      cannot load anything other than what was checked.
 *   2. The URI names the item's BOUND storage account (see
 *      `ScopedItemPath.account`) and the active cloud's DFS suffix, via
 *      `pathToHttpsUrlFor` + `httpsToAbfss` from `lib/azure/cloud-endpoints`,
 *      so a lakehouse bound to a non-primary account, or running in a sovereign
 *      cloud (`*.dfs.core.usgovcloudapi.net`), gets its own URI.
 */
import { pathToHttpsUrl, pathToHttpsUrlFor } from '@/lib/azure/adls-client';
import { httpsToAbfss } from '@/lib/azure/cloud-endpoints';

/** The characters a Spark / Hadoop path reader interprets as glob syntax. */
export const SPARK_GLOB_CHARS_RE = /[{}[\]*?\\]/;

/**
 * The 400 reason when `path` holds a Spark glob character, or null when it
 * holds none. Checked on the SCOPED path (already rebuilt from its segments),
 * so what is checked is what Spark would load.
 */
export function sparkGlobRefusal(path: string): string | null {
  const m = SPARK_GLOB_CHARS_RE.exec(String(path ?? ''));
  if (!m) return null;
  return `This path contains ${JSON.stringify(m[0])}, which Spark reads as a wildcard pattern rather than `
    + 'a literal name, so Loom cannot hand it to a Spark reader. Characters { } [ ] * ? and \\ are not '
    + 'supported in a path previewed or profiled on Spark; rename the file or folder and retry.';
}

export type SparkAbfss =
  | { ok: true; abfss: string }
  | { ok: false; status: 400 | 503; code?: 'not_configured'; error: string };

/**
 * The abfss URI Spark reads for a SCOPED container + path on `account` (the
 * item's bound account; null means the deployment's primary account, used only
 * by the tenant-admin form). Refuses a Spark glob character (400), and answers
 * 503 `not_configured` when no storage account is configured or the URL is not
 * a DFS URL of the active cloud.
 */
export function sparkAbfssFor(account: string | null, container: string, path: string): SparkAbfss {
  const glob = sparkGlobRefusal(path);
  if (glob) return { ok: false, status: 400, error: glob };
  let httpsUrl: string;
  try {
    httpsUrl = account ? pathToHttpsUrlFor(account, container, path) : pathToHttpsUrl(container, path);
  } catch (e: any) {
    return {
      ok: false, status: 503, code: 'not_configured',
      error: e?.message || 'ADLS account not configured — set LOOM_{BRONZE,SILVER,GOLD,LANDING}_URL.',
    };
  }
  const abfss = httpsToAbfss(httpsUrl);
  if (!abfss.startsWith('abfss://')) {
    return {
      ok: false, status: 503, code: 'not_configured',
      error: `The storage URL ${JSON.stringify(httpsUrl)} is not an ADLS Gen2 (DFS) URL for this cloud, so `
        + 'Loom cannot build the abfss:// path Spark reads. Check LOOM_{BRONZE,SILVER,GOLD,LANDING}_URL and LOOM_CLOUD.',
    };
  }
  return { ok: true, abfss };
}
