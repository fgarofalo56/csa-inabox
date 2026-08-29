/**
 * change-tracking-failure-class — WHY `ALTER TABLE … ENABLE CHANGE_TRACKING`
 * failed, and only what that failure actually established.
 *
 * ## The defect this replaces (#4050)
 *
 * `mirror-engine.ts` appended, UNCONDITIONALLY, to any `enableChangeTracking`
 * failure:
 *
 *     "Change tracking could not be enabled — falling back to full snapshot.
 *      Grant db_owner to the console identity to unlock incremental sync."
 *
 * `ENABLE CHANGE_TRACKING` fails for several causes that have nothing to do with
 * permissions: the table has no primary key (CT requires one), database-level
 * change tracking is off, a deadlock or lock timeout on the schema modification,
 * or the connection dropped mid-statement. In every one of those the operator
 * was told to grant `db_owner` — a privilege escalation on their PRODUCTION
 * database — to fix something granting `db_owner` will not fix. They then either
 * do it (a real security change for no benefit) or conclude Loom's diagnostics
 * cannot be trusted.
 *
 * That is `deploy-integrity.md` R7 verbatim, and it is the identical shape as
 * the Snowflake remediation defect #4033 was opened for — the same "we saw a
 * failure, so it must be the one cause we know about" reasoning. This module is
 * the same answer: CLASSIFY BEFORE ADVISING, and where nothing classified, say
 * what was observed and that the cause was not determined.
 *
 * ## What the fallback does NOT change
 *
 * Falling back to a full snapshot is correct and is untouched. The only thing
 * that changes is the sentence explaining why.
 *
 * ## Grounding
 *
 * Error numbers are SQL Server's, and each is used only where the vendor's own
 * text corroborates it — the numbers widen the match, they never carry it alone:
 *
 *   - 297 / 262 / 229  the permission family ("The user does not have permission
 *                      to perform this action", "… permission was denied",
 *                      "requires … permission")
 *   - 4997             ALTER TABLE … ENABLE CHANGE_TRACKING on a table with no
 *                      primary key
 *   - 22105            change tracking is not enabled on the database
 *   - 1205 / 1222      deadlock victim / lock request timeout
 *
 * Pure: no I/O, no env, no SDK. Safe to import from a route, a client, or a test.
 */
import { statusToken } from './status-token';

/**
 * What a failed `ENABLE CHANGE_TRACKING` established.
 *
 * `unknown` is a first-class outcome, not a fallback bucket that gets the
 * friendliest-sounding advice — it is the whole point of the module.
 */
export type ChangeTrackingFailureKind =
  | 'permission'
  | 'no-primary-key'
  | 'database-ct-off'
  | 'transient'
  | 'unknown';

/** Every member of {@link ChangeTrackingFailureKind}, at RUNTIME. */
export const CHANGE_TRACKING_FAILURE_KINDS = [
  'permission',
  'no-primary-key',
  'database-ct-off',
  'transient',
  'unknown',
] as const satisfies readonly ChangeTrackingFailureKind[];

/**
 * POSITIVE evidence of a permission failure. This is the ONLY thing that earns
 * the `db_owner` sentence.
 *
 * Numeric codes go through `statusToken` for the reason `status-token.ts`
 * records: `\b297\b` matches inside `TBL_297_EU` and inside a GUID segment, and
 * telling an operator to escalate a production grant because their table name
 * contains a digit run is the same class of defect one datatype over.
 */
const PERMISSION = new RegExp(
  [
    statusToken('297|262|229'),
    'permission was denied',
    'does not have permission',
    'requires .{0,40}permission',
    'ALTER permission',
    'CONTROL permission',
    'is not a member of the db_owner',
  ].join('|'),
  'i',
);

/** The table has no primary key. CT requires one; no grant changes that. */
const NO_PRIMARY_KEY = new RegExp(
  [
    statusToken('4997'),
    'requires a primary key',
    'does not have a primary key',
    'must have a primary key',
    'no primary key',
  ].join('|'),
  'i',
);

/** Database-level CT is off. `ALTER DATABASE` comes first, and it is not a grant. */
const DATABASE_CT_OFF = new RegExp(
  [
    statusToken('22105'),
    'change tracking is not enabled on database',
    'change tracking is not enabled on the database',
    'Change tracking is disabled',
  ].join('|'),
  'i',
);

/**
 * A contention or connection failure. Retryable, and says NOTHING about grants,
 * keys or database settings.
 */
const TRANSIENT = new RegExp(
  [
    statusToken('1205|1222'),
    'deadlock',
    'was deadlocked',
    'lock request time ?out',
    'timeout expired',
    'connection was (?:forcibly )?closed',
    'transport-level error',
    'socket hang up',
  ].join('|'),
  'i',
);

/**
 * Classify a failed `ENABLE CHANGE_TRACKING`.
 *
 * ORDER. The specific causes are asked before the generic ones, and TRANSIENT is
 * asked LAST of the four because a deadlock message can quote the statement that
 * deadlocked — including the words "primary key" — while a genuine missing-key
 * error never mentions a deadlock. Asking the specific structural causes first
 * therefore cannot steal a transient, but the reverse can.
 */
export function classifyChangeTrackingFailure(
  detail: string | null | undefined,
): ChangeTrackingFailureKind {
  const s = String(detail ?? '');
  if (PERMISSION.test(s)) return 'permission';
  if (NO_PRIMARY_KEY.test(s)) return 'no-primary-key';
  if (DATABASE_CT_OFF.test(s)) return 'database-ct-off';
  if (TRANSIENT.test(s)) return 'transient';
  return 'unknown';
}

/**
 * The remediation for a classified failure, or `null` when nothing was
 * established.
 *
 * `null` is the CONTRACT, not an omission: a caller cannot accidentally render a
 * plausible-sounding default, because there is not one to render. The `unknown`
 * branch's honest text lives in {@link describeChangeTrackingFailure}, where the
 * observed detail is in scope and can be quoted.
 *
 * @param kind    what `classifyChangeTrackingFailure` established
 * @param schema  the source schema, for the no-primary-key case
 * @param table   the source table, for the no-primary-key case
 * @param database the source database, for the DB-level-CT case
 */
export function changeTrackingRemediation(
  kind: ChangeTrackingFailureKind,
  schema?: string,
  table?: string,
  database?: string,
): string | null {
  const obj = schema && table ? `${schema}.${table}` : 'the source table';
  const db = (database || '').trim();
  switch (kind) {
    case 'permission':
      return (
        'SQL Server refused the statement for lack of privilege, which is the one cause a grant fixes. ' +
        'Grant db_owner to the console identity on the source database (or, more narrowly, ALTER on ' +
        `${obj}) to unlock incremental sync.`
      );
    case 'no-primary-key':
      return (
        `Change tracking requires a PRIMARY KEY and ${obj} has none, so no grant will enable it. Add a ` +
        `primary key to ${obj}, or accept full-snapshot sync for this table.`
      );
    case 'database-ct-off':
      return (
        'Change tracking is off at the DATABASE level, so the table-level statement cannot succeed until ' +
        `it is on. Run: ALTER DATABASE ${db ? `[${db}]` : '[<source database>]'} SET CHANGE_TRACKING = ON ` +
        '(CHANGE_RETENTION = 2 DAYS, AUTO_CLEANUP = ON); then re-run. This is a database setting, not a grant.'
      );
    case 'transient':
      return (
        'The statement lost a lock or its connection rather than being refused, so nothing about grants, ' +
        'primary keys or database settings was established. The next Start retries it; if it recurs, run ' +
        'the mirror when the source is not under a heavy schema-modifying workload.'
      );
    default:
      // deploy-integrity.md R7. Every branch above would be a cause this code
      // never established. The honest answer is the absence of one — and per
      // `csa_loom_unknown_as_negative_class_2026_08_02`, an unknown reported as
      // a known cause is worse than an unknown reported honestly.
      return null;
  }
}

/**
 * The full operator-facing note for a failed `ENABLE CHANGE_TRACKING`.
 *
 * INVARIANT, asserted for EVERY branch by
 * `__tests__/change-tracking-failure-class.test.ts` (derived from
 * {@link CHANGE_TRACKING_FAILURE_KINDS}, not hand-listed — see #4049 F3 for what
 * a hand-listed coverage assertion costs): the SQL error's own words are carried
 * through VERBATIM, including in `unknown`.
 *
 * @param prefix  what Loom did instead, in Loom's terms
 * @param detail  SQL Server's message, unmodified
 */
export function describeChangeTrackingFailure(
  prefix: string,
  detail: string,
  schema?: string,
  table?: string,
  database?: string,
): string {
  const kind = classifyChangeTrackingFailure(detail);
  const tail =
    changeTrackingRemediation(kind, schema, table, database) ??
    'Loom does NOT recognise this failure, so it asserts NO cause — not a missing grant, not a missing ' +
      'primary key, not a database setting, not contention. The SQL error above is the whole of what is ' +
      'known; read it before acting on any hypothesis.';
  return `${prefix} (${detail}). ${tail}`;
}
