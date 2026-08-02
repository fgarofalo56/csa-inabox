/**
 * #2830 — the E2E assertion must actually FIRE on the URL that shipped.
 *
 * The `loom:`-id class reached production four times, and every instance was
 * already printed in a Playwright capture log. Adding an assertion is only half
 * the fix; an assertion nobody has proven fires is the same "control that runs,
 * reports, and measures nothing" that let the class survive. These cases pin the
 * predicate against the EXACT observed URL, its encoding variants, and the
 * traffic it must stay quiet about.
 */
import { describe, it, expect } from 'vitest';
import { loomIdFailures, assertNoLoomIdFailures } from '../e2e/_lib/loom-id-failures';

const HOST = 'https://csa-loom.example.net';
const f = (url: string, status: number, sameOrigin = true, method = 'GET') =>
  ({ url, status, sameOrigin, method });

/** Verbatim from run 30757747218 — the request this class was filed on. */
const OBSERVED = `${HOST}/api/items/report/loom%3A8872fd18-f6a8-4a08-aade-7ee7dc3960d3/pages?workspaceId=loom-native`;

describe('#2830 — loomIdFailures catches what four defects walked past', () => {
  it('flags the exact URL from the live run', () => {
    expect(loomIdFailures([f(OBSERVED, 404)]).map((n) => n.status)).toEqual([404]);
  });

  it('flags the #2822 shape too — a `loom:` id on a semantic-model sub-route', () => {
    const url = `${HOST}/api/items/semantic-model/loom%3A9ebf823c-1111-2222-3333-444455556666/roles?workspaceId=2b289a0b-0000-0000-0000-000000000000`;
    expect(loomIdFailures([f(url, 404)])).toHaveLength(1);
  });

  it('flags a RAW colon as well as the percent-encoded form', () => {
    const raw = `${HOST}/api/items/scorecard/loom:abc-123`;
    expect(loomIdFailures([f(raw, 404)])).toHaveLength(1);
    expect(loomIdFailures([f(`${HOST}/api/items/scorecard/loom%3Aabc-123`, 404)])).toHaveLength(1);
    // Lowercase %3a — Playwright reports whatever the client emitted.
    expect(loomIdFailures([f(`${HOST}/api/items/scorecard/loom%3aabc-123`, 404)])).toHaveLength(1);
  });

  it('flags a 400 and a 403, not just a 404', () => {
    expect(loomIdFailures([f(OBSERVED, 400), f(OBSERVED, 403)])).toHaveLength(2);
  });

  it('assertNoLoomIdFailures throws, and names the offending request', () => {
    expect(() => assertNoLoomIdFailures([f(OBSERVED, 404)], 'the report walk'))
      .toThrow(/#2830/);
    expect(() => assertNoLoomIdFailures([f(OBSERVED, 404)], 'the report walk'))
      .toThrow(/loom%3A8872fd18/);
  });
});

describe('#2830 — the assertion must stay quiet on legitimate traffic', () => {
  it('CONTROL: a clean walk passes', () => {
    expect(() => assertNoLoomIdFailures([], 'a clean walk')).not.toThrow();
    expect(() => assertNoLoomIdFailures(undefined, 'no capture')).not.toThrow();
  });

  it('CONTROL: a 404 on a PLAIN Cosmos id is not this class', () => {
    // A plain id can legitimately 404 (deleted item, another tenant's id). Only
    // a `loom:` id proves the item exists, which is what makes 4xx diagnostic.
    const url = `${HOST}/api/items/report/8872fd18-f6a8-4a08-aade-7ee7dc3960d3/pages`;
    expect(loomIdFailures([f(url, 404)])).toEqual([]);
  });

  it('CONTROL: 401 is the auth-not-loaded-yet noise and is ignored', () => {
    expect(loomIdFailures([f(OBSERVED, 401)])).toEqual([]);
  });

  it('CONTROL: a 5xx is left to the caller\'s own assertions', () => {
    expect(loomIdFailures([f(OBSERVED, 500)])).toEqual([]);
  });

  it('CONTROL: a 2xx on a `loom:` id is the fixed state and must not flag', () => {
    expect(loomIdFailures([f(OBSERVED, 200)])).toEqual([]);
  });

  it('CONTROL: a third-party 404 is not our mount\'s problem', () => {
    const url = 'https://cdn.example.com/api/items/report/loom%3Aabc/pages';
    expect(loomIdFailures([f(url, 404, false)])).toEqual([]);
  });

  it('CONTROL: `loom:` elsewhere in the URL is a different namespace', () => {
    // Lineage qualified names (`loom://…`) and cache/pin keys also start `loom:`
    // — only the `[id]` SEGMENT of an item route is this class.
    expect(loomIdFailures([f(`${HOST}/api/catalog/lineage?qn=loom%3A%2F%2Fws%2Fitem`, 404)])).toEqual([]);
    expect(loomIdFailures([f(`${HOST}/api/items/report/abc/pages?catalog=loom%3Axyz`, 404)])).toEqual([]);
  });
});
