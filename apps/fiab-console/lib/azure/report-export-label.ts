/**
 * WAVE-9 — Sensitivity-label stamping for report EXPORTS (Azure-native, no
 * Microsoft Fabric / Power BI dependency per `.claude/rules/no-fabric-dependency.md`).
 *
 * `applySensitivityStamp` is the single seam the export routes call right before
 * they stream bytes back to the browser. It keeps those routes minimal: all the
 * MIP logic (look up the report's applied label, honour protection rules, and
 * write the real MSIP_Label_* metadata into the file) lives here.
 *
 * Behaviour (all branches honest per `.claude/rules/no-vaporware.md`):
 *   1. No applied label, or MIP not enabled (`LOOM_MIP_ENABLED !== 'true'`) →
 *      return the bytes UNCHANGED (no-op). The download always succeeds.
 *   2. Protected label + an export format that cannot carry the protection
 *      (CSV / TXT) → `{ bytes, blocked: <reason> }`; the caller surfaces this as
 *      a 403 and does NOT stream the file (the protection would be stripped).
 *   3. Supported binary format (XLSX / PDF / other OOXML) → stamp the real
 *      MSIP_Label_<GUID>_* properties via `stampMipLabel` and return the stamped
 *      bytes. Unsupported-but-allowed types (e.g. PNG, raw text on an
 *      unprotected label) are returned unchanged.
 *
 * Resilience: every path is wrapped in try/catch. ANY failure (Cosmos read,
 * Graph lookup, stamper error) returns the ORIGINAL bytes unstamped rather than
 * throwing into the export pipeline — a label-service hiccup must never break a
 * user's download. Blocking is reserved for the deterministic, policy-driven
 * `checkExportProtection` decision (case 2 above), which is computed purely.
 *
 * Persisted state shape (written by the sensitivity route, additive + optional):
 *   state.sensitivityLabelId  — the MIP/Purview label GUID
 *   state.sensitivityLabel    — the label display NAME (catalog reads this)
 */
import type { SessionPayload } from '@/lib/auth/session';
import { loadOwnedItem } from '@/app/api/items/_lib/item-crud';
import { getSensitivityLabel } from './mip-graph-client';
import { checkExportProtection } from './label-protection';
import { stampMipLabel, isMipSupportedType } from './mip-file-inject';

/** Result of an export-time stamp attempt. */
export interface SensitivityStampResult {
  /** The bytes to stream — stamped when a supported label applied, else unchanged. */
  bytes: Buffer;
  /**
   * Set when the export is policy-blocked (protected label → CSV/TXT). The
   * caller returns 403 with this message and does NOT stream the file.
   */
  blocked?: string;
}

/**
 * Stamp `bytes` with the report's applied sensitivity label, or block the export
 * when the label's protection forbids the requested format.
 *
 * @param session  the caller's session (tenant ownership is enforced by `loadOwnedItem`)
 * @param reportId the report item id
 * @param bytes    the rendered export payload
 * @param ext      the export file extension WITHOUT a leading dot (e.g. 'xlsx', 'pdf', 'csv')
 */
export async function applySensitivityStamp(
  session: SessionPayload,
  reportId: string,
  bytes: Buffer,
  ext: string,
): Promise<SensitivityStampResult> {
  try {
    // MIP must be enabled tenant-side; otherwise we have nothing to enforce.
    if (process.env.LOOM_MIP_ENABLED !== 'true') return { bytes };

    const item = await loadOwnedItem(reportId, 'report', session.claims.oid);
    const state = (item?.state || {}) as Record<string, unknown>;
    const labelId = typeof state.sensitivityLabelId === 'string' ? state.sensitivityLabelId : '';
    if (!labelId) return { bytes };

    const label = await getSensitivityLabel(labelId);
    if (!label) return { bytes };

    // Policy gate (deterministic): a protected label cannot survive CSV/TXT.
    const chk = checkExportProtection(label, ext);
    if (chk.blocked) return { bytes, blocked: chk.reason };

    // Only OOXML / PDF can physically carry the MSIP_* metadata. Anything else
    // (already allowed by the policy gate above) streams unchanged.
    if (!isMipSupportedType(`f.${ext}`)) return { bytes };

    const stamped = stampMipLabel(bytes, `report.${ext}`, {
      labelId: label.id,
      labelName: label.name || label.displayName || label.id,
      setDate: new Date().toISOString(),
    });
    return { bytes: stamped.body };
  } catch {
    // Never let a label-service failure break an export — ship the bytes as-is.
    return { bytes };
  }
}
