/**
 * LHDS G1 (#5410): the stamp FHIR edge router (platform/fiab/bicep/modules/health/edge-router.bicep + edge-router-nginx.conf).
 *
 * Defect (measured 2026-11-24): the stamp App Gateway forwards every request to the internal-LB address network.bicep reserves
 * (ingressIlbIp), and NOTHING in the cluster listened there, so https://<stamp ingress>/{tenant}/fhir/* reached an empty ILB.
 *
 * Methods, stated. (1) Compile the bicep with `az bicep build` (a missing `az` FAILS the suite) and read the ARM + the source.
 * (2) Parse the nginx template and test its location regexes against real sample paths in JS (the patterns are PCRE that JS
 * reads identically: named groups, character classes, bounded repeats). (3) OPT-IN (LHDS_EDGE_DOCKER=1, needs docker and a
 * Docker Hub pull): render the template, `nginx -t` it in the PINNED image, and curl it against a stub engine. The opt-in arm
 * is local evidence; CI runs (1) and (2) only, and nothing here proves a live route: that is "merged, not deployed" until
 * deploy-health has applied it and a request through the stamp ingress has been read back.
 *
 * Each test names the value that breaks it (assertion-design.md). LHDS_REPO_ROOT points the suite at a sandbox copy for
 * mutation runs.
 *
 * Run: node --test scripts/ci/__tests__/lhds-edge-router.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = process.env.LHDS_REPO_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const BICEP = 'platform/fiab/bicep';
const MOD = `${BICEP}/modules/health/edge-router.bicep`;
const CONF = `${BICEP}/modules/health/edge-router-nginx.conf`;
const SPEC = `${BICEP}/modules/health/edge-router-image.json`;
const CP_HOST = 'apps/loom-health-cp/src/jobs/fhir-engine-host.ts';
const CP_CONFIG = 'apps/loom-health-cp/src/jobs/fhir-tenant-config.ts';
const read = (rel) => readFileSync(resolve(root, rel), 'utf8').replace(/\r\n/g, '\n');

const tmp = mkdtempSync(join(tmpdir(), 'lhds-edge-'));
function compile(rel) {
  const outFile = join(tmp, rel.replace(/[\\/]/g, '_') + '.json');
  const r = spawnSync('az', ['bicep', 'build', '--file', resolve(root, rel), '--outfile', outFile], { encoding: 'utf8', shell: process.platform === 'win32' });
  assert.equal(r.status, 0, `az bicep build ${rel} failed (guard cannot run): ${r.stderr}`);
  return JSON.parse(readFileSync(outFile, 'utf8'));
}
const edge = compile(MOD);
const resourcesOf = (arm) => (Array.isArray(arm.resources) ? arm.resources : Object.values(arm.resources ?? {}));

const conf = read(CONF);
const src = read(MOD);
const health = read(`${BICEP}/health.bicep`);

// The regex locations, in file order (nginx takes the FIRST matching regex location).
const regexLocations = [...conf.matchAll(/^\s*location ~ "([^"]+)" \{$/gm)].map((m) => m[1]);
const [smartRe, engineRe] = regexLocations.map((p) => new RegExp(p));

// ── template <-> bicep ────────────────────────────────────────────────────────

test('every __TOKEN__ in the nginx template is replaced by edge-router.bicep, and nothing else is', () => {
  const inConf = new Set([...conf.matchAll(/__([A-Z_]+?)__/g)].map((m) => m[1]));
  const inBicep = new Set([...src.matchAll(/^\s+'__([A-Z_]+)__', /gm)].map((m) => m[1]));
  // Breaks when a token is added to the template without a bicep replace (it ships literally and nginx refuses the config),
  // or a replace names a token the template no longer has. Positive control: the known tokens are there.
  assert.deepEqual([...inConf].sort(), [...inBicep].sort());
  for (const t of ['RESOLVER', 'ISSUER_HOST', 'ENGINE_PREFIX', 'ENGINE_NS', 'MAX_BODY_MB', 'TIMEOUT_S']) assert.ok(inConf.has(t), t);
  assert.match(src, /loadTextContent\('edge-router-nginx\.conf'\)/);
});

test('the engine host name is the control plane fhirNames(): prefix "fhir-" + slug, Service port 80, namespace loom-health', () => {
  const workload = read(CP_CONFIG).match(/workloadName: `([^`$]*)\$\{slug\}([^`]*)`/);
  assert.ok(workload, 'fhirNames workloadName template not found');
  // Breaks if fhirNames gains a suffix or changes prefix ('fhir-' + slug is what nginx can compute from the path).
  assert.equal(workload[2], '', 'workloadName has a suffix nginx does not add');
  assert.equal(src.match(/^var enginePrefix = '([^']*)'$/m)[1], workload[1]);
  const host = read(CP_HOST);
  // Breaks if SERVICE_PORT or ENGINE_PORT drifts from what the router dials / its NetworkPolicy opens.
  assert.equal(src.match(/^var engineServicePort = (\d+)$/m)[1], host.match(/^export const SERVICE_PORT = (\d+);$/m)[1]);
  assert.equal(src.match(/^var enginePodPort = (\d+)$/m)[1], host.match(/^export const ENGINE_PORT = (\d+);$/m)[1]);
  assert.equal(src.match(/^param engineNamespace string = '([^']+)'$/m)[1], host.match(/^export const ENGINE_NAMESPACE = '([^']+)';$/m)[1]);
  // health.bicep passes the PDP namespace, which is the engine namespace.
  assert.match(health, /engineNamespace: pdpNamespace/);
  assert.match(conf, /proxy_pass http:\/\/__ENGINE_PREFIX__\$tenant\.__ENGINE_NS__\.svc\.cluster\.local:__ENGINE_SERVICE_PORT__\/fhir\$rest\$is_args\$args;/);
});

test('the router namespace and pod label equal the edge peer the control plane admits on every engine', () => {
  const host = read(CP_HOST);
  const ns = host.match(/^export const EDGE_NAMESPACE = '([^']+)';$/m)[1];
  const app = host.match(/^export const EDGE_APP_LABEL = '([^']+)';$/m)[1];
  // Breaks when either side renames (e.g. bicep 'lhds-edge'): the engine policy would drop every routed request.
  assert.equal(src.match(/^var edgeNamespace = '([^']+)'$/m)[1], ns);
  assert.equal(src.match(/^var edgeAppLabel = '([^']+)'$/m)[1], app);
  assert.match(host, /edgePeers: \[EDGE_ROUTER_PEER\]/);
});

// ── routing regexes against real paths ─────────────────────────────────────────

test('two regex locations, discovery FIRST (it would otherwise be routed to the engine)', () => {
  // Breaks at 1 or 3 locations, or when the engine location is moved above discovery.
  assert.equal(regexLocations.length, 2, JSON.stringify(regexLocations));
  assert.match(regexLocations[0], /smart-configuration\$$/);
  assert.match(regexLocations[1], /\/fhir\(\?<rest>/);
  // The engine regex ALSO matches the discovery path: that is why order is load-bearing.
  assert.ok(engineRe.test('/ab/fhir/.well-known/smart-configuration'));
});

test('the tenant group is exactly the control plane SLUG (lifted, not transcribed)', () => {
  const slug = read(CP_HOST).match(/^const SLUG = \/\^(.+)\$\/;$/m)[1];
  // Breaks if the router accepts a different tenant shape than the control plane creates (a wider one forwards names that
  // can never exist; a narrower one 404s a real tenant).
  for (const p of regexLocations) assert.ok(p.includes(`(?<tenant>${slug})`), `${p} does not carry SLUG ${slug}`);
});

test('engine route: /ab/fhir/Patient routes tenant ab, rest /Patient; the negatives do not route', () => {
  const m = engineRe.exec('/ab/fhir/Patient');
  assert.ok(m, '/ab/fhir/Patient must route');
  assert.equal(m.groups.tenant, 'ab');
  assert.equal(m.groups.rest, '/Patient');
  // The bare base routes with an empty rest (-> /fhir on the engine).
  assert.equal(engineRe.exec('/acme-health/fhir').groups.rest, undefined);
  assert.equal(engineRe.exec(`/${'a'.repeat(40)}/fhir/metadata`).groups.tenant.length, 40);
  // Each negative names the change that would let it through:
  for (const [p, why] of [
    ['/a/fhir/x', 'a 1-char tenant ({1,} instead of SLUG)'],
    ['/AB/fhir/x', 'case-insensitive matching (~* or [A-Za-z])'],
    ['/ab/fhirx', 'a missing / after fhir ((?<rest>.*))'],
    ['/-ab/fhir/x', 'a leading hyphen'],
    [`/${'a'.repeat(41)}/fhir/x`, 'a 41-char tenant'],
    ['/ab/cd/fhir/x', 'an unanchored start'],
  ]) {
    assert.equal(engineRe.test(p), false, `${p} routed: ${why}`);
    assert.equal(smartRe.test(p), false, `${p} routed to discovery`);
  }
});

test('discovery route: only the exact smart-configuration path, tenant captured', () => {
  assert.equal(smartRe.exec('/ab/fhir/.well-known/smart-configuration').groups.tenant, 'ab');
  // Breaks on an unescaped dot, a missing $ anchor, or a prefix match.
  assert.equal(smartRe.test('/ab/fhir/xwell-known/smart-configuration'), false);
  assert.equal(smartRe.test('/ab/fhir/.well-known/smart-configuration/x'), false);
  assert.equal(smartRe.test('/ab/fhir/.well-known/openid-configuration'), false);
  assert.match(conf, /proxy_pass https:\/\/__ISSUER_HOST____ISSUER_PATH__\/\$tenant\/\.well-known\/smart-configuration;/);
});

test('unknown tenants and non-FHIR paths answer 404 OperationOutcome; engine errors are NOT intercepted', () => {
  // Breaks if proxy_intercept_errors is turned on (an engine 401/403 OperationOutcome would be rewritten) or the 502 mapping drops.
  assert.doesNotMatch(conf, /proxy_intercept_errors\s+on/);
  assert.match(conf, /error_page 502 = @no_engine;/);
  assert.match(conf, /location @no_engine \{\n\s+default_type application\/fhir\+json;\n\s+return 404 '\{"resourceType":"OperationOutcome"/);
  assert.match(conf, /location \/ \{\n\s+default_type application\/fhir\+json;\n\s+return 404 '\{"resourceType":"OperationOutcome"/);
  assert.match(conf, /^\s+server_tokens off;$/m);
});

// ── manifest + wiring ──────────────────────────────────────────────────────────

test('the internal LB Service requests the App Gateway backend address, in the node subnet', () => {
  // Breaks if the annotation is fed by anything but ilbIp, or ilbIp stops being read from the gateway's backend pool
  // (a re-derived CIDR would silently diverge from network.bicep when a stamp is re-addressed).
  assert.match(src, /'    service\.beta\.kubernetes\.io\/azure-load-balancer-ipv4: "\$\{ilbIp\}"'/);
  assert.match(src, /'    service\.beta\.kubernetes\.io\/azure-load-balancer-internal: "true"'/);
  assert.match(src, /'    service\.beta\.kubernetes\.io\/azure-load-balancer-internal-subnet: "\$\{nodeSubnetName\}"'/);
  assert.match(String(edge.outputs.ilbIp.value), /reference\(resourceId\('Microsoft\.Network\/applicationGateways', parameters\('gatewayName'\)\).*\.backendAddressPools\[0\]\.properties\.backendAddresses\[0\]\.ipAddress/);
  assert.match(src, /'  type: LoadBalancer'/);
  // The gateway has exactly ONE pool, so [0] is the ingress-ilb pool fed by network.bicep ingressIlbIp.
  const ingress = read(`${BICEP}/modules/health/ingress.bicep`);
  assert.equal([...ingress.matchAll(/name: 'ingress-ilb'/g)].length, 1);
  assert.match(ingress, /backendAddressPools: \[\n\s+\{\n\s+name: 'ingress-ilb'\n\s+properties: \{ backendAddresses: \[\{ ipAddress: backendIp \}\] \}\n\s+\}\n\s+\]/);
  assert.match(read(`${BICEP}/modules/health/stamp.bicep`), /backendIp: network\.outputs\.ingressIlbIp/);
  // health.bicep names the gateway the way ingress.bicep does.
  assert.match(ingress, /^var gwName = 'agw-lhds-\$\{stampName\}'$/m);
  assert.match(health, /gatewayName: 'agw-lhds-\$\{healthStampName\}'/);
});

test('the image is pinned BY DIGEST from edge-router-image.json, and deploy-health imports that same file', () => {
  const spec = JSON.parse(read(SPEC));
  // Breaks on a tag-only pin or a malformed digest (the import step refuses it too, but only at deploy time).
  assert.match(spec.digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(spec.source, 'docker.io/nginxinc/nginx-unprivileged');
  assert.match(health, /image: '\$\{cpAcrLoginServer\}\/\$\{edgeImageSpec\.acrRepository\}@\$\{edgeImageSpec\.digest\}'/);
  assert.match(health, /var edgeImageSpec = loadJsonContent\('modules\/health\/edge-router-image\.json'\)/);
  const wf = read('.github/workflows/deploy-health.yml');
  assert.match(wf, /SPECS="[^"]*platform\/fiab\/bicep\/modules\/health\/edge-router-image\.json[^"]*"/);
});

test('the pod runs restricted: non-root, read-only root, ALL caps dropped, RuntimeDefault, no SA token, probes on /healthz', () => {
  for (const line of ['        runAsNonRoot: true', '            readOnlyRootFilesystem: true', '            capabilities: { drop: ["ALL"] }', '          type: RuntimeDefault', '      automountServiceAccountToken: false', '            allowPrivilegeEscalation: false']) {
    // Breaks when any hardening line is removed or loosened.
    assert.ok(src.includes(`'${line}'`), line);
  }
  assert.equal([...src.matchAll(/httpGet: \{ path: \/healthz, port: \$\{containerPort\} \}/g)].length, 2);
  assert.match(conf, /location = \/healthz \{/);
  assert.match(src, /'kind: PodDisruptionBudget'/);
  // The writable paths nginx needs are all under the /tmp emptyDir.
  for (const d of ['pid /tmp/nginx.pid;', 'client_body_temp_path /tmp/', 'proxy_temp_path /tmp/']) assert.ok(conf.includes(d), d);
});

test('the module creates no ARM resource (grants are engines.bicep\'s) and deploys exactly with the PDP', () => {
  // Breaks if a role assignment or identity is added here, duplicating (and racing) the engines.bicep grants.
  assert.deepEqual(resourcesOf(edge).filter((r) => !r.existing).map((r) => r.type), []);
  assert.match(health, /^var edgeDeploy = pdpDeploy$/m);
  assert.match(health, /^module healthEdge 'modules\/health\/edge-router\.bicep' = if \(edgeDeploy\) \{$/m);
  assert.match(health, /manifest: healthEdge!\.outputs\.manifest/);
  assert.equal(edge.outputs.manifest.type, 'string');
});

test('deploy-health applies the edge manifest through aks-apply-manifest.sh, fail-closed, after the PDP apply', () => {
  const wf = read('.github/workflows/deploy-health.yml');
  const start = wf.indexOf('- name: Apply the stamp FHIR edge router manifest (az aks command invoke)');
  assert.ok(start > 0, 'edge apply step missing');
  const rest = wf.slice(start + 1);
  const block = rest.slice(0, rest.search(/\n {6}- name: |\n {6}# [A-Z]/));
  assert.match(block, /bash scripts\/csa-loom\/aks-apply-manifest\.sh --resource-group "\$RG" --cluster "\$CLUSTER" --namespace "\$NS" --deployment "\$DEP" --manifest temp\/edge-manifest\.yaml/);
  assert.match(block, /\.healthEdgeState\.value\.manifest/);
  assert.match(block, /exit 1\n/);
  // Breaks if a result-discarding shape enters the step.
  assert.doesNotMatch(block, /\|\| true|continue-on-error|2>\s*\/dev\/null/);
  assert.ok(wf.indexOf('- name: Apply the stamp PDP manifest') < start, 'after the PDP apply');
  assert.ok(start < wf.indexOf('- name: Fail the run when the PDP was not deployed'), 'before the final step');
});

// ── opt-in: nginx -t and a functional curl in the pinned image ────────────────

const dockerOptIn = process.env.LHDS_EDGE_DOCKER === '1';
test('nginx -t + functional routing in the pinned image (LHDS_EDGE_DOCKER=1)', { skip: dockerOptIn ? false : 'opt-in: set LHDS_EDGE_DOCKER=1 (needs docker + a Docker Hub pull); not run in CI' }, () => {
  const spec = JSON.parse(read(SPEC));
  const image = `${spec.source.replace(/^docker\.io\//, '')}@${spec.digest}`;
  const sh = (args, opts = {}) => spawnSync('docker', args, { encoding: 'utf8', ...opts });
  const net = `lhds-edge-${process.pid}`;
  const dir = mkdtempSync(join(tmpdir(), 'lhds-edge-run-'));
  const render = (vals) => Object.entries(vals).reduce((c, [k, v]) => c.split(`__${k}__`).join(v), conf);
  // Docker's embedded DNS (127.0.0.11) stands in for kube-dns; the stub engine answers under the cluster name.
  const routerConf = render({ RESOLVER: '127.0.0.11', MAX_BODY_MB: '4000', TIMEOUT_S: '300', PORT: '8080', DISCOVERY_ENABLED: '1', ISSUER_HOST: 'issuer.invalid', ISSUER_PATH: '/auth', ENGINE_PREFIX: 'fhir-', ENGINE_NS: 'loom-health', ENGINE_SERVICE_PORT: '80' });
  assert.doesNotMatch(routerConf, /__[A-Z_]+__/);
  writeFileSync(join(dir, 'nginx.conf'), routerConf);
  writeFileSync(join(dir, 'stub.conf'), 'pid /tmp/nginx.pid; events {} http { server { listen 80; location / { default_type text/plain; return 200 "uri=$request_uri auth=$http_authorization xfp=$http_x_forwarded_proto prefix=$http_x_forwarded_prefix\\n"; } } }\n');
  const mount = (f, to) => ['-v', `${join(dir, f)}:${to}:ro`];
  try {
    const t = sh(['run', '--rm', ...mount('nginx.conf', '/etc/nginx/nginx.conf'), '--read-only', '--tmpfs', '/tmp', '--user', '101', image, 'nginx', '-t']);
    // Breaks on any config nginx refuses (an unreplaced token, an unquoted {} regex, a bad directive).
    assert.equal(t.status, 0, `nginx -t failed: ${t.stderr}`);
    assert.equal(sh(['network', 'create', net]).status, 0);
    assert.equal(sh(['run', '-d', '--name', `${net}-stub`, '--network', net, '--network-alias', 'fhir-ab.loom-health.svc.cluster.local', '--user', '0', ...mount('stub.conf', '/etc/nginx/nginx.conf'), image, 'nginx', '-g', 'daemon off;']).status, 0);
    const port = String(18000 + (process.pid % 1000));
    assert.equal(sh(['run', '-d', '--name', `${net}-router`, '--network', net, '-p', `127.0.0.1:${port}:8080`, '--read-only', '--tmpfs', '/tmp', '--user', '101', ...mount('nginx.conf', '/etc/nginx/nginx.conf'), image, 'nginx', '-g', 'daemon off;']).status, 0);
    spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},1500)']);
    const curl = (path, extra = []) => {
      const r = spawnSync('curl', ['-s', '-o', '-', '-w', '\\n%{http_code}', ...extra, `http://127.0.0.1:${port}${path}`], { encoding: 'utf8' });
      const lines = r.stdout.trimEnd().split('\n');
      return { code: lines.pop(), body: lines.join('\n').trimEnd() };
    };
    const ok = curl('/ab/fhir/Patient?name=x&_count=2', ['-H', 'Authorization: Bearer tkn']);
    // Breaks if the path rewrite, the query string, the Authorization pass-through or X-Forwarded-Proto/Prefix is lost.
    assert.equal(ok.code, '200', ok.body);
    assert.equal(ok.body, 'uri=/fhir/Patient?name=x&_count=2 auth=Bearer tkn xfp=https prefix=/ab');
    assert.equal(curl('/ab/fhir').body, 'uri=/fhir auth= xfp=https prefix=/ab');
    const unknown = curl('/zz/fhir/Patient');
    // Breaks if NXDOMAIN surfaces as nginx's 502 page instead of a 404 OperationOutcome.
    assert.equal(unknown.code, '404', unknown.body);
    assert.match(unknown.body, /"resourceType":"OperationOutcome".*"code":"not-found"/);
    for (const p of ['/', '/a/fhir/x', '/AB/fhir/x', '/ab/fhirx']) {
      const r = curl(p);
      assert.equal(r.code, '404', `${p}: ${r.body}`);
      assert.match(r.body, /OperationOutcome/);
    }
    assert.equal(curl('/healthz').code, '200');
    // Discovery with an unreachable issuer is a 502 OperationOutcome (transient), never routed to the engine (whose stub says uri=).
    const disc = curl('/ab/fhir/.well-known/smart-configuration');
    assert.equal(disc.code, '502', disc.body);
    assert.match(disc.body, /"code":"transient"/);
    const hdr = spawnSync('curl', ['-sI', `http://127.0.0.1:${port}/`], { encoding: 'utf8' }).stdout;
    assert.match(hdr, /^Server: nginx\r?$/m, 'server_tokens off: no version in Server');
  } finally {
    sh(['rm', '-f', `${net}-router`, `${net}-stub`]);
    sh(['network', 'rm', net]);
    rmSync(dir, { recursive: true, force: true });
  }
});

test.after(() => rmSync(tmp, { recursive: true, force: true }));
