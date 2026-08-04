/**
 * M3 `loom-author` stdio smoke test — proves the SHIPPED binary boots and speaks
 * MCP, not that it merely compiles. Spawns dist/servers/loom-author/bin.js and:
 *   1. initialize handshake + tools/list returns exactly the 3 author tools;
 *   2. a tools/call with NO credential is denied (authentication required),
 *      proving the no-anonymous control end-to-end against the real process.
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
const BIN = path.resolve(here, '../dist/servers/loom-author/bin.js');

const EXPECTED_TOOLS = ['loom.item.create', 'loom.item.definition.update', 'loom.item.update'];

test('stdio loom-author: initialize + tools/list returns the 3 write tools; anonymous call denied', { timeout: 30_000 }, async () => {
  const emptyHome = await fs.mkdtemp(path.join(os.tmpdir(), 'loom-author-smoke-'));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BIN],
    env: { ...getDefaultEnvironment(), LOOM_CONFIG_DIR: emptyHome },
    stderr: 'ignore',
  });
  const client = new Client({ name: 'loom-author-smoke', version: '0.0.0' });

  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const names = listed.tools.map((t) => t.name).sort();
    assert.deepEqual(names, EXPECTED_TOOLS, 'tools/list must return exactly the M3 author tools');

    // Registration carried real metadata and the write hint.
    const create = listed.tools.find((t) => t.name === 'loom.item.create');
    assert.ok(create?.description && create.description.length > 20, 'tool has a description');
    assert.equal(create?.annotations?.readOnlyHint, false, 'author tools are not read-only');

    // A write call with no credential is denied by the gate.
    const call = await client.callTool({ name: 'loom.item.create', arguments: { type: 'lakehouse', workspaceId: 'ws-1', displayName: 'X', apply: true } });
    assert.equal(call.isError, true, 'anonymous write must be an error');
    assert.match(JSON.stringify(call.content), /authentication required/i);
  } finally {
    await client.close().catch(() => {});
    await fs.rm(emptyHome, { recursive: true, force: true }).catch(() => {});
  }
});
