/**
 * #4050 — `ENABLE CHANGE_TRACKING` failures are CLASSIFIED, not assumed.
 *
 * `mirror-engine.ts` appended, unconditionally, to any `enableChangeTracking`
 * failure:
 *
 *     "Change tracking could not be enabled — falling back to full snapshot.
 *      Grant db_owner to the console identity to unlock incremental sync."
 *
 * `ALTER TABLE … ENABLE CHANGE_TRACKING` fails for several causes that have
 * nothing to do with permissions — no primary key, database-level CT off, a
 * deadlock, a dropped connection — and in every one of those the operator was
 * told to grant `db_owner` on their PRODUCTION database to fix something the
 * grant will not fix. `deploy-integrity.md` R7, and the identical shape to the
 * Snowflake defect #4033 was opened for.
 *
 * THE POINT OF THIS FILE IS THE NEGATIVE ARM. "A test that only checks the happy
 * string is what let this ship" (#4050), so every fixture asserts BOTH that the
 * right advice appears AND that the `db_owner` sentence does not.
 */
import { describe, it, expect } from 'vitest';
import {
  CHANGE_TRACKING_FAILURE_KINDS,
  changeTrackingRemediation,
  classifyChangeTrackingFailure,
  describeChangeTrackingFailure,
  type ChangeTrackingFailureKind,
} from '../change-tracking-failure-class';

const SCHEMA = 'dbo';
const TABLE = 'PLACEHOLDER_ORDERS';
const DB = 'PLACEHOLDER_DB';

/** The sentence that used to be appended to EVERYTHING. */
const DB_OWNER_ADVICE = /db_owner/i;
const PK_ADVICE = /primary key/i;
const ALTER_DB_ADVICE = /ALTER DATABASE/;

/**
 * One payload per kind. Real SQL Server text, with every identifier an obvious
 * placeholder — this repo is PUBLIC.
 */
const BY_KIND: Record<ChangeTrackingFailureKind, string> = {
  permission:
    "Msg 297, Level 16, State 1: The user does not have permission to perform this action. "
    + `ALTER TABLE [${SCHEMA}].[${TABLE}] ENABLE CHANGE_TRACKING failed.`,
  'no-primary-key':
    `Msg 4997, Level 16, State 1: Cannot enable change tracking on table '${SCHEMA}.${TABLE}'. `
    + 'Change tracking requires a primary key on the table.',
  'database-ct-off':
    `Msg 22105, Level 16, State 1: Change tracking is not enabled on database '${DB}'.`,
  transient:
    'Msg 1205, Level 13, State 51: Transaction (Process ID 63) was deadlocked on lock resources '
    + 'with another process and has been chosen as the deadlock victim.',
  unknown:
    'Msg 50000, Level 16, State 1: an unexpected condition occurred while altering the table.',
};

describe('classifyChangeTrackingFailure', () => {
  it('COVERAGE FLOOR: every member of CHANGE_TRACKING_FAILURE_KINDS has a fixture', () => {
    // Derived from the exported runtime list rather than hand-listed — #4049 F3
    // measured what a hand-list costs: a whole branch with no case at all,
    // under a docblock claiming every branch was asserted.
    for (const kind of CHANGE_TRACKING_FAILURE_KINDS) {
      expect(BY_KIND[kind], `no fixture for '${kind}'`).toBeTruthy();
    }
    expect(Object.keys(BY_KIND).sort()).toEqual([...CHANGE_TRACKING_FAILURE_KINDS].sort());
  });

  for (const kind of CHANGE_TRACKING_FAILURE_KINDS) {
    it(`classifies its '${kind}' fixture as '${kind}'`, () => {
      expect(classifyChangeTrackingFailure(BY_KIND[kind])).toBe(kind);
    });
  }

  it('classifies null / undefined / empty as unknown, never as a cause', () => {
    for (const v of [null, undefined, '', '   ']) {
      expect(classifyChangeTrackingFailure(v)).toBe('unknown');
    }
  });

  it('reads the permission family by WORDS as well as by number', () => {
    for (const msg of [
      'ALTER permission was denied on object PLACEHOLDER_ORDERS',
      'The ALTER TABLE statement requires ALTER permission on the object',
      'The current user is not a member of the db_owner fixed database role',
      'Msg 262, Level 14: CONTROL permission denied in database',
    ]) {
      expect(classifyChangeTrackingFailure(msg), `for ${JSON.stringify(msg)}`).toBe('permission');
    }
  });

  it('does NOT read a code out of an OBJECT NAME (the rg-loom-503 defect, in CT dress)', () => {
    // The numeric halves go through `statusToken`, so a table whose name carries
    // a digit run cannot manufacture a grant escalation on a production database.
    for (const msg of [
      'Cannot enable change tracking on table dbo.TBL_297_EU — an unexpected condition.',
      'Cannot enable change tracking on table dbo.ORDERS_4997 — an unexpected condition.',
      'correlation 22105a did not resolve',
      'run id 12051 did not complete',
    ]) {
      expect(classifyChangeTrackingFailure(msg), `for ${JSON.stringify(msg)}`).toBe('unknown');
    }
  });
});

describe('changeTrackingRemediation — the db_owner sentence needs POSITIVE evidence', () => {
  it('attaches db_owner advice ONLY to a permission failure', () => {
    const msg = changeTrackingRemediation('permission', SCHEMA, TABLE, DB)!;
    expect(msg).toMatch(DB_OWNER_ADVICE);
    expect(msg).toContain(`${SCHEMA}.${TABLE}`);
  });

  it('a MISSING PRIMARY KEY gets the primary-key remediation and NO grant advice', () => {
    const msg = changeTrackingRemediation('no-primary-key', SCHEMA, TABLE, DB)!;
    expect(msg).toMatch(PK_ADVICE);
    expect(msg).toContain(`${SCHEMA}.${TABLE}`);
    expect(msg).not.toMatch(DB_OWNER_ADVICE);
    // …and it says so, rather than leaving the operator to infer it.
    expect(msg).toMatch(/no grant will enable it/i);
  });

  it('DB-LEVEL CT OFF gets the ALTER DATABASE statement and NO grant advice', () => {
    const msg = changeTrackingRemediation('database-ct-off', SCHEMA, TABLE, DB)!;
    expect(msg).toMatch(ALTER_DB_ADVICE);
    expect(msg).toContain(`[${DB}]`);
    expect(msg).not.toMatch(DB_OWNER_ADVICE);
    expect(msg).toMatch(/not a grant/i);
  });

  it('a TRANSIENT failure asserts nothing about grants, keys or settings', () => {
    const msg = changeTrackingRemediation('transient', SCHEMA, TABLE, DB)!;
    expect(msg).not.toMatch(DB_OWNER_ADVICE);
    expect(msg).not.toMatch(ALTER_DB_ADVICE);
    expect(msg).toMatch(/nothing about grants, primary keys or database settings was established/i);
  });

  it('an UNKNOWN failure gets NO remediation at all — null is the contract', () => {
    // Not a friendly-sounding default. A caller cannot render one, because there
    // is not one to render.
    expect(changeTrackingRemediation('unknown', SCHEMA, TABLE, DB)).toBeNull();
  });

  it('falls back to generic object wording when schema/table are absent', () => {
    const msg = changeTrackingRemediation('no-primary-key')!;
    expect(msg).toContain('the source table');
    expect(msg).not.toContain('undefined');
  });
});

describe('describeChangeTrackingFailure — the end-to-end note', () => {
  it('COVERAGE: the SQL error is carried VERBATIM in every branch', () => {
    // Same invariant, and same derivation, as #4049 F3 on the Snowflake side:
    // a hand-listed branch set is how a branch ends up with no case at all.
    for (const kind of CHANGE_TRACKING_FAILURE_KINDS) {
      const detail = BY_KIND[kind];
      const note = describeChangeTrackingFailure('Change tracking could not be enabled', detail, SCHEMA, TABLE, DB);
      expect(note, `branch '${kind}' dropped the SQL error`).toContain(detail);
    }
  });

  it('THE #4050 REGRESSION: the four non-permission causes get NO db_owner advice', () => {
    // This is the assertion that would have failed on the unconditional string,
    // and the one a future revert has to get past.
    for (const kind of CHANGE_TRACKING_FAILURE_KINDS) {
      if (kind === 'permission') continue;
      const note = describeChangeTrackingFailure(
        'Change tracking could not be enabled', BY_KIND[kind], SCHEMA, TABLE, DB,
      );
      expect(note, `branch '${kind}' still tells the operator to grant db_owner`).not.toMatch(DB_OWNER_ADVICE);
    }
  });

  it('CONTROL: a REAL permission failure DOES still get the db_owner advice', () => {
    // Without this, the block above is equally satisfied by deleting the advice
    // entirely — which would be a different R7 failure, not a fix.
    const note = describeChangeTrackingFailure(
      'Change tracking could not be enabled', BY_KIND.permission, SCHEMA, TABLE, DB,
    );
    expect(note).toMatch(DB_OWNER_ADVICE);
  });

  it('the UNKNOWN branch names what was observed and says the cause was not determined', () => {
    const note = describeChangeTrackingFailure(
      'Change tracking could not be enabled', BY_KIND.unknown, SCHEMA, TABLE, DB,
    );
    expect(note).toContain(BY_KIND.unknown);
    expect(note).toMatch(/asserts NO cause/);
    expect(note).not.toMatch(DB_OWNER_ADVICE);
    expect(note).not.toMatch(ALTER_DB_ADVICE);
  });

  it('keeps the caller PREFIX, so the fallback behaviour is still explained', () => {
    // The fallback to a full snapshot is correct and unchanged; only the
    // explanation moved. A note that lost the prefix would leave the operator
    // without the one fact that IS established.
    const note = describeChangeTrackingFailure(
      'Change tracking could not be enabled — falling back to full snapshot',
      BY_KIND['no-primary-key'], SCHEMA, TABLE, DB,
    );
    expect(note).toContain('falling back to full snapshot');
  });
});
