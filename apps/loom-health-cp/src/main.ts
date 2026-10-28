import { createServer } from 'node:http';
import { loadAuthServerConfig } from './auth/config.js';
import { authServerInitFromConfig } from './auth/wire.js';
import { compose } from './compose.js';
import { ConfigError, loadConfig } from './config.js';
import { FileBundleSource } from './pdp/bundles.js';
import { authOptionsFromConfig } from './middleware/auth.js';
import { createCosmosStores } from './store/cosmos.js';
import { authoredMessage } from './safe-error.js';
import { loadTenantArmConfig, tenantArmFromConfig } from './jobs/tenant-arm-config.js';

// One JSON line per event. Fields are ids, counts and status codes only: no
// tokens, no request bodies, no clinical data.
function log(event: string, fields: Record<string, string | number>): void {
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }) + '\n');
}

function main(): void {
  let cfg;
  let authCfg;
  let tenantCfg;
  try {
    cfg = loadConfig();
    authCfg = loadAuthServerConfig(cfg.cloud);
    tenantCfg = loadTenantArmConfig(cfg.cloud);
  } catch (e) {
    process.stderr.write(`loom-health-cp: ${e instanceof ConfigError ? authoredMessage(e) : 'invalid configuration'}\n`);
    process.exit(1);
  }
  const app = compose({
    stores: createCosmosStores(cfg),
    auth: authOptionsFromConfig(cfg),
    sloAvailabilityTarget: cfg.sloAvailabilityTarget,
    bundles: cfg.pdpBundleDir ? new FileBundleSource(cfg.pdpBundleDir) : undefined,
    authServer: authServerInitFromConfig(cfg, authCfg),
    tenantArm: tenantArmFromConfig(tenantCfg, cfg.authorityHost),
    log,
  });
  const server = createServer((req, res) => {
    void app.handler(req, res);
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.listen(cfg.port, () => log('server.listening', { port: cfg.port, cloud: cfg.cloud }));

  // Pick up queued jobs and fail leases left behind by a crashed replica.
  const sweep = setInterval(() => {
    app.jobs.tick().catch((e: unknown) => log('job.sweep_error', { error: e instanceof Error ? e.name : 'unknown' }));
  }, 30_000);
  sweep.unref();

  const stop = (): void => {
    clearInterval(sweep);
    server.close(() => {
      app.jobs.idle().finally(() => process.exit(0));
    });
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main();
