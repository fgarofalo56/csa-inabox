{{- if and (not .Values.hardening.aeEnforce) (not .Values.hardening.allowUnenforced) -}}
{{- fail "hardening.aeEnforce=false requires hardening.allowUnenforced=true (dev stamps only): unknown AE titles would be accepted" -}}
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
      containers:
        - name: arc
          image: {{ .Values.image.archive }}
          imagePullPolicy: {{ .Values.image.pullPolicy }}
          ports:
            - {name: http, containerPort: 8080}
            - {name: hl7, containerPort: 2575}
            {{- if .Values.hardening.dimseEnabled }}
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
    {{- if .Values.hardening.dimseEnabled }}
    - {name: dimse, port: 11112}
    {{- end }}
