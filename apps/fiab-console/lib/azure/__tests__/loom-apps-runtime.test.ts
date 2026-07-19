/**
 * Unit tests for the Loom App Runtime PURE builders (DBX-1) — the framework
 * starter bundles, Dockerfile generation, build-context assembly, the ustar tar
 * writer, the env allowlist, and the ACA container-app + authConfig ARM bodies.
 * All deterministic — no Azure I/O.
 */
import { describe, it, expect } from 'vitest';
import {
  LOOM_APP_TEMPLATES, getLoomAppTemplate, isAllowedAppEnvName,
  generateDockerfile, assembleBuildContext, makeTar,
  buildAcaAppBody, buildAuthConfigBody, LoomAppSpecError,
  loomAppContainerName, isValidLoomAppName,
} from '../loom-apps-runtime-templates';

describe('template catalog', () => {
  it('ships the documented runtimes with unique ids + valid ports', () => {
    const ids = LOOM_APP_TEMPLATES.map((t) => t.id);
    expect(ids).toEqual(['streamlit', 'dash', 'gradio', 'flask', 'node-express', 'agent-fastapi', 'ontology-explorer']);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of LOOM_APP_TEMPLATES) {
      expect(t.defaultPort).toBeGreaterThan(0);
      // entry + manifest files exist in the bundle
      expect(t.files.some((f) => f.path === t.entryFile)).toBe(true);
      expect(t.files.some((f) => f.path === t.manifestFile)).toBe(true);
    }
  });
  it('getLoomAppTemplate resolves + misses cleanly', () => {
    expect(getLoomAppTemplate('flask')?.runtime).toBe('python');
    expect(getLoomAppTemplate('node-express')?.runtime).toBe('node');
    expect(getLoomAppTemplate('nope')).toBeUndefined();
  });
});

describe('env-name allowlist (no-freeform-config)', () => {
  it('accepts allowlisted prefixes, rejects arbitrary names', () => {
    expect(isAllowedAppEnvName('LOOM_ADX_CLUSTER')).toBe(true);
    expect(isAllowedAppEnvName('APP_TITLE')).toBe(true);
    expect(isAllowedAppEnvName('AZURE_CLIENT_ID')).toBe(true);
    expect(isAllowedAppEnvName('PORT')).toBe(true);
    expect(isAllowedAppEnvName('KEYVAULT_URI')).toBe(true);
    expect(isAllowedAppEnvName('DATABASE_URL')).toBe(false);
    expect(isAllowedAppEnvName('secret')).toBe(false);
    expect(isAllowedAppEnvName('PATH')).toBe(false);
  });
});

describe('generateDockerfile', () => {
  it('emits a streamlit CMD binding the port + address', () => {
    const df = generateDockerfile(getLoomAppTemplate('streamlit')!, 8501);
    expect(df).toContain('FROM python:3.12-slim');
    expect(df).toContain('streamlit');
    expect(df).toContain('--server.port=8501');
    expect(df).toContain('--server.address=0.0.0.0');
  });
  it('emits gunicorn for flask (app:app) and dash (app:server)', () => {
    expect(generateDockerfile(getLoomAppTemplate('flask')!, 8000)).toContain('gunicorn');
    expect(generateDockerfile(getLoomAppTemplate('flask')!, 8000)).toContain('app:app');
    expect(generateDockerfile(getLoomAppTemplate('dash')!, 8050)).toContain('app:server');
  });
  it('emits uvicorn (ASGI) for the FastAPI agent template', () => {
    const df = generateDockerfile(getLoomAppTemplate('agent-fastapi')!, 8000);
    expect(df).toContain('uvicorn');
    expect(df).toContain('app:app');
    expect(df).toContain('--port');
  });
  it('serves the ontology-explorer with streamlit and ships the SDK module', () => {
    const t = getLoomAppTemplate('ontology-explorer')!;
    const df = generateDockerfile(t, 8501);
    expect(df).toContain('streamlit');
    expect(df).toContain('--server.port=8501');
    expect(t.files.some((f) => f.path === 'loom_ontology.py')).toBe(true);
    const sdk = t.files.find((f) => f.path === 'loom_ontology.py')!.content;
    expect(sdk).toContain('APP_ONT_');
    expect(sdk).toContain('ag_catalog.cypher');
    expect(sdk).toContain('ossrdbms-aad.database.windows.net');
  });

  it('emits a node image + npm start for express', () => {
    const df = generateDockerfile(getLoomAppTemplate('node-express')!, 3000);
    expect(df).toContain('FROM node:20-slim');
    expect(df).toContain('"npm", "start"');
    expect(df).toContain('npm install --omit=dev');
  });
  it('is deterministic (same inputs → same bytes)', () => {
    const a = generateDockerfile(getLoomAppTemplate('gradio')!, 7860);
    const b = generateDockerfile(getLoomAppTemplate('gradio')!, 7860);
    expect(a).toBe(b);
  });
});

describe('assembleBuildContext', () => {
  it('always includes a generated Dockerfile + the starter files', () => {
    const files = assembleBuildContext({ template: getLoomAppTemplate('flask')!, port: 8000 });
    const paths = files.map((f) => f.path);
    expect(paths).toContain('Dockerfile');
    expect(paths).toContain('app.py');
    expect(paths).toContain('requirements.txt');
  });
  it('applies user overrides but never lets a user override the Dockerfile', () => {
    const files = assembleBuildContext({
      template: getLoomAppTemplate('flask')!, port: 8000,
      userFiles: { 'app.py': 'print("hi")', 'Dockerfile': 'FROM scratch' },
    });
    expect(files.find((f) => f.path === 'app.py')!.content).toBe('print("hi")');
    // Dockerfile is generated, not the user's
    expect(files.find((f) => f.path === 'Dockerfile')!.content).toContain('FROM python:3.12-slim');
  });
  it('drops path-traversal user paths', () => {
    const files = assembleBuildContext({
      template: getLoomAppTemplate('flask')!, port: 8000,
      userFiles: { '../evil.sh': 'rm -rf /', '/etc/passwd': 'x' },
    });
    expect(files.some((f) => f.path.includes('..'))).toBe(false);
    expect(files.some((f) => f.path.startsWith('/'))).toBe(false);
  });
});

describe('makeTar (ustar)', () => {
  it('writes 512-byte-aligned blocks with the ustar magic + correct name/size', () => {
    const tar = makeTar([{ path: 'a.txt', content: 'hello' }]);
    // header(512) + content padded to 512 + 1024 trailer = 2048
    expect(tar.length % 512).toBe(0);
    expect(tar.length).toBe(2048);
    // name at offset 0
    expect(tar.toString('utf8', 0, 5)).toBe('a.txt');
    // ustar magic at 257
    expect(tar.toString('ascii', 257, 262)).toBe('ustar');
    // octal size at 124 (len 11) — "hello" = 5
    const sizeOctal = tar.toString('ascii', 124, 135).replace(/\0.*$/, '').trim();
    expect(parseInt(sizeOctal, 8)).toBe(5);
    // content
    expect(tar.toString('utf8', 512, 517)).toBe('hello');
  });
  it('is deterministic + sorts files by path', () => {
    const a = makeTar([{ path: 'b', content: '1' }, { path: 'a', content: '2' }]);
    const b = makeTar([{ path: 'a', content: '2' }, { path: 'b', content: '1' }]);
    expect(a.equals(b)).toBe(true);
    // first file header should be 'a'
    expect(a.toString('utf8', 0, 1)).toBe('a');
  });
  it('computes a valid header checksum', () => {
    const tar = makeTar([{ path: 'x', content: 'y' }]);
    // recompute checksum with the checksum field replaced by spaces
    const header = tar.subarray(0, 512);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += (i >= 148 && i < 156) ? 0x20 : header[i];
    const stored = parseInt(tar.toString('ascii', 148, 154), 8);
    expect(stored).toBe(sum);
  });
});

describe('buildAcaAppBody', () => {
  const base = {
    name: 'app-x', environmentId: '/subscriptions/s/cae', location: 'eastus2',
    uamiId: '/uami/1', image: 'acr.azurecr.io/loom-app-x:b1', targetPort: 8501,
    acrLoginServer: 'acr.azurecr.io',
  };
  it('enforces scale-to-zero floor by default + injects PORT', () => {
    const body: any = buildAcaAppBody(base);
    expect(body.properties.template.scale.minReplicas).toBe(0);
    expect(body.properties.configuration.ingress.external).toBe(true);
    expect(body.properties.configuration.ingress.targetPort).toBe(8501);
    const env = body.properties.template.containers[0].env;
    expect(env.find((e: any) => e.name === 'PORT').value).toBe('8501');
    // registry credential wired to the app UAMI
    expect(body.properties.configuration.registries[0]).toEqual({ server: 'acr.azurecr.io', identity: '/uami/1' });
  });
  it('rejects a non-allowlisted env name', () => {
    expect(() => buildAcaAppBody({ ...base, env: [{ name: 'DATABASE_URL', value: 'x' }] })).toThrow(LoomAppSpecError);
  });
  it('accepts allowlisted plain + secretRef env (KV-backed), rejects both-set', () => {
    const body: any = buildAcaAppBody({
      ...base,
      keyVaultUri: 'https://kv-loom.vault.azure.net',
      env: [{ name: 'LOOM_ADX', value: 'c' }, { name: 'APP_KEY', secretRef: 'kv-key' }],
    });
    const env = body.properties.template.containers[0].env;
    expect(env.find((e: any) => e.name === 'LOOM_ADX').value).toBe('c');
    // secretRef is rewritten to the sanitized ACA secret name (kv-<kvName>).
    const acaSecretRef = env.find((e: any) => e.name === 'APP_KEY').secretRef;
    expect(acaSecretRef).toBe('kv-kv-key');
    // A matching configuration.secrets[] entry is emitted, KV-backed via the app UAMI.
    const secrets = body.properties.configuration.secrets;
    const sec = secrets.find((s: any) => s.name === acaSecretRef);
    expect(sec.keyVaultUrl).toBe('https://kv-loom.vault.azure.net/secrets/kv-key');
    expect(sec.identity).toBe('/uami/1');
    expect(() => buildAcaAppBody({ ...base, env: [{ name: 'APP_X', value: 'a', secretRef: 'b' }] })).toThrow(/both value and secretRef/);
  });
  it('throws an honest error when a secretRef env has no vault configured', () => {
    expect(() => buildAcaAppBody({ ...base, env: [{ name: 'APP_KEY', secretRef: 'kv-key' }] }))
      .toThrow(/no vault is configured/);
  });
  it('clamps a negative minReplicas up to 0', () => {
    const body: any = buildAcaAppBody({ ...base, minReplicas: -5 });
    expect(body.properties.template.scale.minReplicas).toBe(0);
  });
});

describe('buildAuthConfigBody', () => {
  it('wires the Entra provider with RedirectToLoginPage', () => {
    const b: any = buildAuthConfigBody({ clientId: 'cid', openIdIssuer: 'https://login.microsoftonline.com/tid/v2.0' });
    expect(b.properties.globalValidation.unauthenticatedClientAction).toBe('RedirectToLoginPage');
    expect(b.properties.identityProviders.azureActiveDirectory.registration.clientId).toBe('cid');
    expect(b.properties.identityProviders.azureActiveDirectory.registration.openIdIssuer).toContain('tid');
  });
});

describe('app naming', () => {
  it('derives a DNS-safe name ≤32 chars starting with a letter', () => {
    const name = loomAppContainerName('11112222-3333-4444-5555-666677778888');
    expect(isValidLoomAppName(name)).toBe(true);
    expect(name.length).toBeLessThanOrEqual(32);
    expect(/^[a-z]/.test(name)).toBe(true);
  });
  it('validates names correctly', () => {
    expect(isValidLoomAppName('app-abc-1234')).toBe(true);
    expect(isValidLoomAppName('1app')).toBe(false);        // must start with a letter
    expect(isValidLoomAppName('App')).toBe(false);          // no uppercase
    expect(isValidLoomAppName('a'.repeat(40))).toBe(false); // too long
  });
});
