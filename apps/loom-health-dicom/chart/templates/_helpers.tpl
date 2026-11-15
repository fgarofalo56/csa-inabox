{{- define "lhd.name" -}}loom-health-dicom{{- end -}}
{{- define "lhd.labels" -}}
app.kubernetes.io/name: {{ include "lhd.name" . }}
app.kubernetes.io/part-of: loom-health
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end -}}
{{- define "lhd.hardenEnv" -}}
- {name: LDAP_URL, value: "ldap://{{ include "lhd.name" . }}-ldap:389"}
- name: LDAP_ROOTPASS
  valueFrom: {secretKeyRef: {name: {{ .Values.secrets.ldap }}, key: rootpass}}
- {name: AE_ENFORCE, value: {{ .Values.hardening.aeEnforce | quote }}}
- {name: AE_TITLE, value: {{ .Values.hardening.aeTitle | quote }}}
- {name: AE_ALLOWED_CALLING, value: {{ join "," .Values.hardening.aeAllowedCalling | quote }}}
- {name: HL7_AUTH, value: {{ .Values.hardening.hl7Auth | quote }}}
- {name: HL7_ALLOWED_SENDING, value: {{ join "," .Values.hardening.hl7AllowedSending | quote }}}
- {name: DIMSE_ENABLED, value: {{ .Values.hardening.dimseEnabled | quote }}}
{{- end -}}
