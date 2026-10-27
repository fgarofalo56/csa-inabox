# Hand-written deny-rule tests over REAL signed tokens (tests/jwt_fixtures.rego).
# Every deny is paired with a permit control (same request, one variable changed),
# and each test names the input that breaks it. Scope-letter/role matrices are in
# the generated scope_matrix_test.rego.
package lhds.authz_test

import rego.v1

import data.lhds.authz
import data.lhds.fixtures as fx

cfg := {"issuer": fx.issuer, "jwks": fx.jwks}

stamp := {"tenants": {"visn-01": {"bases": [fx.fhir_base, fx.dicom_base]}}}

rq(over) := object.union({
	"service": "fhir", "interaction": "read", "tenant": "visn-01",
	"base": fx.fhir_base, "resource_type": "Observation",
}, over)

dec(tok, request) := d if {
	d := authz.decision with input as {"access_token": tok, "request": request}
		with data.lhds.authz.now as fx.now
		with data.lhds.config as cfg
		with data.lhds.stamp as stamp
}

# Deny with `reason` for `bad`, while `control` permits the SAME request.
denied(bad, control, request, reason) if {
	d := dec(fx.tokens[bad], request)
	d.allow == false
	d.reason == reason
	c := dec(fx.tokens[control], request)
	c.allow == true
	c.reason == "permit"
}

# Baseline: breaks if the valid fixture stops permitting (every pair below would
# then be vacuous: deny for the wrong reason).
test_valid_token_permits if {
	d := dec(fx.tokens.valid, rq({}))
	d.allow == true
	d.reason == "permit"
	d.policy_version == "lhds-scope-map/1"
}

# --- token verification -------------------------------------------------------
# Breaks if: signature verification is skipped (token signed by another key).
test_bad_signature_denied if denied("bad_signature", "valid", rq({}), "token-invalid")

# Breaks if: alg none is accepted.
test_alg_none_denied if denied("alg_none", "valid", rq({}), "token-invalid")

# Breaks if: the header alg is not pinned to ES384.
test_header_alg_not_es384_denied if denied("header_alg_es256", "valid", rq({}), "token-invalid")

# Breaks if: typ is not required to be at+jwt.
test_typ_jwt_denied if denied("typ_jwt", "valid", rq({}), "token-invalid")

# Breaks if: a non-string / absent token is not rejected up front.
test_missing_access_token_denied if {
	d := authz.decision with input as {"request": rq({})}
		with data.lhds.config as cfg
		with data.lhds.stamp as stamp
	d.allow == false
	d.reason == "invalid-input"
}

# --- claims contract lhds-at/1 ---------------------------------------------------
# Breaks if: any missing claim defaults to permit. One token per required claim.
test_each_missing_claim_denied if {
	every k in ["iss", "aud", "exp", "iat", "jti", "lhds_ver", "tenant", "sub", "sub_type", "client_id", "scope", "lhds_roles", "lhds_map_ver", "pou"] {
		denied(concat("", ["missing_", k]), "valid", rq({}), "claims-invalid")
	}
}

# Breaks if: a user token without idp_tid is accepted.
test_user_without_idp_tid_denied if denied("user_no_idp_tid", "valid", rq({}), "claims-invalid")

# Breaks if: sub_type outside user|system is accepted.
test_unknown_sub_type_denied if denied("sub_type_service", "valid", rq({}), "claims-invalid")

# Breaks if: aud as an array is accepted (single string required).
test_aud_array_denied if denied("aud_array", "valid", rq({}), "claims-invalid")

# Breaks if: a W1 token may carry purpose of use BTG.
test_pou_btg_denied if denied("pou_btg", "valid", rq({}), "claims-invalid")

# Breaks if: a non-slug tenant claim (uppercase) passes the slug pattern.
test_tenant_claim_must_be_slug if denied("tenant_uppercase", "valid", rq({}), "claims-invalid")

# Breaks if: any lhds_ver other than lhds-at/1 is tolerated.
test_wrong_version_denied if denied("ver_2", "valid", rq({}), "version-unsupported")

# Breaks if: act is ignored.
test_act_claim_denied if denied("act_present", "valid", rq({}), "reserved-claim")

# Breaks if: cnf is ignored (reserved for DPoP, not issued in W1).
test_cnf_claim_denied if denied("cnf_present", "valid", rq({}), "reserved-claim")

# Breaks if: iss is not pinned; an Entra issuer must be refused even when signed validly.
test_entra_issuer_denied if denied("iss_entra", "valid", rq({}), "issuer-mismatch")

# Breaks if: exp is not enforced (exp = now - 1).
test_expired_denied if denied("expired", "valid", rq({}), "token-time-invalid")

# Breaks if: iat in the future beyond 60 s skew is tolerated (iat = now + 61).
test_iat_future_denied if denied("iat_future", "valid", rq({}), "token-time-invalid")

# Breaks if: lifetime above 300 s is tolerated (exp - iat = 301).
test_lifetime_301_denied if denied("lifetime_301", "valid", rq({}), "token-time-invalid")

# --- tenant match (A8) ------------------------------------------------------------
# Breaks if: the PDP takes the tenant from the token alone (token visn-01, URL visn-02).
# Pair: same token, only the request tenant differs.
test_cross_tenant_denied if {
	d := dec(fx.tokens.valid, rq({"tenant": "visn-02"}))
	d.allow == false
	d.reason == "tenant-mismatch"
	dec(fx.tokens.valid, rq({"tenant": "visn-01"})).allow == true
}

# Breaks if: the tenant comparison case-folds (token visn-01 vs request Visn-01).
test_tenant_case_not_folded if {
	d := dec(fx.tokens.valid, rq({"tenant": "Visn-01"}))
	d.allow == false
	d.reason == "tenant-mismatch"
	dec(fx.tokens.valid, rq({"tenant": "visn-01"})).allow == true
}

# Breaks if: a trailing space on the request tenant is trimmed.
test_tenant_not_trimmed if {
	d := dec(fx.tokens.valid, rq({"tenant": "visn-01 "}))
	d.allow == false
	d.reason == "tenant-mismatch"
	# permit control: same token, exact tenant. Without it a deny for any other reason passes.
	c := dec(fx.tokens.valid, rq({"tenant": "visn-01"}))
	c.allow == true
	c.reason == "permit"
}

# Breaks if: T3 is skipped (token and request agree on visn-09, not homed here).
test_tenant_not_on_stamp_denied if {
	req := rq({"tenant": "visn-09", "base": "https://visn-09.health.example.test/fhir"})
	d := dec(fx.tokens.tenant_off_stamp, req)
	d.allow == false
	d.reason == "tenant-not-on-stamp"
	dec(fx.tokens.valid, rq({})).allow == true
}

# Breaks if: aud is not compared to the request base (token for FHIR base, request to DICOMweb base).
test_aud_other_base_denied if {
	req := rq({"base": fx.dicom_base})
	d := dec(fx.tokens.aud_other_base, rq({}))
	d.allow == false
	d.reason == "audience-mismatch"
	dec(fx.tokens.valid, rq({})).allow == true
	dec(fx.tokens.valid, req).reason == "audience-mismatch"
}

# Breaks if: aud == request base alone suffices (base not in the tenant's stamp bases).
test_aud_unknown_base_denied if {
	req := rq({"base": "https://evil.example.test/fhir"})
	d := dec(fx.tokens.aud_unknown_base, req)
	d.allow == false
	d.reason == "audience-mismatch"
	dec(fx.tokens.valid, rq({})).allow == true
}

# --- per-stamp bundle data (published by the control plane) ----------------------------
# A configured stamp permits; the SAME request against a bundle lacking the per-stamp
# data denies. Breaks if: absent data.lhds.config stops denying with token-invalid (a
# token would verify without the AS key), or absent data.lhds.stamp stops denying with
# tenant-not-on-stamp (a tenant would count as homed with no stamp map).
test_unconfigured_stamp_denies_configured_permits if {
	req := rq({})
	dec(fx.tokens.valid, req).allow == true
	no_cfg := authz.decision with input as {"access_token": fx.tokens.valid, "request": req}
		with data.lhds.authz.now as fx.now
		with data.lhds.stamp as stamp
	no_cfg.allow == false
	no_cfg.reason == "token-invalid"
	no_stamp := authz.decision with input as {"access_token": fx.tokens.valid, "request": req}
		with data.lhds.authz.now as fx.now
		with data.lhds.config as cfg
	no_stamp.allow == false
	no_stamp.reason == "tenant-not-on-stamp"
}

# --- scopes -------------------------------------------------------------------------
# Breaks if: a patient/ scope is honoured without the patient claim (N21).
test_patient_scope_without_patient_claim_denied if {
	req := rq({"patient_compartment": ["p1"]})
	d := dec(fx.tokens.patient_scope_no_patient, req)
	d.allow == false
	d.reason == "scope-denied"
	dec(fx.tokens.patient_scope_with_patient, req).allow == true
}

# Breaks if: the compartment is not checked (N2: another patient's Observation).
test_patient_scope_other_patient_denied if {
	d := dec(fx.tokens.patient_scope_with_patient, rq({"patient_compartment": ["p2"]}))
	d.allow == false
	dec(fx.tokens.patient_scope_with_patient, rq({"patient_compartment": ["p1"]})).allow == true
}

# Breaks if: an unbound search is allowed or filtered silently (N3): no compartment.
test_patient_scope_unbound_search_denied if {
	d := dec(fx.tokens.patient_scope_with_patient, rq({"interaction": "search"}))
	d.allow == false
	b := dec(fx.tokens.patient_scope_with_patient, rq({"interaction": "search", "patient_compartment": ["p1"]}))
	b.allow == true
}

# Breaks if: a multi-owner target is permitted when only one owner is the token patient.
test_patient_scope_mixed_owners_denied if {
	d := dec(fx.tokens.patient_scope_with_patient, rq({"patient_compartment": ["p1", "p2"]}))
	d.allow == false
}

# Breaks if: sub_type is ignored (system/ scope on a user token).
test_system_scope_on_user_token_denied if {
	d := dec(fx.tokens.system_scope_on_user_token, rq({}))
	d.allow == false
	d.reason == "scope-denied"
}

# Breaks if: user/ scope honoured on a system token.
test_user_scope_on_system_token_denied if {
	d := dec(fx.tokens.user_scope_on_system_token, rq({}))
	d.allow == false
	d.reason == "scope-denied"
}

# Breaks if: out-of-order letters are accepted (N6: user/Observation.sr).
test_out_of_order_scope_ignored if {
	d := dec(fx.tokens.scope_out_of_order, rq({}))
	d.allow == false
	d.reason == "scope-denied"
	dec(fx.tokens.valid, rq({})).allow == true
}

# Breaks if: an unsupported constraint (?code=) is stripped and widens the scope (N8).
test_unsupported_constraint_ignored if {
	d := dec(fx.tokens.scope_unsupported_constraint, rq({}))
	d.allow == false
	d.reason == "scope-denied"
	# permit control: same request, plain Observation.rs token. Without it a deny
	# for a non-scope reason (or a broken request) would pass.
	c := dec(fx.tokens.valid, rq({}))
	c.allow == true
	c.reason == "permit"
}

# Breaks if: a constraint on a wildcard type is accepted.
test_wildcard_with_constraint_ignored if {
	d := dec(fx.tokens.scope_wildcard_constraint, rq({}))
	d.allow == false
	d.reason == "scope-denied"
	c := dec(fx.tokens.valid, rq({}))
	c.allow == true
	c.reason == "permit"
}

# Breaks if: the category constraint is dropped (N7): vital-signs read under a laboratory scope.
test_category_constraint_enforced if {
	vital := rq({"categories": ["vital-signs"]})
	lab := rq({"categories": ["laboratory"]})
	dec(fx.tokens.scope_category_lab, vital).allow == false
	dec(fx.tokens.scope_category_lab, rq({})).allow == false
	dec(fx.tokens.scope_category_lab, lab).allow == true
}

# Breaks if: the wildcard type also wildcards the letters (N22): create under *.rs... here
# user/*.cruds permits create, a reader token must not.
test_letters_not_widened_by_wildcard_type if {
	create := rq({"interaction": "create"})
	dec(fx.tokens.scope_wildcard_cruds, create).allow == true
	dec(fx.tokens.valid, create).allow == false
}

# Breaks if: an empty scope string is treated as a grant.
test_empty_scope_grants_nothing if {
	d := dec(fx.tokens.scope_empty, rq({}))
	d.allow == false
	d.reason == "scope-denied"
}

# Breaks if: an unmapped interaction is permitted by a wildcard scope.
test_unknown_interaction_denied if {
	d := dec(fx.tokens.scope_wildcard_cruds, rq({"interaction": "everything"}))
	d.allow == false
	d.reason == "unknown-interaction"
}

# --- role-gated operations -----------------------------------------------------------
export := {"interaction": "operation", "op": "$export", "resource_type": "Patient"}

# Breaks if: the role gate is skipped ($export with no fhir-data-exporter role).
test_export_requires_role if {
	d := dec(fx.tokens.system_no_role, rq(export))
	d.allow == false
	d.reason == "role-denied"
	dec(fx.tokens.system_exporter, rq(export)).allow == true
}

# Breaks if: a role alone suffices without any data scope.
test_export_requires_a_data_scope if {
	d := dec(fx.tokens.system_exporter_no_scope, rq(export))
	d.allow == false
	dec(fx.tokens.system_exporter, rq(export)).allow == true
}

# Breaks if: a held role grants operations it does not list ($import with the exporter role).
test_exporter_cannot_import if {
	dec(fx.tokens.system_exporter, rq(object.union(export, {"op": "$import"}))).allow == false
}

# Breaks if: an operation request without an op is permitted.
test_operation_without_op_denied if {
	d := dec(fx.tokens.system_exporter, rq({"interaction": "operation"}))
	d.allow == false
	d.reason == "unknown-interaction"
}

# Breaks if: DICOM is scope-based (a wildcard FHIR scope must not grant DICOM) or the
# owner/reader distinction is lost (reader may not STOW).
test_dicom_roles if {
	wado := {"service": "dicom", "interaction": "wado", "tenant": "visn-01", "base": fx.dicom_base}
	stow := object.union(wado, {"interaction": "stow"})
	dec(fx.tokens.dicom_reader, wado).allow == true
	dec(fx.tokens.dicom_reader, stow).allow == false
	dec(fx.tokens.dicom_owner, stow).allow == true
	dec(fx.tokens.dicom_reader, stow).reason == "role-denied"
}

# Breaks if: FHIR wildcard scope grants DICOM (valid fixture holds no dicom role).
test_fhir_scope_does_not_grant_dicom if {
	wado := {"service": "dicom", "interaction": "wado", "tenant": "visn-01", "base": fx.fhir_base}
	d := dec(fx.tokens.scope_wildcard_cruds, wado)
	d.allow == false
}

# Breaks if: the default decision becomes allow (empty input must deny).
test_empty_input_denied if {
	d := authz.decision with input as {}
	d.allow == false
	d.reason == "invalid-input"
}
