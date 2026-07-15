/**
 * SCIM 2.0 ServiceProviderConfig (RFC 7643 §5) — advertises which SCIM features
 * Loom's provisioning surface supports so an IdP can adapt its traffic.
 *
 * Auth: the SCIM provisioning bearer (LOOM_SCIM_BEARER_TOKEN).
 */

import { requireScim, scimJson, originOf } from '@/lib/scim/respond';
import { SCIM_SPC_SCHEMA } from '@/lib/scim/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const gate = requireScim(req);
  if (gate) return gate;
  const base = originOf(req).replace(/\/+$/, '');
  return scimJson({
    schemas: [SCIM_SPC_SCHEMA],
    documentationUri: 'https://csa-loom.limitlessdata.ai/developer/api',
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: 200 },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: true },
    authenticationSchemes: [
      {
        type: 'oauthbearertoken',
        name: 'OAuth Bearer Token',
        description: 'Authentication via the SCIM provisioning bearer token configured on the deployment.',
        specUri: 'https://www.rfc-editor.org/info/rfc6750',
        primary: true,
      },
    ],
    meta: {
      resourceType: 'ServiceProviderConfig',
      location: `${base}/api/scim/v2/ServiceProviderConfig`,
    },
  });
}
