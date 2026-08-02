/**
 * Front Door purge-target resolution tests (#2828).
 *
 * The defect being pinned is not "the name was wrong" — it is that the roll
 * ASSUMED a name and then discarded the evidence that the assumption was false.
 * So these tests pin the three states apart (resolved / not-applicable /
 * unresolved) and, specifically, that "unresolved" never silently degrades into
 * "the first endpoint".
 *
 * MUTATION-PROVEN: the tempting one-line "fix" for #2828 is
 *
 *     az afd endpoint list ... --query "[0].name"
 *
 * i.e. replace the hardcoded name with an index. `picks the endpoint that
 * matches, not the first one` and `two endpoints, neither matching -> unresolved`
 * both go RED under that mutation, while the CONTROL tests (a single-endpoint
 * profile, and a direct hostName match that happens to sit at index 0) stay
 * green either way — so an index-based shortcut cannot hide behind them.
 *
 * Run: node --test scripts/ci/__tests__/fd-resolve-purge-target.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { cachingStateOf, hostOf, parseRecords, resolvePurgeTarget } from '../fd-resolve-purge-target.mjs';

/** The live centralus shape, confirmed read-only from `az afd endpoint list`. */
const LIVE = [
  {
    name: 'fd-loom-k6mvh5sm6z7do',
    endpoints: [
      {
        name: 'loom-console-k6mvh5sm6z7do',
        hostName: 'loom-console-k6mvh5sm6z7do-e9cmggbahge3hwf7.b02.azurefd.net',
        domains: ['csa-loom.limitlessdata.ai'],
        // MEASURED, not assumed: `az afd route list` returns
        // `cacheConfiguration: null` for the sole route (`console-route`,
        // patternsToMatch '/*'), so ZERO routes on this endpoint cache — which
        // is why the live URL answers `X-Cache: CONFIG_NOCACHE` and why the
        // purge's `--no-wait` is not an exposure in this estate.
        cachedRoutes: 0,
      },
    ],
  },
];

test('hostOf parses scheme, path, port and case', () => {
  assert.equal(hostOf('https://csa-loom.limitlessdata.ai'), 'csa-loom.limitlessdata.ai');
  assert.equal(hostOf('https://CSA-Loom.LimitlessData.ai/build-marker.txt'), 'csa-loom.limitlessdata.ai');
  assert.equal(hostOf('csa-loom.limitlessdata.ai'), 'csa-loom.limitlessdata.ai');
  assert.equal(hostOf('https://example.net:8443/x'), 'example.net');
  assert.equal(hostOf(''), '');
  assert.equal(hostOf(undefined), '');
});

test('the exact #2828 shape resolves to the SUFFIXED endpoint, via the custom domain', () => {
  const r = resolvePurgeTarget({ url: 'https://csa-loom.limitlessdata.ai', profiles: LIVE });
  assert.equal(r.state, 'resolved');
  assert.equal(r.endpoint, 'loom-console-k6mvh5sm6z7do');
  assert.equal(r.via, 'custom-domain');
  // The name the workflow used to hardcode must never be what we ask Azure for.
  assert.notEqual(r.endpoint, 'loom-console');
});

test('a direct endpoint hostName match resolves via endpoint-host', () => {
  const r = resolvePurgeTarget({
    url: 'https://loom-console-k6mvh5sm6z7do-e9cmggbahge3hwf7.b02.azurefd.net/health',
    profiles: LIVE,
  });
  assert.equal(r.state, 'resolved');
  assert.equal(r.via, 'endpoint-host');
  assert.equal(r.endpoint, 'loom-console-k6mvh5sm6z7do');
});

test('picks the endpoint that matches, not the first one', () => {
  const profiles = [
    {
      name: 'fd-loom',
      endpoints: [
        { name: 'loom-decoy', hostName: 'decoy.b02.azurefd.net', domains: [] },
        { name: 'loom-real', hostName: 'real.b02.azurefd.net', domains: ['csa-loom.limitlessdata.ai'] },
      ],
    },
  ];
  const byDomain = resolvePurgeTarget({ url: 'https://csa-loom.limitlessdata.ai', profiles });
  assert.equal(byDomain.endpoint, 'loom-real');
  const byHost = resolvePurgeTarget({ url: 'https://real.b02.azurefd.net', profiles });
  assert.equal(byHost.endpoint, 'loom-real');
});

test('the match may live in the SECOND profile, not just the second endpoint', () => {
  const profiles = [
    { name: 'fd-other', endpoints: [{ name: 'other-ep', hostName: 'other.b02.azurefd.net', domains: [] }] },
    { name: 'fd-loom', endpoints: [{ name: 'loom-ep', hostName: 'loom.b02.azurefd.net', domains: [] }] },
  ];
  const r = resolvePurgeTarget({ url: 'https://loom.b02.azurefd.net', profiles });
  assert.equal(r.state, 'resolved');
  assert.equal(r.profile, 'fd-loom');
  assert.equal(r.endpoint, 'loom-ep');
});

test('two endpoints, neither matching -> unresolved (NOT the first one)', () => {
  const profiles = [
    {
      name: 'fd-loom',
      endpoints: [
        { name: 'ep-a', hostName: 'a.b02.azurefd.net', domains: [] },
        { name: 'ep-b', hostName: 'b.b02.azurefd.net', domains: [] },
      ],
    },
  ];
  const r = resolvePurgeTarget({ url: 'https://csa-loom.limitlessdata.ai', profiles });
  assert.equal(r.state, 'unresolved');
  assert.equal(r.endpoint, undefined);
  assert.match(r.detail, /guess/);
  // The diagnostic must name what exists, or a failed run tells nobody anything.
  assert.equal(r.candidates.length, 2);
});

test('CONTROL — a sole endpoint resolves even with no host match', () => {
  const profiles = [
    { name: 'fd-loom', endpoints: [{ name: 'loom-console-suffix', hostName: 'x.b02.azurefd.net', domains: [] }] },
  ];
  const r = resolvePurgeTarget({ url: 'https://some-aca-host.centralus.azurecontainerapps.io', profiles });
  assert.equal(r.state, 'resolved');
  assert.equal(r.via, 'sole-endpoint');
  assert.equal(r.endpoint, 'loom-console-suffix');
});

test('no profiles at all is not-applicable, not a failure', () => {
  const r = resolvePurgeTarget({ url: 'https://csa-loom.limitlessdata.ai', profiles: [] });
  assert.equal(r.state, 'not-applicable');
  assert.equal(r.endpoint, undefined);
});

test('a profile with zero endpoints is unresolved, not not-applicable', () => {
  const r = resolvePurgeTarget({ url: 'https://csa-loom.limitlessdata.ai', profiles: [{ name: 'fd-loom', endpoints: [] }] });
  assert.equal(r.state, 'unresolved');
  assert.match(r.detail, /NO endpoint/);
});

test('an unparseable probe URL is unresolved, never a silent pass', () => {
  const r = resolvePurgeTarget({ url: '', profiles: LIVE });
  assert.equal(r.state, 'unresolved');
});

test('duplicate hostNames are ambiguous rather than first-wins', () => {
  const profiles = [
    {
      name: 'fd-loom',
      endpoints: [
        { name: 'ep-a', hostName: 'dup.b02.azurefd.net', domains: [] },
        { name: 'ep-b', hostName: 'dup.b02.azurefd.net', domains: [] },
      ],
    },
  ];
  const r = resolvePurgeTarget({ url: 'https://dup.b02.azurefd.net', profiles });
  assert.equal(r.state, 'unresolved');
  assert.match(r.detail, /ambiguous/);
});

test('parseRecords builds the live shape from the TSV stream the workflow emits', () => {
  const tsv = [
    'profile\tfd-loom-k6mvh5sm6z7do',
    'endpoint\tfd-loom-k6mvh5sm6z7do\tloom-console-k6mvh5sm6z7do\tloom-console-k6mvh5sm6z7do-e9cmggbahge3hwf7.b02.azurefd.net',
    'domain\tfd-loom-k6mvh5sm6z7do\tloom-console-k6mvh5sm6z7do\tcsa-loom.limitlessdata.ai',
    'cache\tfd-loom-k6mvh5sm6z7do\tloom-console-k6mvh5sm6z7do\t0',
    '',
  ].join('\n');
  const profiles = parseRecords(tsv);
  assert.deepEqual(profiles, LIVE);
  assert.equal(resolvePurgeTarget({ url: 'https://csa-loom.limitlessdata.ai', profiles }).endpoint, 'loom-console-k6mvh5sm6z7do');
});

test('parseRecords tolerates CRLF, blank lines and unknown kinds', () => {
  const tsv = 'profile\tp\r\n\nnoise\tx\r\nendpoint\tp\te\th\r\n';
  assert.deepEqual(parseRecords(tsv), [
    { name: 'p', endpoints: [{ name: 'e', hostName: 'h', domains: [], cachedRoutes: null }] },
  ]);
});

test('parseRecords of an EMPTY stream yields no profiles -> not-applicable', () => {
  // A resource group with Front Door genuinely absent must not read as a failure.
  assert.deepEqual(parseRecords(''), []);
  assert.equal(resolvePurgeTarget({ url: 'https://x.example', profiles: parseRecords('') }).state, 'not-applicable');
});

/* --------------------------------------------------------------------------
 * Route caching — is the purge load-bearing at all? (#2828 follow-up)
 *
 * The purge is fired with `--no-wait`, i.e. SUBMITTED not COMPLETED, and a
 * purge can take up to 10 minutes to reach every POP. That is only an exposure
 * if the route caches. It does not (measured three ways: bicep declares
 * `console-route` with no cacheConfiguration; ARM returns cacheConfiguration
 * null; the live URL answers X-Cache: CONFIG_NOCACHE) — so these tests pin the
 * FACT that makes it a non-problem, rather than a comment asserting it.
 *
 * MUTATION-PROVEN. The tempting simplification is a boolean:
 *
 *     caching = Number(cachedRoutes) > 0        // null -> false -> 'off'
 *
 * which silently reclassifies "the az query failed" as "nothing is cached" —
 * absence of evidence read as success, the #2828 defect exactly. Under that
 * mutation `UNKNOWN is not off` and `a failed cache query stays UNKNOWN` go
 * RED, while the CONTROLS (`0 routes -> off`, `1 route -> on`) stay green
 * either way, so the shortcut cannot hide behind them.
 * ------------------------------------------------------------------------ */

test('cachingStateOf keeps UNKNOWN and OFF apart', () => {
  assert.equal(cachingStateOf(0), 'off');          // CONTROL
  assert.equal(cachingStateOf(1), 'on');           // CONTROL
  assert.equal(cachingStateOf(7), 'on');
  assert.equal(cachingStateOf(null), 'unknown');   // the mutation target
  assert.equal(cachingStateOf(undefined), 'unknown');
  assert.equal(cachingStateOf(NaN), 'unknown');
  assert.equal(cachingStateOf('0'), 'unknown');    // a string is not a count
});

test('the measured live estate resolves with caching OFF', () => {
  const r = resolvePurgeTarget({ url: 'https://csa-loom.limitlessdata.ai', profiles: LIVE });
  assert.equal(r.state, 'resolved');
  assert.equal(r.caching, 'off');
});

test('a route WITH cacheConfiguration flips the resolved endpoint to caching ON', () => {
  const profiles = [
    {
      name: 'fd-loom',
      endpoints: [{ name: 'ep', hostName: 'h.example', domains: [], cachedRoutes: 1 }],
    },
  ];
  const r = resolvePurgeTarget({ url: 'https://h.example', profiles });
  assert.equal(r.state, 'resolved');
  assert.equal(r.caching, 'on');
});

test('UNKNOWN is not off — a missing cache record must never read as "nothing is cached"', () => {
  const profiles = [
    // No cachedRoutes at all: the workflow emitted no `cache` record for it.
    { name: 'fd-loom', endpoints: [{ name: 'ep', hostName: 'h.example', domains: [] }] },
  ];
  const r = resolvePurgeTarget({ url: 'https://h.example', profiles });
  assert.equal(r.state, 'resolved');
  assert.equal(r.caching, 'unknown');
  assert.notEqual(r.caching, 'off');
});

test('a failed cache query stays UNKNOWN rather than collapsing to 0', () => {
  // `az ... --query "length(...)"` returning empty/garbage is exactly what a
  // permissions or API hiccup looks like. It must not be read as "0 == off".
  for (const bad of ['', '   ', 'null', 'None', '-1', '1.5', 'ERROR']) {
    const profiles = parseRecords(
      ['profile\tp', 'endpoint\tp\te\th.example', `cache\tp\te\t${bad}`, ''].join('\n'),
    );
    assert.equal(profiles[0].endpoints[0].cachedRoutes, null, `"${bad}" should stay unknown`);
    assert.equal(resolvePurgeTarget({ url: 'https://h.example', profiles }).caching, 'unknown');
  }
});

test('parseRecords reads a cache record, including for an endpoint it has not seen', () => {
  const withEndpoint = parseRecords(['profile\tp', 'endpoint\tp\te\th', 'cache\tp\te\t3', ''].join('\n'));
  assert.equal(withEndpoint[0].endpoints[0].cachedRoutes, 3);

  // Defensive, matching how `domain` records behave: a truncated stream that
  // carries the cache row but not the endpoint row still yields a candidate.
  const orphan = parseRecords(['profile\tp', 'cache\tp\te\t2', ''].join('\n'));
  assert.deepEqual(orphan, [
    { name: 'p', endpoints: [{ name: 'e', hostName: '', domains: [], cachedRoutes: 2 }] },
  ]);
});

test('every non-resolved state reports caching UNKNOWN, never off', () => {
  const notApplicable = resolvePurgeTarget({ url: 'https://x.example', profiles: [] });
  assert.equal(notApplicable.state, 'not-applicable');
  assert.equal(notApplicable.caching, 'unknown');

  const twoNoMatch = resolvePurgeTarget({
    url: 'https://nomatch.example',
    profiles: [
      {
        name: 'fd-loom',
        endpoints: [
          { name: 'a', hostName: 'a.example', domains: [], cachedRoutes: 0 },
          { name: 'b', hostName: 'b.example', domains: [], cachedRoutes: 0 },
        ],
      },
    ],
  });
  assert.equal(twoNoMatch.state, 'unresolved');
  // Both candidates say 0, but no endpoint was chosen — so there is no endpoint
  // whose caching we can report, and 'off' would be a claim about nothing.
  assert.equal(twoNoMatch.caching, 'unknown');
});

test('the CLI emits a caching= line the workflow can parse', async () => {
  const { execFileSync } = await import('node:child_process');
  const { writeFileSync, mkdtempSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { fileURLToPath } = await import('node:url');

  const script = fileURLToPath(new URL('../fd-resolve-purge-target.mjs', import.meta.url));
  const rec = join(mkdtempSync(join(tmpdir(), 'fdrec-')), 'rec.tsv');
  writeFileSync(
    rec,
    [
      'profile\tfd-loom-k6mvh5sm6z7do',
      'endpoint\tfd-loom-k6mvh5sm6z7do\tloom-console-k6mvh5sm6z7do\tloom-console-k6mvh5sm6z7do-e9cmggbahge3hwf7.b02.azurefd.net',
      'domain\tfd-loom-k6mvh5sm6z7do\tloom-console-k6mvh5sm6z7do\tcsa-loom.limitlessdata.ai',
      'cache\tfd-loom-k6mvh5sm6z7do\tloom-console-k6mvh5sm6z7do\t0',
      '',
    ].join('\n'),
  );

  const out = execFileSync(process.execPath, [script, '--url', 'https://csa-loom.limitlessdata.ai', '--input', rec], {
    encoding: 'utf8',
  });
  // Parsed with the same `sed -n 's/^caching=//p'` shape the workflow uses.
  const caching = out.split('\n').find((l) => l.startsWith('caching='));
  assert.equal(caching, 'caching=off');
  assert.ok(out.includes('endpoint=loom-console-k6mvh5sm6z7do'));
});
