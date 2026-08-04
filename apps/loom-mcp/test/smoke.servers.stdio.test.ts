/**
 * Smoke tests — prove the SHIPPED M2/M4 binaries run, not that they compile.
 *
 * Each spawns the built `dist/servers/<name>/bin.js` as a child process and
 * drives it over REAL stdio with the MCP SDK `Client`:
 *   1. `client.connect(transport)` performs the JSON-RPC `initialize` handshake.
 *   2. `tools/list` must return exactly that server's tools.
 *   3. `tools/call` with NO credential is denied (authentication required),
 *      proving the "no anonymous" control end-to-end against the real process.
 *
 * Hermetic + anonymous: fresh empty `LOOM_CONFIG_DIR`, no `LOOM_TOKEN` /
 * `LOOM_API_URL`. A `tsc`/import-only false pass cannot satisfy this — the
 * process has to boot and answer over the wire.
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

async function drive(binRel: string, expectedTools: string[], anonCall: { name: string; arguments: Record<string, unknown> }) {
  const bin = path.resolve(here, binRel);
  const emptyHome = await fs.mkdtemp(path.join(os.tmpdir(), 'loom-mcp-smoke-'));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [bin],
    env: { ...getDefaultEnvironment(), LOOM_CONFIG_DIR: emptyHome },
    stderr: 'ignore',
  });
  const client = new Client({ name: 'loom-mcp-smoke', version: '0.0.0' });
  try {
    await client.connect(transport); // initialize handshake
    const listed = await client.listTools();
    const names = listed.tools.map((t) => t.name).sort();
    assert.deepEqual(names, expectedTools.slice().sort(), `tools/list must return exactly ${binRel}'s tools`);

    const first = listed.tools[0];
    assert.ok(first?.description && first.description.length > 20, 'tool carries a real description');
    assert.ok(first?.inputSchema, 'tool carries an input schema');

    const call = await client.callTool(anonCall);
    assert.equal(call.isError, true, 'anonymous tools/call must be an error');
    assert.match(JSON.stringify(call.content), /authentication required/i);
  } finally {
    await client.close().catch(() => {});
    await fs.rm(emptyHome, { recursive: true, force: true }).catch(() => {});
  }
}

test('stdio: loom-query initialize + tools/list returns the 3 query tools', { timeout: 30_000 }, async () => {
  await drive(
    '../dist/servers/loom-query/bin.js',
    ['loom.query.sql', 'loom.query.kql', 'loom.query.preview'],
    { name: 'loom.query.sql', arguments: { id: 'x', sql: 'SELECT 1' } },
  );
});

test('stdio: loom-ops initialize + tools/list returns the 5 ops tools', { timeout: 30_000 }, async () => {
  await drive(
    '../dist/servers/loom-ops/bin.js',
    ['loom.run.list', 'loom.run.get', 'loom.run.logs', 'loom.run.start', 'loom.run.cancel'],
    // Even the WRITE tool is denied anonymously at the gate before any scope check.
    { name: 'loom.run.start', arguments: { id: 'x' } },
  );
});
