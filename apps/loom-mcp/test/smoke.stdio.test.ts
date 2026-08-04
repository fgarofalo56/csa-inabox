/**
 * Smoke test — proves the SHIPPED binary runs, not that it merely compiles.
 *
 * It spawns the built `dist/servers/loom-catalog/bin.js` as a child process and
 * drives it over REAL stdio with the MCP SDK `Client`:
 *   1. `client.connect(transport)` performs the JSON-RPC `initialize` handshake.
 *   2. `tools/list` must return exactly the four M1 catalog tools.
 *   3. `tools/call` with NO credential must be denied (authentication required),
 *      proving the "no anonymous" control end-to-end against the real process.
 *
 * The child runs with an empty `LOOM_CONFIG_DIR` and no `LOOM_TOKEN`/`LOOM_API_URL`,
 * so it is hermetic and deterministic (anonymous). A `tsc`/import-only false pass
 * cannot satisfy this: the process actually has to boot and answer over the wire.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(here, '../dist/servers/loom-catalog/bin.js');

const EXPECTED_TOOLS = ['loom.catalog.find', 'loom.item.get', 'loom.item.list', 'loom.workspaces.list'];

test('stdio server: initialize + tools/list returns the 4 catalog tools', { timeout: 30_000 }, async () => {
  const emptyHome = await fs.mkdtemp(path.join(os.tmpdir(), 'loom-mcp-smoke-'));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BIN],
    // Hermetic + anonymous: fresh empty credential dir, no PAT / API URL.
    env: { ...getDefaultEnvironment(), LOOM_CONFIG_DIR: emptyHome },
    stderr: 'ignore',
  });
  const client = new Client({ name: 'loom-mcp-smoke', version: '0.0.0' });

  try {
    await client.connect(transport); // performs the initialize handshake
    const listed = await client.listTools();
    const names = listed.tools.map((t) => t.name).sort();
    assert.deepEqual(names, EXPECTED_TOOLS, 'tools/list must return exactly the M1 catalog tools');

    // Registration carried real metadata, not bare names.
    const find = listed.tools.find((t) => t.name === 'loom.catalog.find');
    assert.ok(find?.description && find.description.length > 20, 'tool has a description');
    assert.ok(find?.inputSchema, 'tool has an input schema');

    // A call with no credential is denied by the gate (no anonymous access).
    const call = await client.callTool({ name: 'loom.workspaces.list', arguments: {} });
    assert.equal(call.isError, true, 'anonymous tools/call must be an error');
    assert.match(JSON.stringify(call.content), /authentication required/i);
  } finally {
    await client.close().catch(() => {});
    await fs.rm(emptyHome, { recursive: true, force: true }).catch(() => {});
  }
});
