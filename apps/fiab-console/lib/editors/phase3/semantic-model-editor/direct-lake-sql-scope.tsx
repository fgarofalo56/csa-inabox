'use client';

// direct-lake-sql-scope.tsx — what the "Direct Lake query" tab tells a caller
// who is not a tenant admin about a semantic model's own SQL, and how a query
// the route chose not to run is shown.
//
// `POST /api/items/semantic-model/[id]/direct-lake` has two branches. The TABLE
// branch (the only one this tab sends) builds its own SQL over the Gold Delta
// table and is unchanged. The SQL branch runs a model's own T-SQL; for a caller
// who is not a tenant admin it runs only text the lakehouse classifier accepts,
// with every OPENROWSET(BULK …) location under the storage root of a lakehouse
// in the model's workspace, in master
// (`app/api/items/semantic-model/_lib/direct-lake-scope.ts`). A refusal comes
// back as `{ ok:false, code, error, remediation }` and is rendered by the SQL
// tab's shared bar, so both surfaces word it the same way.

import { MessageBar, MessageBarBody, MessageBarTitle } from '@fluentui/react-components';
import { useIsTenantAdmin } from '@/lib/components/session-context';
import { SqlRefusalOrError, type SqlFailure } from '../../lakehouse/panes/sql-pane';
import { SqlScopeFollowUp } from '../../components/sql-pool-query-scope-note';

/** The scope of a model's own SQL, shown to a caller who is not a tenant admin. */
export function DirectLakeSqlScopeNote() {
  const isAdmin = useIsTenantAdmin();
  if (isAdmin) return null;
  return (
    <MessageBar intent="info" layout="multiline" data-testid="direct-lake-sql-scope">
      <MessageBarBody>
        <MessageBarTitle>What a model&apos;s own SQL can read</MessageBarTitle>
        A table query on this tab reads the Gold Delta table. SQL that a semantic model sends to this
        endpoint runs, for a caller who is not a tenant admin, only as a read-only SELECT over files under
        the storage root of a lakehouse in the model&apos;s workspace (named by full URL in
        OPENROWSET(BULK …)) and over the INFORMATION_SCHEMA views, in master. A model whose SQL reads
        other storage is not run: read that data through a lakehouse in the model&apos;s workspace, or ask
        a tenant admin, who can run other statements.
        <SqlScopeFollowUp />
      </MessageBarBody>
    </MessageBar>
  );
}

/** A failed Direct Lake query: "Query not run" with the remediation, or "Query failed". */
export function DirectLakeQueryFailure({ result }: { result: { error?: string; code?: string; remediation?: string } }) {
  return <SqlRefusalOrError result={{ ok: false, ...result } as SqlFailure} />;
}
