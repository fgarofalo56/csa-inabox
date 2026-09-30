'use client';

// sql-pool-query-scope-note.tsx — what the editors that post to the serverless
// SQL pool query route tell a caller who is not a tenant admin.
//
// `POST /api/items/synapse-serverless-sql-pool/[id]/query` (re-exported by the
// SQL analytics endpoint's query route) runs such a caller's text only when the
// lakehouse classifier accepts it, with every OPENROWSET(BULK …) location under
// the storage root of a lakehouse in the item's workspace, in master
// (`app/api/items/synapse-serverless-sql-pool/_lib/query-scope.ts`). The
// editors pin their Connect to picker at master for that caller, and show a
// refusal through the SQL tab's shared bar.

import { Link, MessageBar, MessageBarBody, MessageBarTitle, makeStyles } from '@fluentui/react-components';
import { useIsTenantAdmin } from '@/lib/components/session-context';

const useStyles = makeStyles({
  wrapText: { overflowWrap: 'anywhere', wordBreak: 'break-word' },
});

/** The issues that track lifting the limit, linked from each scope note. */
export const SQL_SCOPE_FOLLOW_UP = {
  perItemDatabase: 'https://github.com/fgarofalo56/csa-inabox/issues/4821',
  tracking: 'https://github.com/fgarofalo56/csa-inabox/issues/4840',
};

/**
 * Why a ribbon template (DDL, GRANT, RLS, a `sys` catalog script) is disabled
 * for a caller who is not a tenant admin: the query route would refuse it.
 */
export const SQL_POOL_ADMIN_ONLY_TEMPLATE =
  'Tenant admins only. For other callers this editor runs read-only SELECT queries in master, '
  + 'so this template would be refused.';

/** The sentence, shared by every scope note, that says the limit is temporary and what lifts it. */
export function SqlScopeFollowUp() {
  return (
    <>
      {' '}This limit is temporary: a per-item serverless database (
      <Link href={SQL_SCOPE_FOLLOW_UP.perItemDatabase} target="_blank" rel="noreferrer">#4821</Link>
      , tracked in{' '}
      <Link href={SQL_SCOPE_FOLLOW_UP.tracking} target="_blank" rel="noreferrer">#4840</Link>
      ) replaces it.
    </>
  );
}

/** "A, B and C" — the ribbon entry list as one readable phrase. */
export function joinEntries(entries: readonly string[]): string {
  if (entries.length <= 1) return entries.join('');
  return `${entries.slice(0, -1).join(', ')} and ${entries[entries.length - 1]}`;
}

/**
 * Rendered only for a caller who is not a tenant admin.
 *
 * `adminOnlyEntries` names the ribbon entries this editor disables for that
 * caller. They are named here in visible text, so the reason does not depend on
 * hovering or focusing a disabled button to read its tooltip.
 */
export function SqlPoolQueryScopeNote({ adminOnlyEntries = [] }: { adminOnlyEntries?: readonly string[] }) {
  const s = useStyles();
  const isAdmin = useIsTenantAdmin();
  if (isAdmin) return null;
  return (
    <MessageBar intent="info" layout="multiline" data-testid="sql-pool-query-scope">
      <MessageBarBody className={s.wrapText}>
        <MessageBarTitle>What you can query here</MessageBarTitle>
        Read-only SELECT queries over the files of the lakehouses in this workspace, named by
        their full URL in OPENROWSET(BULK &apos;https://&lt;account&gt;.dfs.&lt;suffix&gt;/&lt;container&gt;/&lt;lakehouse root&gt;/…&apos;),
        and the INFORMATION_SCHEMA views. Queries run in master; the Connect to database applies
        to tenant admins only, who can also run other statements.
        {adminOnlyEntries.length > 0 && (
          <span data-testid="sql-pool-admin-only-entries">
            {' '}{joinEntries(adminOnlyEntries)} in the ribbon are available to tenant admins only,
            because the statements they open would not be run for you.
          </span>
        )}
        <SqlScopeFollowUp />
      </MessageBarBody>
    </MessageBar>
  );
}
