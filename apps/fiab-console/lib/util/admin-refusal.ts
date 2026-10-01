/**
 * Turn a BFF refusal envelope into the text a surface shows the user.
 *
 * Tenant-admin routes answer a non-admin with the canonical 403 envelope
 * `{ ok:false, error:'forbidden', code:'admin_only', reason, remediation }`
 * (`requireTenantAdmin` in lib/auth/feature-gate). `error` there is the bare
 * token "forbidden", so a surface that renders `j.error` shows the user one
 * word and no way forward. This reads `reason` + `remediation` for that code
 * and falls back to `error`, then to the HTTP status, for every other refusal.
 *
 * Pure (no React) so the editors and dialogs share one reading of the shape.
 */

export interface RefusalEnvelope {
  ok?: boolean;
  code?: string;
  error?: string;
  reason?: string;
  remediation?: string;
}

/** True for the canonical tenant-admin refusal. */
export function isAdminOnlyRefusal(j: RefusalEnvelope | null | undefined): boolean {
  return !!j && j.ok === false && j.code === 'admin_only';
}

/**
 * The message to show for a failed response. `admin_only` → reason and
 * remediation (or a generic tenant-admin sentence if the route sent neither);
 * otherwise `error`, else `HTTP <status>`, else a generic failure.
 */
export function refusalText(j: RefusalEnvelope | null | undefined, status?: number): string {
  if (isAdminOnlyRefusal(j)) {
    const text = [j!.reason, j!.remediation].filter((s) => typeof s === 'string' && s.trim()).join(' ');
    return text || 'Only a tenant admin can make this change.';
  }
  if (j && typeof j.error === 'string' && j.error.trim()) return j.error;
  return typeof status === 'number' ? `HTTP ${status}` : 'The request failed.';
}
