// CSA Loom Health Data Services (LHDS) - stamp FHIR edge router (G1, #5410).
//
// The stamp App Gateway (ingress.bicep) forwards every HTTPS request to ONE internal-LB address (network.bicep
// ingressIlbIp, backend pool ingress-ilb, port 80). Before this module nothing in the cluster listened there. This is that
// listener: a Loom-owned OSS nginx (nginx-unprivileged, pinned by digest in edge-router-image.json) behind an INTERNAL
// LoadBalancer Service pinned to that address, routing
//   /{tenant}/fhir/.well-known/smart-configuration -> {issuer}/{tenant}/.well-known/smart-configuration (the AS)
//   /{tenant}/fhir[/...]                           -> http://fhir-{tenant}.<engine ns>.svc.cluster.local:80/fhir[/...]
// Not ingress-nginx and not the AKS app-routing add-on (operator decision 2026-11-25: managed NGINX loses Azure support in
// Nov 2026; the Gateway API add-on needs an AKS API bump and its Gov availability is undocumented).
//
// NO AUTHORIZATION happens in the router. The tenant boundary is the engine's PDP interceptor (bearer token passed through).
//
// DELIVERY is the PDP's (engines.bicep): this module deploys NO Kubernetes object itself. Its output `manifest` is the single
// source of truth for the YAML, applied by .github/workflows/deploy-health.yml with scripts/csa-loom/aks-apply-manifest.sh.
// It creates no ARM resource either: the kubelet AcrPull on the hub registry and the applier's Cluster Admin data role are
// both granted by engines.bicep, and health.bicep deploys this module only together with the PDP (edgeDeploy == pdpDeploy).
//
// Every deploy-time value is READ from the deployed stamp, not re-derived: the ILB address, the node subnet and the backend
// timeout from the App Gateway / cluster that the stamp created, the WAF upload cap from the WAF policy, and the resolver from
// the cluster's dnsServiceIP. So a re-addressed stamp cannot leave the router listening on a stale address.

targetScope = 'resourceGroup'

@description('Name of the stamp cluster (same resource group).')
param aksClusterName string

@description('Name of the stamp Application Gateway (same resource group); its ingress-ilb pool names the address this router must hold.')
param gatewayName string

@description('Name of the stamp WAF policy (same resource group); its file-upload limit is the router body cap.')
param wafPolicyName string

@description('Public FQDN of the stamp ingress. Discovery is NOT proxied when the issuer is this same host (it would loop through the gateway).')
param stampIngressFqdn string

@description('Public https issuer URL of the LHDS authorization server (for example https://<front door host>/auth). SMART discovery is proxied to <issuer>/<tenant>/.well-known/smart-configuration.')
param issuerUrl string

@description('Full image reference pinned BY DIGEST (<acr>/<repo>@sha256:<64 hex>).')
param image string

@description('Namespace of the tenant FHIR engines (fhir-engine-host.ts ENGINE_NAMESPACE).')
param engineNamespace string = 'loom-health'

@description('Router replicas.')
@minValue(1)
param replicas int = 2

// The namespace and pod label the control plane admits on every engine NetworkPolicy (fhir-engine-host.ts EDGE_NAMESPACE /
// EDGE_APP_LABEL). Changing one side without the other drops every edge request at the engine; the CI test pins both.
var edgeNamespace = 'loom-health-edge'
var edgeAppLabel = 'loom-health-edge'
var name = 'loom-health-edge'
var containerPort = 8080
// fhirNames(slug).workloadName = 'fhir-' + slug; the engine Service listens on SERVICE_PORT 80 (fhir-engine-host.ts) and the
// engine pod on ENGINE_PORT 8080, which is the port NetworkPolicy sees.
var enginePrefix = 'fhir-'
var engineServicePort = 80
var enginePodPort = 8080

resource cluster 'Microsoft.ContainerService/managedClusters@2025-04-01' existing = {
  name: aksClusterName
}

resource gateway 'Microsoft.Network/applicationGateways@2024-05-01' existing = {
  name: gatewayName
}

resource wafPolicy 'Microsoft.Network/ApplicationGatewayWebApplicationFirewallPolicies@2024-05-01' existing = {
  name: wafPolicyName
}

var ilbIp = string(gateway.properties.backendAddressPools[0].properties.backendAddresses[0].ipAddress)
var requestTimeoutSeconds = int(gateway.properties.backendHttpSettingsCollection[0].properties.requestTimeout)
var maxBodyMb = int(wafPolicy.properties.policySettings.fileUploadLimitInMb)
var dnsServiceIp = string(cluster.properties.networkProfile.dnsServiceIP)
var nodeSubnetName = last(split(string(cluster.properties.agentPoolProfiles[0].vnetSubnetID), '/'))

// Issuer host/path. A trailing slash is trimmed (replace() is literal, not a regex).
var issuerTrimmed = endsWith(issuerUrl, '/') ? take(issuerUrl, max(length(issuerUrl) - 1, 0)) : issuerUrl
var issuerIsHttps = startsWith(issuerTrimmed, 'https://')
var issuerRest = issuerIsHttps ? substring(issuerTrimmed, length('https://')) : ''
var issuerHost = issuerIsHttps ? split(issuerRest, '/')[0] : ''
var issuerPath = issuerIsHttps ? substring(issuerRest, length(issuerHost)) : ''
var discoveryProxied = issuerIsHttps && !empty(issuerHost) && toLower(issuerHost) != toLower(stampIngressFqdn)

var nginxTemplate = replace(loadTextContent('edge-router-nginx.conf'), '\r', '')
var nginxConf = replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(nginxTemplate,
  '__RESOLVER__', dnsServiceIp),
  '__MAX_BODY_MB__', string(maxBodyMb)),
  '__TIMEOUT_S__', string(requestTimeoutSeconds)),
  '__PORT__', string(containerPort)),
  '__DISCOVERY_ENABLED__', discoveryProxied ? '1' : '0'),
  '__ISSUER_HOST__', discoveryProxied ? issuerHost : 'issuer.invalid'),
  '__ISSUER_PATH__', discoveryProxied ? issuerPath : ''),
  '__ENGINE_PREFIX__', enginePrefix),
  '__ENGINE_NS__', engineNamespace),
  '__ENGINE_SERVICE_PORT__', string(engineServicePort))

var manifest = join([
  'apiVersion: v1'
  'kind: Namespace'
  'metadata:'
  '  name: ${edgeNamespace}'
  '---'
  'apiVersion: v1'
  'kind: ConfigMap'
  'metadata:'
  '  name: ${name}-config'
  '  namespace: ${edgeNamespace}'
  'data:'
  '  nginx.conf: |'
  '    ${replace(nginxConf, '\n', '\n    ')}'
  '---'
  'apiVersion: apps/v1'
  'kind: Deployment'
  'metadata:'
  '  name: ${name}'
  '  namespace: ${edgeNamespace}'
  '  labels:'
  '    app: ${edgeAppLabel}'
  'spec:'
  '  replicas: ${replicas}'
  '  selector:'
  '    matchLabels:'
  '      app: ${edgeAppLabel}'
  '  template:'
  '    metadata:'
  '      labels:'
  '        app: ${edgeAppLabel}'
  '      annotations:'
  // A config change rolls the pods (nginx reads its config at start only).
  '        loom.health/config-hash: "${uniqueString(nginxConf)}"'
  '    spec:'
  '      automountServiceAccountToken: false'
  '      securityContext:'
  '        runAsNonRoot: true'
  '        runAsUser: 101'
  '        runAsGroup: 101'
  '        seccompProfile:'
  '          type: RuntimeDefault'
  '      affinity:'
  '        podAntiAffinity:'
  '          preferredDuringSchedulingIgnoredDuringExecution:'
  '            - weight: 100'
  '              podAffinityTerm:'
  '                topologyKey: kubernetes.io/hostname'
  '                labelSelector:'
  '                  matchLabels:'
  '                    app: ${edgeAppLabel}'
  '      containers:'
  '        - name: nginx'
  '          image: ${image}'
  // The image entrypoint scripts rewrite files under /etc/nginx; with a read-only root they are skipped by running nginx directly.
  '          command: ["nginx", "-g", "daemon off;"]'
  '          ports:'
  '            - name: http'
  '              containerPort: ${containerPort}'
  '          resources:'
  '            requests: { cpu: 100m, memory: 64Mi }'
  '            limits: { cpu: 500m, memory: 256Mi }'
  '          securityContext:'
  '            allowPrivilegeEscalation: false'
  '            readOnlyRootFilesystem: true'
  '            capabilities: { drop: ["ALL"] }'
  '          volumeMounts:'
  '            - { name: config, mountPath: /etc/nginx/nginx.conf, subPath: nginx.conf, readOnly: true }'
  '            - { name: tmp, mountPath: /tmp }'
  '          readinessProbe:'
  '            httpGet: { path: /healthz, port: ${containerPort} }'
  '            periodSeconds: 5'
  '          livenessProbe:'
  '            httpGet: { path: /healthz, port: ${containerPort} }'
  '            initialDelaySeconds: 5'
  '            periodSeconds: 15'
  '      volumes:'
  '        - name: config'
  '          configMap: { name: ${name}-config }'
  '        - name: tmp'
  '          emptyDir: {}'
  '---'
  'apiVersion: policy/v1'
  'kind: PodDisruptionBudget'
  'metadata:'
  '  name: ${name}'
  '  namespace: ${edgeNamespace}'
  'spec:'
  '  maxUnavailable: 1'
  '  selector:'
  '    matchLabels:'
  '      app: ${edgeAppLabel}'
  '---'
  // INTERNAL load balancer on the App Gateway's backend address, in the node subnet (the cluster identity holds Network
  // Contributor on the stamp VNet, aks.bicep vnetRole, which covers the subnet join).
  'apiVersion: v1'
  'kind: Service'
  'metadata:'
  '  name: ${name}'
  '  namespace: ${edgeNamespace}'
  '  annotations:'
  '    service.beta.kubernetes.io/azure-load-balancer-internal: "true"'
  '    service.beta.kubernetes.io/azure-load-balancer-ipv4: "${ilbIp}"'
  '    service.beta.kubernetes.io/azure-load-balancer-internal-subnet: "${nodeSubnetName}"'
  'spec:'
  '  type: LoadBalancer'
  '  selector:'
  '    app: ${edgeAppLabel}'
  '  ports:'
  '    - name: http'
  '      port: 80'
  '      targetPort: http'
  '---'
  // Ingress: the router port only, from any source (the App Gateway reaches it through the internal LB, whose source address
  // the node may SNAT, so a source CIDR would be a guess). Egress: cluster DNS, the tenant engine pods, and 443 for the issuer.
  // Port 443 cannot be narrowed to the issuer FQDN with a Kubernetes NetworkPolicy (that needs Cilium FQDN policy, ACNS, paid);
  // in firewall egress mode the stamp firewall allow-list is the FQDN control (health.bicep extraAllowedFqdns).
  'apiVersion: networking.k8s.io/v1'
  'kind: NetworkPolicy'
  'metadata:'
  '  name: ${name}'
  '  namespace: ${edgeNamespace}'
  'spec:'
  '  podSelector:'
  '    matchLabels:'
  '      app: ${edgeAppLabel}'
  '  policyTypes: ["Ingress", "Egress"]'
  '  ingress:'
  '    - ports:'
  '        - { protocol: TCP, port: ${containerPort} }'
  '  egress:'
  '    - to:'
  '        - namespaceSelector: { matchLabels: { kubernetes.io/metadata.name: kube-system } }'
  '          podSelector: { matchLabels: { k8s-app: kube-dns } }'
  '      ports:'
  '        - { protocol: UDP, port: 53 }'
  '        - { protocol: TCP, port: 53 }'
  '    - to:'
  '        - namespaceSelector: { matchLabels: { kubernetes.io/metadata.name: ${engineNamespace} } }'
  '          podSelector: { matchExpressions: [{ key: loom.health/tenant, operator: Exists }] }'
  '      ports:'
  '        - { protocol: TCP, port: ${enginePodPort} }'
  '    - to:'
  '        - ipBlock: { cidr: 0.0.0.0/0 }'
  '      ports:'
  '        - { protocol: TCP, port: 443 }'
], '\n')

@description('The rendered Kubernetes manifest (Namespace, ConfigMap, Deployment, PodDisruptionBudget, Service, NetworkPolicy). No secret material. Applied by the deploy workflow.')
output manifest string = manifest

@description('Kubernetes namespace of the router.')
output namespace string = edgeNamespace

@description('Name of the router Deployment (and Service).')
output deploymentName string = name

@description('Internal LB address the router Service requests (read from the App Gateway backend pool).')
output ilbIp string = ilbIp

@description('Whether SMART discovery is proxied to the issuer (false when the issuer is not https or is the stamp ingress itself).')
output discoveryProxied bool = discoveryProxied

@description('Issuer host discovery is proxied to (empty when not proxied).')
output issuerHost string = discoveryProxied ? issuerHost : ''
