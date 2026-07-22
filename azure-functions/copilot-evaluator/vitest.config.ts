// Mirrors azure-functions/ops-agent-evaluator: the pure core tests run on node.
// In CI / a worktree with no local install, run via the console's toolchain:
//   node apps/fiab-console/node_modules/vitest/vitest.mjs run \
//     --root azure-functions/copilot-evaluator
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['src/**/*.test.ts'], environment: 'node' } });
