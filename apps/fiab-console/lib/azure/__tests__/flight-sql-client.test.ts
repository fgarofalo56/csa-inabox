/**
 * N3 — Flight ticket minting + connection snippets.
 *
 * The three properties this surface is judged on:
 *   1. TICKETS ARE SHORT-LIVED AND SCOPED — minted from a verified principal,
 *      TTL clamped, single-audience, HMAC-signed, and verifiable.
 *   2. SNIPPETS CARRY NO SECRET AND NO INTERNAL HOST — they reference the
 *      reader's own env var and the audited console route, never a signing key,
 *      a minted ticket, or a `*.internal.*` container address.
 *   3. ISSUANCE IS AUDITED — one `_auditLog` row per mint, carrying the ticket
 *      id the serving tier repeats on redemption.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const auditRows: any[] = [];
const streamed: any[] = [];
vi.mock('@/lib/azure/cosmos-client', () => ({
  auditLogContainer: async () => ({
    items: { create: async (doc: any) => { auditRows.push(doc); return { resource: doc }; } },
  }),
}));
vi.mock('@/lib/admin/audit-stream', () => ({ emitAuditEvent: (e: any) => { streamed.push(e); } }));

import {
  buildFlightSnippets,
  logFlightAccess,
  mintFlightTicket,
  resolveFlightEndpoint,
  snippetIsSecretFree,
  verifyFlightTicket,
  MAX_TICKET_TTL_S,
  TICKET_AUDIENCE,
} from '../flight-sql-client';

const PRINCIPAL = { oid: 'oid-1', upn: 'analyst@contoso.com', tenantId: 'tid-1' };

beforeEach(() => {
  auditRows.length = 0;
  streamed.length = 0;
  process.env.LOOM_FLIGHT_TICKET_SECRET = 'unit-test-signing-key';
});

afterEach(() => {
  delete process.env.LOOM_FLIGHT_TICKET_SECRET;
  delete process.env.LOOM_FLIGHTSQL_URL;
  delete process.env.LOOM_FLIGHTSQL_PUBLIC_URL;
});

describe('mintFlightTicket', () => {
  it('carries the Entra principal, the scope and a short expiry', () => {
    const minted = mintFlightTicket({ ...PRINCIPAL, scope: ['container:gold'], now: 1_700_000_000_000 });
    expect(minted.claims.aud).toBe(TICKET_AUDIENCE);
    expect(minted.claims.oid).toBe('oid-1');
    expect(minted.claims.upn).toBe('analyst@contoso.com');
    expect(minted.claims.tid).toBe('tid-1');
    expect(minted.claims.scope).toEqual(['container:gold']);
    expect(minted.claims.exp - minted.claims.iat).toBe(300);
    expect(minted.signed).toBe(true);
    expect(minted.token.startsWith('v1.')).toBe(true);
  });

  it('clamps an absurd TTL so a caller cannot mint a permanent credential', () => {
    const forever = mintFlightTicket({ ...PRINCIPAL, ttlSeconds: 60 * 60 * 24 * 365 });
    expect(forever.ttlSeconds).toBe(MAX_TICKET_TTL_S);
    const instant = mintFlightTicket({ ...PRINCIPAL, ttlSeconds: 1 });
    expect(instant.ttlSeconds).toBe(30);
  });

  it('gives every ticket a distinct id so mint and redemption join 1:1', () => {
    const a = mintFlightTicket(PRINCIPAL);
    const b = mintFlightTicket(PRINCIPAL);
    expect(a.claims.jti).not.toBe(b.claims.jti);
  });

  it('reports signed:false — rather than pretending — when no key is configured', () => {
    delete process.env.LOOM_FLIGHT_TICKET_SECRET;
    expect(mintFlightTicket(PRINCIPAL).signed).toBe(false);
  });
});

describe('verifyFlightTicket', () => {
  it('round-trips a freshly minted ticket', () => {
    const minted = mintFlightTicket({ ...PRINCIPAL, scope: ['container:gold'] });
    expect(verifyFlightTicket(minted.token)?.oid).toBe('oid-1');
  });

  it('rejects a tampered payload', () => {
    const minted = mintFlightTicket(PRINCIPAL);
    const forged = Buffer.from(JSON.stringify({ ...minted.claims, oid: 'attacker' })).toString('base64url');
    const tampered = `v1.${forged}.${minted.token.split('.')[2]}`;
    expect(verifyFlightTicket(tampered)).toBeNull();
  });

  it('rejects an expired ticket', () => {
    const minted = mintFlightTicket({ ...PRINCIPAL, ttlSeconds: 30 });
    expect(verifyFlightTicket(minted.token, Date.now() + 60_000)).toBeNull();
  });

  it('rejects a malformed or wrong-version token', () => {
    expect(verifyFlightTicket('')).toBeNull();
    expect(verifyFlightTicket('v2.a.b')).toBeNull();
    expect(verifyFlightTicket('not-a-ticket')).toBeNull();
  });
});

describe('resolveFlightEndpoint', () => {
  it('reports not-deployed when nothing is wired, and still explains the Arrow path', () => {
    const info = resolveFlightEndpoint();
    expect(info.exposure).toBe('not-deployed');
    expect(info.uri).toBe('');
    expect(info.note).toContain('audited HTTP tier');
  });

  it('NEVER hands out the internal container address', () => {
    process.env.LOOM_FLIGHTSQL_URL = 'grpc://loom-duckdb.internal.bluesky-1234.eastus.azurecontainerapps.io:8815';
    const info = resolveFlightEndpoint();
    expect(info.exposure).toBe('in-vnet');
    expect(info.uri).toBe('');
    expect(info.note).not.toContain('azurecontainerapps.io');
    expect(info.note).toContain('LOOM_FLIGHTSQL_PUBLIC_URL');
  });

  it('rejects a "published" URL that is actually an internal host', () => {
    process.env.LOOM_FLIGHTSQL_URL = 'grpc://loom-duckdb.internal.x.eastus.azurecontainerapps.io:8815';
    process.env.LOOM_FLIGHTSQL_PUBLIC_URL = 'grpc://loom-duckdb.internal.x.eastus.azurecontainerapps.io:8815';
    expect(resolveFlightEndpoint().exposure).toBe('in-vnet');
  });

  it('publishes a genuinely external endpoint', () => {
    process.env.LOOM_FLIGHTSQL_URL = 'grpc://internal:8815';
    process.env.LOOM_FLIGHTSQL_PUBLIC_URL = 'grpc+tls://flight.loom.contoso.com:443';
    const info = resolveFlightEndpoint();
    expect(info.exposure).toBe('published');
    expect(info.uri).toBe('grpc+tls://flight.loom.contoso.com:443');
  });
});

describe('buildFlightSnippets', () => {
  const endpoint = {
    uri: 'grpc+tls://flight.loom.contoso.com:443',
    exposure: 'published' as const,
    note: 'ok',
  };
  const mintUrl = 'https://loom.contoso.com/api/flightsql/session';

  it('covers the clients an analyst actually uses', () => {
    const ids = buildFlightSnippets({ endpoint, ticketMintUrl: mintUrl }).map((s) => s.id);
    expect(ids).toEqual(['curl-ticket', 'adbc-python', 'flight-python', 'jdbc', 'adbc-go']);
  });

  it('reads the credential from the reader\'s OWN environment — never inlines one', () => {
    const minted = mintFlightTicket(PRINCIPAL);
    for (const snippet of buildFlightSnippets({ endpoint, ticketMintUrl: mintUrl })) {
      expect(snippet.code).toContain('LOOM_FLIGHT_TICKET');
      expect(snippet.code).not.toContain(minted.token);
      expect(snippet.code).not.toContain('unit-test-signing-key');
      expect(snippetIsSecretFree(snippet.code)).toBe(true);
    }
  });

  it('points ticket acquisition at the AUDITED console route', () => {
    const curl = buildFlightSnippets({ endpoint, ticketMintUrl: mintUrl }).find((s) => s.id === 'curl-ticket')!;
    expect(curl.code).toContain('/api/flightsql/session');
    expect(curl.code).toContain('https://loom.contoso.com');
  });

  it('never names an internal host, even when only the in-VNet endpoint exists', () => {
    const snippets = buildFlightSnippets({
      endpoint: { uri: '', exposure: 'in-vnet', note: 'in-vnet only' },
      ticketMintUrl: mintUrl,
    });
    for (const snippet of snippets) {
      expect(snippet.code).not.toMatch(/\.internal\.[a-z0-9-]+\.azurecontainerapps\./i);
    }
  });

  it('embeds the caller\'s sample statement so the snippet is runnable as pasted', () => {
    const snippets = buildFlightSnippets({ endpoint, ticketMintUrl: mintUrl, sampleSql: 'SELECT 42 AS answer' });
    const adbc = snippets.find((s) => s.id === 'adbc-python')!;
    expect(adbc.code).toContain('SELECT 42 AS answer');
  });
});

describe('snippetIsSecretFree', () => {
  it('catches an accidentally inlined ticket or signing key', () => {
    const minted = mintFlightTicket(PRINCIPAL);
    expect(snippetIsSecretFree(`token=${minted.token}`)).toBe(false);
    expect(snippetIsSecretFree('key=unit-test-signing-key')).toBe(false);
    expect(snippetIsSecretFree('token=$LOOM_FLIGHT_TICKET')).toBe(true);
  });
});

describe('logFlightAccess', () => {
  it('writes ONE audit row carrying the join key and fans it out to the stream', async () => {
    await logFlightAccess({
      actorOid: 'oid-1',
      actorUpn: 'analyst@contoso.com',
      tenantId: 'tid-1',
      operation: 'flight.ticket.mint',
      ticketId: 'ticket-abc',
      scope: ['container:gold'],
      ttlSeconds: 300,
      signed: true,
      exposure: 'published',
      outcome: 'success',
    });
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      tenantId: 'tid-1',
      itemType: 'flight-sql',
      action: 'flight.ticket.mint',
      ticketId: 'ticket-abc',
      signed: true,
      outcome: 'success',
    });
    expect(auditRows[0].summary).toContain('300s');
    expect(streamed).toHaveLength(1);
    expect(streamed[0].targetId).toBe('ticket-abc');
  });

  it('records a failure honestly rather than dropping it', async () => {
    await logFlightAccess({
      actorOid: 'oid-1', actorUpn: 'a@b.c', tenantId: 't', operation: 'flight.session.create',
      ticketId: 'ticket-x', scope: [], ttlSeconds: 60, signed: false, exposure: 'in-vnet',
      outcome: 'failure', detail: 'endpoint unreachable',
    });
    expect(auditRows[0].outcome).toBe('failure');
    expect(auditRows[0].summary).toContain('endpoint unreachable');
    expect(auditRows[0].summary).toContain('in-VNet trust');
  });
});
