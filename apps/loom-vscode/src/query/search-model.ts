/**
 * Estate-search model — PURE (no `vscode`) mapping of the `/api/catalog/find`
 * response into ranked, deployment-tagged hits for the quick-pick. Unit tested;
 * the cross-deployment rank order is a mutation-proof.
 *
 * `/api/catalog/find` (the `loom find` backend, ACL/tenant-scoped server-side)
 * returns, per deployment:
 *   { ok, q, backend, total, workspacesSearched, hits: [{ id, workspaceId,
 *     workspaceName, itemType, displayName, description?, tags[], updatedAt?,
 *     url, score }] }
 *
 * The extension queries EACH selected deployment (the P1 multi-deployment model)
 * and merges the results, tagging every hit with the deployment it came from so
 * the chosen item is opened against the right Console.
 */

/** One raw hit from `/api/catalog/find`. */
export interface FindHit {
  id: string;
  workspaceId: string;
  workspaceName: string;
  itemType: string;
  displayName: string;
  description?: string;
  tags?: string[];
  updatedAt?: string;
  url?: string;
  score?: number;
}

/** The `/api/catalog/find` envelope. */
export interface FindResponse {
  ok?: boolean;
  q?: string;
  backend?: string;
  total?: number;
  workspacesSearched?: number;
  hits?: FindHit[];
}

/** A hit tagged with the deployment it belongs to. */
export interface EstateHit extends FindHit {
  deploymentId: string;
  deploymentName: string;
  /** Whether more than one deployment was searched (drives label disambiguation). */
  multiDeployment: boolean;
  score: number;
}

/** Map one deployment's find response into tagged hits (drops malformed rows). */
export function mapFindResponse(
  deploymentId: string,
  deploymentName: string,
  res: FindResponse | null | undefined,
  multiDeployment: boolean,
): EstateHit[] {
  const hits = res && Array.isArray(res.hits) ? res.hits : [];
  const out: EstateHit[] = [];
  for (const h of hits) {
    if (!h || typeof h.id !== 'string' || typeof h.itemType !== 'string' || typeof h.displayName !== 'string') {
      continue; // never fabricate a hit from a malformed row
    }
    out.push({
      ...h,
      score: typeof h.score === 'number' ? h.score : 0,
      deploymentId,
      deploymentName,
      multiDeployment,
    });
  }
  return out;
}

/**
 * Merge + rank hits from every searched deployment. Highest score first; ties
 * break on display name (stable, case-insensitive) so the order is deterministic
 * across runs. Optionally caps the merged list.
 */
export function rankEstateHits(groups: EstateHit[][], limit?: number): EstateHit[] {
  const merged = ([] as EstateHit[]).concat(...groups);
  merged.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.displayName.toLowerCase().localeCompare(b.displayName.toLowerCase());
  });
  return typeof limit === 'number' && limit > 0 ? merged.slice(0, limit) : merged;
}
