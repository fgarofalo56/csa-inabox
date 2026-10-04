/**
 * How the classifier's refusals read on `POST /api/items/[type]/[id]/visual-query`
 * for a serverless SQL pool item, for a caller who is not a tenant admin.
 *
 * Two canvases post there: the Warp transform canvas
 * (`lib/components/warp/warp-transform-canvas.tsx`) and the serverless SQL pool
 * editor's visual query canvas (`lib/editors/components/visual-query-canvas.tsx`).
 * Both send a graph, and the route compiles it, so the wording speaks of a visual
 * query and its Sink rather than of an editor the caller typed SQL into. The
 * rules are the same as the serverless SQL pool query route's
 * (`./query-scope.ts`, `SQL_POOL_EDITOR`); only the wording differs.
 *
 * `generated` leaves out the hint to bracket or qualify a refused word: the
 * `INTO` of a table Sink is the compiler's, so that hint is neither true nor
 * something the caller can act on. (A view Sink's `CREATE` opens the statement
 * and is refused by the statement-start rule, which carries no such hint.) The
 * cost is stated rather than hidden: a refused word inside an expression the
 * caller typed into a node (a filter or a derived column) gets no bracket hint
 * here either.
 *
 * This module imports only the type, so a client test can use the same object.
 */
import type { QueryScopeSurface } from '@/app/api/items/lakehouse/_lib/query-scope';

/** The visual query canvases on a serverless SQL pool target. */
export const VISUAL_QUERY_SURFACE: QueryScopeSurface = {
  lead:
    'A visual query on a serverless SQL pool target runs as one read-only SELECT in master for a caller who is '
    + 'not a tenant admin. ',
  name: 'a visual query on this target',
  place: 'a visual query on this target',
  files: 'the files of the lakehouses in this workspace',
  selectRemediation:
    'If the query ends in a Sink, remove the Sink, or pick a warehouse or dedicated SQL pool target to write the '
    + 'table or view. Otherwise build it from tables and views in master, such as the INFORMATION_SCHEMA views. '
    + 'A tenant admin can run other statements.',
  dataSource:
    'no external data source is scoped to this workspace; name each file by its full URL under a lakehouse root',
  generated: true,
};
