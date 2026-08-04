#!/usr/bin/env node
/**
 * `loom-ops-mcp` — stdio entry point for the M4 run/logs MCP server.
 *
 * An MCP client (Claude Code, Cursor, the Loom Console, a custom agent) spawns
 * this binary and speaks JSON-RPC over stdin/stdout. ALL diagnostics go to
 * stderr — stdout is reserved for the protocol stream.
 *
 * Auth comes from the environment (`LOOM_API_URL` + `LOOM_TOKEN`) or the `loom`
 * CLI credential store. The two WRITE tools (`loom.run.start`, `loom.run.cancel`)
 * additionally require a read-write scope; a read-only credential can read runs
 * and logs but cannot start or cancel a run.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createOpsServer, OPS_SERVER_NAME, OPS_SERVER_VERSION } from './server.js';

async function main(): Promise<void> {
  const server = await createOpsServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`[${OPS_SERVER_NAME}] MCP server v${OPS_SERVER_VERSION} ready on stdio\n`);
}

main().catch((e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e);
  process.stderr.write(`[${OPS_SERVER_NAME}] fatal: ${msg}\n`);
  process.exit(1);
});
