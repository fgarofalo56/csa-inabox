// Production wiring for the fhir-tenant.* jobs (W2-2b B2c). The engine host needs two image references and a
// PostgreSQL token scope. The images are hub-ACR references the deploy produces (the HAPI image from the
// loom-health-fhir build, the PG client image from platform/fiab/bicep/modules/health/pg-client-image.json); the
// deploy (B3) sets them. Neither set = the feature is off and the kinds answer "unknown job kind"; one set, or a
// malformed one, refuses to start and names the variable, like the other loaders.

import { DefaultAzureCredential } from '@azure/identity';
import { ConfigError, type Cloud } from '../config.js';
import { RestAksRunCommand } from './aks-run-command.js';
import { armEngineTarget, armStampTarget, assertEngineImagePinned, RunCommandFhirEngineHost } from './fhir-engine-host.js';
import type { TenantArmConfig } from './tenant-arm-config.js';
import type { TenantArm } from './tenant-arm.js';
import type { StampDoc, TenantDoc } from '../registry/types.js';
import type { Collection } from '../store/types.js';

/** Entra scope for Azure Database for PostgreSQL tokens. GCC is public-cloud Azure under a gov-community identity. */
export const PG_SCOPE_BY_CLOUD: Record<Cloud, string> = {
  commercial: 'https://ossrdbms-aad.database.windows.net/.default',
  gcc: 'https://ossrdbms-aad.database.windows.net/.default',
  'gcc-high': 'https://ossrdbms-aad.database.usgovcloudapi.net/.default',
  il5: 'https://ossrdbms-aad.database.usgovcloudapi.net/.default',
  dod: 'https://ossrdbms-aad.database.usgovcloudapi.net/.default',
};

export interface FhirEngineConfig {
  fhirImage: string;
  pgClientImage: string;
  pgScope: string;
}

// A tag reference, or a digest reference (`repo@sha256:<64 hex>`): deploy-health pins LOOM_HEALTH_CP_FHIR_IMAGE by digest (#5439).
// Before #5439 this had no `@`, so the digest form the deploy now renders would have refused to start the control plane.
const IMAGE = /^[a-z0-9][a-z0-9.\-/:_]{0,200}(@sha256:[0-9a-f]{64})?$/;
const IMAGE_BY_DIGEST = /^[a-z0-9][a-z0-9.\-/:_]{0,200}@sha256:[0-9a-f]{64}$/;

export function loadFhirEngineConfig(cloud: Cloud, env: NodeJS.ProcessEnv = process.env): FhirEngineConfig | undefined {
  const fhirImage = (env.LOOM_HEALTH_CP_FHIR_IMAGE ?? '').trim();
  const pgClientImage = (env.LOOM_HEALTH_CP_PG_CLIENT_IMAGE ?? '').trim();
  if (!fhirImage && !pgClientImage) return undefined;
  const missing = [!fhirImage && 'LOOM_HEALTH_CP_FHIR_IMAGE', !pgClientImage && 'LOOM_HEALTH_CP_PG_CLIENT_IMAGE'].filter(Boolean);
  if (missing.length > 0) throw new ConfigError(`the FHIR engine host needs both images; missing: ${missing.join(', ')}`);
  if (!IMAGE.test(fhirImage)) throw new ConfigError('LOOM_HEALTH_CP_FHIR_IMAGE must be an image reference');
  try {
    assertEngineImagePinned(fhirImage);
  } catch {
    throw new ConfigError('LOOM_HEALTH_CP_FHIR_IMAGE must carry an explicit tag other than latest, or a digest');
  }
  if (!IMAGE_BY_DIGEST.test(pgClientImage)) throw new ConfigError('LOOM_HEALTH_CP_PG_CLIENT_IMAGE must be pinned by digest (name@sha256:<64 hex>)');
  return { fhirImage, pgClientImage, pgScope: PG_SCOPE_BY_CLOUD[cloud] };
}

export function fhirEngineHostFromConfig(
  c: FhirEngineConfig,
  t: TenantArmConfig,
  authorityHost: string,
  d: { stamps: Collection<StampDoc>; tenants: Collection<TenantDoc>; arm: TenantArm },
): RunCommandFhirEngineHost {
  const credential = new DefaultAzureCredential({ authorityHost: `https://${authorityHost}` });
  const run = new RestAksRunCommand({
    armEndpoint: t.armEndpoint,
    subscriptionId: t.subscriptionId,
    token: async (scope) => (await credential.getToken(scope)).token,
  });
  return new RunCommandFhirEngineHost({
    run,
    target: armEngineTarget(d),
    stampTarget: armStampTarget(d),
    fhirImage: c.fhirImage,
    pgClientImage: c.pgClientImage,
    pgScope: c.pgScope,
    log: (event, fields) => process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }) + '\n'),
  });
}
