#!/usr/bin/env node
/**
 * `loom-admin-mcp` — stdio entry point for the M5 ADMIN (escalation) MCP server.
 *
 * An MCP client spawns this binary and speaks JSON-RPC over stdin/stdout. ALL
 * diagnostics go to stderr — stdout is reserved for the protocol stream.
 *
 * This is the highest-blast-radius server and is DEFAULT-OFF: set
 * `LOOM_MCP_ADMIN_ENABLED=1` to enable it (an explicit, audited action). It never
 * accepts a PAT — sign in interactively (Entra) and assert `LOOM_TOKEN_SCOPE=admin`.
 * Every admin tool is DRY-RUN by default (pass `apply:true` to mutate) and every
 * call is audited with the target principal. When disabled or under-credentialed,
 * the server still lists its tools but denies every call.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createAdminServer, adminEnabled, ADMIN_SERVER_NAME, ADMIN_SERVER_VERSION } from './server.js';

async function main(): Promise<void> {
  const enabled = adminEnabled();
  const server = await createAdminServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(
    `[${ADMIN_SERVER_NAME}] MCP server v${ADMIN_SERVER_VERSION} ready on stdio — ` +
      `${enabled ? 'ENABLED' : 'DISABLED (set LOOM_MCP_ADMIN_ENABLED=1)'}; ` +
      'no PAT accepted; admin scope + dry-run-default; every call audited\n',
  );
}

main().catch((e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e);
  process.stderr.write(`[${ADMIN_SERVER_NAME}] fatal: ${msg}\n`);
  process.exit(1);
});
