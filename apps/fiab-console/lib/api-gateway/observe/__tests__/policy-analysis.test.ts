import { describe, expect, it } from 'vitest';
import { analyzePolicy, redactUrl } from '../policy-analysis';
import { detectAiSurface } from '../detect';

const SECRET_POLICY = `<policies><inbound><base />
  <set-backend-service base-url="https://h/p?code=SECRET#frag" />
  <rate-limit calls="100" renewal-period="60" />
  <validate-azure-ad-token tenant-id="organizations"><audiences><audience>api://x</audience></audiences></validate-azure-ad-token>
  <include-fragment fragment-id="loom-pub-a" />
  <my-custom-thing foo="bar" /><another-custom />
  <set-header name="x-api-key" exists-action="override"><value>TOPSECRETVALUE</value></set-header>
</inbound></policies>`;

describe('analyzePolicy comment and CDATA stripping', () => {
  // Breaking value: a rate-limit inside a comment counted as live (limits.length 1), or an element that
  // sits AFTER a comment dropped with it (externalElementNames []).
  it('ignores elements inside comments and CDATA but keeps the ones around them', () => {
    const a = analyzePolicy(
      '<policies><inbound><!-- <rate-limit calls="1" renewal-period="1" /> --><my-live /><![CDATA[<other-ghost />]]></inbound></policies>',
    );
    expect(a.facets.limits).toEqual([]);
    expect(a.externalElementNames).toEqual(['my-live']);
  });

  // DOCUMENTATION / regression guard, not a kill: the old single replace() pass also passes this (measured in
  // a sandbox copy — only the two tests above go RED). It pins that the spliced text stays unread by the tags.
  it('does not splice a new comment out of the text around a removed one', () => {
    const a = analyzePolicy('<policies><!<!-- x -->-- <rate-limit calls="5" renewal-period="9" /> --></policies>');
    expect(a.facets.limits).toHaveLength(1);
    expect(a.facets.limits[0]).toMatchObject({ element: 'rate-limit', calls: 5 });
  });

  it('an unterminated comment swallows the rest, as a parser would', () => {
    expect(analyzePolicy('<policies><!-- <my-ghost /></policies>').externallyAuthored).toBe(0);
  });
});

describe('analyzePolicy', () => {
  it('yields host h and the stored document carries no query, fragment or secret (paired positive + absence)', () => {
    const a = analyzePolicy(SECRET_POLICY);
    // Positive: breaks if the host facet is dropped (e.g. parser stops reading base-url).
    expect(a.facets.backendHosts).toEqual(['h']);
    expect(a.facets.backendUrls).toEqual(['https://h/p']);
    // Absence over the WHOLE serialised stored document; breaks if any facet keeps the raw URL or a header value.
    const stored = JSON.stringify({ id: 'x', policyAnalysis: a });
    for (const needle of ['code=', 'SECRET', '#frag', 'TOPSECRETVALUE', '<policies', '<inbound']) {
      expect(stored, `needle ${needle}`).not.toContain(needle);
    }
  });

  it('counts externally authored elements and names them (breaks if unknown elements are ignored or known ones counted)', () => {
    const a = analyzePolicy(SECRET_POLICY);
    expect(a.externallyAuthored).toBe(2);
    expect(a.externalElementNames).toEqual(['another-custom', 'my-custom-thing']);
  });

  it('extracts limits, auth method and included fragments', () => {
    const a = analyzePolicy(SECRET_POLICY);
    expect(a.facets.limits).toEqual([{ element: 'rate-limit', calls: 100, tokensPerMinute: undefined, renewalPeriod: 60 }]);
    expect(a.facets.authMethods).toEqual(['validate-azure-ad-token']);
    expect(a.facets.includedFragments).toEqual(['loom-pub-a']);
  });

  it('digest is the SHA-256 of the text: changes with the text, stable otherwise', () => {
    const a = analyzePolicy(SECRET_POLICY);
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(analyzePolicy(SECRET_POLICY).sha256).toBe(a.sha256);
    expect(analyzePolicy(SECRET_POLICY.replace('100', '101')).sha256).not.toBe(a.sha256);
  });

  it('an unparseable base-url contributes no host (a named value placeholder is not leaked as a host)', () => {
    const a = analyzePolicy('<policies><inbound><set-backend-service base-url="{{backend}}" /></inbound></policies>');
    expect(a.facets.backendHosts).toEqual([]);
    expect(a.facets.elements['set-backend-service']).toBe(1);
  });

  it('redactUrl strips userinfo, query and fragment', () => {
    expect(redactUrl('https://user:pw@Host.example/a/b?k=v#f')).toEqual({ url: 'https://host.example/a/b', host: 'host.example' });
    expect(redactUrl('ftp://h/x')).toBeUndefined();
  });
});

describe('detectAiSurface', () => {
  it('detects an Azure OpenAI backend host, and a plain host is not AI', () => {
    expect(detectAiSurface({ serviceUrl: 'https://acct.openai.azure.com/openai' })?.kinds).toEqual(['azure-openai']);
    expect(detectAiSurface({ serviceUrl: 'https://example.com/api' })).toBeUndefined();
  });
  it('detects llm policy elements as selection detected', () => {
    const p = analyzePolicy('<policies><inbound><llm-token-limit tokens-per-minute="5000" counter-key="k" /></inbound></policies>');
    const s = detectAiSurface({ policy: p });
    expect(s?.selection).toBe('detected');
    expect(s?.kinds).toEqual(['llm-policy']);
  });
});
