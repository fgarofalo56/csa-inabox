// @ts-nocheck
/**
 * pylsp-bridge — server half of the "Monaco cell editor + Pylance LSP bridge".
 *
 * Attaches a WebSocket upgrade handler to the Console's Node HTTP server for
 * paths matching /api/notebook/<id>/lsp. Each accepted socket spawns a
 * python-lsp-server (pylsp) process and bridges it to the browser:
 *
 *   browser  --(1 JSON-RPC msg per WS frame)-->  bridge  --(Content-Length framed stdio)-->  pylsp
 *   pylsp    --(Content-Length framed stdout)-->  bridge  --(1 JSON-RPC msg per WS frame)-->  browser
 *
 * pylsp wraps the open-source pyright/jedi analysis engines that Microsoft's
 * Pylance is built on, so `import pandas as pd; pd.read_` yields real member
 * completions (pandas-stubs) and hovering `pd.DataFrame` returns the docstring.
 *
 * Real auth: the upgrade request must carry a valid `loom_session` cookie
 * (AES-256-GCM, HKDF from SESSION_SECRET — identical scheme to lib/auth/session.ts).
 * Invalid/missing sessions are destroyed before any process spawns.
 *
 * Gated entirely behind LOOM_PYLSP_ENABLED (wired in instrumentation.ts) so the
 * default Console deployment is untouched. When the flag is set but Python/pylsp
 * isn't on PATH (image built without --build-arg LOOM_INCLUDE_PYLSP=true), the
 * spawn fails and the socket closes cleanly — the editor keeps Monaco's built-in
 * completions and the /api/notebook/<id>/lsp probe reports lspAvailable:false.
 *
 * Plain .mjs (excluded from the TS program). Imports `ws` at runtime only.
 */

import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const COOKIE_NAME = 'loom_session';
const ALG = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;
const LSP_PATH_RE = /^\/api\/notebook\/[^/?#]+\/lsp(?:[/?#]|$)/;

function sessionKey() {
  const secret = process.env.SESSION_SECRET;
  if (!secret) return null;
  return crypto.hkdfSync('sha256', Buffer.from(secret, 'utf-8'), Buffer.alloc(32), Buffer.from('loom-session-v1'), 32);
}

function readCookie(header, name) {
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
  }
  return null;
}

/** Validate the encrypted loom_session cookie. Returns true when decodable. */
function hasValidSession(req) {
  const key = sessionKey();
  if (!key) return false;
  const value = readCookie(req.headers && req.headers.cookie, COOKIE_NAME);
  if (!value) return false;
  try {
    const raw = Buffer.from(value, 'base64url');
    if (raw.length < IV_LEN + TAG_LEN + 1) return false;
    const iv = raw.subarray(0, IV_LEN);
    const tag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const encrypted = raw.subarray(IV_LEN + TAG_LEN);
    const decipher = crypto.createDecipheriv(ALG, key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    JSON.parse(plaintext.toString('utf-8'));
    return true;
  } catch {
    return false;
  }
}

/** Streaming Content-Length frame parser for pylsp stdout. */
function makeStdoutParser(onMessage) {
  let buffer = Buffer.alloc(0);
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const header = buffer.subarray(0, headerEnd).toString('ascii');
      const match = /content-length:\s*(\d+)/i.exec(header);
      if (!match) {
        // Unparseable header — drop it to avoid a permanent stall.
        buffer = buffer.subarray(headerEnd + 4);
        continue;
      }
      const length = parseInt(match[1], 10);
      const bodyStart = headerEnd + 4;
      if (buffer.length < bodyStart + length) return; // wait for the rest
      const body = buffer.subarray(bodyStart, bodyStart + length).toString('utf-8');
      buffer = buffer.subarray(bodyStart + length);
      onMessage(body);
    }
  };
}

function frame(message) {
  const body = Buffer.from(message, 'utf-8');
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]);
}

let attached = false;

/**
 * Attach the pylsp WebSocket bridge to a Node http.Server. Idempotent per
 * process. Safe to call when `ws` or Python are absent — failures are logged
 * and the socket is closed, never throwing into the HTTP server.
 */
export async function attachPylspBridge(server) {
  if (attached) return;
  attached = true;

  let WebSocketServer;
  try {
    ({ WebSocketServer } = await import('ws'));
  } catch (e) {
    console.error('[pylsp-bridge] `ws` package not installed — LSP bridge disabled.', e && e.message);
    return;
  }

  const pythonBin = (process.env.LOOM_PYLSP_PYTHON || 'python3').trim();
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = req.url || '';
    if (!LSP_PATH_RE.test(url)) return; // not ours — let other handlers run

    if (!hasValidSession(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      let pylsp;
      try {
        pylsp = spawn(pythonBin, ['-m', 'pylsp', '--check-parent-process'], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: process.env,
        });
      } catch (e) {
        console.error('[pylsp-bridge] spawn failed:', e && e.message);
        try { ws.close(1011, 'pylsp unavailable'); } catch { /* noop */ }
        return;
      }

      const parse = makeStdoutParser((body) => {
        if (ws.readyState === ws.OPEN) ws.send(body);
      });
      pylsp.stdout.on('data', parse);
      pylsp.stderr.on('data', (d) => {
        // pylsp logs to stderr; surface only when explicitly debugging.
        if (process.env.LOOM_PYLSP_DEBUG) process.stderr.write(`[pylsp] ${d}`);
      });
      pylsp.on('error', (e) => {
        console.error('[pylsp-bridge] process error:', e && e.message);
        try { ws.close(1011, 'pylsp error'); } catch { /* noop */ }
      });
      pylsp.on('exit', () => { try { ws.close(); } catch { /* noop */ } });

      ws.on('message', (data) => {
        const text = typeof data === 'string' ? data : data.toString('utf-8');
        try { pylsp.stdin.write(frame(text)); } catch { /* process gone */ }
      });
      ws.on('close', () => { try { pylsp.kill(); } catch { /* noop */ } });
      ws.on('error', () => { try { pylsp.kill(); } catch { /* noop */ } });
    });
  });

  console.log('[pylsp-bridge] attached — Python LSP bridge live on /api/notebook/*/lsp');
}

// Pure helpers exported for unit tests (Content-Length framing round-trip,
// cookie parsing). Not part of the public attach surface.
export const __test = { frame, makeStdoutParser, readCookie };
