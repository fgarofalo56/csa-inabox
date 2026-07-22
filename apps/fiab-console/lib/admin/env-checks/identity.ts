/**
 * R30 fragment — the 'identity' domain slice of ENV_CHECKS (formerly part of the
 * lib/admin/env-checks.ts monolith). An env-adding item edits ONLY its own
 * domain fragment; ./index.ts merges every fragment into the same exported
 * ENV_CHECKS array (public API unchanged). Import ONLY from './core' here —
 * never './index' (barrel-cycle rule, WS-E1 gotcha).
 */
import type { EnvSpec } from './core';

export const IDENTITY_ENV_CHECKS: EnvSpec[] = [
  // ── identity ──
  {
    id: 'session-secret', category: 'identity', title: 'Session signing secret', severity: 'critical',
    required: ['SESSION_SECRET'],
    remediation: 'Set SESSION_SECRET (resolved in CI from Key Vault by the deploy SP; never on disk). Without it sessions cannot be minted/verified.',
    provisionedBy: 'modules/admin-plane/main.bicep (param loomSessionSecret → ACA secret; empty → stable per-RG GUID)',
  },
  {
    id: 'entra-app', category: 'identity', title: 'Entra sign-in app (MSAL)', severity: 'critical',
    // The confidential client that performs interactive user login (lib/auth/msal.ts)
    // reads LOOM_MSAL_CLIENT_ID + LOOM_MSAL_CLIENT_SECRET — NOT AZURE_CLIENT_ID
    // (that is the Console UAMI, a managed identity that cannot do user login).
    // Keying the check on the MSAL vars matches what login actually requires so a
    // missing app-registration credential is reported honestly instead of looking
    // "configured" merely because the UAMI client id is set (PRP deploy-readiness
    // gap #2 — the same mis-keying the /auth/sign-in 503 gate had).
    required: ['LOOM_MSAL_CLIENT_ID', 'LOOM_MSAL_CLIENT_SECRET'],
    anyOf: [['AZURE_TENANT_ID', 'LOOM_MSAL_TENANT_ID']],
    remediation: 'Set LOOM_MSAL_CLIENT_ID + LOOM_MSAL_CLIENT_SECRET (the Entra app users sign in with) and AZURE_TENANT_ID. The push-button deploy provisions these automatically (loomMsalAppRegEnabled, default on) — re-run csa-loom-post-deploy-bootstrap.yml ("Provision MSAL app registration") or see docs/fiab/MSAL-handoff.md.',
    provisionedBy: 'modules/admin-plane/entra-app-registration.bicep (deploymentScript → app reg + secret in Key Vault) → loomMsalClientId / loom-msal-client-secret secretRef → apps[] env',
    role: 'Entra app registration with redirect URI for the Console host (reconciled by the deploy + bootstrap)',
  },
  {
    id: 'uami', category: 'identity', title: 'Console managed identity (UAMI)', severity: 'critical',
    required: ['LOOM_UAMI_CLIENT_ID'],
    remediation: 'Set LOOM_UAMI_CLIENT_ID to the user-assigned managed identity client id. Every Azure data-plane call authenticates as this identity.',
    provisionedBy: 'modules/admin-plane/main.bicep (uami-console resource → apps[] env, auto-derived)',
  },
];
