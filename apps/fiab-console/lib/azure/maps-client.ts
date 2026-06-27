/**
 * maps-client — server-side resolver for the report-designer Azure Maps visual
 * (WAVE-5, Chunk C / shared-contract §D "Map aggregate / token contract").
 *
 * The map visual draws REAL bubbles / choropleth polygons from the SAME real
 * `/query` aggregate rows the rest of the report gallery uses. To reach the
 * Azure Maps data-plane (atlas.microsoft.com) the browser SDK needs either a
 * short-lived AAD token (preferred, gov-safe) or a subscription key (commercial
 * fallback). This module is the single server-side place that decides which —
 * it is consumed by the new `GET /api/items/report/[id]/map-token` route, which
 * adds the session + owner guard and returns this verdict as JSON.
 *
 * ## no-vaporware
 * There is no mock map. {@link resolveMapsBackend} returns an HONEST verdict:
 * either a usable credential (AAD token or key) OR `{ ok:false }` carrying the
 * exact env var to set. The report-designer keeps the full map surface + the
 * real aggregate rows visible on the `ok:false` path — never a dead control.
 *
 * ## no-fabric-dependency
 * Azure Maps is an Azure-native service. The token is scoped to the
 * `https://atlas.microsoft.com` audience ONLY — this module never acquires a
 * Fabric / Power BI token and never reaches `api.fabric.microsoft.com` /
 * `api.powerbi.com`. The map backend is strictly opt-in via `LOOM_MAPS_BACKEND`
 * (unset = honest gate, the default), so a deployment with no Maps account is
 * still 100% functional (gate + real rows).
 *
 * ## Auth model (two distinct GUIDs — do not conflate)
 * Azure Maps AAD auth requires two things on every data-plane call:
 *   1. `Authorization: Bearer <token>` — an AAD token for the atlas audience,
 *      minted here by the Console UAMI credential ({@link uamiArmCredential},
 *      the proven ACA-first chain). The UAMI holds the "Azure Maps Data Reader"
 *      role granted in `landing-zone/azure-maps.bicep`.
 *   2. `x-ms-client-id: <account uniqueId>` — the Azure Maps account's unique
 *      client id (the account's `properties.uniqueId`, surfaced by the bicep
 *      output and wired to `LOOM_AZURE_MAPS_CLIENT_ID`). This is what the map
 *      SDK sends as `clientId`; it is NOT a secret and NOT the UAMI's client id.
 * So `LOOM_AZURE_MAPS_CLIENT_ID` selects the AAD path AND is the value returned
 * as `clientId`; the bearer token is minted by the Console UAMI separately.
 *
 * Credential-light: no token is persisted here. `@azure/identity` caches the
 * AAD token internally and `expiresOn` is returned so the client can re-fetch.
 */

import { uamiArmCredential } from '@/lib/azure/arm-credential';

/** The env var that opts the map visual into the Azure Maps backend. */
export const LOOM_MAPS_ENV = 'LOOM_MAPS_BACKEND';

/**
 * AAD audience for the Azure Maps data-plane. Overridable for sovereign clouds
 * via `LOOM_AZURE_MAPS_SCOPE` (Azure Maps has limited Gov availability — stated
 * honestly per no-vaporware) but defaults to the public atlas audience. The
 * token is scoped to atlas ONLY — never Fabric / Power BI.
 */
const ATLAS_SCOPE = process.env.LOOM_AZURE_MAPS_SCOPE || 'https://atlas.microsoft.com/.default';

/**
 * The verdict {@link resolveMapsBackend} returns. A discriminated union so the
 * route + map-visual can branch on `ok` / `mode` with no `any`.
 *
 *  - `{ ok:true, mode:'aad' }`  — AAD: a short-lived bearer token + the account
 *     `clientId` (x-ms-client-id) + `expiresOn` (unix ms). Preferred / gov-safe.
 *  - `{ ok:true, mode:'key' }`  — subscription key (commercial fallback). Azure
 *     Maps keys are designed for client SDK use; AAD is still preferred.
 *  - `{ ok:false }`             — honest gate: `reason` + the `envVar` to set.
 */
export type MapsBackend =
  | { ok: true; mode: 'aad'; token: string; clientId: string; expiresOn: number }
  | { ok: true; mode: 'key'; key: string }
  | { ok: false; reason: string; envVar: string };

/**
 * Resolve the active Azure Maps backend for the report map visual.
 *
 * Reads `LOOM_MAPS_BACKEND`:
 *   - anything other than `azure-maps`  → `{ ok:false }` honest gate.
 *   - `azure-maps` + `LOOM_AZURE_MAPS_CLIENT_ID` → AAD path: mints an
 *     atlas-scoped token via the Console UAMI and returns it with the account
 *     `clientId` + `expiresOn` (preferred / gov-safe).
 *   - `azure-maps` + `LOOM_AZURE_MAPS_KEY` (and no client id) → key path.
 *   - `azure-maps` but neither configured → `{ ok:false }`.
 *
 * Never throws: token-acquisition failures degrade to an `{ ok:false }` verdict
 * naming the role/env to fix, so the route returns a clean 412 gate rather than
 * a 500. No Fabric / Power BI host is ever contacted.
 */
export async function resolveMapsBackend(): Promise<MapsBackend> {
  const backend = (process.env.LOOM_MAPS_BACKEND || '').trim().toLowerCase();

  if (backend !== 'azure-maps') {
    return {
      ok: false,
      envVar: LOOM_MAPS_ENV,
      reason: backend
        ? `LOOM_MAPS_BACKEND="${backend}" is not a supported map backend. Set LOOM_MAPS_BACKEND=azure-maps to enable the Azure-native map visual (no Power BI / Fabric required).`
        : 'Azure Maps is not configured. Set LOOM_MAPS_BACKEND=azure-maps (plus an Azure Maps account via platform/fiab/bicep/modules/landing-zone/azure-maps.bicep) to enable the map visual. The aggregated location rows still render.',
    };
  }

  // ── AAD path (preferred, gov-safe) ────────────────────────────────────────
  // Presence of the account's unique client id selects AAD. The bearer token is
  // minted by the Console UAMI (Azure Maps Data Reader); `clientId` is the
  // account's x-ms-client-id sent by the browser SDK.
  const clientId = (process.env.LOOM_AZURE_MAPS_CLIENT_ID || '').trim();
  if (clientId) {
    try {
      const token = await uamiArmCredential().getToken(ATLAS_SCOPE);
      if (token?.token) {
        return {
          ok: true,
          mode: 'aad',
          token: token.token,
          clientId,
          expiresOn: token.expiresOnTimestamp,
        };
      }
      return {
        ok: false,
        envVar: LOOM_MAPS_ENV,
        reason:
          'Azure Maps AAD auth is configured (LOOM_AZURE_MAPS_CLIENT_ID) but no token was returned for the atlas.microsoft.com audience. Confirm the Console managed identity has the "Azure Maps Data Reader" role on the account (granted by landing-zone/azure-maps.bicep).',
      };
    } catch (err) {
      return {
        ok: false,
        envVar: LOOM_MAPS_ENV,
        reason: `Failed to mint an Azure Maps AAD token for the atlas.microsoft.com audience: ${
          err instanceof Error ? err.message : String(err)
        }. Confirm the Console managed identity has "Azure Maps Data Reader" on the account.`,
      };
    }
  }

  // ── Key path (commercial fallback) ────────────────────────────────────────
  const key = (process.env.LOOM_AZURE_MAPS_KEY || '').trim();
  if (key) {
    return { ok: true, mode: 'key', key };
  }

  // ── Opted in, but nothing usable configured ───────────────────────────────
  return {
    ok: false,
    envVar: LOOM_MAPS_ENV,
    reason:
      'LOOM_MAPS_BACKEND=azure-maps is set but no credential is configured. Set LOOM_AZURE_MAPS_CLIENT_ID (AAD, preferred — the Azure Maps account uniqueId, with the Console identity granted "Azure Maps Data Reader") or LOOM_AZURE_MAPS_KEY (subscription key, commercial only).',
  };
}
