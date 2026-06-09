/**
 * loom-copilot-maf — Microsoft Agent Framework (MAF) orchestration tier for
 * GCC-High / IL5. A tiny node:http server (no framework deps) that exposes the
 * SAME orchestration contract as the Console's /api/copilot/orchestrate route,
 * but runs the agent loop against Gov AOAI direct.
 *
 *   GET  /health      → { ok, tier:'maf', cloud }
 *   POST /orchestrate → SSE stream of OrchestratorStep (event: step) terminated
 *                       by event: done. Caller passes the trusted x-user-oid
 *                       header (VNet-internal; the Console forwards the signed-in
 *                       user's oid). No MSAL session — this app is internal-only.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { orchestrateMaf } from './agent-loop.js';
import { isGovCloud } from './cloud-scope.js';

const PORT = parseInt(process.env.PORT || '3100', 10);

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(payload);
}

async function readJsonBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
  } catch {
    return {};
  }
}

async function handleOrchestrate(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const userOid = (req.headers['x-user-oid'] as string | undefined)?.trim();
  if (!userOid) {
    sendJson(res, 401, { ok: false, error: 'x-user-oid header required' });
    return;
  }

  const body = await readJsonBody(req);
  const prompt = (body?.prompt || '').trim();
  if (!prompt) {
    sendJson(res, 400, { ok: false, error: 'prompt is required' });
    return;
  }
  const sessionId =
    body?.sessionId || `sess-maf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const maxIterations =
    typeof body?.maxIterations === 'number' ? body.maxIterations : undefined;

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  send('session', { sessionId });
  try {
    for await (const step of orchestrateMaf({ prompt, sessionId, userOid, maxIterations })) {
      send('step', step);
      if (step.kind === 'final' || step.kind === 'error') break;
    }
  } catch (e: any) {
    send('step', { kind: 'error', error: e?.message || String(e) });
  } finally {
    send('done', { sessionId });
    res.end();
  }
}

const server = createServer((req, res) => {
  const url = (req.url || '').split('?')[0];

  if (req.method === 'GET' && url === '/health') {
    sendJson(res, 200, {
      ok: true,
      tier: 'maf',
      cloud: process.env.AZURE_CLOUD || 'AzureUSGovernment',
      gov: isGovCloud(),
    });
    return;
  }

  if (req.method === 'POST' && url === '/orchestrate') {
    handleOrchestrate(req, res).catch((e) => {
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: e?.message || String(e) });
      else res.end();
    });
    return;
  }

  sendJson(res, 404, { ok: false, error: 'not found' });
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`loom-copilot-maf listening on :${PORT} (Gov AOAI direct, tier=maf)`);
});
