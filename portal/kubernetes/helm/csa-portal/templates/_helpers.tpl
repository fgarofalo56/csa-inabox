{{/* Expand the name of the chart */}}
{{- define "csa-portal.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/* Create a default fully qualified app name */}}
{{- define "csa-portal.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}

{{/* Common labels */}}
{{- define "csa-portal.labels" -}}
helm.sh/chart: {{ include "csa-portal.name" . }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: csa-inabox
{{- end }}

{{/* Frontend labels */}}
{{- define "csa-portal.frontend.labels" -}}
{{ include "csa-portal.labels" . }}
app.kubernetes.io/name: {{ include "csa-portal.name" . }}-frontend
app.kubernetes.io/component: frontend
{{- end }}

{{/* Backend labels */}}
{{- define "csa-portal.backend.labels" -}}
{{ include "csa-portal.labels" . }}
app.kubernetes.io/name: {{ include "csa-portal.name" . }}-backend
app.kubernetes.io/component: backend
{{- end }}
