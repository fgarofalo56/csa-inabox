import { createServer } from 'node:http';
import { loadAuthServerConfig } from './auth/config.js';
import { authServerInitFromConfig } from './auth/wire.js';
import { compose } from './compose.js';
import { ConfigError, loadConfig } from './config.js';
import { CollectionBundleSource, FileBundleSource } from './pdp/bundles.js';
import { bundleSignerFromConfig } from './pdp/bundle-key.js';
import { verificationKeyPem } from './pdp/bundle-sign.js';
import { authOptionsFromConfig } from './middleware/auth.js';
import { createCosmosStores } from './store/cosmos.js';
import { authoredMessage } from './safe-error.js';
import { DefaultAzureCredential } from '@azure/identity';
import { loadIngressCertConfig, scheduleIngressCert } from './tls/ingress-cert.js';
import { loadTenantArmConfig, tenantArmFromConfig } from './jobs/tenant-arm-config.js';
import { fhirEngineHostFromConfig, loadFhirEngineConfig } from './jobs/fhir-engine-config.js';
import { loadStampSelfRegistration, scheduleStampSelfRegistration } from './registry/self-register.js';
import { scheduleEngineReconcile } from './jobs/fhir-engine-reconcile.js';

// One JSON line per event. Fields are ids, counts and status codes only: no
// tokens, no request bodies, no clinical data.
function log(event: string, fields: Record<string, string | number>): void {
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }) + '\n');
}

function main(): void {
  let cfg;
  let authCfg;
  let tenantCfg;
  let tlsCfg;
  let stampCfg;
  let engineCfg;
  try {
    cfg = loadConfig();
    authCfg = loadAuthServerConfig(cfg.cloud);
    tenantCfg = loadTenantArmConfig(cfg.cloud);
    tlsCfg = loadIngressCertConfig(cfg.cloud);
    stampCfg = loadStampSelfRegistration(cfg.cloud);
    engineCfg = loadFhirEngineConfig(cfg.cloud);
  } catch (e) {
    process.stderr.write(`loom-health-cp: ${e instanceof ConfigError ? authoredMessage(e) : 'invalid configuration'}\n`);
    process.exit(1);
  }
  let bundleSigner;
  try {
    bundleSigner = bundleSignerFromConfig(cfg);
  } catch (e) {
    process.stderr.write(`loom-health-cp: ${e instanceof ConfigError ? authoredMessage(e) : 'invalid configuration'}\n`);
    process.exit(1);
  }
  const stores = createCosmosStores(cfg);
  const tenantArm = tenantArmFromConfig(tenantCfg, cfg.authorityHost);
  // W2-2b B2c: the per-tenant FHIR engine host (ARM runCommand). Off without its images AND the PDP url.
  let fhirEngine;
  if (engineCfg && cfg.pdpUrl) {
    fhirEngine = { host: fhirEngineHostFromConfig(engineCfg, tenantCfg, cfg.authorityHost, { stamps: stores.stamps, tenants: stores.tenants, arm: tenantArm }), pdpUrl: cfg.pdpUrl };
  } else {
    log('fhir_engine.disabled', { reason: !engineCfg ? 'LOOM_HEALTH_CP_FHIR_IMAGE and LOOM_HEALTH_CP_PG_CLIENT_IMAGE unset' : 'LOOM_HEALTH_CP_PDP_URL unset (an engine without a PDP answers 503)' });
  }
  const app = compose({
    stores,
    auth: authOptionsFromConfig(cfg),
    sloAvailabilityTarget: cfg.sloAvailabilityTarget,
    // Cosmos-backed by default (published via PUT .../bundle); a configured dir overrides it (read-only, dev).
    bundles: cfg.pdpBundleDir ? new FileBundleSource(cfg.pdpBundleDir) : new CollectionBundleSource(stores.pdpBundles, undefined, bundleSigner),
    bundleKey: bundleSigner ? () => verificationKeyPem(bundleSigner) : undefined,
    authServer: authServerInitFromConfig(cfg, authCfg),
    tenantArm,
    fhirEngine,
    log,
  });
  const server = createServer((req, res) => {
    void app.handler(req, res);
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.listen(cfg.port, () => log('server.listening', { port: cfg.port, cloud: cfg.cloud }));

  // #5345: ensure the stamp ingress certificate in Key Vault (startup + timer). Off when the TLS vars are unset.
  if (tlsCfg) {
    const credential = new DefaultAzureCredential({ authorityHost: `https://${cfg.authorityHost}` });
    scheduleIngressCert({ cfg: tlsCfg, getToken: async (scope) => (await credential.getToken(scope)).token }, log);
  }

  // #5377: register this stamp in our own registry and mark it healthy once its deployment reads back. A failure
  // is logged and retried on a timer; the server is already listening and keeps serving.
  let stopSelfRegister = (): void => {};
  if (stampCfg) {
    stopSelfRegister = scheduleStampSelfRegistration({ registry: app.registry, arm: tenantArm, log }, stampCfg);
  } else {
    log('stamp.self_register_disabled', { reason: 'LOOM_HEALTH_CP_STAMP_ID unset' });
  }

  // #5482 item 6: re-apply any engine whose running revision differs from what this control plane renders (startup + timer).
  let stopReconcile = (): void => {};
  if (app.reconcileEngines) {
    stopReconcile = scheduleEngineReconcile(app.reconcileEngines, log);
  } else {
    log('engine_reconcile.disabled', { reason: 'the fhir-tenant job kinds are not registered (see fhir_engine.disabled)' });
  }

  // Pick up queued jobs and fail leases left behind by a crashed replica.
  const sweep = setInterval(() => {
    app.jobs.tick().catch((e: unknown) => log('job.sweep_error', { error: e instanceof Error ? e.name : 'unknown' }));
  }, 30_000);
  sweep.unref();

  const stop = (): void => {
    clearInterval(sweep);
    stopSelfRegister();
    stopReconcile();
    server.close(() => {
      app.jobs.idle().finally(() => process.exit(0));
    });
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main();
