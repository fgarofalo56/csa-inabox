import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse, type OutgoingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { randomUUID } from 'node:crypto';
import { Transform, pipeline } from 'node:stream';
import { archiveBase, type GatewayConfig } from './config.js';
import { parseRoute, type Route } from './routes.js';
import { UNAUTHENTICATED_REASONS, type Pdp } from './pdp.js';
import { subjectOf, type AuditEvent, type AuditSink } from './audit.js';

export interface Deps {
  cfg: GatewayConfig;
  pdp: Pdp;
  audit: AuditSink;
  /** Test seam; production resolves the per-tenant archive from the URL template. */
  resolveArchive?: (tenant: string) => string;
}

const MAX_TOKEN = 8192;

// Request headers forwarded to the archive. Authorization is NOT among them: the
// archive is unauthenticated by design and reachable only through this gateway, and
// a Loom token has no business in its logs.
const FORWARD_REQUEST = ['accept', 'content-type', 'content-length', 'range'];
// Response headers forwarded back. Everything else (Server, Set-Cookie, ...) is dropped.
const FORWARD_RESPONSE = ['content-type', 'content-length', 'content-disposition', 'content-range', 'accept-ranges', 'warning'];

function json(res: ServerResponse, status: number, body: unknown, extra: OutgoingHttpHeaders = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extra,
  });
  res.end(text);
}

function bearer(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  if (typeof h !== 'string') return null;
  const m = /^Bearer ([A-Za-z0-9._~+/=-]+)$/.exec(h);
  if (!m || m[1]!.length > MAX_TOKEN) return null;
  return m[1]!;
}

type QidoCheck = { ok: true; query: string } | { ok: false; message: string };

/** QIDO caps (AHDS parity): limit 1-200 (default 100), offset >= 0. Values are validated, never trusted. */
export function checkQido(search: URLSearchParams, cfg: GatewayConfig): QidoCheck {
  for (const k of ['limit', 'offset']) {
    if (search.getAll(k).length > 1) return { ok: false, message: `${k} given more than once` };
  }
  const limit = search.get('limit');
  if (limit !== null) {
    if (!/^[0-9]{1,6}$/.test(limit) || Number(limit) < 1 || Number(limit) > cfg.qidoMaxLimit) {
      return { ok: false, message: `limit must be an integer from 1 to ${cfg.qidoMaxLimit}` };
    }
  } else {
    search.set('limit', String(cfg.qidoDefaultLimit));
  }
  const offset = search.get('offset');
  if (offset !== null && !/^[0-9]{1,9}$/.test(offset)) {
    return { ok: false, message: 'offset must be a non-negative integer' };
  }
  return { ok: true, query: search.toString() };
}

export function createGateway(deps: Deps): Server {
  const { cfg, pdp, audit } = deps;

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://gateway.invalid');
    if (url.pathname === '/healthz' && req.method === 'GET') {
      json(res, 200, { ok: true });
      return;
    }

    const requestId = randomUUID();
    res.setHeader('x-request-id', requestId);
    const base: Omit<AuditEvent, 'phase' | 'outcome' | 'reason'> = {
      ts: new Date().toISOString(),
      event: 'dicom.gateway.interaction',
      requestId,
      tenant: null,
      interaction: 'unknown',
      method: req.method ?? '',
      path: url.pathname.slice(0, 300),
      queryKeys: [...new Set(url.searchParams.keys())].slice(0, 30),
    };
    const emit = (e: Partial<AuditEvent> & Pick<AuditEvent, 'phase' | 'outcome' | 'reason'>): void => {
      audit({ ...base, ...e, ts: new Date().toISOString() });
    };
    // Best effort for records that do not gate the response.
    const emitSafe: typeof emit = (e) => {
      try {
        emit(e);
      } catch {
        /* the decision record is the gating one */
      }
    };

    const routed = parseRoute(req.method ?? '', url.pathname, cfg.archiveAet);
    if (!routed.ok) {
      emitSafe({ phase: 'complete', outcome: 'not-found', reason: routed.reason, status: routed.status });
      json(res, routed.status, { error: routed.reason }, routed.allow ? { allow: routed.allow } : {});
      return;
    }
    const route = routed.route;
    base.tenant = route.tenant;
    base.interaction = route.interaction;

    const token = bearer(req);
    if (!token) {
      emitSafe({ phase: 'complete', outcome: 'unauthenticated', reason: 'no-bearer-token', status: 401 });
      json(res, 401, { error: 'unauthenticated' }, { 'www-authenticate': 'Bearer' });
      return;
    }

    // Any exception from the PDP wrapper is "unavailable" (deny), never an allow.
    const decision = await pdp(token, {
      service: 'dicom',
      interaction: route.interaction,
      tenant: route.tenant,
      base: `${cfg.publicBase}/${route.tenant}/dicomweb`,
    }).catch((): { kind: 'unavailable'; cause: string } => ({ kind: 'unavailable', cause: 'pdp-exception' }));

    if (decision.kind === 'unavailable') {
      emitSafe({ phase: 'complete', outcome: 'pdp-unavailable', reason: decision.cause, status: 503 });
      json(res, 503, { error: 'authorization-unavailable' }, { 'retry-after': '5' });
      return;
    }
    if (decision.kind === 'deny') {
      const unauth = UNAUTHENTICATED_REASONS.has(decision.reason);
      const status = unauth ? 401 : 403;
      emitSafe({ phase: 'complete', outcome: unauth ? 'unauthenticated' : 'deny', reason: decision.reason, policyVersion: decision.policyVersion, status });
      json(res, status, { error: unauth ? 'unauthenticated' : 'forbidden', reason: decision.reason }, unauth ? { 'www-authenticate': 'Bearer error="invalid_token"' } : {});
      return;
    }

    // Allowed. The decision record gates the proxy: no audit record, no data.
    try {
      emit({ phase: 'decision', outcome: 'permit', reason: decision.reason, policyVersion: decision.policyVersion, ...subjectOf(token) });
    } catch {
      json(res, 503, { error: 'audit-unavailable' }, { 'retry-after': '5' });
      return;
    }

    let query = url.search.replace(/^\?/, '');
    if (route.interaction === 'qido') {
      const q = checkQido(new URLSearchParams(url.searchParams), cfg);
      if (!q.ok) {
        emitSafe({ phase: 'complete', outcome: 'rejected', reason: 'qido-parameters', status: 400 });
        json(res, 400, { error: 'invalid-query', message: q.message });
        return;
      }
      query = q.query;
    }
    if (route.interaction === 'stow') {
      const ct = String(req.headers['content-type'] ?? '').toLowerCase();
      if (!ct.startsWith('multipart/related')) {
        emitSafe({ phase: 'complete', outcome: 'rejected', reason: 'stow-content-type', status: 415 });
        json(res, 415, { error: 'unsupported-media-type', message: 'STOW-RS requires multipart/related' });
        return;
      }
      const declared = Number(req.headers['content-length']);
      if (Number.isFinite(declared) && declared > cfg.stowMaxBytes) {
        emitSafe({ phase: 'complete', outcome: 'rejected', reason: 'stow-too-large', status: 413 });
        json(res, 413, { error: 'payload-too-large', maxBytes: cfg.stowMaxBytes }, { connection: 'close' });
        return;
      }
    }

    proxy(deps, route, query, req, res, emitSafe);
  };

  return createServer((req, res) => {
    handler(req, res).catch(() => {
      // Never leak an exception message; the connection is closed uniformly.
      if (!res.headersSent) json(res, 500, { error: 'internal' });
      else res.destroy();
    });
  });
}

function proxy(
  deps: Deps,
  route: Route,
  query: string,
  req: IncomingMessage,
  res: ServerResponse,
  emit: (e: Partial<AuditEvent> & Pick<AuditEvent, 'phase' | 'outcome' | 'reason'>) => void,
): void {
  const { cfg } = deps;
  const archiveRoot = (deps.resolveArchive ?? ((t: string) => archiveBase(cfg, t)))(route.tenant);
  const target = new URL(archiveRoot);
  const headers: OutgoingHttpHeaders = {};
  for (const h of FORWARD_REQUEST) {
    const v = req.headers[h];
    if (v !== undefined) headers[h] = v;
  }
  const doRequest = target.protocol === 'https:' ? httpsRequest : httpRequest;
  const rewrite = route.interaction === 'qido' || route.interaction === 'stow';
  const archiveRs = `${archiveRoot}/dcm4chee-arc/aets/${encodeURIComponent(cfg.archiveAet)}/rs`;
  const publicRs = `${cfg.publicBase}/${route.tenant}/dicomweb/v1`;

  let bytesIn = 0;
  let bytesOut = 0;
  let finished = false;
  const done = (status: number, outcome: AuditEvent['outcome'], reason: string): void => {
    if (finished) return;
    finished = true;
    emit({ phase: 'complete', outcome, reason, status, bytesIn, bytesOut });
  };

  const upstream = doRequest(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      method: req.method,
      path: `${route.archivePath}${query ? `?${query}` : ''}`,
      headers,
      timeout: cfg.archiveTimeoutMs,
    },
    (ures) => {
      const status = ures.statusCode ?? 502;
      const out: OutgoingHttpHeaders = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
      for (const h of FORWARD_RESPONSE) {
        const v = ures.headers[h];
        if (v !== undefined && !(rewrite && h === 'content-length')) out[h] = v;
      }
      if (typeof ures.headers.location === 'string') {
        out.location = ures.headers.location.split(archiveRs).join(publicRs);
      }

      if (rewrite) {
        // QIDO/STOW bodies carry RetrieveURL values pointing at the archive. They are
        // small and bounded: buffer, rewrite to the public gateway URL, else fail closed.
        const chunks: Buffer[] = [];
        let size = 0;
        ures.on('data', (c: Buffer) => {
          size += c.length;
          if (size > cfg.rewriteMaxBytes) {
            ures.destroy();
            if (!res.headersSent) json(res, 502, { error: 'archive-response-too-large' });
            done(502, 'error', 'rewrite-too-large');
            return;
          }
          chunks.push(c);
        });
        ures.on('end', () => {
          if (res.headersSent) return;
          const body = Buffer.from(Buffer.concat(chunks).toString('utf8').split(archiveRs).join(publicRs), 'utf8');
          out['content-length'] = body.length;
          bytesOut = body.length;
          res.writeHead(status, out);
          res.end(body);
          done(status, 'permit', 'proxied');
        });
        ures.on('error', () => {
          if (!res.headersSent) json(res, 502, { error: 'archive-error' });
          done(502, 'error', 'archive-stream-error');
        });
        return;
      }

      res.writeHead(status, out);
      const counter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          bytesOut += chunk.length;
          cb(null, chunk);
        },
      });
      pipeline(ures, counter, res, (err) => {
        done(status, err ? 'error' : 'permit', err ? 'stream-aborted' : 'proxied');
      });
    },
  );

  upstream.on('timeout', () => upstream.destroy(new Error('archive-timeout')));
  upstream.on('error', (e) => {
    if (!res.headersSent) json(res, 502, { error: 'archive-unreachable' });
    else res.destroy();
    done(502, 'error', e.message === 'archive-timeout' ? 'archive-timeout' : 'archive-unreachable');
  });
  res.on('close', () => {
    if (!res.writableFinished) upstream.destroy();
  });

  if (req.method === 'POST') {
    // STOW: stream request to archive; the counter enforces the hard cap on the
    // bytes actually received (a lying or absent Content-Length cannot bypass it).
    const limiter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        bytesIn += chunk.length;
        if (bytesIn > cfg.stowMaxBytes) {
          cb(new Error('stow-too-large'));
          return;
        }
        cb(null, chunk);
      },
    });
    pipeline(req, limiter, upstream, (err) => {
      if (!err) return;
      upstream.destroy();
      if (err.message === 'stow-too-large') {
        if (!res.headersSent) json(res, 413, { error: 'payload-too-large', maxBytes: cfg.stowMaxBytes }, { connection: 'close' });
        done(413, 'rejected', 'stow-too-large');
      }
    });
  } else {
    req.resume();
    upstream.end();
  }
}
