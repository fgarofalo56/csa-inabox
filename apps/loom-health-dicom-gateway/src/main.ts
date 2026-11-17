import { loadConfig } from './config.js';
import { httpPdp } from './pdp.js';
import { stdoutAudit } from './audit.js';
import { createGateway } from './server.js';

const cfg = loadConfig();
const server = createGateway({ cfg, pdp: httpPdp(cfg.pdpUrl, cfg.pdpTimeoutMs), audit: stdoutAudit });
// STOW bodies of several GB take longer than Node's default 5 min request timeout.
server.requestTimeout = 0;
server.headersTimeout = 30_000;
server.listen(cfg.port, () => {
  process.stdout.write(`${JSON.stringify({ event: 'dicom.gateway.listening', port: cfg.port })}\n`);
});
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
