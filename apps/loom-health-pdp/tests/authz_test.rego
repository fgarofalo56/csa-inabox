# Hand-written PDP tests. Each states the input/mutation that makes it fail.
package lhds.authz_test

import rego.v1

import data.lhds.authz

full := ["system/*.cruds"]

fhir_read(tenant) := {"service": "fhir", "interaction": "read", "tenant": tenant, "resource_type": "Patient", "patient": "p1"}

tok(tenant, scopes) := {"sub": "u1", "tenant": tenant, "scopes": scopes}

# Breaks if: the tenant comparison is removed or weakened (token t1 + full scope
# against route t2 would become permit). Paired positive below.
test_cross_tenant_denied_even_with_full_scope if {
	d := authz.decision with input as {"token": tok("t1", full), "request": fhir_read("t2")}
	d.allow == false
	d.reason == "tenant-mismatch"
}

# Positive pair: same token, same request, only the route tenant differs.
test_same_tenant_permitted if {
	d := authz.decision with input as {"token": tok("t1", full), "request": fhir_read("t1")}
	d.allow == true
	d.reason == "permit"
	d.policy_version == "1.0.0"
}

# Breaks if: tenant mismatch is checked after scopes (reason would be scope-denied).
test_tenant_mismatch_reported_before_scope if {
	d := authz.decision with input as {"token": tok("t1", []), "request": fhir_read("t2")}
	d.reason == "tenant-mismatch"
}

# Breaks if: equality alone decides tenant match ("" == "" would permit).
test_empty_tenants_on_both_sides_denied if {
	d := authz.decision with input as {"token": tok("", full), "request": fhir_read("")}
	d.allow == false
	d.reason == "invalid-input"
}

# Breaks if: a token with no scopes and no roles is permitted (fail-open default).
test_no_scopes_no_roles_denied if {
	d := authz.decision with input as {"token": {"sub": "u1", "tenant": "t1"}, "request": fhir_read("t1")}
	d.allow == false
	d.reason == "scope-denied"
}

# Breaks if: a read-only scope can create (c letter ignored).
test_read_scope_cannot_create if {
	req := object.union(fhir_read("t1"), {"interaction": "create"})
	d := authz.decision with input as {"token": tok("t1", ["system/Patient.rs"]), "request": req}
	d.allow == false
	d.reason == "scope-denied"
}

# Breaks if: the resource type of the scope is not compared (Observation scope on Patient).
test_scope_for_other_resource_type_denied if {
	d := authz.decision with input as {"token": tok("t1", ["system/Observation.rs"]), "request": fhir_read("t1")}
	d.allow == false
}

test_scope_for_same_resource_type_permitted if {
	d := authz.decision with input as {"token": tok("t1", ["system/Patient.rs"]), "request": fhir_read("t1")}
	d.allow == true
}

# Breaks if: the FHIR wildcard is allowed to cover DICOM (system/*.cruds on a dicom request).
test_fhir_wildcard_does_not_grant_dicom if {
	req := {"service": "dicom", "interaction": "wado", "tenant": "t1", "resource_type": "dicom"}
	d := authz.decision with input as {"token": tok("t1", full), "request": req}
	d.allow == false
	d.reason == "scope-denied"
}

test_explicit_dicom_scope_permits_dicom if {
	req := {"service": "dicom", "interaction": "wado", "tenant": "t1", "resource_type": "dicom"}
	d := authz.decision with input as {"token": tok("t1", ["system/dicom.r"]), "request": req}
	d.allow == true
}

# Breaks if: malformed or granular scopes are honoured (a ?query suffix would be
# stripped and grant the whole type).
test_granular_scope_grants_nothing_in_v1 if {
	d := authz.decision with input as {"token": tok("t1", ["system/Patient.rs?category=vital-signs"]), "request": fhir_read("t1")}
	d.allow == false
}

# Breaks if: a patient-context scope ignores the launch patient (p2 token reading p1).
test_patient_scope_requires_matching_patient if {
	token := {"sub": "u1", "tenant": "t1", "scopes": ["patient/Patient.rs"], "patient": "p2"}
	d := authz.decision with input as {"token": token, "request": fhir_read("t1")}
	d.allow == false
}

test_patient_scope_permits_own_patient if {
	token := {"sub": "u1", "tenant": "t1", "scopes": ["patient/Patient.rs"], "patient": "p1"}
	d := authz.decision with input as {"token": token, "request": fhir_read("t1")}
	d.allow == true
}

# Breaks if: absent request.patient equals absent token.patient ("" / undefined match).
test_patient_scope_without_any_patient_denied if {
	req := {"service": "fhir", "interaction": "read", "tenant": "t1", "resource_type": "Patient"}
	d := authz.decision with input as {"token": {"sub": "u1", "tenant": "t1", "scopes": ["patient/Patient.rs"]}, "request": req}
	d.allow == false
}

# Breaks if: an unknown role grants anything, or role expansion is skipped.
test_unknown_role_denied if {
	d := authz.decision with input as {"token": {"sub": "u1", "tenant": "t1", "roles": ["fhir-god"]}, "request": fhir_read("t1")}
	d.allow == false
}

test_role_union_with_scopes if {
	token := {"sub": "u1", "tenant": "t1", "roles": ["fhir-data-reader"], "scopes": ["system/Patient.c"]}
	create := object.union(fhir_read("t1"), {"interaction": "create"})
	d := authz.decision with input as {"token": token, "request": create}
	d.allow == true
}

# Breaks if: an unmapped interaction is permitted by a wildcard scope.
test_unknown_interaction_denied if {
	req := object.union(fhir_read("t1"), {"interaction": "everything"})
	d := authz.decision with input as {"token": tok("t1", full), "request": req}
	d.allow == false
	d.reason == "unknown-interaction"
}

# Breaks if: the default decision becomes allow (empty input must deny).
test_empty_input_denied if {
	d := authz.decision with input as {}
	d.allow == false
	d.reason == "invalid-input"
}

# Breaks if: a non-string tenant (e.g. number 1 vs "1") sneaks through validation.
test_non_string_tenant_denied if {
	d := authz.decision with input as {"token": {"sub": "u1", "tenant": 1, "scopes": full}, "request": fhir_read("1")}
	d.allow == false
}
