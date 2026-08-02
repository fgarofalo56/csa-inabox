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
import { hostOf, parseRecords, resolvePurgeTarget } from '../fd-resolve-purge-target.mjs';

/** The live centralus shape, confirmed read-only from `az afd endpoint list`. */
const LIVE = [
  {
    name: 'fd-loom-k6mvh5sm6z7do',
    endpoints: [
      {
        name: 'loom-console-k6mvh5sm6z7do',
        hostName: 'loom-console-k6mvh5sm6z7do-e9cmggbahge3hwf7.b02.azurefd.net',
        domains: ['csa-loom.limitlessdata.ai'],
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
    '',
  ].join('\n');
  const profiles = parseRecords(tsv);
  assert.deepEqual(profiles, LIVE);
  assert.equal(resolvePurgeTarget({ url: 'https://csa-loom.limitlessdata.ai', profiles }).endpoint, 'loom-console-k6mvh5sm6z7do');
});

test('parseRecords tolerates CRLF, blank lines and unknown kinds', () => {
  const tsv = 'profile\tp\r\n\nnoise\tx\r\nendpoint\tp\te\th\r\n';
  assert.deepEqual(parseRecords(tsv), [{ name: 'p', endpoints: [{ name: 'e', hostName: 'h', domains: [] }] }]);
});

test('parseRecords of an EMPTY stream yields no profiles -> not-applicable', () => {
  // A resource group with Front Door genuinely absent must not read as a failure.
  assert.deepEqual(parseRecords(''), []);
  assert.equal(resolvePurgeTarget({ url: 'https://x.example', profiles: parseRecords('') }).state, 'not-applicable');
});
