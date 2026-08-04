/**
 * M5 `loom-admin` stdio smoke test — proves the SHIPPED escalation binary boots
 * and speaks MCP. Spawns dist/servers/loom-admin/bin.js with the server ENABLED
 * (LOOM_MCP_ADMIN_ENABLED=1) but NO credential, and asserts:
 *   1. initialize + tools/list returns exactly the 3 admin tools (discovery
 *      works even default-OFF-eligible);
 *   2. a tools/call with no credential is denied — proving the deny-by-default
 *      posture end-to-end against the real process (an enabled-but-anonymous
 *      caller still gets nothing).
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
const BIN = path.resolve(here, '../dist/servers/loom-admin/bin.js');

const EXPECTED_TOOLS = ['loom.admin.gate.resolve', 'loom.admin.grant', 'loom.admin.role.assign'];

test('stdio loom-admin: initialize + tools/list returns the 3 admin tools; anonymous call denied', { timeout: 30_000 }, async () => {
  const emptyHome = await fs.mkdtemp(path.join(os.tmpdir(), 'loom-admin-smoke-'));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BIN],
    // Enabled but anonymous + hermetic: proves discovery works and calls still deny.
    env: { ...getDefaultEnvironment(), LOOM_CONFIG_DIR: emptyHome, LOOM_MCP_ADMIN_ENABLED: '1' },
    stderr: 'ignore',
  });
  const client = new Client({ name: 'loom-admin-smoke', version: '0.0.0' });

  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const names = listed.tools.map((t) => t.name).sort();
    assert.deepEqual(names, EXPECTED_TOOLS, 'tools/list must return exactly the M5 admin tools');

    const grant = listed.tools.find((t) => t.name === 'loom.admin.grant');
    assert.ok(grant?.description && grant.description.length > 20, 'tool has a description');
    assert.equal(grant?.annotations?.readOnlyHint, false, 'admin tools are not read-only');

    // No credential → denied (authentication required), even though enabled.
    const call = await client.callTool({ name: 'loom.admin.grant', arguments: { capabilityId: 'admin.permissions', principalId: 'oid-1', role: 'Reader', apply: true } });
    assert.equal(call.isError, true, 'anonymous admin call must be an error');
    assert.match(JSON.stringify(call.content), /authentication required/i);
  } finally {
    await client.close().catch(() => {});
    await fs.rm(emptyHome, { recursive: true, force: true }).catch(() => {});
  }
});
