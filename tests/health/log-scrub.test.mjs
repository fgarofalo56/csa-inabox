// LHDS W2-5: the log-scrub test.
//
//   node --test tests/health/log-scrub.test.mjs                 # fixture mode (no Docker)
//   LHDS_SCRUB_LIVE=1 node --test tests/health/log-scrub.test.mjs   # real HAPI in Docker, ~1 min
//
// Runner: node:test (zero dependencies, matches apps/loom-health-fhir/tests/*.test.mjs;
// the scrubber is plain ESM and needs no TS toolchain or vitest install). The PRP names
// `log-scrub.test.ts`; the PRP's own validation block allows the runner to be chosen here.
//
// WHAT IS UNDER TEST. The real scrubber CLI (a child process, `src/cli.mjs`) is fed output
// captured from the REAL pinned HAPI image running under the OTel Java agent after
// create / read / search / $everything / delete / an invalid create carrying the sentinel.
// Fixture mode replays a committed capture of exactly that; live mode re-captures.
//
// assertion-design.md: every test states the input that breaks it ("BREAKS when").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  scrubLine, scrubQueryText, scrubAttributes, scrubMetricLabels, scrubOtlp,
  createScrubTransform, MAX_LINE_BYTES, OVERLONG_MARKER, ERROR_MARKER,
} from '../../apps/loom-health-scrubber/src/scrub.mjs';
import { SENTINEL, captureHapi } from '../../apps/loom-health-scrubber/scripts/capture-hapi.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const APP = join(ROOT, 'apps', 'loom-health-scrubber');
const CLI = join(APP, 'src', 'cli.mjs');
const LIVE = process.env.LHDS_SCRUB_LIVE === '1';

// Any rendering of the sentinel a scrubber could leave behind: case-folded, url-encoded
// hyphens, or just the distinctive stem.
const SENTINEL_ANY = /zz[-_%\s]*(?:2d)?[-_]?sentinel/i;

// ---- capture ------------------------------------------------------------------------
let capture;
async function getCapture() {
  if (capture) return capture;
  if (LIVE) {
    const c = await captureHapi({ workDir: join(ROOT, 'temp', 'scrub-capture') });
    capture = { log: c.log, ops: c.ops, source: 'live HAPI' };
  } else {
    const dir = join(APP, 'fixtures');
    capture = {
      log: readFileSync(join(dir, 'capture.txt'), 'utf8'),
      ops: JSON.parse(readFileSync(join(dir, 'ops.json'), 'utf8')).ops,
      source: 'fixture (real HAPI output, captured earlier)',
    };
  }
  return capture;
}

const channelOf = (line) =>
  line.includes('fhirtest.access') ? 'access-log'
    : line.includes('LoggingSpanExporter') ? 'trace'
      : line.includes('LoggingMetricExporter') ? 'metric'
        : line.includes('Failure during REST processing') ? 'exception'
          : 'other';
const byChannel = (log) => {
  const m = { 'access-log': [], trace: [], metric: [], exception: [], other: [] };
  for (const l of log.split('\n').filter(Boolean)) m[channelOf(l)].push(l);
  return m;
};

function pipe(cmd, args, input) {
  const r = spawnSync(cmd, args, { input, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  assert.equal(r.status, 0, `${cmd} exited ${r.status}: ${r.stderr}`);
  return r.stdout;
}
// The "bypass" is a plain byte copy, not the CLI with a flag: the CLI has no off switch.
const bypass = (input) => pipe(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], input);
const scrubbed = (input) => pipe(process.execPath, [CLI], input);

// ---- 1. the sentinel test, with its positive control ------------------------------------
test('capture exercised create/read/search/$everything/delete, and the delete took effect', async () => {
  // BREAKS when: the harness skips an operation class (an operation missing from the access
  // log), or delete silently no-ops (read-after-delete would return 200 instead of 410).
  const { log, ops } = await getCapture();
  const status = Object.fromEntries(ops.map((o) => [o.op, o.status]));
  assert.deepEqual(
    status,
    { create: 201, read: 200, search: 200, everything: 200, delete: 200, 'read-after-delete': 410, 'invalid-create': 400 },
  );
  for (const op of ['Operation[create  Patient', 'Operation[read  Patient/', 'Operation[search-type  Patient', 'Operation[extended-operation-instance $everything Patient/', 'Operation[delete  Patient/']) {
    assert.ok(log.includes(op), `no access-log record of operation "${op}": the operation never reached the logged path`);
  }
});

test('POSITIVE CONTROL: with the scrubber bypassed the sentinel is visible in log, trace, metric and exception output', async () => {
  // BREAKS when: the capture stops containing the sentinel in any channel (a harness that
  // no longer sends it, a server that stops logging it). Then "sentinel absent after
  // scrubbing" below would be vacuously true, which is exactly what this guards against.
  const { log, source } = await getCapture();
  console.log(`# log-scrub capture source: ${source}`);
  const raw = bypass(log);
  assert.equal(raw, log, 'bypass must be a byte-identical copy');
  const ch = byChannel(raw);
  for (const name of ['access-log', 'trace', 'metric', 'exception']) {
    const hits = ch[name].filter((l) => l.includes(SENTINEL)).length;
    assert.ok(hits >= 1, `unscrubbed ${name} output never shows ${SENTINEL}: the control cannot see the leak`);
  }
});

test('SENTINEL TEST: the sentinel appears in NO log line, trace attribute or metric label after scrubbing', async () => {
  // BREAKS when: the CLI stops applying the scrubber (the sandbox mutation that replaces the
  // transform with a pass-through turns this red), or any single rule stops covering its
  // channel. Checked per channel so the failure names the sink.
  const { log } = await getCapture();
  const out = scrubbed(log);
  const ch = byChannel(out);
  for (const name of ['access-log', 'trace', 'metric', 'exception', 'other']) {
    const leaked = ch[name].filter((l) => SENTINEL_ANY.test(l));
    assert.equal(leaked.length, 0, `${name}: ${leaked.length} line(s) still carry the sentinel, first: ${(leaked[0] ?? '').slice(0, 160)}`);
  }
  assert.equal(SENTINEL_ANY.test(out), false);
});

test('the scrubber redacts rather than deletes: same line count, operational fields intact', async () => {
  // BREAKS when: an implementation "passes" by emitting nothing or by blanking every line.
  // Pairs with the absence test above (assertion-design.md #4).
  const { log } = await getCapture();
  const out = scrubbed(log);
  assert.equal(out.split('\n').length, log.split('\n').length, 'line count changed');
  assert.ok(out.includes('Operation[search-type  Patient]'), 'access-log operation name was lost');
  assert.ok(out.includes('url.path=/fhir/Patient'), 'span url.path was lost');
  assert.ok(out.includes('_count=5'), 'allow-listed _count value was lost');
  assert.match(out, /family=\[REDACTED\]/, 'the query key must survive with its value redacted');
  assert.match(out, /InvalidRequestException: HAPI-0450:/, 'exception class and HAPI code must survive');
  assert.ok(out.includes('LoggingMetricExporter') && out.includes('http.server.request.duration'), 'metric names were lost');
});

test('scrubbing is idempotent over every captured line', async () => {
  // BREAKS when: a replacement token (e.g. [REDACTED]) is itself matched by a rule and
  // rewritten, which would make a pipeline of two scrubbers corrupt the output.
  const { log } = await getCapture();
  for (const l of log.split('\n').filter(Boolean)) {
    const once = scrubLine(l);
    assert.equal(scrubLine(once), once, `not idempotent on: ${l.slice(0, 120)}`);
  }
});

// ---- 2. rule units (each names its breaking input) ------------------------------------------
test('query: only allow-listed keys with a constrained value survive; the rest fail closed', () => {
  // BREAKS when: the rule becomes a deny-list (then `mothersmaidenname=Smith` or
  // `zzfuture=X` would stay) or the _count value shape is dropped (then `_count=<name>` passes).
  assert.equal(scrubQueryText('family=ZZ-SENTINEL-LHDS&_count=5'), 'family=[REDACTED]&_count=5');
  assert.equal(scrubQueryText('mothersmaidenname=Smith&zzfuture=X'), 'mothersmaidenname=[REDACTED]&zzfuture=[REDACTED]');
  assert.equal(scrubQueryText('_count=ZZ-SENTINEL-LHDS'), '_count=[REDACTED]');
  assert.equal(scrubQueryText('_count=5&_sort=-birthdate'), '_count=5&_sort=-birthdate');
});

test('query: modifiers, url-encoding and bare tokens do not slip past', () => {
  // BREAKS when: keys are compared without decoding/lowercasing (`Family%3Aexact` would be
  // an "unknown" key that is still redacted, but `%5Fcount=ZZ` decoding to an allowed key
  // with a bad value must be redacted by the value shape), or a token with no `=` is kept.
  assert.equal(scrubQueryText('name%3Acontains=Smith'), 'name:contains=[REDACTED]');
  assert.equal(scrubQueryText('%5Fcount=ZZ-SENTINEL-LHDS'), '_count=[REDACTED]');
  assert.equal(scrubQueryText('ZZ-SENTINEL-LHDS'), '[REDACTED]');
  assert.equal(scrubQueryText('identifier=urn%3Amrn%7C12345'), 'identifier=[REDACTED]');
});

test('line: HAPI access log, OTel url.query (quoted and bare) and url.full are all covered', () => {
  // BREAKS when: one of the three introducers (`Params[?`, `url.query=`, a `?` in a URL) is removed from QUERY_SEGMENT.
  const a = scrubLine(`Params[?_count=5&family=${SENTINEL}] ResponseEncoding[]`);
  const b = scrubLine(`url.path=/fhir/Patient, url.query="family=${SENTINEL}&_count=5", x=1`);
  const c = scrubLine(`url.query=family=${SENTINEL}&_count=5, url.path=/fhir/Patient`);
  const d = scrubLine(`url.full=http://h/fhir/Patient?given=${SENTINEL} next=1`);
  for (const s of [a, b, c, d]) assert.equal(SENTINEL_ANY.test(s), false, s);
  assert.equal(a, 'Params[?_count=5&family=[REDACTED]] ResponseEncoding[]');
  assert.equal(b, 'url.path=/fhir/Patient, url.query="family=[REDACTED]&_count=5", x=1');
  assert.equal(c, 'url.query=family=[REDACTED]&_count=5, url.path=/fhir/Patient');
  assert.equal(d, 'url.full=http://h/fhir/Patient?given=[REDACTED] next=1');
});

test('line: JSON fragments of a resource lose name/identifier/DOB/address values but keep the key', () => {
  // BREAKS when: a PHI key is removed from PHI_JSON_KEYS or the array form `"given":["A","B"]` stops matching.
  const s = scrubLine(`echo {"family":"${SENTINEL}","given":["Ann","Bo"],"birthDate":"1970-01-01","city":"Reno","status":"active"}`);
  assert.equal(
    s,
    'echo {"family":"[REDACTED]","given":"[REDACTED]","birthDate":"[REDACTED]","city":"[REDACTED]","status":"active"}',
  );
});

test('line: a HAPI exception keeps its class and code but never its message', () => {
  // BREAKS when: the REST_FAILURE rule is removed (HAPI echoes `Invalid attribute value "<x>"`),
  // or when it also eats the HAPI code an operator needs to triage.
  const line = `WARN x : Failure during REST processing: ca.uhn.fhir.rest.server.exceptions.InvalidRequestException: HAPI-0450: Invalid attribute value "${SENTINEL}"`;
  assert.equal(
    scrubLine(line),
    'WARN x : Failure during REST processing: ca.uhn.fhir.rest.server.exceptions.InvalidRequestException: HAPI-0450: [REDACTED-MESSAGE]',
  );
  // the same echo outside that prefix is caught by the HAPI-code rule
  const bare = scrubLine(`HAPI-1821: [element="gender"] Invalid attribute value "${SENTINEL}"`);
  assert.equal(bare, 'HAPI-1821: [REDACTED-MESSAGE]');
});

test('line: SSN, e-mail, MRN, DOB and DICOM patient tags', () => {
  // BREAKS when: any SHAPE_RULES entry is removed. Each input is distinct so one rule cannot hide another.
  assert.equal(scrubLine('ssn 123-45-6789 end'), 'ssn [REDACTED-SSN] end');
  assert.equal(scrubLine('mail jane.doe@example.org end'), 'mail [REDACTED-EMAIL] end');
  assert.equal(scrubLine('id MRN-ZZ-0001 end'), 'id [REDACTED-MRN] end');
  assert.equal(scrubLine('DOB: 1970-01-01 end'), '[REDACTED-DOB] end');
  assert.equal(scrubLine('(0010,0010) PN [DOE^JOHN]'), '[REDACTED-DICOM-TAG]');
  assert.equal(scrubLine('PatientID=ABC123 x'), 'PatientID=[REDACTED] x');
  assert.equal(scrubLine('SeriesDescription=Chest CT'), 'SeriesDescription=Chest CT', 'non-PHI DICOM keywords must be left alone');
});

// ---- 3. structured telemetry ----------------------------------------------------------------
test('attributes: body/header/exception-message keys are dropped, url.query scrubbed, route kept', () => {
  // BREAKS when: DROP_KEY stops matching `http.request.body`/`...header.authorization`, the
  // exception.message drop is removed (HAPI puts the offending value there), or the bare PHI
  // key `family` is no longer redacted. `thread.name` must NOT be redacted (false-positive guard).
  const out = scrubAttributes({
    'http.request.body': `{"family":"${SENTINEL}"}`,
    'http.request.header.authorization': 'Bearer abc',
    'exception.message': `bad value ${SENTINEL}`,
    'exception.type': 'InvalidRequestException',
    'url.query': `family=${SENTINEL}&_count=5`,
    'http.route': '/fhir/*',
    family: SENTINEL,
    'thread.name': 'http-nio-8080-exec-5',
    given: ['A', 'B'],
  });
  assert.deepEqual(out, {
    'exception.type': 'InvalidRequestException',
    'url.query': 'family=[REDACTED]&_count=5',
    'http.route': '/fhir/*',
    family: '[REDACTED]',
    'thread.name': 'http-nio-8080-exec-5',
    given: ['[REDACTED]', '[REDACTED]'],
  });
});

test('metric labels: deny by default; unknown and PHI-bearing labels are dropped', () => {
  // BREAKS when: the label filter becomes a deny-list (url.query and patient.family would
  // pass), or the length cap is removed (a 200-char value would pass).
  const out = scrubMetricLabels({
    'http.route': '/fhir/*',
    'http.response.status_code': 200,
    'url.query': `family=${SENTINEL}`,
    'patient.family': SENTINEL,
    'fhir.operation': 'x'.repeat(200),
  });
  assert.deepEqual(out, { 'http.route': '/fhir/*', 'http.response.status_code': 200, 'fhir.operation': '[REDACTED]' });
});

test('OTLP JSON: span attributes, data-point labels and exemplar attributes are scrubbed; resource attributes are not label-filtered', () => {
  // SYNTHETIC document (the stamp's OTLP path is not exercised locally; see README). BREAKS
  // when: exemplar `filteredAttributes` (where HAPI's url.query lands in metrics) are skipped,
  // or resource attributes are run through the label allow-list (host.name would vanish).
  const kv = (key, stringValue) => ({ key, value: { stringValue } });
  const doc = {
    resourceSpans: [{
      resource: { attributes: [kv('host.name', 'pod-1')] },
      scopeSpans: [{ spans: [{ name: 'GET /fhir/*', attributes: [kv('url.query', `family=${SENTINEL}&_count=5`), kv('http.route', '/fhir/*'), kv('http.request.body', SENTINEL)] }] }],
    }],
    resourceMetrics: [{
      resource: { attributes: [kv('host.name', 'pod-1')] },
      scopeMetrics: [{ metrics: [{ name: 'http.server.request.duration', histogram: { dataPoints: [{
        attributes: [kv('http.route', '/fhir/*'), kv('url.query', SENTINEL)],
        exemplars: [{ filteredAttributes: [kv('url.query', `family=${SENTINEL}`)] }],
      }] } }] }],
    }],
  };
  const out = scrubOtlp(doc);
  assert.equal(SENTINEL_ANY.test(JSON.stringify(out)), false);
  const span = out.resourceSpans[0].scopeSpans[0].spans[0];
  assert.deepEqual(span.attributes, [kv('url.query', 'family=[REDACTED]&_count=5'), kv('http.route', '/fhir/*')]);
  assert.deepEqual(out.resourceSpans[0].resource.attributes, [kv('host.name', 'pod-1')]);
  assert.deepEqual(out.resourceMetrics[0].resource.attributes, [kv('host.name', 'pod-1')]);
  const dp = out.resourceMetrics[0].scopeMetrics[0].metrics[0].histogram.dataPoints[0];
  assert.deepEqual(dp.attributes, [kv('http.route', '/fhir/*')]);
  assert.deepEqual(dp.exemplars[0].filteredAttributes, []);
});

test('OTLP JSON: a kvlistValue attribute is scrubbed, an unknown value type is DROPPED (fail closed)', () => {
  // BREAKS when: a value type the scrubber cannot read passes through (the original defect:
  // kvlistValue and non-string array elements were returned untouched, so the nested
  // `family` below survived), or a nested key is exempt from the PHI-key rule.
  const sv = (s) => ({ stringValue: s });
  const doc = { attributes: [
    { key: 'x', value: { kvlistValue: { values: [{ key: 'family', value: sv(SENTINEL) }] } } },
    { key: 'raw', value: { bytesValue: Buffer.from(SENTINEL).toString('base64') } },
    { key: 'mixed', value: { arrayValue: { values: [sv('ok'), { bytesValue: 'WlotU0VOVElORUwtTEhEUw==' }] } } },
    { key: 'future', value: { someNewValue: SENTINEL } },
    { key: 'n', value: { intValue: '7' } },
    { key: 'tags', value: { arrayValue: { values: [sv('a'), sv('b')] } } },
  ] };
  const out = scrubOtlp(doc);
  assert.equal(SENTINEL_ANY.test(JSON.stringify(out)), false, JSON.stringify(out));
  assert.deepEqual(out.attributes, [
    { key: 'x', value: { kvlistValue: { values: [{ key: 'family', value: sv('[REDACTED]') }] } } },
    { key: 'n', value: { intValue: '7' } },
    { key: 'tags', value: { arrayValue: { values: [sv('a'), sv('b')] } } },
  ]);
});

test('OTLP JSON: span name, status.message, and log-record body are scrubbed', () => {
  // BREAKS when: scrubOtlp leaves `name`, `status.message` or a log `body` untouched
  // (a span named from a URL, an error message echoing a value, a log body carrying a name).
  const doc = {
    resourceSpans: [{ scopeSpans: [{ spans: [{
      name: `GET /fhir/Patient?family=${SENTINEL}`,
      status: { code: 2, message: `Failure during REST processing: x.InvalidRequestException: HAPI-0450: bad ${SENTINEL}` },
    }] }] }],
    resourceLogs: [
      { scopeLogs: [{ logRecords: [{ body: { stringValue: `Params[?family=${SENTINEL}]` } }, { body: { bytesValue: 'eA==' } }] }] },
    ],
  };
  const out = scrubOtlp(doc);
  assert.equal(SENTINEL_ANY.test(JSON.stringify(out)), false, JSON.stringify(out));
  const span = out.resourceSpans[0].scopeSpans[0].spans[0];
  assert.equal(span.name, 'GET /fhir/Patient?family=[REDACTED]');
  assert.equal(span.status.message, 'Failure during REST processing: x.InvalidRequestException: HAPI-0450: [REDACTED-MESSAGE]');
  assert.equal(span.status.code, 2);
  const [a, b] = out.resourceLogs[0].scopeLogs[0].logRecords;
  assert.deepEqual(a.body, { stringValue: 'Params[?family=[REDACTED]]' });
  assert.deepEqual(b.body, { stringValue: '[REDACTED]' }, 'an unknown body type is replaced, not passed');
});

test('metric labels: a non-scalar value on an allowed key is dropped', () => {
  // BREAKS when: an object/array value on an allow-listed label key passes through unscrubbed.
  assert.deepEqual(scrubMetricLabels({ 'http.route': { family: SENTINEL }, 'http.request.method': 'GET' }), { 'http.request.method': 'GET' });
});

test('stream: a multibyte character split across chunks does not corrupt the line', async () => {
  // Fixture arithmetic: U+00E9 is 2 bytes (0xC3 0xA9); the cut is between them. BREAKS when
  // chunks are decoded independently (each half becomes U+FFFD).
  const bytes = Buffer.from('café ok\n');
  const out = await through(createScrubTransform(), [bytes.subarray(0, 4), bytes.subarray(4)]);
  assert.equal(out, 'café ok\n');
});

// ---- 4. stream behaviour ---------------------------------------------------------------------
async function through(stream, chunks) {
  const out = [];
  stream.on('data', (d) => out.push(d.toString()));
  for (const c of chunks) stream.write(c);
  await new Promise((r) => { stream.end(); stream.on('end', r); stream.resume(); });
  return out.join('');
}

test('stream: a sentinel split across two chunks is still redacted (line assembly)', async () => {
  // Fixture arithmetic: the cut falls after "ZZ-SEN" (6 chars of the 16-char sentinel), so
  // each chunk alone holds an incomplete token. BREAKS when: the stream scrubs per chunk
  // instead of per line - then neither half matches and "ZZ-SEN" survives.
  const out = await through(createScrubTransform(), ['Params[?family=ZZ-SEN', 'TINEL-LHDS]\nnext\n']);
  assert.equal(out, 'Params[?family=[REDACTED]]\nnext\n');
  assert.equal(out.includes('ZZ-SEN'), false);
});

test('stream: a line the scrubber throws on is DROPPED, never passed through', async () => {
  // BREAKS when: the catch block emits the original line (fail-open).
  const boom = () => { throw new Error('rule bug'); };
  const out = await through(createScrubTransform(boom), [`secret ${SENTINEL}\n`]);
  assert.equal(out, `${ERROR_MARKER}\n`);
});

test('stream: an over-long line is dropped with a marker and does not poison the next line', async () => {
  // BREAKS when: the cap is removed (unbounded buffer) or the tail of the long line is emitted.
  const big = `${SENTINEL}${'a'.repeat(MAX_LINE_BYTES + 10)}`;
  const out = await through(createScrubTransform(), [big.slice(0, MAX_LINE_BYTES + 5), `${big.slice(MAX_LINE_BYTES + 5)}\nok\n`]);
  assert.equal(out, `${OVERLONG_MARKER}\nok\n`);
});

// ---- 5. OTel config (a guard on the config file, not behaviour) ----------------------------------
test('GUARD (documentation of intent, not a behaviour test): otel.properties captures no headers and disables log forwarding', () => {
  // BREAKS when: someone sets a capture-*-headers list to a non-empty value or turns the
  // OTel log exporter on. It cannot detect a NEW capture setting it does not list.
  const p = join(ROOT, 'apps', 'loom-health-fhir', 'config', 'otel.properties');
  assert.ok(existsSync(p), 'otel.properties missing');
  const props = Object.fromEntries(readFileSync(p, 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('#')).map((l) => l.split(/=(.*)/s).slice(0, 2)));
  for (const k of ['server.capture-request-headers', 'server.capture-response-headers', 'client.capture-request-headers', 'client.capture-response-headers']) {
    assert.equal(props[`otel.instrumentation.http.${k}`], '', `${k} must be set and empty`);
  }
  assert.equal(props['otel.logs.exporter'], 'none');
  assert.equal(props['otel.instrumentation.common.db-statement-sanitizer.enabled'], 'true');
});
