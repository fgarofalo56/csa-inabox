/**
 * Production ArmPort for the gateway preflight: Console UAMI credential chain
 * (same chain as lib/azure/apim-client.ts) + the counted ARM fetch.
 */
import { uamiArmCredential } from '@/lib/azure/arm-credential';
import { armCountedFetch } from '@/lib/azure/arm-counted-fetch';
import { armBase, armScope } from '@/lib/azure/cloud-endpoints';
import type { ArmPort } from './preflight';

// Pure ARM-plane client: the shared Console UAMI chain, not a per-file construction.
const credential = uamiArmCredential;

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
