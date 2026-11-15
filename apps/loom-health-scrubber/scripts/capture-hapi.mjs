#!/usr/bin/env node
// Runs the REAL pinned HAPI image under the OTel Java agent, drives the sentinel
// operations through it, and returns everything it emitted (stdout/stderr: application
// log, access log, and the spans/metrics the agent's `logging` exporters print).
//
//   node apps/loom-health-scrubber/scripts/capture-hapi.mjs <outdir>
//
// What is real: the HAPI server (digest lifted from apps/loom-health-fhir/Dockerfile),
// the agent (version + sha256 lifted from otel-agent.lock), the agent settings
// (apps/loom-health-fhir/config/otel.properties), and every byte of output.
// What differs from a stamp: H2 in-memory database instead of Postgres, no plugin jar,
// and `logging` exporters instead of OTLP, so traces and metrics land on the same stream
// the scrubber filters. See the README for what that does and does not prove.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, '..', '..', '..');
const FHIR = join(ROOT, 'apps', 'loom-health-fhir');
export const SENTINEL = 'ZZ-SENTINEL-LHDS';
const STARTED_ACCESS = /fhirtest\.access/;

const docker = (args, opts = {}) =>
  execFileSync('docker', args, { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], ...opts });

/** Lift the runtime base image digest from the Dockerfile rather than transcribing it. */
export function hapiImage() {
  const m = readFileSync(join(FHIR, 'Dockerfile'), 'utf8').match(/^FROM (hapiproject\/hapi@sha256:[0-9a-f]{64}) AS runtime/m);
  if (!m) throw new Error('could not lift the HAPI digest from apps/loom-health-fhir/Dockerfile');
  return m[1];
}

async function ensureAgent(dir) {
  const lock = Object.fromEntries(
    readFileSync(join(FHIR, 'otel-agent.lock'), 'utf8').split(/\r?\n/).filter(Boolean).map((l) => l.split(/=(.*)/s).slice(0, 2)),
  );
  const jar = join(dir, `opentelemetry-javaagent-${lock.version}.jar`);
  // Read-or-download without a separate existence check (no check-then-use window): the bytes
  // that are hashed below are the bytes that were read or just fetched.
  let bytes;
  try {
    bytes = readFileSync(jar);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    const res = await fetch(lock.url);
    if (!res.ok) throw new Error(`agent download failed: HTTP ${res.status}`);
    bytes = Buffer.from(await res.arrayBuffer());
    // Cache only bytes that match the lock; 'wx' fails rather than overwrite a file that appeared meanwhile.
    if (createHash('sha256').update(bytes).digest('hex') === lock.sha256.trim()) {
      try { writeFileSync(jar, bytes, { flag: 'wx' }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    }
  }
  const sum = createHash('sha256').update(bytes).digest('hex');
  if (sum !== lock.sha256.trim()) throw new Error(`agent sha256 mismatch: got ${sum}, lock says ${lock.sha256.trim()}`);
  return jar;
}

async function call(base, method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/fhir+json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, text };
}

/** @returns {{log: string, ops: Array<{op: string, status: number}>, image: string}} */
export async function captureHapi({ workDir }) {
  mkdirSync(workDir, { recursive: true });
  const jar = await ensureAgent(workDir);
  const props = join(FHIR, 'config', 'otel.properties');
  const image = hapiImage();
  const name = `lhds-w25-${process.pid}`;
  docker([
    'run', '-d', '--name', name, '-p', '127.0.0.1::8080',
    '-v', `${jar}:/otel/agent.jar:ro`, '-v', `${props}:/otel/otel.properties:ro`,
    '-e', 'JAVA_TOOL_OPTIONS=-javaagent:/otel/agent.jar -Dotel.javaagent.configuration-file=/otel/otel.properties',
    '-e', 'OTEL_TRACES_EXPORTER=logging', '-e', 'OTEL_METRICS_EXPORTER=logging', '-e', 'OTEL_METRIC_EXPORT_INTERVAL=3000',
    image,
  ]);
  try {
    const port = docker(['port', name, '8080/tcp']).trim().split('\n')[0].split(':').pop();
    const base = `http://127.0.0.1:${port}/fhir`;
    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
      try { up = (await fetch(`${base}/metadata`)).ok; } catch { /* not listening yet */ }
      if (!up) await new Promise((r) => setTimeout(r, 3000));
    }
    if (!up) throw new Error('HAPI did not become ready within 180 s');

    const since = Math.floor(Date.now() / 1000) - 1;
    const ops = [];
    const rec = (op, r) => { ops.push({ op, status: r.status }); return r; };
    const patient = {
      resourceType: 'Patient',
      identifier: [{ system: 'urn:loom:mrn', value: 'MRN-ZZ-0001' }],
      name: [{ family: SENTINEL, given: ['Probe'] }],
      birthDate: '1970-01-01',
    };
    const created = rec('create', await call(base, 'POST', '/Patient', patient));
    const id = JSON.parse(created.text).id;
    rec('read', await call(base, 'GET', `/Patient/${id}`));
    rec('search', await call(base, 'GET', `/Patient?family=${SENTINEL}&_count=5`));
    rec('everything', await call(base, 'GET', `/Patient/${id}/$everything`));
    rec('delete', await call(base, 'DELETE', `/Patient/${id}`));
    rec('read-after-delete', await call(base, 'GET', `/Patient/${id}`));
    // The error path: HAPI echoes the offending value in its exception message.
    rec('invalid-create', await call(base, 'POST', '/Patient', { resourceType: 'Patient', name: [{ family: SENTINEL }], gender: SENTINEL }));
    await new Promise((r) => setTimeout(r, 8000)); // let the periodic metric reader flush

    return { log: collect(name, since), ops, image };
  } finally {
    try { docker(['rm', '-f', name]); } catch { /* best effort */ }
  }
}

// `docker logs` replays the container's stdout on stdout and its stderr on stderr; keep both
// (concatenated: arrival order is not recoverable, and the scrubber is line-local anyway).
// Only the window from just before the first operation is kept: startup output is ~16 MB of
// unrelated agent/Hibernate noise that carries no request data.
function collect(name, sinceEpochSec) {
  const r = spawnSync('docker', ['logs', '--since', String(sinceEpochSec), name], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`docker logs failed (exit ${r.status})`);
  // Drop the background cache-refresh spans (thread search-parameter-identity-cache-*): ~24,600
  // lines of internal queries that run on a timer, serve no request, and would make the
  // committed fixture 13 MB. Request-thread output is untouched.
  const lines = `${r.stdout}\n${r.stderr}`.split(/\r?\n/)
    .filter((l) => l.length > 0 && !l.includes('[search-parameter-identity-cache'));
  if (!lines.some((l) => STARTED_ACCESS.test(l))) throw new Error('capture window has no access-log line: the operations never reached the server log');
  return normalizeIds(lines.join('\n') + '\n');
}

/**
 * Replace random hex identifiers (trace ids 32, span ids 16, container id 64 / host name 12)
 * with stable placeholders. They carry no meaning for the test, and secret scanners read
 * high-entropy hex next to words like "token" (the HFJ_SPIDX_TOKEN table) as API keys. The
 * mapping is consistent within one capture, so span/trace relationships stay readable.
 */
export function normalizeIds(text) {
  const seen = new Map();
  const label = (prefix, id) => {
    if (!seen.has(id)) seen.set(id, `${prefix}-${String(seen.size + 1).padStart(4, '0')}`);
    return seen.get(id);
  };
  return text
    .replace(/\b[0-9a-f]{64}\b/g, (m) => label('container', m))
    .replace(/\b[0-9a-f]{32}\b/g, (m) => label('trace', m))
    .replace(/\b[0-9a-f]{16}\b/g, (m) => label('span', m))
    .replace(/\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{12}\b/g, (m) => label('host', m));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = resolve(process.argv[2] ?? join(ROOT, 'temp', 'scrub-capture'));
  mkdirSync(out, { recursive: true });
  const { log, ops, image } = await captureHapi({ workDir: join(ROOT, 'temp', 'scrub-capture') });
  writeFileSync(join(out, 'capture.txt'), log);
  writeFileSync(join(out, 'ops.json'), JSON.stringify({ image, ops }, null, 2) + '\n');
  process.stdout.write(`captured ${log.split('\n').length - 1} lines, ops=${JSON.stringify(ops)}\n`);
}
