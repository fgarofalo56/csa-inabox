/**
 * mirror-source-compat — the source-type ↔ connection-type guard, and the
 * REFUSAL TEXT that replaced a false claim.
 *
 * THE INCIDENT (2026-08-22, operator, mid-demo-setup)
 * --------------------------------------------------
 * A Snowflake connection was created successfully, the wizard's hardcoded
 * `AzureSqlDatabase` default was left in place, and "Load tables" produced:
 *
 *     Could not enumerate source tables: Failed to connect to
 *     <account>.database.windows.net:1433 - getaddrinfo ENOTFOUND
 *     <account>.database.windows.net
 *
 * The route dispatches on `sourceType`, so it took the TDS branch and handed a
 * Snowflake ACCOUNT IDENTIFIER to `azure-sql-client`, which appends the Azure
 * SQL host suffix to any server with no dot in it. Loom then reported a DNS
 * failure for a hostname LOOM HAD CONSTRUCTED, naming a domain the operator had
 * never typed — so they opened their Snowflake firewall wide open chasing a
 * network problem that did not exist. deploy-integrity.md R7: an error must not
 * state as fact something the code did not establish.
 *
 * These tests pin BOTH halves: the pair is refused, and the words used to refuse
 * it carry no constructed hostname while naming the real cause.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  MIRROR_SOURCE_CONN_TYPES, MIRROR_SOURCE_LABEL, MIRROR_SOURCE_IDS,
  isMirrorConnectionCompatible, mirrorSourceIdsForConnType, describeMirrorConnMismatch,
} from '../mirror-source-compat';
import { CONNECTION_TYPES } from '../connectable-types';

/** The shape of the operator's incident: Snowflake connection, Azure SQL mirror. */
const INCIDENT = { sourceType: 'AzureSqlDatabase', connType: 'snowflake', connName: 'snowflake-prod' };

/**
 * Every artifact of the FALSE claim. A refusal message containing any of these
 * is reporting a hostname the platform invented, a port the user never chose,
 * or a DNS verdict that was never reached at the point of refusal.
 *
 * HOST checks are plain SUBSTRING checks, deliberately NOT regexes. A regex for
 * a host is either unanchored — which CodeQL flags as `js/regex/missing-regexp-anchor`,
 * because an unanchored host pattern matches anywhere and arbitrary hosts may
 * precede or follow it — or anchored, which would be WRONG here: the assertion
 * is "this substring appears nowhere in the message", and anchoring would weaken
 * it to "the message is not exactly this host". `toContain` expresses the real
 * property with no regex at all.
 *
 * BOTH clouds are listed. The suffix `azure-sql-client` appends is cloud-
 * dependent (`cloud-endpoints.getSqlSuffix`), so checking only the Commercial
 * one would let a Gov-suffix leak through (cloud-parity.md).
 */
const CONSTRUCTED_HOSTS = [
  'database.windows.net',        // Commercial / GCC
  'database.usgovcloudapi.net',  // GCC-High / IL5 / DoD
];
/** Non-host artifacts of the original message; these are not URL-shaped. */
const CONSTRUCTED_PATTERNS = [
  /getaddrinfo/i,
  /ENOTFOUND/i,
  /\b1433\b/,
  /Failed to connect to/i,
  /could not enumerate source tables/i,
];

/** Assert a refusal message carries no invented hostname / port / DNS verdict. */
function expectNoConstructedArtifacts(msg: string) {
  for (const host of CONSTRUCTED_HOSTS) {
    expect(msg, `refusal text leaked the constructed host ${host}: ${msg}`).not.toContain(host);
  }
  for (const pattern of CONSTRUCTED_PATTERNS) {
    expect(msg, `refusal text leaked a constructed artifact ${pattern}: ${msg}`).not.toMatch(pattern);
  }
}

describe('the mismatch that caused the incident is REFUSED', () => {
  it('a Snowflake connection is not compatible with an Azure SQL Database mirror', () => {
    expect(isMirrorConnectionCompatible('AzureSqlDatabase', 'snowflake')).toBe(false);
    expect(describeMirrorConnMismatch(INCIDENT)).not.toBeNull();
  });

  it('names Snowflake as the one source type that connection can back', () => {
    const mm = describeMirrorConnMismatch(INCIDENT)!;
    expect(mm.candidates).toEqual(['Snowflake']);
  });

  it('still allows every legitimate pairing', () => {
    expect(isMirrorConnectionCompatible('AzureSqlDatabase', 'azure-sql')).toBe(true);
    expect(isMirrorConnectionCompatible('AzureSqlDatabase', 'generic-sql')).toBe(true);
    expect(isMirrorConnectionCompatible('Snowflake', 'snowflake')).toBe(true);
    expect(isMirrorConnectionCompatible('AzurePostgreSql', 'postgres')).toBe(true);
    expect(isMirrorConnectionCompatible('CosmosDb', 'cosmos')).toBe(true);
    expect(describeMirrorConnMismatch({ sourceType: 'Snowflake', connType: 'snowflake' })).toBeNull();
  });
});

describe('the refusal TEXT (deploy-integrity R7)', () => {
  const msg = describeMirrorConnMismatch(INCIDENT)!.message;

  it('contains NO hostname, port, or DNS verdict the platform constructed', () => {
    expectNoConstructedArtifacts(msg);
  });

  it('never echoes the account identifier the user supplied as though it were a host', () => {
    // The account id is the value that got the Azure SQL suffix bolted onto it.
    // An obviously-fake stand-in: the real one must never reach a fixture.
    const accountId = 'fakeorg-fakeacct999';
    const withAccount = describeMirrorConnMismatch({ ...INCIDENT, connName: accountId }).message;
    // The connection NAME may be quoted back (it is the user's own label), but
    // it must never appear glued to a domain.
    expect(withAccount).not.toMatch(new RegExp(`${accountId}\\.`));
  });

  it('names the REAL cause — both the mirror\'s type and the connection\'s type', () => {
    expect(msg).toMatch(/Azure SQL Database/);
    expect(msg).toMatch(/Snowflake/);
    expect(msg).toMatch(/source type/i);
  });

  it('states that nothing was contacted, which is what sent the operator to their firewall', () => {
    expect(msg).toMatch(/no request was sent/i);
    expect(msg).toMatch(/not a network, DNS, or firewall problem/i);
  });

  it('states the concrete repair', () => {
    expect(msg).toMatch(/Set this mirror's source type to "Snowflake"/);
  });

  it('quotes the connection name when one is supplied, so the operator knows WHICH connection', () => {
    expect(msg).toContain('"snowflake-prod"');
    // …and stays honest when there is no name to quote.
    const anon = describeMirrorConnMismatch({ sourceType: 'AzureSqlDatabase', connType: 'snowflake' })!.message;
    expect(anon).toContain('the connection bound to it');
    expect(anon).not.toContain('""');
  });
});

/**
 * The brief asked whether the SIBLING non-SQL sources share the trap. They do:
 * the direction that bites is a non-SQL CONNECTION under a SQL SOURCE TYPE,
 * because that is the branch which dials TDS.
 */
describe('BigQuery and Oracle share the trap and are covered by the same guard', () => {
  it.each([
    ['bigquery', 'GoogleBigQuery'],
    ['oracle', 'Oracle'],
  ])('a %s connection under an Azure SQL Database mirror is refused', (connType, expectedCandidate) => {
    expect(isMirrorConnectionCompatible('AzureSqlDatabase', connType)).toBe(false);
    const mm = describeMirrorConnMismatch({ sourceType: 'AzureSqlDatabase', connType })!;
    expect(mm).not.toBeNull();
    expect(mm.candidates).toContain(expectedCandidate);
    for (const artifact of CONSTRUCTED_PATTERNS) expect(mm.message).not.toMatch(artifact);
  });

  it('offers EVERY candidate when the connection type maps to several source types', () => {
    // `generic-sql` legitimately backs many sources, so the guard must not
    // pretend there is one right answer — it lists them for a Fix-it button each.
    const mm = describeMirrorConnMismatch({ sourceType: 'Snowflake', connType: 'generic-sql' })!;
    expect(mm.candidates.length).toBeGreaterThan(1);
    expect(mm.candidates).toContain('AzureSqlDatabase');
    expect(mm.message).toMatch(/Set this mirror's source type to one of/);
  });
});

/**
 * R7 cuts BOTH ways: an unknown must never be reported as a negative. A mirror
 * whose connection was deleted, or which binds none at all, authenticates as the
 * Console UAMI by design (connection-auth.ts) and must keep working.
 */
describe('an UNKNOWN is never reported as a mismatch', () => {
  it('no connection bound → compatible, no refusal', () => {
    expect(isMirrorConnectionCompatible('AzureSqlDatabase', undefined)).toBe(true);
    expect(describeMirrorConnMismatch({ sourceType: 'AzureSqlDatabase' })).toBeNull();
    expect(describeMirrorConnMismatch({ sourceType: 'AzureSqlDatabase', connType: '' })).toBeNull();
  });

  it('an unrecognised source type makes no claim either way', () => {
    expect(isMirrorConnectionCompatible('SomeFutureSource', 'snowflake')).toBe(true);
    expect(describeMirrorConnMismatch({ sourceType: 'SomeFutureSource', connType: 'snowflake' })).toBeNull();
  });
});

/**
 * CLOUD PARITY (cloud-parity.md, die-hard).
 *
 * The suffix `azure-sql-client` appends is cloud-dependent — `getSqlSuffix()`
 * returns `database.windows.net` in Commercial/GCC and
 * `database.usgovcloudapi.net` in GCC-High/IL5/DoD. A detector keyed to one
 * cloud's suffix would be BLIND in the other: a Gov operator would make exactly
 * the mistake this guard exists to catch and get the original unhelpful
 * ENOTFOUND back.
 *
 * This guard decides using ONLY `sourceType` vs the connection's `type` and
 * never inspects a hostname, so it is cloud-independent by construction. These
 * tests PIN that property rather than assuming it: if anyone later reworks the
 * detector to sniff hostnames — the obvious "improvement" — keying it to the
 * Commercial suffix turns the Gov arm red.
 */
describe('the refusal is identical in every cloud', () => {
  const CLOUD_ENVS = [
    ['Commercial', { LOOM_CLOUD: 'AzureCloud', AZURE_CLOUD: 'AzureCloud' }],
    ['GCC-High / IL5 / DoD', { LOOM_CLOUD: 'AzureUSGovernment', AZURE_CLOUD: 'AzureUSGovernment' }],
  ] as const;

  const saved = { LOOM_CLOUD: process.env.LOOM_CLOUD, AZURE_CLOUD: process.env.AZURE_CLOUD };
  afterEach(() => {
    process.env.LOOM_CLOUD = saved.LOOM_CLOUD;
    process.env.AZURE_CLOUD = saved.AZURE_CLOUD;
  });

  it.each(CLOUD_ENVS)('refuses the incident pair in %s', (_name, env) => {
    Object.assign(process.env, env);
    const mm = describeMirrorConnMismatch(INCIDENT);
    expect(mm, 'the mismatch went undetected in this cloud').not.toBeNull();
    expect(mm!.candidates).toEqual(['Snowflake']);
    expectNoConstructedArtifacts(mm!.message);
  });

  it('produces a BYTE-IDENTICAL message in Commercial and Gov', () => {
    // The strongest form of "cloud-independent": not merely that both refuse,
    // but that the cloud cannot influence the text at all. A hostname-sniffing
    // rewrite would almost certainly differ between the two.
    Object.assign(process.env, CLOUD_ENVS[0][1]);
    const commercial = describeMirrorConnMismatch(INCIDENT)!.message;
    Object.assign(process.env, CLOUD_ENVS[1][1]);
    const gov = describeMirrorConnMismatch(INCIDENT)!.message;
    expect(gov).toBe(commercial);
  });

  it('names NEITHER cloud\'s SQL suffix, in either cloud', () => {
    for (const [, env] of CLOUD_ENVS) {
      Object.assign(process.env, env);
      const m = describeMirrorConnMismatch(INCIDENT)!.message;
      for (const host of CONSTRUCTED_HOSTS) expect(m).not.toContain(host);
    }
  });

  it('refuses a Gov-suffixed server value the same way', () => {
    // A Gov operator whose connection carries a Gov-suffixed host is the same
    // defect; the guard must not care what the server field holds.
    const mm = describeMirrorConnMismatch({
      sourceType: 'AzureSqlDatabase', connType: 'snowflake', connName: 'gov-snowflake',
    });
    expect(mm).not.toBeNull();
    expectNoConstructedArtifacts(mm!.message);
  });
});

describe('catalog integrity', () => {
  it('declares only REAL ConnectionTypes', () => {
    const bogus: string[] = [];
    for (const id of MIRROR_SOURCE_IDS) {
      for (const t of MIRROR_SOURCE_CONN_TYPES[id]) {
        if (!(CONNECTION_TYPES as string[]).includes(t)) bogus.push(`${id}: ${t}`);
      }
    }
    expect(bogus, `not a ConnectionType: ${bogus.join(' | ')}`).toEqual([]);
  });

  it('labels every source id', () => {
    for (const id of MIRROR_SOURCE_IDS) expect(MIRROR_SOURCE_LABEL[id]?.length).toBeGreaterThan(0);
  });

  it('never offers DatabricksUC as a candidate — it declares no connection types', () => {
    for (const t of CONNECTION_TYPES) {
      expect(mirrorSourceIdsForConnType(t)).not.toContain('DatabricksUC');
    }
  });
});
