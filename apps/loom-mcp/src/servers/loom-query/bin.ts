#!/usr/bin/env node
/**
 * `loom-query-mcp` — stdio entry point for the M2 bounded data-read MCP server.
 *
 * An MCP client (Claude Code, Cursor, the Loom Console, a custom agent) spawns
 * this binary and speaks JSON-RPC over stdin/stdout. ALL diagnostics go to
 * stderr — stdout is reserved for the protocol stream.
 *
 * Auth comes from the environment (`LOOM_API_URL` + `LOOM_TOKEN`) or the `loom`
 * CLI credential store. With no credential the server still starts and lists its
 * tools, but every call is denied (authentication required) — no anonymous read.
 *
 * This is the data-exfiltration surface: queries are read-only by construction,
 * row/byte-capped server-side, and every returned cell is secret-scrubbed.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createQueryServer, QUERY_SERVER_NAME, QUERY_SERVER_VERSION } from './server.js';

async function main(): Promise<void> {
  const server = await createQueryServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`[${QUERY_SERVER_NAME}] MCP server v${QUERY_SERVER_VERSION} ready on stdio\n`);
}

main().catch((e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e);
  process.stderr.write(`[${QUERY_SERVER_NAME}] fatal: ${msg}\n`);
  process.exit(1);
});
