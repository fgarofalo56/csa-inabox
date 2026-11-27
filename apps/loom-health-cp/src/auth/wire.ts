// Production wiring for the Authorization Server: Key Vault signer, Entra
// federation, Graph membership, Cosmos stores. Everything reaches Azure with
// the managed identity, EXCEPT Graph: that is called as the AS app
// (loom-health-cp-as) with the MI federated in as its client assertion.
// compose() adds the control-plane authenticator, the tenant collection and
// the logger.

import { DefaultAzureCredential } from '@azure/identity';
import { createRemoteJWKSet } from 'jose';
import type { Config } from '../config.js';
import { jwksUrl } from '../middleware/auth.js';
import { cachingJwksFetcher, httpsJwksFetcher } from './backend-auth.js';
import { TOKEN_EXCHANGE_SCOPE_BY_CLOUD } from './clouds.js';
import type { AuthServerConfig } from './config.js';
import { createCosmosAuthStores } from './cosmos.js';
import { createAppTokenProvider, createEntraFederation, createGraphMembership, type GraphMembership } from './federation.js';
import { createFhirUserResolver } from './fhir-user.js';
import type { AuthServerInit } from './server.js';
import { KeyVaultRsaSigner, KeyVaultSigner, idTokenKeyUrlFrom } from './signer.js';

export interface AsAppGraphOptions {
  cloud: Config['cloud'];
  authorityHost: string;
  entraTenantId: string;
  /** loom-health-cp-as: the app the bootstrap declares User.ReadBasic.All + GroupMember.Read.All on. */
  asClientId: string;
  /** The managed identity's token getter; used ONLY to mint the federated client assertion. */
  getToken: (scope: string) => Promise<string>;
  fetchImpl?: typeof fetch;
}

/**
 * Graph membership AS the AS app, not as the managed identity. The Graph application permissions and their
 * admin consent live on loom-health-cp-as; the managed identity holds none, so a Graph token minted for the
 * managed identity is refused (401/403) - the live `consent:1` on 2026-11-27. The AS app's token comes from
 * the client-credentials grant with the same federated MI assertion the Entra sign-in already uses.
 */
export function graphMembershipAsApp(o: AsAppGraphOptions): GraphMembership {
  const asAppToken = createAppTokenProvider({
    authorityHost: o.authorityHost,
    entraTenantId: o.entraTenantId,
    clientId: o.asClientId,
    getClientAssertion: () => o.getToken(TOKEN_EXCHANGE_SCOPE_BY_CLOUD[o.cloud]),
    ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}),
  });
  return createGraphMembership({ cloud: o.cloud, getToken: asAppToken, ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}) });
}

export function authServerInitFromConfig(cfg: Config, a: AuthServerConfig): AuthServerInit {
  const credential = new DefaultAzureCredential({ authorityHost: `https://${cfg.authorityHost}` });
  const getToken = async (scope: string): Promise<string> => (await credential.getToken(scope)).token;
  const stores = createCosmosAuthStores(cfg);
  const fhirBaseFor = (tenant: string): string => `${a.fhirEdgeBase}/${tenant}/fhir`;
  return {
    issuer: a.issuer,
    cloud: cfg.cloud,
    entraTenantId: cfg.entraTenantId,
    stores,
    signer: new KeyVaultSigner({ cloud: cfg.cloud, keyId: a.signingKeyId, getToken }),
    // RS256 id_token key (#5454 A7): same vault as the access-token key, fixed name, created at runtime if missing.
    idTokenSigner: new KeyVaultRsaSigner({ cloud: cfg.cloud, keyUrl: idTokenKeyUrlFrom(cfg.cloud, a.signingKeyId), getToken }),
    federation: createEntraFederation({
      authorityHost: cfg.authorityHost,
      entraTenantId: cfg.entraTenantId,
      clientId: a.asClientId,
      getClientAssertion: () => getToken(TOKEN_EXCHANGE_SCOPE_BY_CLOUD[cfg.cloud]),
      keyResolver: createRemoteJWKSet(jwksUrl(cfg.authorityHost, cfg.entraTenantId), {
        cooldownDuration: 30_000,
        timeoutDuration: 5_000,
      }),
    }),
    graph: graphMembershipAsApp({
      cloud: cfg.cloud,
      authorityHost: cfg.authorityHost,
      entraTenantId: cfg.entraTenantId,
      asClientId: a.asClientId,
      getToken,
    }),
    fhirBaseFor,
    // SMART fhirUser from the operator-managed mapping (#5454 A4); same base as the token audience.
    resolveFhirUser: createFhirUserResolver(stores.fhirUsers, fhirBaseFor),
    fetchJwks: cachingJwksFetcher(httpsJwksFetcher(), () => new Date()),
    ...(a.graphConsentUrl ? { graphConsentUrl: a.graphConsentUrl } : {}),
  };
}
