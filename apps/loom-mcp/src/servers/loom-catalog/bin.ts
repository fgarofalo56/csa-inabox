#!/usr/bin/env node
/**
 * `loom-catalog-mcp` — stdio entry point for the M1 read-only MCP server.
 *
 * An MCP client (Claude Code, Cursor, the Loom Console, a custom agent) spawns
 * this binary and speaks JSON-RPC over stdin/stdout. ALL diagnostics go to
 * stderr — stdout is reserved for the protocol stream.
 *
 * Auth comes from the environment (`LOOM_API_URL` + `LOOM_TOKEN`) or the `loom`
 * CLI credential store (`~/.loom/credentials.json`). With no credential the
 * server still starts and lists its tools, but every call is denied
 * (authentication required) — there is no anonymous access.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createCatalogServer, CATALOG_SERVER_NAME, CATALOG_SERVER_VERSION } from './server.js';

async function main(): Promise<void> {
  const server = await createCatalogServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`[${CATALOG_SERVER_NAME}] MCP server v${CATALOG_SERVER_VERSION} ready on stdio\n`);
}

main().catch((e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e);
  process.stderr.write(`[${CATALOG_SERVER_NAME}] fatal: ${msg}\n`);
  process.exit(1);
});
