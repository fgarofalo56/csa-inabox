// Derives the per-stamp PDP bundle data (data.lhds.config / data.lhds.stamp) from
// the routing map the control plane already publishes (W1-5). Pure: no I/O, no
// signing. apps/loom-health-pdp/tools/stage-policies.mjs writes the result into the
// staged bundle tree; build-bundle.sh signs and publishes it. The scope/role
// matrix is NOT here: it stays single-sourced in role-scope-map.v1.json.

import type { RoutingEntry } from '../routing/types.js';

export interface PdpStampInputs {
  /** Stamp these inputs belong to; the staged bundle is published as <stampId>.tar.gz. */
  stampId: string;
  /** data.lhds.config: AS issuer URL and the AS JWKS as a JSON string. */
  config: { issuer: string; jwks: string };
  /** data.lhds.stamp: tenants homed on this stamp and the bases a token aud may name. */
  stamp: { tenants: Record<string, { bases: string[] }> };
}

/** Path-prefix service bases (ADR-006): <stampBaseUrl>/<tenant>/fhir and /dicomweb. */
export const tenantBases = (stampBaseUrl: string, tenantSlug: string): string[] => {
  const root = stampBaseUrl.replace(/\/+$/, '');
  return [`${root}/${tenantSlug}/fhir`, `${root}/${tenantSlug}/dicomweb`];
};

export function buildPdpStampInputs(
  stampId: string,
  entries: RoutingEntry[],
  issuer: string,
  jwks: string,
): PdpStampInputs {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jwks);
  } catch {
    throw new Error('jwks is not valid JSON');
  }
  const keys = (parsed as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(keys) || keys.length === 0) throw new Error('jwks has no keys');
  let issuerUrl: URL;
  try {
    issuerUrl = new URL(issuer);
  } catch {
    throw new Error('issuer is not a URL');
  }
  if (issuerUrl.protocol !== 'https:') throw new Error('issuer must be https');

  const tenants: PdpStampInputs['stamp']['tenants'] = {};
  // Only active routes are homed: a paused/unavailable/suspended tenant must fall
  // to tenant-not-on-stamp rather than keep a live token working.
  for (const e of [...entries].sort((a, b) => a.tenantSlug.localeCompare(b.tenantSlug))) {
    if (e.stampId !== stampId || e.status !== 'active') continue;
    tenants[e.tenantSlug] = { bases: tenantBases(e.stampBaseUrl, e.tenantSlug) };
  }
  return { stampId, config: { issuer, jwks }, stamp: { tenants } };
}
