// esbuild bundler for the CSA Loom VS Code extension.
//
// VS Code extensions must ship a single bundled CommonJS file (the per-app,
// no-root-workspace install model makes an unbundled node_modules untenable).
// We bundle src/extension.ts -> dist/extension.js with:
//   • platform:node, format:cjs, target:node20  (the extension-host runtime)
//   • external:['vscode']  — the host provides the `vscode` module at runtime
//   • an alias mapping `@csa-loom/sdk` to the SDK SOURCE in the sibling app.
//
// Reuse-not-reimplement (PRP §2.2): the extension consumes @csa-loom/sdk. That
// package has no npm tag yet (R-1), so Phase 1 resolves it to the sibling app's
// source and esbuild inlines it into the .vsix — the documented interim path
// (PRP §2.2 option b). When loom-sdk-v0.1.0 publishes, this alias becomes a
// normal dependency with no code change.
import * as esbuild from 'esbuild';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sdkEntry = path.resolve(__dirname, '../loom-sdk/src/index.ts');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: [path.resolve(__dirname, 'src/extension.ts')],
  bundle: true,
  outfile: path.resolve(__dirname, 'dist/extension.js'),
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  sourcemap: !production,
  minify: production,
  external: ['vscode'],
  alias: {
    '@csa-loom/sdk': sdkEntry,
  },
  logLevel: 'info',
};

async function main() {
  if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
    // eslint-disable-next-line no-console
    console.log('[esbuild] watching…');
  } else {
    await esbuild.build(options);
    // eslint-disable-next-line no-console
    console.log('[esbuild] built dist/extension.js');
  }
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
