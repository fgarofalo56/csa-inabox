# ADR-012 — Encryption and key model: per-tenant CMK, Key Vault / Managed HSM, crypto-shred

Status: Proposed. Date: 2026-10-22. Evidence: `../research/azure-gov-availability.md` (Key Vault, Managed HSM rows; IL5 "workload isolation" note), Learn CMK pages cited in `../SECURITY-AND-COMPLIANCE.md` section 4.

## Decision
- Every data service in a stamp uses customer-managed keys: Storage (pixel
  data, audit, export staging), PostgreSQL Flexible Server, control-plane
  Cosmos, backups. IL5 in US Gov regions requires CMK for data services
  (research "workload isolation"), so CMK is **on everywhere** — configuration
  parity.
- Key store: Key Vault Premium (HSM-backed) per stamp; **Managed HSM** per
  stamp is a bicep option for tenants whose IL5 interpretation or policy
  requires single-tenant FIPS 140-3 Level 3 (price: Managed HSM B1 $4.00/h in
  Gov, research). Decision D15 sets the default.
- One key per tenant per purpose (`st-pixel`, `st-audit`, `pg`, `backup`),
  rotation yearly or on demand (automatic key version rotation; services pick
  up the new version), with the rotation job in the control plane and an
  audit record.
- Double encryption: Storage infrastructure encryption enabled; PostgreSQL
  relies on service-level encryption + CMK.
- Crypto-shred: tenant offboarding destroys the tenant keys after the
  contractual export, then deletes data; the receipt records key destruction.
- No application-level field encryption in v1 (search); D14 revisits for
  specific identifiers (e.g. SSN hashed, never stored plain — that is a data
  rule, not encryption).

## Consequences
Key Vault availability becomes a dependency of every store; soft-delete and
purge protection are mandatory (bicep enforced); a lost key is unrecoverable
data by design — documented loudly in the operator docs.

## Reversal cost
Low (key configuration is per resource).
