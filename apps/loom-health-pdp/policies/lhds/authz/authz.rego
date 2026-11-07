# LHDS PDP bundle v1: token contract lhds-at/1, tenant match, scopes, role-gated
# operations (W1-5). Deny by default. Contract source: docs/fiab/health/security.md
# section A7/A8 (W1-4). Input shape: ../../../input-contract.json.
#
# Data (all supplied by the bundle, none hard-coded here):
#   data.lhds.rolemap       apps/loom-health-cp/src/auth/role-scope-map.v1.json, staged by tools/stage-policies.mjs
#   data.lhds.interactions  policies/lhds/interactions/data.json
#   data.lhds.config        {issuer, jwks}  per stamp, from the control plane
#   data.lhds.stamp         {tenants: {<slug>: {bases: [<base url>...]}}}  per stamp, from the routing map
# Missing config/stamp data makes every request deny (no token can verify).
package lhds.authz

import rego.v1

cfg := data.lhds.config

ix := data.lhds.interactions

skew_seconds := 60

max_lifetime_seconds := 300

tenant_re := `^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])$`

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
	"policy_version": data.lhds.rolemap.version,
	"obligations": [],
}

non_empty(x) if {
	is_string(x)
	x != ""
}

req := input.request

# --- request-side validation -------------------------------------------------

valid_input if {
	non_empty(input.access_token)
	non_empty(req.tenant)
	non_empty(req.base)
	req.service in {"fhir", "dicom"}
	non_empty(req.interaction)
	service_fields_ok
	optional_arrays_ok
}

service_fields_ok if req.service == "dicom"

service_fields_ok if {
	req.service == "fhir"
	non_empty(req.resource_type)
}

optional_arrays_ok if {
	every k in ["categories", "patient_compartment"] {
		_array_of_strings_or_absent(k)
	}
}

_array_of_strings_or_absent(k) if not k in object.keys(req)

_array_of_strings_or_absent(k) if {
	is_array(req[k])
	every v in req[k] {
		is_string(v)
	}
}

# --- token verification (seam: tests of scope logic mock token_valid/claims/now) --

decoded := io.jwt.decode(input.access_token)

header := decoded[0]

claims := decoded[1]

now := time.now_ns() / 1000000000

token_valid if {
	is_string(input.access_token)
	io.jwt.verify_es384(input.access_token, cfg.jwks)
	header.alg == "ES384"
	header.typ == "at+jwt"
}

required_non_empty := [
	"iss", "aud", "jti", "lhds_ver", "tenant", "sub", "sub_type",
	"client_id", "lhds_map_ver",
]

# Every claim of contract lhds-at/1 must be present and well typed. scope may be
# the empty string (a DICOM-only client holds roles, not scopes); everything else
# may not be absent.
claims_ok if {
	every k in required_non_empty {
		non_empty(claims[k])
	}
	is_string(claims.scope)
	is_number(claims.exp)
	is_number(claims.iat)
	claims.sub_type in {"user", "system"}
	regex.match(tenant_re, claims.tenant)
	is_array(claims.lhds_roles)
	every r in claims.lhds_roles {
		is_string(r)
	}
	is_array(claims.pou)
	count(claims.pou) > 0
	every p in claims.pou {
		non_empty(p)
	}
	not "BTG" in claims.pou # BTG is never issued in W1
	idp_ok
}

idp_ok if claims.sub_type == "system"

idp_ok if {
	claims.sub_type == "user"
	non_empty(claims.idp_tid)
}

version_ok if claims.lhds_ver == "lhds-at/1"

issuer_ok if claims.iss == cfg.issuer

# T1: exact equality, no case-folding or trimming.
tenant_ok if claims.tenant == req.tenant

has_reserved_claim if {
	some k in {"act", "cnf"}
	k in object.keys(claims)
}

time_ok if {
	now < claims.exp
	claims.iat <= now + skew_seconds
	claims.exp > claims.iat
	claims.exp - claims.iat <= max_lifetime_seconds
}

# T3: the tenant is homed on this stamp.
tenant_on_stamp if is_object(data.lhds.stamp.tenants[claims.tenant])

# T2: aud is a single string equal to the request base, and that base belongs to
# the token's tenant in the stamp map.
aud_ok if {
	claims.aud == req.base
	req.base in data.lhds.stamp.tenants[claims.tenant].bases
}

# Ordered: the first matching branch wins. Exact string comparison throughout; no
# case-folding, trimming or normalisation (A8).
reason := "invalid-input" if not valid_input
else := "token-invalid" if not token_valid
else := "claims-invalid" if not claims_ok
else := "version-unsupported" if not version_ok
else := "reserved-claim" if has_reserved_claim
else := "issuer-mismatch" if not issuer_ok
else := "token-time-invalid" if not time_ok
else := "tenant-mismatch" if not tenant_ok
else := "tenant-not-on-stamp" if not tenant_on_stamp
else := "audience-mismatch" if not aud_ok
else := "unknown-interaction" if not known_interaction
else := "permit" if authorized
else := "role-denied" if role_gated
else := "scope-denied"

# --- interaction classification ----------------------------------------------

role_gated if req.service == "dicom"

role_gated if {
	req.service == "fhir"
	req.interaction == ix.fhir_operation
}

known_interaction if {
	req.service == "fhir"
	req.interaction == ix.fhir_operation
	non_empty(req.op)
}

known_interaction if {
	req.service == "fhir"
	ix.fhir[req.interaction]
}

known_interaction if {
	req.service == "dicom"
	ix.dicom[req.interaction]
}

# --- authorization -------------------------------------------------------------

# DICOM: roles only (the role map carries no DICOM scopes).
authorized if {
	req.service == "dicom"
	role_has_op(ix.dicom[req.interaction])
}

# FHIR operation ($export, ...): a held role must list the op, AND the token must
# carry at least one data scope valid for its sub_type. The per-operation scope
# letter is not defined by W1-4; this is the minimum, flagged in the README.
authorized if {
	req.service == "fhir"
	req.interaction == ix.fhir_operation
	role_has_op(req.op)
	some s in scope_list
	p := parsed(s)
	compartment_fits_subtype(p.ctx)
}

# FHIR resource interaction: some granted scope matches compartment, type, letter
# and (when present) the category constraint.
authorized if {
	req.service == "fhir"
	ix.fhir[req.interaction]
	some s in scope_list
	p := parsed(s)
	compartment_fits_subtype(p.ctx)
	contains(p.perms, ix.fhir[req.interaction])
	type_ok(p.res)
	patient_ok(p.ctx)
	constraint_ok(p)
}

role_has_op(op) if {
	some r in data.lhds.rolemap.roles
	r.id in claims.lhds_roles
	op in r.operations
}

scope_list := split(claims.scope, " ")

# v2 grammar only (A2). Anything that does not parse, including out-of-order or
# repeated letters and unsupported constraints, yields no parse and so grants nothing.
parsed(s) := {"ctx": m[1], "res": m[2], "perms": m[3], "category": m[4]} if {
	found := regex.find_all_string_submatch_n(`^(patient|user|system)/(\*|[A-Za-z][A-Za-z0-9]*)\.([cruds]+)(?:\?category=([^&\s?]+))?$`, s, 1)
	m := found[0]
	regex.match(`^c?r?u?d?s?$`, m[3])
	constraint_allowed(m[2], m[4])
}

constraint_allowed(_, "")

constraint_allowed(res, cat) if {
	cat != ""
	res in {"Observation", "Condition", "DocumentReference"}
}

# system/ only for system tokens; user/ and patient/ only for user tokens.
compartment_fits_subtype("system") if claims.sub_type == "system"

compartment_fits_subtype(ctx) if {
	ctx in {"user", "patient"}
	claims.sub_type == "user"
}

# Wildcard covers FHIR resource types only (the service is already fhir here).
type_ok(res) if res == req.resource_type

type_ok("*")

patient_ok(ctx) if ctx != "patient"

# Needs the patient claim, and a non-empty compartment all of whose owners are that
# patient. An unbound search or unknown owner has an empty compartment and denies.
patient_ok("patient") if {
	non_empty(claims.patient)
	comp := object.get(req, "patient_compartment", [])
	count(comp) > 0
	every o in comp {
		o == claims.patient
	}
}

constraint_ok(p) if p.category == ""

constraint_ok(p) if {
	p.category != ""
	p.category in object.get(req, "categories", [])
}
