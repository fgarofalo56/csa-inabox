# LHDS PDP bundle v1: scopes, roles, tenant match (W1-5). Deny by default.
# Input shape: ../../../input-contract.json (PROVISIONAL, reconcile with W1-4).
# Data: data.lhds.mapping (policies/lhds/mapping/data.json), the single mapping
# table the scope-matrix test is generated from.
package lhds.authz

import rego.v1

mapping := data.lhds.mapping

# Fail closed: anything not positively derived below is a deny.
default decision := {
	"allow": false,
	"reason": "invalid-input",
	"policy_version": "unknown",
	"obligations": [],
}

decision := {
	"allow": reason == "permit",
	"reason": reason,
	"policy_version": mapping.version,
	"obligations": [],
}

non_empty(x) if {
	is_string(x)
	x != ""
}

valid_input if {
	non_empty(input.token.sub)
	non_empty(input.token.tenant)
	non_empty(input.request.tenant)
	non_empty(input.request.service)
	non_empty(input.request.interaction)
	non_empty(input.request.resource_type)
}

# Ordered: the first matching branch wins, so a tenant mismatch is reported as
# such even when the token also lacks the scope.
reason := "invalid-input" if not valid_input
else := "tenant-mismatch" if input.token.tenant != input.request.tenant
else := "unknown-interaction" if not needed
else := "permit" if count(grants) > 0
else := "scope-denied"

# Single CRUDS letter the request needs.
needed := mapping.interactions[input.request.service][input.request.interaction]

# Scopes granted directly plus the bundles of the roles held. Union by design:
# a role is a grant, not a ceiling.
effective_scopes contains s if {
	some s in input.token.scopes
}

effective_scopes contains s if {
	some r in input.token.roles
	some s in mapping.roles[r]
}

parsed(s) := {"ctx": m[1], "res": m[2], "perms": m[3]} if {
	found := regex.find_all_string_submatch_n(`^(patient|user|system)/(\*|[A-Za-z][A-Za-z0-9]*)\.([cruds]+)$`, s, 1)
	m := found[0]
}

grants contains s if {
	some s in effective_scopes
	p := parsed(s)
	contains(p.perms, needed)
	resource_ok(p.res)
	context_ok(p.ctx)
}

# Wildcard covers FHIR types only; DICOM needs an explicit dicom scope.
resource_ok(res) if res == input.request.resource_type

resource_ok("*") if input.request.service == "fhir"

context_ok(ctx) if ctx != "patient"

context_ok("patient") if {
	input.request.service == "fhir"
	non_empty(input.token.patient)
	input.token.patient == input.request.patient
}
