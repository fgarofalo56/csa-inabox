/**
 * data-access-mode — DORMANT switchboard for which identity backs server-side
 * data-plane calls (EH Phase-1). DEFAULT is the SHARED Console UAMI, byte-for-byte
 * identical to today; the per-user On-Behalf-Of path is opt-in and never on by
 * default.
 *
 * ## Modes — LOOM_OBO_DATA_PLANE (default `off`)
 *
 *   off    — DEFAULT. Always the shared {@link uamiArmCredential}. No OBO code
 *            runs; behavior is identical to before this scaffold existed.
 *   shadow — Returns the SHARED credential (creds NEVER switch), but, when a raw
 *            user assertion is available, ALSO tries to mint the OBO token and
 *            logs success/failure. Pure observability to prove OBO would work
 *            before flipping `on`.
 *   on     — Returns a credential backed by the per-user OBO token; on ANY
 *            failure (OBO unset, no assertion, exchange error) FALLS BACK to the
 *            shared credential. Never fails the call vs. today.
 *
 * `@azure/identity` is lazy-loaded (via dynamic import of arm-credential) so the
 * shared-UAMI default carries no extra static import cost; the OBO store is fetch
 * -only. ~233 existing shared-UAMI callers stay untouched until they opt a scope
 * in through this seam.
 */
/** OBO data-plane modes. */
export type OboMode = 'off' | 'shadow' | 'on';

/** Minimal session shape this seam reads. The cookie carries claims only; a raw
 *  user assertion is optional and absent today, so OBO stays dormant. */
export interface DataPlaneSession {
  claims?: { oid?: string; upn?: string };
  /** Raw user assertion for the OBO exchange when available (absent by default). */
  userAssertion?: string;
}

/** Structural TokenCredential (no @azure/core-auth import on the default path). */
export interface DataPlaneCredential {
  getToken(scopes: string | string[]): Promise<{ token: string; expiresOnTimestamp: number } | null>;
}

/** Current mode from LOOM_OBO_DATA_PLANE; anything but shadow|on resolves to off. */
export function oboMode(): OboMode {
  const v = (process.env.LOOM_OBO_DATA_PLANE || 'off').toLowerCase();
  return v === 'shadow' || v === 'on' ? v : 'off';
}

/** The shared Console UAMI credential — the DEFAULT for every mode's fallback. */
async function shared(): Promise<DataPlaneCredential> {
  const { uamiArmCredential } = await import('./arm-credential');
  return uamiArmCredential() as unknown as DataPlaneCredential;
}

/**
 * Resolve the credential a data-plane caller should use for `scope`. Default
 * (`off`) returns the shared UAMI identically to today. `shadow` returns shared
 * but logs an OBO acquisition attempt; `on` returns an OBO-backed credential with
 * silent fallback to shared. Never throws — a failure degrades to shared.
 */
export async function getDataPlaneCredential(
  session: DataPlaneSession | null | undefined,
  scope: string,
): Promise<DataPlaneCredential> {
  const mode = oboMode();
  if (mode === 'off') return shared();

  const assertion = session?.userAssertion;
  if (mode === 'shadow') {
    if (assertion) {
      try {
        const { acquireOboToken } = await import('./obo-token-store');
        await acquireOboToken(assertion, scope);
        console.warn('[obo:shadow] OBO acquire OK for scope', scope);
      } catch (e: any) {
        console.warn('[obo:shadow] OBO acquire failed (using shared):', e?.message || e);
      }
    } else {
      console.warn('[obo:shadow] no user assertion in session — using shared');
    }
    return shared();
  }

  // mode === 'on'
  if (!assertion) return shared();
  try {
    const { acquireOboToken } = await import('./obo-token-store');
    return {
      async getToken() {
        const token = await acquireOboToken(assertion, scope);
        return { token, expiresOnTimestamp: Date.now() + 50 * 60_000 };
      },
    };
  } catch {
    return shared();
  }
}
