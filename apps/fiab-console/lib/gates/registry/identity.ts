/**
 * R30 fragment — the 'identity' domain slice of GATE_META (formerly part of the
 * lib/gates/registry.ts monolith; entries sit in the same domain as their
 * ENV_CHECKS spec in lib/admin/env-checks/identity.ts). ./index.ts merges every
 * fragment into the same exported GATE_META shape (public API unchanged).
 * Import ONLY from './types' here — never './index' (barrel-cycle rule).
 */
import type { GateMeta } from './types';

export const IDENTITY_GATE_META: Record<string, GateMeta> = {
  // ── identity / data-plane (deploy-critical; the deploy wires them) ──
  'session-secret': {
    surfaces: [{ path: '/auth/sign-in', label: 'Sign-in (session minting)' }],
    fixit: { kind: 'env-picker' },
  },
  'entra-app': {
    surfaces: [{ path: '/auth/sign-in', label: 'Sign-in (MSAL confidential client)' }],
    fixit: {
      kind: 'wizard',
      grantNote: 'Provisioned automatically by the push-button deploy (loomMsalAppRegEnabled) — re-run csa-loom-post-deploy-bootstrap.yml "Provision MSAL app registration" rather than hand-typing a client secret.',
    },
    legacyCodes: ['auth_error=not_configured'],
  },
  uami: {
    surfaces: [{ path: '*', label: 'Every Azure data-plane call (Console identity)' }],
    fixit: { kind: 'env-picker' },
  },
};
