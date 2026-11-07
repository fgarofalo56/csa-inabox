// Authorization Server configuration. Same rules as src/config.ts: environment
// only, no secrets (the signing key stays in Key Vault; Entra and Graph are
// reached with the managed identity). The AS is not optional: a control plane
// that starts without it would serve no token endpoint while looking healthy,
// so every missing or malformed value stops startup with the variable named.

import { ConfigError, type Cloud } from '../config.js';
import { validateKeyVaultKeyId } from './signer.js';

export interface AuthServerConfig {
  /** Public issuer URL including its path, no trailing slash. */
  issuer: string;
  /** Public FHIR edge base; a tenant's FHIR base is `${fhirEdgeBase}/{tenant}/fhir`. */
  fhirEdgeBase: string;
  /** App registration (client id) of the AS in this cloud's Entra tenant. */
  asClientId: string;
  /** Full versioned Key Vault key id used to sign LHDS tokens. */
  signingKeyId: string;
  /** Optional admin-consent URL surfaced by the readiness gate's Fix-it. */
  graphConsentUrl?: string;
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cleanHttps(name: string, v: string): string {
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new ConfigError(`${name} must be an https URL`);
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) {
    throw new ConfigError(`${name} must be an https URL without credentials, query or fragment`);
  }
  return v.replace(/\/+$/, '');
}

export function loadAuthServerConfig(cloud: Cloud, env: NodeJS.ProcessEnv = process.env): AuthServerConfig {
  const missing: string[] = [];
  const need = (name: string): string => {
    const v = (env[name] ?? '').trim();
    if (!v) missing.push(name);
    return v;
  };
  const issuer = need('LOOM_HEALTH_CP_ISSUER_URL');
  const fhirEdgeBase = need('LOOM_HEALTH_CP_FHIR_BASE_URL');
  const asClientId = need('LOOM_HEALTH_CP_AS_CLIENT_ID');
  const signingKeyId = need('LOOM_HEALTH_CP_SIGNING_KEY_ID');
  if (missing.length > 0) {
    throw new ConfigError(`missing required environment for the authorization server: ${missing.join(', ')}`);
  }
  if (!GUID.test(asClientId)) throw new ConfigError('LOOM_HEALTH_CP_AS_CLIENT_ID must be an app registration GUID');
  try {
    validateKeyVaultKeyId(cloud, signingKeyId);
  } catch {
    throw new ConfigError(
      'LOOM_HEALTH_CP_SIGNING_KEY_ID must be a versioned Key Vault key id (https://<vault>.<cloud suffix>/keys/<name>/<version>)',
    );
  }
  const consent = (env.LOOM_HEALTH_CP_GRAPH_CONSENT_URL ?? '').trim();
  return {
    issuer: cleanHttps('LOOM_HEALTH_CP_ISSUER_URL', issuer),
    fhirEdgeBase: cleanHttps('LOOM_HEALTH_CP_FHIR_BASE_URL', fhirEdgeBase),
    asClientId,
    signingKeyId,
    ...(consent ? { graphConsentUrl: cleanHttps('LOOM_HEALTH_CP_GRAPH_CONSENT_URL', consent) } : {}),
  };
}
