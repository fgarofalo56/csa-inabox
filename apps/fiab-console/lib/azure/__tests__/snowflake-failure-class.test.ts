/**
 * snowflake-failure-class — the R7 regression suite.
 *
 * ## The regression, stated once
 *
 * A Snowflake mirror Start failed with an MFA rejection. Loom surfaced
 * Snowflake's error verbatim (right) and then appended "Check that the
 * connection's role has USAGE on database <DB> and SELECT on its tables, and
 * that the warehouse can start" (wrong — no grant resolves an MFA rejection).
 *
 * So the load-bearing assertions in this file are the NEGATIVE ones:
 *   - the MFA payload must NOT produce grant advice;
 *   - an unrecognised failure must produce NO remediation at all.
 *
 * A suite that only checked "authentication produces authentication advice"
 * would stay green against a classifier whose default branch hands out the
 * grants sentence — which is the original defect wearing a new coat.
 *
 * ## Placeholders
 *
 * This repo is PUBLIC. Every account identifier, user, database and request id
 * below is an obvious placeholder. The one thing reproduced from the live
 * failure is the Snowflake driver's own sentence, because that string IS the
 * regression.
 */
import { describe, it, expect } from 'vitest';
import {
  classifySnowflakeFailure,
  snowflakeRemediation,
  describeSnowflakeFailure,
  snowflakeGateMissing,
  SNOWFLAKE_FAILURE_KINDS,
  type SnowflakeFailureKind,
} from '../snowflake-failure-class';

/**
 * THE regression payload — the operator's failure with every identifier elided
 * exactly as it was reported. Do not "tidy" this string.
 */
const MFA_PAYLOAD =
  'Operation on target CountSchemas failed: ... [Snowflake] 394509 (08004): ' +
  'Failed to authenticate: MFA authentication is required, but none of your current ' +
  'MFA methods are supported for programmatic authentication.';

const DB = 'PLACEHOLDER_DB';

/**
 * The advice that used to be appended to EVERYTHING.
 *
 * Matched on the INSTRUCTION ("USAGE on …", "SELECT on …"), not on the word
 * "grant": the authentication branch legitimately says "no GRANT will change
 * it", which is the opposite of grant advice, and a regex that could not tell
 * those apart would fail an honest message and pass a dishonest one.
 */
const GRANT_ADVICE = /USAGE on|SELECT on/i;
const WAREHOUSE_ADVICE = /AUTO_RESUME|resume it|no running compute/i;
const NETWORK_ADVICE = /firewall|private endpoint|network policy|DNS/i;
const AUTH_ADVICE = /key-pair|KEY-PAIR|TYPE = SERVICE|RSA_PUBLIC_KEY/;

// ── The live case ───────────────────────────────────────────────────────────
describe('the MFA rejection (the measured regression)', () => {
  it('classifies as authentication, not grants', () => {
    expect(classifySnowflakeFailure(MFA_PAYLOAD)).toBe('authentication');
  });

  it('does NOT produce grant advice', () => {
    // THE assertion. If this goes green while the classifier funnels unknown or
    // authentication into the authorization branch, the fix did not happen.
    const msg = describeSnowflakeFailure('Snowflake did not return a table list', MFA_PAYLOAD, DB);
    expect(msg).not.toMatch(GRANT_ADVICE);
    expect(msg).not.toContain(DB);
  });

  it('#4048 F1 — the MFA remediation is SEQUENTIAL, and TYPE = SERVICE is not an alternative', () => {
    // It used to read "switch to KEY-PAIR auth … OR point the connection at a
    // user created with TYPE = SERVICE, which is exempt from interactive MFA".
    // Per docs.snowflake.com/en/user-guide/admin-user-management a SERVICE user
    // "cannot log in using a password … cannot have the following properties:
    // … PASSWORD" — so it is not an alternative to key-pair, it REQUIRES it. An
    // operator who read the "or", created a SERVICE user and left the connection
    // on basic auth failed again, having done real work in their account first.
    const msg = snowflakeRemediation('authentication')!;
    expect(msg).toMatch(/RSA_PUBLIC_KEY/);
    expect(msg).toMatch(/TYPE = SERVICE/);
    // The two are joined by "ALSO", never by an "or" that makes them exclusive.
    expect(msg).not.toMatch(/or point the connection at a user created with TYPE = SERVICE/i);
    expect(msg).toMatch(/ALSO change the user to TYPE = SERVICE/);
    // And the fact that makes the "or" wrong is STATED, not left for the
    // operator to discover in their own Snowflake account.
    expect(msg).toMatch(/cannot have a password at all/);
    expect(msg).toMatch(/key-pair is required either way/);
    expect(msg).toMatch(/never a substitute/);
  });

  it('does not produce warehouse or network advice either', () => {
    const msg = describeSnowflakeFailure('Snowflake did not return a table list', MFA_PAYLOAD, DB);
    expect(msg).not.toMatch(WAREHOUSE_ADVICE);
    expect(msg).not.toMatch(NETWORK_ADVICE);
  });

  it('produces the remediation that is actually true of an MFA rejection', () => {
    const msg = describeSnowflakeFailure('Snowflake did not return a table list', MFA_PAYLOAD, DB);
    expect(msg).toMatch(AUTH_ADVICE);
    expect(msg).toContain('REJECTED THE SIGN-IN');
  });

  it('carries Snowflake\'s own message through VERBATIM', () => {
    // The part the original code got right. A fix that swallowed the backend's
    // words while tidying the advice would be a net regression.
    const msg = describeSnowflakeFailure('Snowflake did not return a table list', MFA_PAYLOAD, DB);
    expect(msg).toContain(MFA_PAYLOAD);
  });

  it('reports a machine-readable gate key that names the class', () => {
    expect(snowflakeGateMissing(classifySnowflakeFailure(MFA_PAYLOAD))).toBe('snowflake-authentication');
  });
});

// ── One test per class, asserting the RIGHT remediation attaches ────────────
describe('per-class classification', () => {
  const cases: Array<[string, ReturnType<typeof classifySnowflakeFailure>, string]> = [
    [
      'Operation on target CountSchemas failed: 390100 (08004): Incorrect username or password was specified.',
      'authentication', 'bad password',
    ],
    [
      'Operation on target ListTables failed: 003001 (42501): SQL access control error: '
        + "Insufficient privileges to operate on schema 'PLACEHOLDER_SCHEMA'.",
      'authorization', 'insufficient privileges',
    ],
    [
      'Operation on target ListTables failed: 002003 (02000): SQL compilation error: '
        + "Object does not exist or not authorized: 'PLACEHOLDER_DB.PUBLIC.ORDERS'.",
      'authorization', 'object does not exist or not authorized',
    ],
    [
      'Operation on target CountSchemas failed: 000606 (57P03): No active warehouse selected in the current session.',
      'warehouse', 'no active warehouse',
    ],
    [
      "Operation on target ListTables failed: Warehouse 'PLACEHOLDER_WH' cannot be resumed because "
        + "resource monitor 'PLACEHOLDER_RM' has exceeded its quota.",
      'warehouse', 'resource monitor quota',
    ],
    [
      'Operation on target ListTables failed: 250001 (08001): Could not connect to Snowflake backend after 2 attempt(s).',
      'network', 'could not connect',
    ],
    [
      // #4048 F2 — the ms-adf-doc form, NOT the self-authored `390432 (08004)`
      // this used to carry. `390432` has zero Snowflake-related hits in GitHub
      // code search, and Microsoft's own ADF connector troubleshooting page
      // (connector-troubleshoot-snowflake.md) gives this payload with NO vendor
      // code and NO SQLSTATE — which is what ADF actually hands this classifier.
      'Operation on target ListTables failed: IP 203.0.113.10 is not allowed to access Snowflake. '
        + 'Contact your local security administrator.',
      'network-policy', 'network policy / IP allowlist',
    ],
  ];

  for (const [payload, expected, label] of cases) {
    it(`${label} → ${expected}`, () => {
      expect(classifySnowflakeFailure(payload)).toBe(expected);
    });
  }

  it('the grants advice attaches ONLY to a grants failure, and names the database', () => {
    const authz = cases.find(([, k]) => k === 'authorization')![0];
    const msg = describeSnowflakeFailure('Snowflake did not return a table list', authz, DB);
    expect(msg).toMatch(GRANT_ADVICE);
    expect(msg).toContain(`USAGE on database ${DB}`);
    expect(msg).toContain(authz);
  });

  it('the warehouse advice attaches ONLY to a warehouse failure', () => {
    const wh = cases.find(([, k]) => k === 'warehouse')![0];
    const msg = describeSnowflakeFailure('Snowflake did not return a table list', wh, DB);
    expect(msg).toMatch(WAREHOUSE_ADVICE);
    expect(msg).not.toMatch(AUTH_ADVICE);
    // #4049 F3 — and the vendor's own sentence survives. See the six-branch
    // block below for why this line is here rather than only there.
    expect(msg).toContain(wh);
  });

  it('a blocked IP is told about the network policy, NOT about its credential', () => {
    const np = cases.find(([, k]) => k === 'network-policy')![0];
    const msg = describeSnowflakeFailure('Snowflake did not return a table list', np, DB);
    expect(msg).toContain('NETWORK POLICY');
    expect(msg).not.toMatch(AUTH_ADVICE);
    expect(msg).not.toMatch(GRANT_ADVICE);
    expect(msg).toContain(np); // #4049 F3
  });

  it('a NETWORK failure is told about the transport, and keeps the vendor sentence', () => {
    // THERE WAS NO `network` CASE AT ALL in this block. `describeSnowflakeFailure`
    // has six branches; five had a message assertion and this one had none, so a
    // change that swallowed Snowflake's own words on the network path shipped
    // green (#4049 F3).
    const net = cases.find(([, k]) => k === 'network')![0];
    const msg = describeSnowflakeFailure('Snowflake did not return a table list', net, DB);
    expect(msg).toMatch(NETWORK_ADVICE);
    expect(msg).not.toMatch(AUTH_ADVICE);
    expect(msg).not.toMatch(GRANT_ADVICE);
    expect(msg).toContain(net);
  });

  it('every class maps to its own gate key', () => {
    expect(snowflakeGateMissing('authentication')).toBe('snowflake-authentication');
    // Matches the value mirror-adf-copy's visibility probe already emits for the
    // same state — two names for one condition is how a consumer handles half of it.
    expect(snowflakeGateMissing('authorization')).toBe('snowflake-grants');
    expect(snowflakeGateMissing('warehouse')).toBe('snowflake-warehouse');
    expect(snowflakeGateMissing('network-policy')).toBe('snowflake-network-policy');
    expect(snowflakeGateMissing('network')).toBe('snowflake-network');
    // Unknown keeps the pre-existing key: still "the read failed, cause unclassified".
    expect(snowflakeGateMissing('unknown')).toBe('snowflake-read');
  });
});

// ── The important one: unknown asserts NOTHING ──────────────────────────────
describe('an unrecognised failure attaches NO remediation', () => {
  const unrecognised = [
    'Operation on target ListTables failed: ErrorCode=UserErrorOdbcOperationFailed, an unexpected condition.',
    'the run ended as Cancelled',
    'the run ended as InProgress',
    '',
    '   ',
  ];

  for (const payload of unrecognised) {
    it(`classifies ${JSON.stringify(payload.slice(0, 48))} as unknown`, () => {
      expect(classifySnowflakeFailure(payload)).toBe('unknown');
    });
  }

  it('snowflakeRemediation returns null — there is no default advice to render', () => {
    // The contract, not an omission. A caller cannot accidentally print a
    // plausible-sounding fallback because there is not one to print.
    expect(snowflakeRemediation('unknown', DB)).toBeNull();
    expect(snowflakeRemediation(classifySnowflakeFailure('who knows'), DB)).toBeNull();
  });

  it('handles null/undefined without throwing, and without guessing', () => {
    expect(classifySnowflakeFailure(undefined)).toBe('unknown');
    expect(classifySnowflakeFailure(null)).toBe('unknown');
  });

  it('the composed message names no cause at all', () => {
    const msg = describeSnowflakeFailure('Snowflake did not return a table list', unrecognised[0], DB);
    expect(msg).not.toMatch(GRANT_ADVICE);
    expect(msg).not.toMatch(WAREHOUSE_ADVICE);
    expect(msg).not.toMatch(NETWORK_ADVICE);
    expect(msg).not.toMatch(AUTH_ADVICE);
    expect(msg).toContain('asserts NO cause');
    // …and still carries the backend's words.
    expect(msg).toContain(unrecognised[0]);
  });

  it('an ADF ACTIVITY timeout is unknown, NOT a network problem', () => {
    // The specific wrong turn this module refuses to take. The Lookup carries a
    // 5-minute activity timeout; a warehouse that resumed slowly trips it. Bare
    // /timed out/ in the network class would answer that with firewall advice —
    // the exact hunt that preceded this fix.
    const payload = "Operation on target ListTables failed: Activity 'ListTables' timed out after 00:05:00.";
    expect(classifySnowflakeFailure(payload)).toBe('unknown');
    expect(describeSnowflakeFailure('Snowflake did not return a table list', payload, DB))
      .not.toMatch(NETWORK_ADVICE);
  });
});

// ── #4049 F3: the verbatim-`detail` invariant, for ALL SIX branches ────────
//
// `snowflake-failure-class.ts` states that `detail` is carried through VERBATIM
// in every branch and that this is "asserted by its own test". Measured by
// mutation — dropping `detail` one branch at a time:
//
//     authentication  RC=1 CAUGHT      warehouse       RC=0 ESCAPED
//     authorization   RC=1 CAUGHT      network         RC=0 ESCAPED
//     unknown         RC=1 CAUGHT      network-policy  RC=0 ESCAPED
//
// Three of six, and there was no `network` case in the suite at all. A change
// that swallowed the vendor's own sentence in those three branches shipped
// green — the exact regression the comment says would be "a net regression".
describe('#4049 F3 — the vendor sentence survives EVERY branch, not three of six', () => {
  /** One payload per kind, keyed so the coverage assertion below can be total. */
  const BY_KIND: Record<SnowflakeFailureKind, string> = {
    authentication: MFA_PAYLOAD,
    authorization:
      'Operation on target ListTables failed: 003001 (42501): SQL access control error: '
      + "Insufficient privileges to operate on schema 'PLACEHOLDER_SCHEMA'.",
    warehouse:
      'Operation on target CountSchemas failed: 000606 (57P03): No active warehouse selected in the current session.',
    'network-policy':
      'Operation on target ListTables failed: IP 203.0.113.10 is not allowed to access Snowflake. '
      + 'Contact your local security administrator.',
    network:
      'Operation on target ListTables failed: 250001 (08001): Could not connect to Snowflake backend after 2 attempt(s).',
    unknown:
      'Operation on target ListTables failed: ErrorCode=UserErrorOdbcOperationFailed, an unexpected condition.',
  };

  it('COVERAGE FLOOR: every member of SNOWFLAKE_FAILURE_KINDS has a fixture', () => {
    // Derived from the exported runtime list rather than hand-listed, so adding a
    // seventh kind without a fixture is a RED test rather than a silent gap —
    // which is precisely how `network` came to have no case at all.
    for (const kind of SNOWFLAKE_FAILURE_KINDS) {
      expect(BY_KIND[kind], `no fixture for '${kind}'`).toBeTruthy();
    }
    expect(Object.keys(BY_KIND).sort()).toEqual([...SNOWFLAKE_FAILURE_KINDS].sort());
  });

  for (const kind of SNOWFLAKE_FAILURE_KINDS) {
    it(`carries the vendor sentence verbatim in the '${kind}' branch`, () => {
      const payload = BY_KIND[kind];
      // The fixture must actually REACH the branch it claims to, or the
      // assertion below is about some other branch's message.
      expect(classifySnowflakeFailure(payload), `fixture for '${kind}' misclassified`).toBe(kind);
      const msg = describeSnowflakeFailure('Snowflake did not return a table list', payload, DB);
      expect(msg).toContain(payload);
    });
  }
});

// ── Ordering, pinned where it is actually load-bearing ─────────────────────
describe('classification ORDER', () => {
  // #4048 F2 — THE SELF-AUTHORED 390432 (08004) FIXTURE IS GONE, and with it the
  // claim it "pinned". The old case asserted that Snowflake returns the IP
  // rejection over SQLSTATE 08004, the same code as the measured MFA failure —
  // an assertion this repo never established, backed by a fixture written to
  // match the comment that cited it. `390432` has zero Snowflake-related hits in
  // GitHub code search; tools in the wild use 390429 / 390422.
  //
  // These two are the forms actually observed in the wild, and the ordering they
  // pin is NETWORK_POLICY before NETWORK — which is the dependency that really
  // flips a real input, because form B carries 08001 and the NETWORK branch
  // matches it.

  it('form A — the Microsoft ADF connector doc payload, which carries NO code at all', () => {
    // MicrosoftDocs/azure-docs, connector-troubleshoot-snowflake.md. This is the
    // exact path this classifier consumes, and it has no vendor code and no
    // SQLSTATE — so any ordering argument that depends on one is arguing about a
    // payload shape that this consumer does not see.
    const payload =
      'Operation on target CountSchemas failed: IP 203.0.113.10 is not allowed to access '
      + 'Snowflake. Contact your local security administrator.';
    expect(classifySnowflakeFailure(payload)).toBe('network-policy');
  });

  it('form B — the 250001 (08001) form, which NETWORK would otherwise claim', () => {
    // PostHog's production Snowflake source annotates the rejection this way.
    // 08001 is in the NETWORK branch, so this case is what makes the
    // NETWORK_POLICY-first ordering load-bearing rather than decorative:
    // reorder them and a blocked-IP operator is sent to check DNS and firewall
    // egress, which cannot fix an allowlist.
    const payload =
      'Operation on target CountSchemas failed: 250001 (08001): IP address 203.0.113.10 '
      + 'is not allowed to access Snowflake.';
    expect(classifySnowflakeFailure(payload)).toBe('network-policy');
  });

  it('CONTROL: the same 08001 WITHOUT the policy sentence is still NETWORK', () => {
    // Without this, form B is equally satisfied by a classifier that stopped
    // recognising 08001 as a connect failure at all.
    expect(classifySnowflakeFailure('250001 (08001): Could not connect to Snowflake backend.'))
      .toBe('network');
  });

  it('form D — the bare "Incoming request" sentence, no code on either side', () => {
    expect(
      classifySnowflakeFailure(
        'Operation on target CountSchemas failed: Incoming request with IP/Token 203.0.113.10 '
        + 'is not allowed to access Snowflake.',
      ),
    ).toBe('network-policy');
  });

  it('SQLSTATE 08001 is a CONNECT failure, not an auth one — the codes are exact tokens', () => {
    // 08004 (auth) and 08001 (connect) are one digit apart in the same SQLSTATE
    // class. A loose `080\d\d` or an unanchored `0800` would collapse them.
    expect(classifySnowflakeFailure('250001 (08001): Could not connect to Snowflake backend.')).toBe('network');
    expect(classifySnowflakeFailure('390100 (08004): Incorrect username or password was specified.')).toBe('authentication');
  });

  it("Warehouse 'X' does not exist or not authorized is AUTHORIZATION, not warehouse", () => {
    // Deliberate: Snowflake reports "you may not see it" and "it is not there"
    // identically, so "resume the warehouse" would be a guess between them.
    expect(classifySnowflakeFailure("Warehouse 'PLACEHOLDER_WH' does not exist or not authorized."))
      .toBe('authorization');
  });
});

// ── Anchoring: a code inside a NAME is not that code ───────────────────────
describe('numeric codes are anchored (the rg-loom-503 defect, in Snowflake dress)', () => {
  it('a warehouse or database whose NAME contains a code run stays unknown', () => {
    for (const payload of [
      'Operation on target ListTables failed: ODBC operation failed on warehouse WH_394509_EU.',
      'Operation on target ListTables failed: object PLACEHOLDER_DB_08004 was unavailable.',
      'Operation on target ListTables failed: run id 3945091 did not complete.',
      'Operation on target ListTables failed: correlation 250001a did not resolve.',
    ]) {
      expect(classifySnowflakeFailure(payload), `for ${JSON.stringify(payload)}`).toBe('unknown');
    }
  });

  it('and the same codes DO classify when they stand alone', () => {
    // The control for the test above: without this, the anchoring test would
    // also pass against a classifier that simply never matched anything.
    expect(classifySnowflakeFailure('[Snowflake] 394509 (08004): login rejected')).toBe('authentication');
    expect(classifySnowflakeFailure('[Snowflake] 250001 (08001): backend unreachable')).toBe('network');
  });
});

// ── The remediation surface itself ─────────────────────────────────────────
describe('snowflakeRemediation', () => {
  it('never mentions grants outside the authorization branch', () => {
    for (const kind of ['authentication', 'warehouse', 'network', 'network-policy', 'unknown'] as const) {
      const r = snowflakeRemediation(kind, DB);
      if (r === null) continue;
      expect(r, `for ${kind}`).not.toContain(`USAGE on database ${DB}`);
    }
  });

  it('omits the database name gracefully when the caller has none', () => {
    const r = snowflakeRemediation('authorization');
    expect(r).toContain('USAGE on the database');
    expect(r).not.toContain('undefined');
  });
});
