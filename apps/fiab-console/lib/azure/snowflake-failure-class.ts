/**
 * snowflake-failure-class — what did a FAILED Snowflake read actually establish?
 *
 * ## Why this exists (deploy-integrity.md R7)
 *
 * MEASURED, live, on a Snowflake mirror Start. Loom surfaced Snowflake's own
 * error verbatim — correct, and the code was right to do that:
 *
 *   Operation on target CountSchemas failed: … [Snowflake] 394509 (08004):
 *   Failed to authenticate: MFA authentication is required, but none of your
 *   current MFA methods are supported for programmatic authentication.
 *
 * and then appended, unconditionally:
 *
 *   "Check that the connection's role has USAGE on database <DB> and SELECT on
 *    its tables, and that the warehouse can start."
 *
 * Snowflake had already NAMED the cause — the login never completed — and Loom
 * appended a different one. No GRANT resolves an MFA rejection, so that sentence
 * could only send the operator somewhere useless. It was the second misleading
 * remediation that operator had chased in one evening; the first had cost them
 * time on firewall rules.
 *
 * **A remediation is a factual claim.** "Check the grants" asserts that grants
 * are a plausible cause of THIS failure. When the backend has already told you
 * the cause, appending a different guess is worse than appending nothing — R7:
 * an error must not state as fact something it did not establish.
 *
 * ## Design — the default asserts NOTHING
 *
 * Modelled on `scripts/ci/_az-failure-class.mjs` (ARM/az) and
 * `lib/azure/aoai-failure-class.ts` (Azure OpenAI), both of which end in an
 * `unknown` that names no cause. The rule those encode, restated:
 *
 *   A classifier whose default branch attaches a plausible remediation is the
 *   defect wearing a new coat.
 *
 * So `snowflakeRemediation('unknown')` returns `null`. Not a softer guess — no
 * guess. `describeSnowflakeFailure` then says, in as many words, that Snowflake's
 * message is the whole of what is known.
 *
 * ## Why regex over prose here, when aoai-failure-class refuses to
 *
 * `aoai-failure-class` reads a STRUCTURED `status` off the thrown value and
 * explicitly refuses to infer a status from prose. It can: the AOAI client
 * attaches one. This surface cannot. What arrives here is
 * `AdfPipelineRun.message` — a STRING, assembled by ADF, quoting the Snowflake
 * ODBC driver. There is no structured field to read, so the only options are
 * "match the vendor's own codes and sentences" or "assert nothing, ever".
 *
 * The mitigations, taken from `_az-failure-class.mjs`:
 *   - numeric codes are matched as ANCHORED STANDALONE TOKENS (`status-token.ts`),
 *     never bare digits, so a warehouse named `WH_394509` is not an auth failure;
 *   - a code is listed ONLY where it adds signal the prose does not. Where
 *     Snowflake always emits a verbatim sentence alongside (e.g. "Incorrect
 *     username or password was specified"), the sentence carries it and the code
 *     is omitted rather than guessed at from memory. A code that never matches is
 *     inert (it falls to `unknown`); a code recalled WRONG misclassifies, which
 *     is the very defect this module exists to end. `394509` and `08004` are here
 *     because they were MEASURED in the payload above.
 *   - phrases are Snowflake's, not paraphrases, and are narrow enough that ADF's
 *     own wrapper text cannot produce them.
 *
 * Pure: no I/O, no env, no SDK. Safe to import from a route, a client, or a test.
 */
import { statusToken } from './status-token';

/**
 * What a failed Snowflake read established. `unknown` is a first-class outcome,
 * not a fallback bucket that gets the friendliest-sounding advice.
 */
export type SnowflakeFailureKind =
  | 'authentication'
  | 'authorization'
  | 'warehouse'
  | 'network-policy'
  | 'network'
  | 'unknown';

/**
 * Snowflake's NETWORK POLICY rejection — the IP allowlist, not the credential.
 *
 * Checked FIRST, and this ordering is the one that genuinely flips a real input.
 * Snowflake returns the policy rejection over SQLSTATE `08004` — the SAME
 * SQLSTATE as the measured MFA failure — so on `AUTHENTICATION`-first ordering
 * a blocked IP would be told to switch to key-pair auth, which cannot fix it.
 * Pinned by a fixture; do not reorder without reading that test.
 */
const NETWORK_POLICY = new RegExp(
  [
    'is not allowed to access Snowflake',
    'not allowed to access Snowflake',
    'blocked by .{0,40}network policy',
    'IP address .{0,60}not allowed',
  ].join('|'),
  'i',
);

/**
 * The sign-in itself failed. Nothing past the login was reached, so NOTHING
 * about the role, its grants, the warehouse or the objects was tested — and any
 * remediation naming those asserts something this failure did not establish.
 *
 * `394509` / `08004` are from the measured payload. `28000` is the standard
 * SQLSTATE for an invalid authorization specification. `390100` is Snowflake's
 * bad-username/password code and is corroborated by its own sentence below.
 */
const AUTHENTICATION = new RegExp(
  [
    statusToken('394509|390100|08004|28000'),
    'Failed to authenticate',
    'Incorrect username or password',
    'programmatic authentication',
    '\\bMFA\\b',
    'multi-factor',
    'JWT token is invalid',
    'User authentication failed',
    'password (is|has) expired',
    'user account .{0,40}locked',
  ].join('|'),
  'i',
);

/**
 * The sign-in SUCCEEDED and Snowflake refused the object. This is the class the
 * old hard-coded sentence was written for — and it is correct HERE.
 *
 * `42501` is the standard SQLSTATE for insufficient privilege. The two "does not
 * exist" phrases are quoted in full deliberately: a bare /does not exist/ would
 * swallow ADF's own "the linked service does not exist" and report an unrelated
 * control-plane fault as a Snowflake grants problem.
 */
const AUTHORIZATION = new RegExp(
  [
    statusToken('42501'),
    'Insufficient privileges',
    'SQL access control error',
    'does not exist or not authorized',
    'does not exist, or operation cannot be performed',
    'not authorized to (perform|access|operate)',
  ].join('|'),
  'i',
);

/**
 * There was no compute to run on.
 *
 * Deliberately NARROW. `Warehouse 'X' does not exist or not authorized` is
 * classified as AUTHORIZATION, not here, because that is what Snowflake actually
 * established — it reports "you may not see it" and "it is not there" with the
 * same sentence, and "resume the warehouse" would be a guess between them.
 */
const WAREHOUSE = new RegExp(
  [
    'No active warehouse selected',
    'no active warehouse',
    'cannot be resumed',
    'warehouse .{0,60}is suspended',
    'resource monitor .{0,80}exceeded',
  ].join('|'),
  'i',
);

/**
 * No session was established at all — DNS, TCP, TLS, or a proxy in the path.
 *
 * `250001` is Snowflake's "could not connect to backend"; `08001` is the
 * standard SQLSTATE for a client that could not establish a connection.
 *
 * A bare /timed out/ is DELIBERATELY ABSENT, and this is the sharp edge of the
 * whole module. The ADF Lookup carries a 5-minute activity timeout, and a
 * warehouse that took too long to resume fails it with a message containing
 * "timed out". Classifying that as network hands the operator firewall advice
 * for a compute problem — precisely the wasted evening that preceded this fix.
 * `connection timed out` and `ETIMEDOUT` are socket-level and stay; the bare
 * word does not.
 */
const NETWORK = new RegExp(
  [
    statusToken('250001|08001'),
    'Could not connect to Snowflake',
    'getaddrinfo',
    'ENOTFOUND',
    'EAI_AGAIN',
    'ECONNREFUSED',
    'ECONNRESET',
    'ETIMEDOUT',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'Name or service not known',
    'connection refused',
    'connection timed out',
    'certificate verif',
    'self.signed certificate',
  ].join('|'),
  'i',
);

/**
 * PURE. Classify a failed Snowflake read into what it actually established.
 *
 * ORDER, and how much of it is claimed to be load-bearing:
 *
 *  1. NETWORK_POLICY — pinned by a discriminating fixture (it shares SQLSTATE
 *     `08004` with the measured MFA payload and MUST beat AUTHENTICATION).
 *  2. AUTHENTICATION — the measured live case, and the class where wrong advice
 *     is most expensive: it sends the operator to grants that cannot help.
 *  3. AUTHORIZATION  — explicit privilege signals.
 *  4. WAREHOUSE      — narrow compute-availability phrases.
 *  5. NETWORK        — LAST, because transport tokens are the ones most easily
 *     produced incidentally by surrounding ADF text.
 *
 * The relative order of 3 and 4 has NO known input that flips it — the two
 * patterns are disjoint on every real message reviewed — so it is stated as
 * definiteness ordering, not claimed as load-bearing. Saying otherwise would be
 * the same species of unearned assertion this module exists to remove.
 *
 * An EMPTY message must reach `unknown`: a failure that said nothing established
 * nothing.
 */
export function classifySnowflakeFailure(detail: string | null | undefined): SnowflakeFailureKind {
  const s = String(detail ?? '');
  if (NETWORK_POLICY.test(s)) return 'network-policy';
  if (AUTHENTICATION.test(s)) return 'authentication';
  if (AUTHORIZATION.test(s)) return 'authorization';
  if (WAREHOUSE.test(s)) return 'warehouse';
  if (NETWORK.test(s)) return 'network';
  return 'unknown';
}

/**
 * PURE. The remediation for a classified failure — or `null` when the failure
 * was not recognised.
 *
 * `null` is the contract, not an omission: a caller cannot accidentally render a
 * plausible-sounding default, because there is not one to render.
 *
 * @param kind    what `classifySnowflakeFailure` established
 * @param database the Snowflake database the read targeted, for the grants case
 */
export function snowflakeRemediation(
  kind: SnowflakeFailureKind,
  database?: string,
): string | null {
  const db = (database || '').trim();
  switch (kind) {
    case 'authentication':
      return (
        'Snowflake REJECTED THE SIGN-IN, so nothing past the login was reached: this failure says nothing about ' +
        'the role, its grants, or the warehouse, and no GRANT will change it. Loom signs in through the ADF ' +
        'Snowflake connector, which is non-interactive, so a user that requires interactive MFA cannot complete ' +
        'this login by design. Either switch the connection to KEY-PAIR auth (in Snowflake: ' +
        'ALTER USER … SET RSA_PUBLIC_KEY = …, then set the Loom connection\'s auth method to "Key pair"), or point ' +
        'the connection at a user created with TYPE = SERVICE, which is exempt from interactive MFA. Snowflake\'s ' +
        'own message above is the authoritative detail.'
      );
    case 'authorization':
      return (
        'Snowflake ACCEPTED the sign-in and refused the object, so this is a privileges-or-naming problem rather ' +
        'than an authentication one. Snowflake reports "you may not see it" and "it is not there" with the same ' +
        'sentence, so check both: that the object named above is spelled as it exists, and that the connection\'s ' +
        `role holds USAGE on ${db ? `database ${db}` : 'the database'} and on the schemas to mirror, SELECT on ` +
        'their tables, and USAGE on the warehouse.'
      );
    case 'warehouse':
      return (
        'Snowflake ACCEPTED the sign-in but had no running compute to execute on. Set the connection\'s warehouse ' +
        'to one the role holds USAGE on, and either enable AUTO_RESUME on that warehouse or resume it before the ' +
        'run. This failure did not test the grants on the database or its tables.'
      );
    case 'network-policy':
      return (
        'Snowflake reached the account and its NETWORK POLICY refused the caller\'s IP address — the credential ' +
        'was never evaluated, so nothing about it is known. Add the data factory\'s outbound address to the ' +
        'Snowflake network policy (or attach the account to a private link), then re-run. Changing the ' +
        'credential or the grants will not move this.'
      );
    case 'network':
      return (
        'Loom\'s data factory could NOT establish a session with the Snowflake account at all, so nothing about ' +
        'the credential, the role, the warehouse or the grants was tested. Check that the connection\'s account ' +
        'identifier is the organization-account form (myorg-account123, not the full sign-in URL), and that the ' +
        'factory\'s outbound path to <account>.snowflakecomputing.com is open — private endpoint, firewall, DNS, ' +
        'or an intercepting proxy.'
      );
    default:
      // deploy-integrity.md R7. There is no "safe" generic remediation here:
      // every one of the branches above would be a cause this code never
      // established. The honest answer is the absence of one.
      return null;
  }
}

/**
 * PURE. The full operator-facing message for a failed Snowflake read.
 *
 * INVARIANT, asserted by its own test: `detail` is carried through VERBATIM in
 * every branch, including `unknown`. Surfacing the backend's own words was the
 * one thing the original message got right, and a "fix" that swallowed them
 * while tidying the advice would be a net regression.
 *
 * @param prefix  what Loom was doing, in Loom's terms
 * @param detail  the backend's message, unmodified
 * @param database the Snowflake database the read targeted
 */
export function describeSnowflakeFailure(
  prefix: string,
  detail: string,
  database?: string,
): string {
  const kind = classifySnowflakeFailure(detail);
  const remediation = snowflakeRemediation(kind, database);
  const tail = remediation
    ?? 'Loom does NOT recognise this failure, so it asserts NO cause — not authentication, not grants, not the ' +
       'warehouse, not the network. Snowflake\'s message above is the whole of what is known; read it before ' +
       'acting on any hypothesis.';
  return `${prefix}: ${detail}. ${tail}`;
}

/**
 * The machine-readable `missing` key for a classified failure.
 *
 * `authorization` maps to `snowflake-grants`, matching the value the zero-tables
 * visibility probe in mirror-adf-copy.ts already emits for the same condition —
 * two names for one state is how a consumer ends up handling only half of it.
 * `unknown` keeps the pre-existing `snowflake-read`, so nothing keyed on the old
 * value changes meaning: it still means "the read failed, cause unclassified".
 */
export function snowflakeGateMissing(kind: SnowflakeFailureKind): string {
  switch (kind) {
    case 'authentication': return 'snowflake-authentication';
    case 'authorization': return 'snowflake-grants';
    case 'warehouse': return 'snowflake-warehouse';
    case 'network-policy': return 'snowflake-network-policy';
    case 'network': return 'snowflake-network';
    default: return 'snowflake-read';
  }
}
