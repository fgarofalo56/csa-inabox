/**
 * domainResourceInventory puts the domain id into an Azure Resource Graph
 * query. Resource Graph parses KQL, and a KQL regular string literal uses
 * BACKSLASH escapes (`\\` for a backslash, `\'` for a quote) — so the id goes
 * through escapeKqlLiteral, not quote doubling.
 *
 * What breaks these tests:
 *   - interpolating `domainId` raw (the pre-change shape): the query carries
 *     `fin'ance\x`, not `fin\'ance\\x`, and the exact-line assertion fails;
 *   - quote doubling (escapeSqlLiteral) instead: the query carries
 *     `fin''ance\x`, which the same assertion rejects;
 *   - escaping only one of the two values: the line holds one escaped and one
 *     raw copy, and the exact-line assertion fails.
 * The plain-id case is the positive control: a value with nothing to escape is
 * carried unchanged, so the escaping cannot pass by mangling every id.
 *
 * No network and no auth: fetch-with-timeout and @azure/identity are mocked,
 * the same stubs the sibling suites under this directory use.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'tk', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});
vi.mock('@/lib/azure/aca-managed-identity', () => {
  class AcaManagedIdentityCredential { async getToken() { return { token: 'tk', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { AcaManagedIdentityCredential };
});

const fetchWithTimeout = vi.fn();
vi.mock('@/lib/azure/fetch-with-timeout', () => ({
  fetchWithTimeout: (...args: unknown[]) => fetchWithTimeout(...args),
}));

import { domainResourceInventory } from '../topology-inventory';
import { DOMAIN_TAG_KEY } from '../domain-registry';

function okResponse() {
  return { ok: true, status: 200, text: async () => JSON.stringify({ data: [] }) };
}

/** The `| where` line of the single query sent. */
async function whereLine(domainId: string): Promise<string> {
  fetchWithTimeout.mockResolvedValue(okResponse());
  await domainResourceInventory(domainId, ['sub-1']);
  expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
  const body = JSON.parse(String(fetchWithTimeout.mock.calls[0][1].body));
  const line = String(body.query).split('\n').find((l: string) => l.startsWith('| where'));
  expect(line, 'the query has a | where line').toBeDefined();
  return line as string;
}

beforeEach(() => {
  fetchWithTimeout.mockReset();
});

describe('domainResourceInventory — Resource Graph (KQL) literal escaping', () => {
  it('positive control: a plain domain id is carried unchanged', async () => {
    // The tag key has nothing to escape; asserting it here pins that the key
    // literal is the constant and not an empty or mangled string.
    expect(DOMAIN_TAG_KEY).toMatch(/^[A-Za-z0-9-]+$/);
    expect(await whereLine('finance')).toBe(
      `| where tags['${DOMAIN_TAG_KEY}'] =~ '${DOMAIN_TAG_KEY}:finance' or tags['${DOMAIN_TAG_KEY}'] =~ 'finance'`,
    );
  });

  it('a quote and a backslash are backslash-escaped in both literals', async () => {
    // Input fin'ance\x. Raw interpolation would give fin'ance\x; quote
    // doubling would give fin''ance\x. Only the KQL rule gives fin\'ance\\x.
    const line = await whereLine("fin'ance\\x");
    expect(line).toBe(
      `| where tags['${DOMAIN_TAG_KEY}'] =~ '${DOMAIN_TAG_KEY}:fin\\'ance\\\\x' or tags['${DOMAIN_TAG_KEY}'] =~ 'fin\\'ance\\\\x'`,
    );
    expect(line).not.toContain("fin''ance");
  });

  it('a control character is encoded as \\uXXXX, not sent raw', async () => {
    // U+0001 has no short escape in KQL; escapeKqlLiteral writes \u0001.
    const line = await whereLine('a\u0001b');
    expect(line).toContain(`'a\\u0001b'`);
    expect(line).not.toContain('\u0001');
  });
});
