// Unit tests for the standalone patient picker's pieces (#5454 A5): the HTML
// escaper, the page renderer, and the default FHIR PatientSearch over a fake
// fetch. The end-to-end flow is in auth-server.test.ts.

import { describe, expect, it } from 'vitest';
import { FHIR_ID } from '../src/auth/fhir-user.js';
import {
  PATIENT_SEARCH_MAX,
  PatientSearchUnavailableError,
  createFhirPatientSearch,
  patientName,
  summarize,
} from '../src/auth/patient-search.js';
import { escapeHtml, renderPicker, renderPickerError } from '../src/auth/picker-page.js';

describe('escapeHtml', () => {
  it('escapes the five significant characters, & first so nothing is double-escaped', () => {
    // Breaks if any one of the five is missing from the map, or if & is escaped after the others (&amp;lt;).
    expect(escapeHtml(`<script>alert("x")</script> & 'q'`)).toBe('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;q&#39;');
    expect(escapeHtml('&lt;')).toBe('&amp;lt;'); // an already-escaped string is escaped again, never trusted
    expect(escapeHtml(undefined)).toBe('');
    expect(escapeHtml(42)).toBe('42');
    expect(escapeHtml('plain-id.1')).toBe('plain-id.1'); // positive: ordinary text is unchanged
  });
});

describe('renderPicker', () => {
  const view = {
    action: '/auth/visn-01/pick',
    req: 'r'.repeat(32),
    csrf: 'c'.repeat(32),
    appName: `App "<b>"`,
    tenant: 'visn-01',
    query: { name: `x" autofocus onfocus="alert(1)`, birthdate: '' },
  };
  it('escapes attribute and text values and has no script element or event-handler attribute', () => {
    const html = renderPicker({ ...view, state: { kind: 'results', patients: [{ id: 'p1', name: '<img src=x onerror=alert(1)>' }] } });
    // Breaks if the query is interpolated raw into value="...": the quote would close the attribute.
    expect(html).toContain('value="x&quot; autofocus onfocus=&quot;alert(1)"');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('App &quot;&lt;b&gt;&quot;');
    // An injected element needs a raw `<`, an injected attribute a raw quote after on*= (escaped text has neither).
    expect(html).not.toMatch(/<script|<img|\son\w+="/i);
    // Accessibility: every input has a label, the results are radios in a fieldset with a legend.
    expect(html).toContain('<label for="q">Patient name</label>');
    expect(html).toContain('<label for="birthdate">');
    expect(html).toMatch(/<fieldset><legend>1 matching patient<\/legend>/);
    expect(html).toContain('<label for="p0"><input type="radio" id="p0" name="patient" value="p1" required>');
  });
  it('renders Continue only with results; Cancel always; no search box when not permitted', () => {
    const results = renderPicker({ ...view, state: { kind: 'results', patients: [{ id: 'p1', name: 'A' }] } });
    expect(results).toContain('value="select"');
    const unavailable = renderPicker({ ...view, state: { kind: 'unavailable' } });
    expect(unavailable).not.toContain('value="select"'); // breaks if Continue is offered with nothing to pick
    expect(unavailable).toContain('value="cancel"');
    expect(unavailable).toContain('name="q"');
    const denied = renderPicker({ ...view, state: { kind: 'not-permitted' } });
    expect(denied).not.toContain('name="q"');
    expect(denied).toContain('value="cancel"');
    expect(denied).toContain('value="continue"'); // Continue without a patient: offered only here
    expect(unavailable).not.toContain('value="continue"');
    expect(results).not.toContain('value="continue"');
  });
  it('the error page escapes and offers no form', () => {
    const html = renderPickerError('<h>', 'a & b');
    expect(html).toContain('&lt;h&gt;');
    expect(html).toContain('a &amp; b');
    expect(html).not.toContain('<form');
  });
});

describe('FHIR_ID', () => {
  it('refuses ids made only of dots and accepts dotted ids', () => {
    for (const bad of ['.', '..', '...', '', 'a/b', 'a b', 'x'.repeat(65)]) expect([bad, FHIR_ID.test(bad)]).toEqual([bad, false]);
    for (const good of ['a', 'a.b', '.a', 'a..', 'pat-1', 'x'.repeat(64)]) expect([good, FHIR_ID.test(good)]).toEqual([good, true]);
  });
});

describe('Patient summaries', () => {
  it('prefers the official name, falls back to given + family, and drops non-Patients and invalid ids', () => {
    expect(patientName({ name: [{ use: 'usual', text: 'Nick' }, { use: 'official', given: ['Ada', 'B'], family: 'Smith' }] })).toBe('Ada B Smith');
    expect(patientName({ name: [{ text: ' Grace H ' }] })).toBe('Grace H');
    expect(patientName({})).toBe('');
    expect(summarize({ resourceType: 'Patient', id: 'p1', birthDate: '1970-01-02', gender: 'female', name: [{ text: 'A' }] })).toEqual({ id: 'p1', name: 'A', birthDate: '1970-01-02', gender: 'female' });
    expect(summarize({ resourceType: 'Patient', id: 'p1', birthDate: '<x>', gender: 'evil' })).toEqual({ id: 'p1', name: '' });
    expect(summarize({ resourceType: 'Practitioner', id: 'p1' })).toBeUndefined();
    expect(summarize({ resourceType: 'Patient', id: '..' })).toBeUndefined(); // breaks if dot-only ids are offered
  });
});

describe('createFhirPatientSearch', () => {
  type Call = { url: string; init: RequestInit | undefined };
  function make(respond: (url: string, init?: RequestInit) => Response | Promise<Response>, timeoutMs?: number) {
    const calls: Call[] = [];
    const tokens: string[] = [];
    const s = createFhirPatientSearch({
      fhirBaseFor: (t) => `https://fhir.test/${t}/fhir`,
      token: async (t, oid, roles) => {
        tokens.push(`${t}|${oid}|${roles.join(',')}`);
        return 'tok-1';
      },
      fetch: (async (u: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(u), init });
        return respond(String(u), init);
      }) as typeof fetch,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
    return { s, calls, tokens };
  }
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/fhir+json' } });
  const patient = (id: string, name = id) => ({ resourceType: 'Patient', id, name: [{ text: name }] });

  it('searches the tenant base with name, birthdate and _count as the user, and keeps matches only', async () => {
    const { s, calls, tokens } = make(() => json(200, {
      resourceType: 'Bundle',
      entry: [
        { resource: patient('p1', 'Ada'), search: { mode: 'match' } },
        { resource: { resourceType: 'Organization', id: 'o1' }, search: { mode: 'include' } },
        { resource: patient('p2', 'Bea'), search: { mode: 'include' } },
        { resource: patient('..') },
      ],
    }));
    const out = await s.search('visn-01', 'oid-1', ['fhir-data-reader'], { name: 'a d&a', birthdate: '1970' });
    expect(out).toEqual([{ id: 'p1', name: 'Ada' }]); // breaks if includes or a dot-only id are offered
    expect(calls[0]!.url).toBe('https://fhir.test/visn-01/fhir/Patient?name=a+d%26a&_count=20&birthdate=1970');
    expect((calls[0]!.init!.headers as Record<string, string>).authorization).toBe('Bearer tok-1');
    expect(tokens).toEqual(['visn-01|oid-1|fhir-data-reader']);
  });

  it(`returns at most ${PATIENT_SEARCH_MAX} patients even when the server ignores _count`, async () => {
    const { s } = make(() => json(200, { resourceType: 'Bundle', entry: Array.from({ length: 30 }, (_, i) => ({ resource: patient(`p${i}`) })) }));
    expect((await s.search('t1', 'o', [], { name: 'x' })).length).toBe(PATIENT_SEARCH_MAX); // breaks (30) without the cap
  });

  it('a network failure, a timeout, a non-2xx and a non-Bundle all throw PatientSearchUnavailableError, never []', async () => {
    const refused = make(() => Promise.reject(new TypeError('fetch failed')));
    await expect(refused.s.search('t1', 'o', [], { name: 'x' })).rejects.toBeInstanceOf(PatientSearchUnavailableError);
    // Never answers; rejects only when the AbortSignal fires, as undici does. Breaks (hangs) if no timeout signal is passed.
    const slow = make((_u, init) => new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))), 20);
    await expect(slow.s.search('t1', 'o', [], { name: 'x' })).rejects.toThrow(/unavailable: timeout$/);
    await expect(make(() => json(500, {})).s.search('t1', 'o', [], { name: 'x' })).rejects.toThrow('HTTP 500');
    await expect(make(() => json(200, { resourceType: 'OperationOutcome' })).s.search('t1', 'o', [], { name: 'x' })).rejects.toThrow('not a Bundle');
  });

  it('read: the patient when visible; undefined on 404/403/410 or an id mismatch; throws when unreachable', async () => {
    const { s, calls } = make((u) => (u.endsWith('/Patient/p1') ? json(200, patient('p1', 'Ada')) : u.endsWith('/Patient/swap') ? json(200, patient('other')) : json(404, {})));
    expect(await s.read('t1', 'o', [], 'p1')).toEqual({ id: 'p1', name: 'Ada' });
    expect(calls[0]!.url).toBe('https://fhir.test/t1/fhir/Patient/p1');
    expect(await s.read('t1', 'o', [], 'gone')).toBeUndefined();
    expect(await s.read('t1', 'o', [], 'swap')).toBeUndefined(); // breaks if the server's id is not compared with the asked one
    expect(await make(() => json(403, {})).s.read('t1', 'o', [], 'p1')).toBeUndefined();
    const before = calls.length;
    expect(await s.read('t1', 'o', [], '..')).toBeUndefined();
    expect(calls.length).toBe(before); // a dot-only id never builds a URL
    await expect(make(() => Promise.reject(new TypeError('fetch failed'))).s.read('t1', 'o', [], 'p1')).rejects.toBeInstanceOf(PatientSearchUnavailableError);
  });

  // R7: the live picker logged `reason: no response` for what may have been a rejected certificate. Each row is the
  // shape undici rejects with (TypeError('fetch failed') + a coded cause); the expected reason is what the AS logs.
  // Breaks if the classes collapse back to one label (every row would read the same), if TLS codes fall to
  // `network`, or if the cause chain / AggregateError member is not walked (those rows would read `network`).
  const failed = (cause: unknown) => new TypeError('fetch failed', { cause });
  const coded = (code: string) => Object.assign(new Error('x'), { code });
  it.each([
    [failed(coded('SELF_SIGNED_CERT_IN_CHAIN')), 'tls SELF_SIGNED_CERT_IN_CHAIN', 'tls'],
    [failed(coded('DEPTH_ZERO_SELF_SIGNED_CERT')), 'tls DEPTH_ZERO_SELF_SIGNED_CERT', 'tls'],
    [failed(coded('ERR_TLS_CERT_ALTNAME_INVALID')), 'tls ERR_TLS_CERT_ALTNAME_INVALID', 'tls'],
    [failed(coded('CERT_HAS_EXPIRED')), 'tls CERT_HAS_EXPIRED', 'tls'],
    [failed(coded('ENOTFOUND')), 'dns ENOTFOUND', 'dns'],
    [failed(coded('EAI_AGAIN')), 'dns EAI_AGAIN', 'dns'],
    [failed(coded('ECONNREFUSED')), 'refused ECONNREFUSED', 'refused'],
    [failed(new AggregateError([coded('ECONNREFUSED')])), 'refused ECONNREFUSED', 'refused'],
    [failed(coded('ECONNRESET')), 'reset ECONNRESET', 'reset'],
    [failed(coded('EHOSTUNREACH')), 'network EHOSTUNREACH', 'network'],
    [new TypeError('fetch failed'), 'network', 'network'],
    [new DOMException('The operation was aborted due to timeout', 'TimeoutError'), 'timeout', 'timeout'],
    [new DOMException('This operation was aborted', 'AbortError'), 'timeout', 'timeout'],
  ])('a fetch rejected with %s is logged as %j', async (err, reason, kind) => {
    const e = (await make(() => Promise.reject(err)).s.search('t1', 'o', [], { name: 'x' }).catch((x: unknown) => x)) as PatientSearchUnavailableError;
    expect(e).toBeInstanceOf(PatientSearchUnavailableError);
    expect(e.reason).toBe(reason);
    expect(e.kind).toBe(kind);
  });

  it('never puts the URL, token or a message into the reason: a code that is not a bare token is dropped', async () => {
    // Breaks if the classifier copies a free-text code (or the message) into the logged reason.
    const err = failed(Object.assign(new Error('https://stamp.example/t1/fhir Bearer tok-1'), { code: 'https://stamp.example/?tok-1' }));
    const e = (await make(() => Promise.reject(err)).s.search('t1', 'o', [], { name: 'x' }).catch((x: unknown) => x)) as PatientSearchUnavailableError;
    expect(e.reason).toBe('network');
    expect(e.message).toBe('patient search unavailable: network');
  });
});
