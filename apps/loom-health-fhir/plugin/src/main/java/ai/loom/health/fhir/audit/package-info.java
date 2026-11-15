/**
 * One {@code AuditEvent} (and one {@code LhdsAudit_CL} row) per FHIR interaction (LHDS W2-3).
 * Records carry identifiers and decisions only: no tokens, no bodies, no query values.
 */
package ai.loom.health.fhir.audit;
