{{- /* toString: a quoted "false" is a truthy string to Go templates, but harden.sh receives it as false. */ -}}
{{- if and (ne (toString .Values.hardening.aeEnforce) "true") (ne (toString .Values.hardening.allowUnenforced) "true") -}}
{{- fail "hardening.aeEnforce is not true: that requires hardening.allowUnenforced=true (dev stamps only): unknown AE titles would be accepted" -}}
{{- end -}}
{{- if and (eq (toString .Values.hardening.dimseEnabled) "true") (ne (toString .Values.hardening.allowDimse) "true") -}}
{{- fail "hardening.dimseEnabled=true requires hardening.allowDimse=true: it opens the DICOM association listener (11112)" -}}
{{- end -}}
apiVersion: v1
kind: Service
metadata:
  name: {{ include "lhd.name" . }}-ldap
  labels: {{- include "lhd.labels" . | nindent 4 }}
spec:
  clusterIP: None
  selector: {app: {{ include "lhd.name" . }}-ldap}
  ports: [{name: ldap, port: 389}]
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: {{ include "lhd.name" . }}-ldap
  labels: {{- include "lhd.labels" . | nindent 4 }}
spec:
  serviceName: {{ include "lhd.name" . }}-ldap
  replicas: 1
  selector: {matchLabels: {app: {{ include "lhd.name" . }}-ldap}}
  template:
    metadata: {labels: {app: {{ include "lhd.name" . }}-ldap}}
    spec:
      containers:
        - name: ldap
          image: {{ .Values.image.ldap }}
          imagePullPolicy: {{ .Values.image.pullPolicy }}
          ports: [{containerPort: 389}]
          env:
            - name: LDAP_ROOTPASS
              valueFrom: {secretKeyRef: {name: {{ .Values.secrets.ldap }}, key: rootpass}}
          readinessProbe: {tcpSocket: {port: 389}, periodSeconds: 5}
          resources: {{- toYaml .Values.ldap.resources | nindent 12 }}
          volumeMounts:
            - {name: data, mountPath: /var/lib/openldap/openldap-data}
            - {name: conf, mountPath: /etc/openldap/slapd.d}
  volumeClaimTemplates:
    - {metadata: {name: data}, spec: {accessModes: [ReadWriteOnce], resources: {requests: {storage: {{ .Values.ldap.dataStorage }}}}}}
    - {metadata: {name: conf}, spec: {accessModes: [ReadWriteOnce], resources: {requests: {storage: {{ .Values.ldap.configStorage }}}}}}
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: {{ include "lhd.name" . }}-storage
  labels: {{- include "lhd.labels" . | nindent 4 }}
spec: {accessModes: [ReadWriteOnce], resources: {requests: {storage: {{ .Values.archive.storage }}}}}
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ include "lhd.name" . }}
  labels: {{- include "lhd.labels" . | nindent 4 }}
spec:
  replicas: 1
  strategy: {type: Recreate}
  selector: {matchLabels: {app: {{ include "lhd.name" . }}}}
  template:
    metadata: {labels: {app: {{ include "lhd.name" . }}}}
    spec:
      initContainers:
        # Applies the hardened defaults to the LDAP config store BEFORE the archive boots, so the
        # archive never runs with the image's accept-anything defaults. Fails the pod on a
        # read-back mismatch (ldap/harden.sh).
        - name: harden
          image: {{ .Values.image.ldap }}
          imagePullPolicy: {{ .Values.image.pullPolicy }}
          command: [sh, /opt/loom/harden.sh]
          env: {{- include "lhd.hardenEnv" . | nindent 12 }}
          securityContext:
            allowPrivilegeEscalation: false
            privileged: false
            capabilities: {drop: [ALL]}
            seccompProfile: {type: RuntimeDefault}
          resources:
            requests: {cpu: 50m, memory: 64Mi}
            limits: {memory: 128Mi}
      containers:
        - name: arc
          image: {{ .Values.image.archive }}
          imagePullPolicy: {{ .Values.image.pullPolicy }}
          ports:
            - {name: http, containerPort: 8080}
            - {name: hl7, containerPort: 2575}
            {{- if eq (toString .Values.hardening.dimseEnabled) "true" }}
            - {name: dimse, containerPort: 11112}
            {{- end }}
          env:
            - {name: POSTGRES_HOST, value: {{ .Values.postgres.host | quote }}}
            - {name: POSTGRES_DB, value: {{ .Values.postgres.database | quote }}}
            - {name: POSTGRES_JDBC_PARAMS, value: {{ .Values.postgres.jdbcParams | quote }}}
            - name: POSTGRES_USER
              valueFrom: {secretKeyRef: {name: {{ .Values.secrets.postgres }}, key: username}}
            - name: POSTGRES_PASSWORD
              valueFrom: {secretKeyRef: {name: {{ .Values.secrets.postgres }}, key: password}}
            - {name: LDAP_URL, value: "ldap://{{ include "lhd.name" . }}-ldap:389"}
            - name: LDAP_ROOTPASS
              valueFrom: {secretKeyRef: {name: {{ .Values.secrets.ldap }}, key: rootpass}}
            - {name: WILDFLY_CHOWN, value: "/opt/wildfly/standalone /storage"}
            - {name: WILDFLY_WAIT_FOR, value: "{{ include "lhd.name" . }}-ldap:389 {{ .Values.postgres.host }}:5432"}
            - {name: JAVA_OPTS, value: {{ .Values.archive.javaOpts | quote }}}
          readinessProbe:
            httpGet: {path: /dcm4chee-arc/aets/{{ .Values.hardening.aeTitle }}/rs/instances/count, port: 8080}
            initialDelaySeconds: 30
            periodSeconds: 10
            failureThreshold: 60
          resources: {{- toYaml .Values.archive.resources | nindent 12 }}
          volumeMounts:
            - {name: storage, mountPath: /storage}
      volumes:
        - name: storage
          persistentVolumeClaim: {claimName: {{ include "lhd.name" . }}-storage}
---
apiVersion: v1
kind: Service
metadata:
  name: {{ include "lhd.name" . }}
  labels: {{- include "lhd.labels" . | nindent 4 }}
spec:
  selector: {app: {{ include "lhd.name" . }}}
  ports:
    - {name: http, port: 8080}
    - {name: hl7, port: 2575}
    {{- if eq (toString .Values.hardening.dimseEnabled) "true" }}
    - {name: dimse, port: 11112}
    {{- end }}
---
# Default-deny ingress for the archive pods, then allow only the gateway. kubelet probes are
# node-local and not subject to this on conformant CNIs.
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: {{ include "lhd.name" . }}-ingress
  labels: {{- include "lhd.labels" . | nindent 4 }}
spec:
  podSelector: {matchLabels: {app: {{ include "lhd.name" . }}}}
  policyTypes: [Ingress]
  ingress:
    - from:
        - podSelector:
            matchLabels: {{- toYaml .Values.networkPolicy.gatewayPodLabels | nindent 14 }}
      ports:
        - {protocol: TCP, port: 8080}
        {{- if eq (toString .Values.networkPolicy.hl7Enabled) "true" }}
        - {protocol: TCP, port: 2575}
        {{- end }}
        {{- if eq (toString .Values.hardening.dimseEnabled) "true" }}
        - {protocol: TCP, port: 11112}
        {{- end }}
---
# The LDAP config store accepts connections from the archive pod only (this includes the harden
# initContainer, same pod).
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: {{ include "lhd.name" . }}-ldap-ingress
  labels: {{- include "lhd.labels" . | nindent 4 }}
spec:
  podSelector: {matchLabels: {app: {{ include "lhd.name" . }}-ldap}}
  policyTypes: [Ingress]
  ingress:
    - from:
        - podSelector: {matchLabels: {app: {{ include "lhd.name" . }}}}
      ports:
        - {protocol: TCP, port: 389}
