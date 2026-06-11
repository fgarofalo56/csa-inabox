// CSA Loom — stdio MCP child-process JSON-RPC client.
//
// Spawns an `npx`/`uvx`-launched MCP server that speaks JSON-RPC over
// stdio (newline-delimited per the MCP stdio transport spec) and exposes
// initialize / tools/list / tools/call as promises. One instance per
// bridged catalog entry; the child is spawned lazily on first use and
// kept warm (re-spawned automatically if it exits).
//
// No external dependencies — Node built-ins only (child_process).

import { spawn } from 'node:child_process';

/** Resolve the launcher binary for a catalog entry. */
function launcherCommand(launcher) {
  // npx ships with Node; uvx ships with the `uv` Python toolchain (pipx-installed
  // in the Dockerfile). Anything else is rejected — no free-form commands.
  if (launcher === 'npx') return 'npx';
  if (launcher === 'uvx') return 'uvx';
  throw new Error(`unsupported launcher: ${launcher} (allowed: npx, uvx)`);
}

/**
 * Build the child env: process env filtered to the entry's envAllowlist plus
 * the always-safe PATH/HOME/locale set. Secrets reach the container as Key
 * Vault secretRefs and are surfaced as env vars; only allow-listed names are
 * forwarded to the child, never the bridge's own identity/config.
 */
function childEnv(entry) {
  const base = {};
  for (const k of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'TEMP', 'TMP', 'NODE_OPTIONS', 'npm_config_cache', 'UV_CACHE_DIR']) {
    if (process.env[k] != null) base[k] = process.env[k];
  }
  for (const name of entry.envAllowlist || []) {
    if (process.env[name] != null) base[name] = process.env[name];
  }
  return base;
}

export class StdioMcpClient {
  /** @param {object} entry catalog entry */
  constructor(entry, logger = console) {
    this.entry = entry;
    this.logger = logger;
    this.child = null;
    this.buf = '';
    this.nextId = 1;
    this.pending = new Map(); // id -> {resolve, reject, timer}
    this.notificationHandlers = new Set(); // (msg) => void  (for SSE fan-out)
    this.initialized = null; // Promise<void> once handshake completes
  }

  _spawn() {
    const cmd = launcherCommand(this.entry.launcher);
    const args = [...(this.entry.launcherArgs || []), this.entry.package, ...(this.entry.args || [])];
    const child = spawn(cmd, args, {
      env: childEnv(this.entry),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this._onData(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => this.logger.error?.(`[${this.entry.id}] ${String(d).trimEnd()}`));
    child.on('exit', (code, sig) => {
      this.logger.error?.(`[${this.entry.id}] child exited code=${code} sig=${sig}`);
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(`stdio MCP server '${this.entry.id}' exited (code=${code})`));
      }
      this.pending.clear();
      this.child = null;
      this.initialized = null;
    });
    this.child = child;
  }

  _onData(chunk) {
    this.buf += chunk;
    let nl;
    // Newline-delimited JSON-RPC frames (MCP stdio transport).
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        this.logger.error?.(`[${this.entry.id}] non-JSON line: ${line.slice(0, 200)}`);
        continue;
      }
      if (msg.id != null && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(msg.error.message || `JSON-RPC error ${msg.error.code}`));
        else p.resolve(msg.result);
      } else {
        // Notification / server-initiated message → fan out to SSE listeners.
        for (const h of this.notificationHandlers) {
          try { h(msg); } catch { /* listener errors are non-fatal */ }
        }
      }
    }
  }

  _send(method, params, { notify = false, timeoutMs = 30000 } = {}) {
    if (!this.child) this._spawn();
    if (notify) {
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
      return Promise.resolve();
    }
    const id = this.nextId++;
    const payload = { jsonrpc: '2.0', id, method, params: params ?? {} };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout after ${timeoutMs}ms calling ${method} on '${this.entry.id}'`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.child.stdin.write(JSON.stringify(payload) + '\n');
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  /** Lazily perform the MCP initialize handshake (once per live child). */
  ensureInitialized() {
    if (!this.child) this._spawn();
    if (this.initialized) return this.initialized;
    this.initialized = (async () => {
      await this._send('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        clientInfo: { name: 'csa-loom-mcp-bridge', version: '0.1.0' },
      }, { timeoutMs: 20000 });
      await this._send('notifications/initialized', {}, { notify: true });
    })();
    return this.initialized;
  }

  async listTools(timeoutMs = 15000) {
    await this.ensureInitialized();
    const result = await this._send('tools/list', {}, { timeoutMs });
    return result?.tools || [];
  }

  async callTool(name, args, timeoutMs = 60000) {
    await this.ensureInitialized();
    return this._send('tools/call', { name, arguments: args || {} }, { timeoutMs });
  }

  onNotification(handler) {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  /** Raw JSON-RPC pass-through for the standard SSE/streamable-HTTP transport. */
  async rpc(message, timeoutMs = 60000) {
    await this.ensureInitialized();
    if (message.id == null) {
      // Notification — forward, no response.
      this.child.stdin.write(JSON.stringify(message) + '\n');
      return null;
    }
    return this._send(message.method, message.params, { timeoutMs });
  }

  dispose() {
    if (this.child) {
      try { this.child.kill('SIGTERM'); } catch { /* already gone */ }
      this.child = null;
    }
  }
}
