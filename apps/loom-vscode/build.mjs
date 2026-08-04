// esbuild bundler for the CSA Loom VS Code extension.
//
// VS Code extensions must ship a single bundled CommonJS file (the per-app,
// no-root-workspace install model makes an unbundled node_modules untenable).
// We bundle src/extension.ts -> dist/extension.js with:
//   • platform:node, format:cjs, target:node20  (the extension-host runtime)
//   • external:['vscode']  — the host provides the `vscode` module at runtime
//   • an alias mapping `@csa-loom/sdk` to the SDK SOURCE in the sibling app.
//
// Phase 4 ALSO bundles the SHIPPED `apps/loom-mcp` servers (M1 catalog … M5
// admin) into `dist/mcp/<id>.mjs` so the extension's McpServerDefinitionProvider
// can point VS Code at real, self-contained stdio servers with NO external
// runtime deps and NO hand-edited mcp.json. Each server is bundled as ESM
// (`.mjs`) — the MCP + SDK + zod trees are inlined; only Node built-ins stay
// external. `@modelcontextprotocol/sdk` + `zod` resolve from THIS app's
// devDependencies (build-time only; nothing ships in node_modules).
//
// Reuse-not-reimplement (PRP §2.2): the extension consumes @csa-loom/sdk. That
// package has no npm tag yet (R-1), so builds resolve it to the sibling app's
// source and esbuild inlines it into the .vsix — the documented interim path
// (PRP §2.2 option b). When loom-sdk-v0.1.0 publishes, this alias becomes a
// normal dependency with no code change.
import * as esbuild from 'esbuild';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sdkEntry = path.resolve(__dirname, '../loom-sdk/src/index.ts');
const mcpServersDir = path.resolve(__dirname, '../loom-mcp/src/servers');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** The shipped loom-mcp stdio servers, bundled into dist/mcp/<id>.mjs. */
const MCP_SERVERS = ['loom-catalog', 'loom-query', 'loom-author', 'loom-ops', 'loom-admin'];

/** @type {import('esbuild').BuildOptions} */
const extensionOptions = {
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

/** @type {import('esbuild').BuildOptions} */
const mcpOptions = {
  entryPoints: Object.fromEntries(
    MCP_SERVERS.map((id) => [id, path.join(mcpServersDir, id, 'bin.ts')]),
  ),
  bundle: true,
  outdir: path.resolve(__dirname, 'dist/mcp'),
  outExtension: { '.js': '.mjs' },
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: false,
  minify: production,
  // Inline everything (MCP SDK, zod, the Loom SDK, the shared core). Only Node
  // built-ins stay external; the shipped .mjs has no node_modules dependency.
  external: [],
  alias: {
    '@csa-loom/sdk': sdkEntry,
  },
  // The MCP server sources live in a SIBLING app (apps/loom-mcp/src); their
  // `@modelcontextprotocol/sdk` + `zod` imports resolve from THIS app's
  // node_modules (build-time devDeps), which is not an ancestor of the sources.
  nodePaths: [path.resolve(__dirname, 'node_modules')],
  // ESM output needs a require() shim for any transitively-CJS dep.
  banner: {
    js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);",
  },
  logLevel: 'info',
};

async function main() {
  if (watch) {
    const ext = await esbuild.context(extensionOptions);
    const mcp = await esbuild.context(mcpOptions);
    await ext.watch();
    await mcp.watch();
    // eslint-disable-next-line no-console
    console.log('[esbuild] watching extension + MCP servers…');
  } else {
    await esbuild.build(extensionOptions);
    await esbuild.build(mcpOptions);
    // eslint-disable-next-line no-console
    console.log(`[esbuild] built dist/extension.js + dist/mcp/{${MCP_SERVERS.join(',')}}.mjs`);
  }
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
