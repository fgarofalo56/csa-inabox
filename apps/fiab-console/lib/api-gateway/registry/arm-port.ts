/**
 * Production ArmPort for the gateway preflight: Console UAMI credential chain
 * (same chain as lib/azure/apim-client.ts) + the counted ARM fetch.
 */
import { ChainedTokenCredential, DefaultAzureCredential, ManagedIdentityCredential } from '@azure/identity';
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';
import { armCountedFetch } from '@/lib/azure/arm-counted-fetch';
import { armBase, armScope } from '@/lib/azure/cloud-endpoints';
import type { ArmPort } from './preflight';

function credential(): ChainedTokenCredential | DefaultAzureCredential {
  const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
  return uamiClientId
    ? new ChainedTokenCredential(
        new AcaManagedIdentityCredential(),
        new ManagedIdentityCredential({ clientId: uamiClientId }),
        new DefaultAzureCredential(),
      )
    : new DefaultAzureCredential();
}

export function hostArmPort(): ArmPort {
  const cred = credential();
  return {
    armBase,
    async getToken() {
      const t = await cred.getToken(armScope());
      if (!t?.token) throw new Error('Failed to acquire an ARM token for the Console identity');
      return t.token;
    },
    async get(url, token) {
      const res = await armCountedFetch(url, { method: 'GET', headers: { Authorization: `Bearer ${token}` } });
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      return { status: res.status, body };
    },
  };
}
