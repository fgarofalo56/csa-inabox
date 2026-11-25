// Production wiring for the Authorization Server: Key Vault signer, Entra
// federation, Graph membership, Cosmos stores. Everything reaches Azure with
// the managed identity. compose() adds the control-plane authenticator, the
// tenant collection and the logger.

import { DefaultAzureCredential } from '@azure/identity';
import { createRemoteJWKSet } from 'jose';
import type { Config } from '../config.js';
import { jwksUrl } from '../middleware/auth.js';
import { cachingJwksFetcher, httpsJwksFetcher } from './backend-auth.js';
import { TOKEN_EXCHANGE_SCOPE_BY_CLOUD } from './clouds.js';
import type { AuthServerConfig } from './config.js';
import { createCosmosAuthStores } from './cosmos.js';
import { createEntraFederation, createGraphMembership } from './federation.js';
import { createFhirUserResolver } from './fhir-user.js';
import type { AuthServerInit } from './server.js';
import { KeyVaultRsaSigner, KeyVaultSigner, idTokenKeyUrlFrom } from './signer.js';

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
    graph: createGraphMembership({ cloud: cfg.cloud, getToken }),
    fhirBaseFor,
    // SMART fhirUser from the operator-managed mapping (#5454 A4); same base as the token audience.
    resolveFhirUser: createFhirUserResolver(stores.fhirUsers, fhirBaseFor),
    fetchJwks: cachingJwksFetcher(httpsJwksFetcher(), () => new Date()),
    ...(a.graphConsentUrl ? { graphConsentUrl: a.graphConsentUrl } : {}),
  };
}
