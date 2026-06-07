/**
 * Purview → MIP sensitivity-label lookup for ADLS Gen2 paths.
 *
 * When Microsoft Purview scans an ADLS Gen2 account, each file/folder becomes an
 * Atlas entity (`azure_datalake_gen2_path` / `azure_datalake_gen2_resource_set`)
 * whose qualifiedName is the canonical
 *   https://<account>.dfs.core.windows.net/<container>/<path>
 * The MIP sensitivity label applied to that asset surfaces on the entity (as an
 * attribute and/or as a `MICROSOFT.GOVERNANCE.LABELS.*`-style classification).
 *
 * This module reads that label so the lakehouse download proxy can stamp the
 * bytes (see lib/azure/mip-file-inject.ts). It is NON-throwing on the download
 * path: any miss (env unset, asset not scanned, no label, Purview unreachable)
 * returns null so the download still succeeds — the BFF reports an honest
 * `x-loom-mip-status` instead.
 *
 * Backends used (real, no mocks):
 *   - Purview Atlas Data Map  → getEntityByQualifiedName (purview-client.ts)
 *   - Microsoft Graph (opt.)  → listSensitivityLabels (mip-graph-client.ts) to
 *                                resolve a label NAME to its GUID when the scan
 *                                only recorded the display name.
 *
 * Gating: LOOM_PURVIEW_ACCOUNT must be set (the Console UAMI must also hold a
 * Purview Data Map "Data Reader" role on the root collection — granted via
 * scripts/csa-loom/grant-purview-datamap-role.sh with ROLE=data-reader).
 */

import { getEntityByQualifiedName, isPurviewConfigured } from './purview-client';
import { listSensitivityLabels } from './mip-graph-client';
import type { MipLabelInfo } from './mip-file-inject';

export type { MipLabelInfo };

/** Atlas entity types Purview assigns to ADLS Gen2 files / resource sets. */
const ADLS_ENTITY_TYPES = ['azure_datalake_gen2_path', 'azure_datalake_gen2_resource_set'];

const GUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
/** Same shape, un-anchored — finds a GUID embedded in a longer classification typeName. */
const GUID_SUBSTR_RE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/;

/** Build the canonical Purview qualifiedName for an ADLS Gen2 path. */
export function adlsQualifiedName(account: string, container: string, path: string): string {
  const clean = String(path || '').replace(/^\/+/, '');
  return `https://${account}.dfs.core.windows.net/${container}/${clean}`;
}

/**
 * Pull a label name + (best-effort) GUID off a scanned Atlas entity. Purview has
 * exposed sensitivity labels under several shapes across versions; probe the
 * known attribute keys and the classifications array.
 */
function extractLabel(entity: any): { name?: string; id?: string } {
  const attrs = entity?.attributes || {};
  const name =
    attrs.sensitivityLabel ||
    attrs.microsoft_label_name ||
    attrs.sensitivity_label ||
    undefined;
  const id =
    attrs.sensitivityLabelId ||
    attrs.microsoft_label_id ||
    attrs.sensitivity_label_id ||
    undefined;
  if (name || id) return { name, id };

  // Classifications: scans can record the label as a classification whose
  // typeName carries the label GUID (MICROSOFT.GOVERNANCE.LABELS.<guid>) or name.
  const classifications = entity?.classifications;
  if (Array.isArray(classifications)) {
    for (const c of classifications) {
      const tn: string = c?.typeName || '';
      if (/label/i.test(tn)) {
        const guidMatch = tn.match(GUID_SUBSTR_RE);
        return { id: guidMatch ? guidMatch[0] : undefined, name: guidMatch ? undefined : tn };
      }
    }
  }
  return {};
}

/**
 * Resolve the sensitivity label assigned to an ADLS Gen2 path in Purview.
 * Returns null (never throws) when nothing is applicable so the download path
 * degrades gracefully.
 */
export async function getLabelForAdlsPath(
  account: string,
  container: string,
  path: string,
): Promise<MipLabelInfo | null> {
  if (!isPurviewConfigured() || !account) return null;
  const qn = adlsQualifiedName(account, container, path);

  let entity: any = null;
  for (const type of ADLS_ENTITY_TYPES) {
    try {
      const res = await getEntityByQualifiedName(type, qn);
      if (res?.entity) { entity = res.entity; break; }
    } catch {
      // 404 / type-not-defined → try the next type; auth/network → treat as miss.
    }
  }
  if (!entity) return null;

  const { name, id } = extractLabel(entity);
  let labelId = id && GUID_RE.test(id) ? id : '';
  let labelName = name || '';

  // If we only have a name (or only a non-GUID id), resolve the real GUID via
  // Graph when MIP is enabled. Best-effort — leave as-is on failure.
  if ((!labelId || !labelName) && process.env.LOOM_MIP_ENABLED === 'true') {
    try {
      const labels = await listSensitivityLabels();
      const match = labels.find(
        (l) =>
          (labelId && l.id === labelId) ||
          (labelName &&
            ((l.displayName || '').toLowerCase() === labelName.toLowerCase() ||
              (l.name || '').toLowerCase() === labelName.toLowerCase())),
      );
      if (match) {
        labelId = match.id;
        labelName = match.displayName || match.name || labelName;
      }
    } catch {
      /* Graph not consented / disabled — keep what we have. */
    }
  }

  if (!labelId || !GUID_RE.test(labelId)) return null; // no usable GUID → cannot stamp
  return {
    labelId,
    labelName: labelName || labelId,
    setDate: new Date().toISOString(),
    siteId: process.env.LOOM_MSAL_TENANT_ID || process.env.AZURE_TENANT_ID || undefined,
    method: 'Standard',
  };
}
