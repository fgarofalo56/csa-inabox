/**
 * THE ANALYZERS — with regression pins on the two bugs this package shipped and
 * fixed during its own construction. Both are recorded because both were
 * SILENT: each produced a smaller finding set, never an error.
 *
 *   1. A GENERIC data-plane call was invisible. `.read<{…}>()` did not match
 *      `/\.read\s*\(/`, so `c.item(id, id).read<T>()` was not recorded as a
 *      privileged sink and the live cross-tenant point-read this extractor exists
 *      to surface was emitted `reachesPrivilegedSink: false`. C1 then correctly
 *      declined to fire on it. Typed data-plane calls are the norm here, so the
 *      matcher was blind to most sinks that matter.
 *
 *   2. STRING-LITERAL evidence was blanked away. `stdio: ['inherit']` and
 *      `process['stdout']` are matched against text whose string contents had
 *      been replaced with spaces, so both read as empty. C4 measured 0 findings
 *      over 208 judged candidates — a perfect, wrong, clean result.
 *
 * Both are the same underlying error in opposite directions: the analysis has to
 * agree with the text it is actually reading.
 */

import { describe, expect, it } from 'vitest';
import {
  blankComments,
  blankNonCode,
  dynamicSegmentsOf,
  findCalls,
  findExportedHandlers,
  routePathOf,
} from '../source-facts';
import { findPrivilegedSinks, sessionScopedIdentifiers, argsAreSessionScoped } from '../sinks';
import { classifyConsumption } from '../consumption';

describe('blankNonCode', () => {
  it('preserves length and line count exactly', () => {
    const src = "const a = 1; // note\n/* block */\nconst s = 'text';\n";
    const out = blankNonCode(src);
    expect(out).toHaveLength(src.length);
    expect(out.split('\n')).toHaveLength(src.split('\n').length);
  });

  it('blanks a docblock that quotes the very shape the extractor hunts', () => {
    // NOT hypothetical: lib/api/route-toolkit.ts:10 contains this in prose, and
    // lib/brain/security/detectors/c1-*.ts contains `if (isTenantAdmin(session))
    // return null;` twice as the shape it is looking for. Matching raw text
    // would report the DETECTOR as carrying the defect.
    const src = `/** const gate = requireTenantAdmin(s); if (gate) return gate */\nconst x = 1;`;
    const out = blankNonCode(src);
    expect(out).not.toContain('requireTenantAdmin');
    expect(out).toContain('const x = 1');
  });

  it('does not let an apostrophe in a comment swallow the rest of the file', () => {
    const src = "// it's fine\nconst realCode = 1;\n";
    expect(blankNonCode(src)).toContain('realCode');
  });
});

describe('blankComments — strings preserved (REGRESSION: C4 read 0 over 208)', () => {
  it('keeps string contents while still removing comments', () => {
    const src = "// stdio: ['inherit'] in a comment\nspawn(x, { stdio: ['inherit', 'pipe'] });";
    const out = blankComments(src);
    expect(out).toContain("stdio: ['inherit', 'pipe']");
    // The commented mention is gone, so it cannot produce a phantom sink.
    expect(out.slice(0, out.indexOf('\n'))).not.toContain('inherit');
  });
});

describe('routePathOf / dynamicSegmentsOf', () => {
  it('derives the URL path and strips route groups', () => {
    expect(routePathOf('apps/fiab-console/app/api/copilot/sessions/[id]/trace/route.ts')).toBe(
      '/api/copilot/sessions/[id]/trace',
    );
    expect(routePathOf('apps/fiab-console/app/(admin)/api/x/route.ts')).toBe('/api/x');
  });

  it('returns null for a module that is not a route', () => {
    expect(routePathOf('apps/fiab-console/lib/api/route-toolkit.ts')).toBeNull();
  });

  it('names the caller-supplied segments', () => {
    expect(dynamicSegmentsOf('/api/a/[id]/b/[slug]')).toEqual(['id', 'slug']);
    expect(dynamicSegmentsOf('/api/a/[...rest]')).toEqual(['rest']);
  });
});

describe('findExportedHandlers', () => {
  it('captures the WRAPPER, not just the handler arrow', () => {
    // The authorization fact lives in the wrapper position. An implementation
    // that returned only the arrow body found ZERO wrappers.
    const src = blankNonCode(
      `export const GET = withTenantAdmin<{ id: string }>(async (req, { params }) => { return ok(); });`,
    );
    const handlers = findExportedHandlers(src);
    expect(handlers).toHaveLength(1);
    expect(handlers[0].method).toBe('GET');
    expect(handlers[0].body).toContain('withTenantAdmin');
  });

  it('reads the function-declaration form too', () => {
    const src = blankNonCode(`export async function POST(req) { return ok(); }`);
    expect(findExportedHandlers(src).map((h) => h.method)).toEqual(['POST']);
  });
});

describe('findCalls tolerates generic instantiation', () => {
  it('finds withTenantAdmin<{ id: string }>(...)', () => {
    const src = blankNonCode(`export const GET = withTenantAdmin<{ id: string }>(handler);`);
    expect(findCalls(src, 'withTenantAdmin')).toHaveLength(1);
  });
});

describe('findPrivilegedSinks (REGRESSION: generic .read<T>() was invisible)', () => {
  it('records a Cosmos point-read written with a type argument', () => {
    const src = blankNonCode(
      `const { resource } = await c.item(id, id).read<{ steps?: unknown[]; prompt?: string }>();`,
    );
    const sinks = findPrivilegedSinks(src);
    expect(sinks.map((s) => s.kind)).toContain('cosmos-cross-partition-read');
  });

  it('records the non-generic form too', () => {
    const src = blankNonCode(`const r = await c.item(a, b).read();`);
    expect(findPrivilegedSinks(src).map((s) => s.kind)).toContain('cosmos-cross-partition-read');
  });

  it('does NOT call a bare .item() without a read a sink', () => {
    const src = blankNonCode(`const handle = c.item(a, b);`);
    expect(findPrivilegedSinks(src)).toHaveLength(0);
  });

  it('classifies writes and deletes distinctly', () => {
    const src = blankNonCode(`await c.items.upsert(doc); await c.item(a, b).delete();`);
    const kinds = findPrivilegedSinks(src).map((s) => s.kind);
    expect(kinds).toContain('cosmos-write');
    expect(kinds).toContain('delete-cascade');
  });
});

describe('session scoping — attribution is NOT authorization', () => {
  it('treats a partition key drawn from the session as SCOPE', () => {
    const body = blankNonCode(`await c.item(id, session.claims.oid).read();`);
    const derived = sessionScopedIdentifiers(body);
    const sink = findPrivilegedSinks(body)[0];
    expect(argsAreSessionScoped(sink.argsText, derived)).toBe(true);
  });

  it('follows a session value through a local binding', () => {
    const body = blankNonCode(`const oid = session.claims.oid;\nawait c.item(id, oid).read();`);
    const derived = sessionScopedIdentifiers(body);
    expect(derived.has('oid')).toBe(true);
    const sink = findPrivilegedSinks(body)[0];
    expect(argsAreSessionScoped(sink.argsText, derived)).toBe(true);
  });

  it('does NOT treat a savedBy ATTRIBUTION field as scope', () => {
    // The measured error: removing bare `claims.*` from the guard signal set
    // moved 0 violations -> 205 on 2026-08-08. A token present in the handler
    // is not a decision about the resource.
    const body = blankNonCode(
      `await c.items.upsert({ ...payload, savedBy: session.claims.oid });\nawait c.item(id, id).read();`,
    );
    const derived = sessionScopedIdentifiers(body);
    const read = findPrivilegedSinks(body).find((s) => s.via.includes('read'))!;
    expect(argsAreSessionScoped(read.argsText, derived)).toBe(false);
  });
});

describe('classifyConsumption', () => {
  const call = (src: string, symbol: string) => {
    const b = blankNonCode(src);
    return classifyConsumption(b, b.indexOf(symbol));
  };

  it('recognises the canonical refusal as TOTAL', () => {
    const c = call(`const gate = await enforceCapability(s, x); if (gate) return gate;`, 'enforceCapability');
    expect(c.consumption).toBe('returned');
    expect(c.refusalIsTotal).toBe(true);
  });

  it('recognises a CONDITIONAL refusal as not total — bypass (a)', () => {
    // `if (gate && req.method !== 'GET') return gate;` genuinely tests the value
    // and genuinely takes a decision. A checker asking "is it tested?" passes it
    // while GET is unauthorized.
    const c = call(
      `const gate = await enforceCapability(s, x); if (gate && req.method !== 'GET') return gate;`,
      'enforceCapability',
    );
    expect(c.consumption).toBe('returned');
    expect(c.refusalIsTotal).toBe(false);
  });

  it('recognises a DEAD STORE — bypass (b)', () => {
    const c = call(`const gate = await enforceCapability(s, x); console.warn(gate);`, 'enforceCapability');
    expect(c.consumption).toBe('logged');
  });

  it('recognises an ATTRIBUTION-only use — bypass (c)', () => {
    const c = call(`const gate = await pdpCheck(s); await save({ decidedBy: gate });`, 'pdpCheck');
    expect(c.consumption).toBe('attribution-only');
  });

  it('recognises a verdict that is never read at all', () => {
    const c = call(`const gate = await pdpCheck(s); return ok();`, 'pdpCheck');
    expect(c.consumption).toBe('ignored');
  });
});
