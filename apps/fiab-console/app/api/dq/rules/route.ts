/**
 * /api/dq/rules — Governance → Data quality rule CRUD.
 *
 * The rule store is shared with the legacy `/api/admin/data-quality-rules`
 * surface (Cosmos `dq-rules:<tenantId>`); this namespace simply re-exports the
 * same handlers so the new Governance → Data quality page (Rules / Run /
 * Results / Monitors) reads + writes the one canonical rule set. No second copy.
 */
export { GET, POST, PUT, DELETE, runtime, dynamic } from '../../admin/data-quality-rules/route';
