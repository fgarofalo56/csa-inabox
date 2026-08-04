#!/usr/bin/env node
/**
 * `loom-author-mcp` — stdio entry point for the M3 WRITE MCP server.
 *
 * An MCP client spawns this binary and speaks JSON-RPC over stdin/stdout. ALL
 * diagnostics go to stderr — stdout is reserved for the protocol stream.
 *
 * Auth comes from the environment (`LOOM_API_URL` + `LOOM_TOKEN`) or the `loom`
 * CLI credential store. Because every tool mutates, a `read-write` credential is
 * required — set `LOOM_TOKEN_SCOPE=read-write` for a PAT (a `read-only` token is
 * refused). Every mutating tool is DRY-RUN by default: pass `apply:true` to write.
 * With no credential the server still starts and lists its tools, but every call
 * is denied (authentication required).
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createAuthorServer, AUTHOR_SERVER_NAME, AUTHOR_SERVER_VERSION } from './server.js';

async function main(): Promise<void> {
  const server = await createAuthorServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(
    `[${AUTHOR_SERVER_NAME}] MCP server v${AUTHOR_SERVER_VERSION} ready on stdio — mutating tools are DRY-RUN by default (apply:true to write)\n`,
  );
}

main().catch((e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e);
  process.stderr.write(`[${AUTHOR_SERVER_NAME}] fatal: ${msg}\n`);
  process.exit(1);
});
