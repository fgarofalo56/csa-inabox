/**
 * loom-apps-runtime-templates — PURE builders for the Loom App Runtime
 * (DBX-1, Databricks-Apps-class hosted apps on Azure Container Apps).
 *
 * Everything in this module is side-effect-free and deterministic so it can be
 * unit-tested without touching Azure: the framework starter bundles, the
 * Dockerfile generator, the build-context assembly (+ a minimal ustar tar
 * writer), the env-var allowlist, and the ACA container-app ARM body builder.
 *
 * The real ARM/ACR REST calls that consume these builders live in
 * lib/azure/loom-apps-client.ts.
 *
 * Governing rules:
 *  - no-vaporware.md: every deployed app runs REAL user code built into a REAL
 *    image and served on a REAL ACA URL — no mock surface.
 *  - loom_no_freeform_config: the runtime template is a DROPDOWN choice (fixed
 *    set below), and env-var NAMES are allowlisted by prefix so a caller can't
 *    inject an arbitrary variable through the structured deploy options.
 *  - no-fabric-dependency.md: pure Azure Container Apps — no Fabric anywhere.
 */

/** A structured env var — a literal value OR a reference to a Key Vault-backed ACA secret. */
export interface LoomAppEnvVar {
  name: string;
  /** Plain value (non-secret). Mutually exclusive with secretRef. */
  value?: string;
  /** ACA secret name (Key Vault-backed). Mutually exclusive with value. */
  secretRef?: string;
}

/**
 * Allowlisted env-var name prefixes the deploy path accepts. Mirrors the MCP
 * deploy guard (container-apps-arm-client.ts) plus an APP_-prefixed family so a
 * hosted app can receive its own config, and the standard telemetry/identity
 * keys. Per loom_no_freeform_config the deploy method never takes an arbitrary
 * env blob — every name must match this, so a caller cannot inject an unrelated
 * variable through the structured options.
 */
export const LOOM_APP_ENV_NAME_RE =
  /^(APP_|LOOM_|AZURE_|APPLICATIONINSIGHTS_|KEYVAULT_|CSA_LOOM_|PORT|PYTHONUNBUFFERED|NODE_ENV)[A-Z0-9_]*$/;

export function isAllowedAppEnvName(name: string): boolean {
  return LOOM_APP_ENV_NAME_RE.test(name);
}

export type LoomAppRuntimeKind = 'python' | 'node';

/** A source file that ships in the build context. */
export interface TemplateFile {
  /** POSIX relative path inside the build context (e.g. 'app.py'). */
  path: string;
  content: string;
}

export interface LoomAppTemplate {
  /** Stable dropdown value persisted on the item. */
  id: string;
  label: string;
  description: string;
  runtime: LoomAppRuntimeKind;
  /** Container port the framework listens on. */
  defaultPort: number;
  /** The primary source file the user edits (path within the context). */
  entryFile: string;
  /** The dependency-manifest file the user edits (requirements.txt / package.json). */
  manifestFile: string;
  /** Base starter files (entry + manifest). */
  files: TemplateFile[];
}

// ---------------------------------------------------------------------------
// Starter bundles — each is a REAL, runnable app (renders + serves on its port).
// ---------------------------------------------------------------------------

const STREAMLIT: LoomAppTemplate = {
  id: 'streamlit',
  label: 'Streamlit',
  description: 'Python data app — interactive widgets + charts (Streamlit).',
  runtime: 'python',
  defaultPort: 8501,
  entryFile: 'app.py',
  manifestFile: 'requirements.txt',
  files: [
    {
      path: 'app.py',
      content: `import os
import streamlit as st

st.set_page_config(page_title="Loom App", page_icon="🧵", layout="wide")
st.title("🧵 Hello from your Loom App")
st.caption("Streamlit on Azure Container Apps — autoscale-to-zero, Entra-gated.")

st.write("This app is running your code. Edit app.py and redeploy.")
n = st.slider("Pick a number", 1, 100, 42)
st.metric("Square", n * n)

# Bound Loom data-plane endpoints (if any) are injected as LOOM_* env vars.
loom_env = {k: v for k, v in os.environ.items() if k.startswith("LOOM_")}
if loom_env:
    st.subheader("Bound Loom endpoints")
    st.json(loom_env)
`,
    },
    {
      path: 'requirements.txt',
      content: 'streamlit==1.39.0\n',
    },
  ],
};

const DASH: LoomAppTemplate = {
  id: 'dash',
  label: 'Dash (Plotly)',
  description: 'Python analytical dashboard — Plotly Dash.',
  runtime: 'python',
  defaultPort: 8050,
  entryFile: 'app.py',
  manifestFile: 'requirements.txt',
  files: [
    {
      path: 'app.py',
      content: `import os
from dash import Dash, html, dcc, callback, Output, Input
import plotly.express as px
import pandas as pd

app = Dash(__name__)
server = app.server  # gunicorn entrypoint

df = pd.DataFrame({"x": list(range(1, 11)), "y": [v * v for v in range(1, 11)]})

app.layout = html.Div([
    html.H2("🧵 Loom App — Dash"),
    dcc.Slider(1, 10, 1, value=5, id="n"),
    dcc.Graph(id="g"),
])

@callback(Output("g", "figure"), Input("n", "value"))
def update(n):
    return px.line(df.head(n), x="x", y="y", title="y = x²")

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "8050")))
`,
    },
    {
      path: 'requirements.txt',
      content: 'dash==2.18.2\nplotly==5.24.1\npandas==2.2.3\ngunicorn==23.0.0\n',
    },
  ],
};

const GRADIO: LoomAppTemplate = {
  id: 'gradio',
  label: 'Gradio',
  description: 'Python ML/AI demo UI — Gradio.',
  runtime: 'python',
  defaultPort: 7860,
  entryFile: 'app.py',
  manifestFile: 'requirements.txt',
  files: [
    {
      path: 'app.py',
      content: `import os
import gradio as gr

def greet(name, intensity):
    return "Hello, " + name + "!" * int(intensity)

demo = gr.Interface(
    fn=greet,
    inputs=["text", gr.Slider(1, 5, value=1, step=1)],
    outputs="text",
    title="🧵 Loom App — Gradio",
)

if __name__ == "__main__":
    demo.launch(server_name="0.0.0.0", server_port=int(os.environ.get("PORT", "7860")))
`,
    },
    {
      path: 'requirements.txt',
      content: 'gradio==4.44.1\n',
    },
  ],
};

const FLASK: LoomAppTemplate = {
  id: 'flask',
  label: 'Flask',
  description: 'Python web API / app — Flask (served by gunicorn).',
  runtime: 'python',
  defaultPort: 8000,
  entryFile: 'app.py',
  manifestFile: 'requirements.txt',
  files: [
    {
      path: 'app.py',
      content: `import os
from flask import Flask, jsonify

app = Flask(__name__)

@app.get("/")
def index():
    return "<h1>🧵 Hello from your Loom App (Flask)</h1><p>Edit app.py and redeploy.</p>"

@app.get("/api/health")
def health():
    return jsonify(ok=True, loom={k: v for k, v in os.environ.items() if k.startswith("LOOM_")})

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "8000")))
`,
    },
    {
      path: 'requirements.txt',
      content: 'flask==3.0.3\ngunicorn==23.0.0\n',
    },
  ],
};

const NODE_EXPRESS: LoomAppTemplate = {
  id: 'node-express',
  label: 'Node / Express',
  description: 'Node.js web API / app — Express.',
  runtime: 'node',
  defaultPort: 3000,
  entryFile: 'server.js',
  manifestFile: 'package.json',
  files: [
    {
      path: 'server.js',
      content: `const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

app.get('/', (_req, res) => {
  res.send('<h1>🧵 Hello from your Loom App (Express)</h1><p>Edit server.js and redeploy.</p>');
});

app.get('/api/health', (_req, res) => {
  const loom = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => k.startsWith('LOOM_')),
  );
  res.json({ ok: true, loom });
});

app.listen(port, '0.0.0.0', () => console.log('listening on ' + port));
`,
    },
    {
      path: 'package.json',
      content: `{
  "name": "loom-app",
  "version": "1.0.0",
  "private": true,
  "main": "server.js",
  "scripts": { "start": "node server.js" },
  "dependencies": { "express": "^4.21.1" }
}
`,
    },
  ],
};

// AGENT (FastAPI) — DBX-2. Bring-your-own agent harness (LangGraph / CrewAI /
// Claude Agent SDK / OpenAI Agents SDK-style code) hosted as an autoscaled
// endpoint, distinct from the single-purpose NL2SQL Data Agent. The starter is
// a real FastAPI app exposing POST /invoke that runs an AOAI tool-calling loop
// (pre-wired to the same env the Loom AOAI clients read — AZURE_OPENAI_*),
// returning {output, steps}. Deployed exactly like the other templates (ACR
// Task build → ACA autoscale-to-zero). It composes back into a Data Agent as an
// `agent` source (DA_SOURCE_TYPES) so custom agents fold into Genie-style chat.
const AGENT_FASTAPI: LoomAppTemplate = {
  id: 'agent-fastapi',
  label: 'Agent (FastAPI)',
  description: 'Bring-your-own agent — FastAPI /invoke endpoint pre-wired to Azure OpenAI with a tool-calling loop. Compose it back into a Data Agent.',
  runtime: 'python',
  defaultPort: 8000,
  entryFile: 'app.py',
  manifestFile: 'requirements.txt',
  files: [
    {
      path: 'app.py',
      content: `"""
Loom hosted agent (DBX-2) — a FastAPI /invoke endpoint pre-wired to Azure OpenAI.

Deployed by the Loom App Runtime as an autoscale-to-zero Azure Container App.
Replace \`TOOLS\` + \`run_tool()\` with your own harness (LangGraph / CrewAI /
Claude Agent SDK / OpenAI Agents SDK) — it is just a container. The ONE contract
Loom relies on for compose-back is: POST /invoke {"input": "..."} -> {"output": "..."}.
"""
import json
import os
from typing import Any

from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI(title="Loom Agent")

# --- Azure OpenAI wiring (same env the Loom AOAI clients read) ---------------
# Managed identity (the app's UAMI) is preferred; an API key is the fallback.
AOAI_ENDPOINT = os.environ.get("AZURE_OPENAI_ENDPOINT", "").rstrip("/")
AOAI_DEPLOYMENT = os.environ.get("AZURE_OPENAI_DEPLOYMENT", "gpt-4o")
AOAI_API_VERSION = os.environ.get("AZURE_OPENAI_API_VERSION", "2024-10-21")
AOAI_API_KEY = os.environ.get("AZURE_OPENAI_API_KEY", "")


def _aoai_client():
    from openai import AzureOpenAI

    if AOAI_API_KEY:
        return AzureOpenAI(
            azure_endpoint=AOAI_ENDPOINT,
            api_key=AOAI_API_KEY,
            api_version=AOAI_API_VERSION,
        )
    # Managed-identity token provider (DefaultAzureCredential resolves the ACA UAMI).
    from azure.identity import DefaultAzureCredential, get_bearer_token_provider

    token_provider = get_bearer_token_provider(
        DefaultAzureCredential(), "https://cognitiveservices.azure.com/.default"
    )
    return AzureOpenAI(
        azure_endpoint=AOAI_ENDPOINT,
        azure_ad_token_provider=token_provider,
        api_version=AOAI_API_VERSION,
    )


# --- Your tools --------------------------------------------------------------
# Declare tools the model can call. Each maps to a branch in run_tool().
TOOLS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "echo",
            "description": "Echo a message back (replace with a real tool).",
            "parameters": {
                "type": "object",
                "properties": {"message": {"type": "string"}},
                "required": ["message"],
            },
        },
    },
]


def run_tool(name: str, args: dict[str, Any]) -> str:
    if name == "echo":
        return str(args.get("message", ""))
    return f"Tool '{name}' is not implemented in this agent."


class InvokeRequest(BaseModel):
    input: str
    system: str | None = None


@app.get("/")
def index() -> dict[str, Any]:
    return {"agent": "Loom Agent", "invoke": "POST /invoke {\\"input\\": \\"...\\"}", "aoai_configured": bool(AOAI_ENDPOINT)}


@app.get("/health")
def health() -> dict[str, bool]:
    return {"ok": True}


@app.post("/invoke")
def invoke(req: InvokeRequest) -> dict[str, Any]:
    """Run a bounded tool-calling loop and return the final answer + steps."""
    if not AOAI_ENDPOINT:
        return {
            "output": "This agent is not wired to Azure OpenAI yet — set AZURE_OPENAI_ENDPOINT "
            "(+ AZURE_OPENAI_DEPLOYMENT) as a binding on the Loom App Runtime.",
            "steps": [],
        }
    client = _aoai_client()
    messages: list[dict[str, Any]] = [
        {"role": "system", "content": req.system or "You are a helpful agent. Use tools when they help."},
        {"role": "user", "content": req.input},
    ]
    steps: list[dict[str, Any]] = []
    for _ in range(6):  # bound the loop
        resp = client.chat.completions.create(
            model=AOAI_DEPLOYMENT, messages=messages, tools=TOOLS, tool_choice="auto"
        )
        msg = resp.choices[0].message
        if not msg.tool_calls:
            return {"output": msg.content or "", "steps": steps}
        messages.append(msg.model_dump(exclude_none=True))
        for call in msg.tool_calls:
            try:
                args = json.loads(call.function.arguments or "{}")
            except json.JSONDecodeError:
                args = {}
            result = run_tool(call.function.name, args)
            steps.append({"tool": call.function.name, "args": args, "result": result})
            messages.append({"role": "tool", "tool_call_id": call.id, "content": result})
    return {"output": "Reached the tool-call step limit.", "steps": steps}
`,
    },
    {
      path: 'requirements.txt',
      content: 'fastapi==0.115.5\nuvicorn[standard]==0.32.1\nopenai==1.57.0\nazure-identity==1.19.0\npydantic==2.10.3\n',
    },
  ],
};

export const LOOM_APP_TEMPLATES: readonly LoomAppTemplate[] = [
  STREAMLIT, DASH, GRADIO, FLASK, NODE_EXPRESS, AGENT_FASTAPI,
];

export function getLoomAppTemplate(id: string): LoomAppTemplate | undefined {
  return LOOM_APP_TEMPLATES.find((t) => t.id === id);
}

// ---------------------------------------------------------------------------
// Dockerfile generation — one per runtime kind, parameterized by the template.
// ---------------------------------------------------------------------------

/**
 * Generate a production Dockerfile for a template. The container listens on
 * $PORT (defaulting to the template's port); the ACA ingress targetPort is set
 * to the same value in the deploy body. Deterministic — same inputs → same
 * bytes (important for the tar-hash-based build idempotency + the unit test).
 */
export function generateDockerfile(template: LoomAppTemplate, port: number): string {
  const p = String(port);
  if (template.runtime === 'python') {
    // gunicorn for WSGI frameworks (Flask/Dash expose `server`/`app`); the
    // framework's own server for Streamlit/Gradio (they aren't WSGI apps).
    let cmd: string;
    if (template.id === 'streamlit') {
      cmd = `CMD ["streamlit", "run", "app.py", "--server.port=${p}", "--server.address=0.0.0.0", "--server.headless=true"]`;
    } else if (template.id === 'flask') {
      cmd = `CMD ["gunicorn", "--bind", "0.0.0.0:${p}", "app:app"]`;
    } else if (template.id === 'dash') {
      cmd = `CMD ["gunicorn", "--bind", "0.0.0.0:${p}", "app:server"]`;
    } else if (template.id === 'agent-fastapi') {
      // FastAPI is ASGI, not WSGI — serve with uvicorn (app:app).
      cmd = `CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "${p}"]`;
    } else {
      // gradio + generic python: run the entry file directly.
      cmd = `CMD ["python", "${template.entryFile}"]`;
    }
    return [
      'FROM python:3.12-slim',
      'ENV PYTHONUNBUFFERED=1',
      `ENV PORT=${p}`,
      'WORKDIR /app',
      `COPY ${template.manifestFile} ./`,
      `RUN pip install --no-cache-dir -r ${template.manifestFile}`,
      'COPY . ./',
      `EXPOSE ${p}`,
      cmd,
      '',
    ].join('\n');
  }
  // node
  return [
    'FROM node:20-slim',
    `ENV PORT=${p}`,
    'WORKDIR /app',
    'COPY package.json ./',
    'RUN npm install --omit=dev',
    'COPY . ./',
    `EXPOSE ${p}`,
    'CMD ["npm", "start"]',
    '',
  ].join('\n');
}

/**
 * Assemble the full build-context file set for a template deploy: the generated
 * Dockerfile plus the app files, with any USER-supplied overrides replacing the
 * matching starter file (path-keyed). Unknown user paths are appended (so a user
 * can add a helper module), but only for whitelisted text extensions to keep the
 * context sane. Returns a deterministic, path-sorted list.
 */
export function assembleBuildContext(opts: {
  template: LoomAppTemplate;
  port: number;
  /** User edits: path → content. Overrides starter files of the same path. */
  userFiles?: Record<string, string>;
}): TemplateFile[] {
  const { template, port } = opts;
  const byPath = new Map<string, string>();
  for (const f of template.files) byPath.set(f.path, f.content);
  for (const [path, content] of Object.entries(opts.userFiles || {})) {
    const clean = path.replace(/^\.?\/+/, '').trim();
    if (!clean || clean.includes('..') || clean.startsWith('/')) continue; // path traversal guard
    if (clean === 'Dockerfile') continue; // Dockerfile is generated, never user-supplied
    byPath.set(clean, content);
  }
  byPath.set('Dockerfile', generateDockerfile(template, port));
  return [...byPath.entries()]
    .map(([path, content]) => ({ path, content }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

// ---------------------------------------------------------------------------
// Minimal ustar tar writer — the ACR quick-build source-upload wants a tarball
// of the build context. Node has gzip (zlib) but no tar; this writes a spec-
// compliant ustar archive with 512-byte blocks. Pure → unit-tested.
// ---------------------------------------------------------------------------

function tarHeader(name: string, size: number): Buffer {
  const buf = Buffer.alloc(512, 0);
  buf.write(name.slice(0, 100), 0, 'utf8');            // name (0)
  buf.write('0000644\0', 100, 'ascii');                // mode (100)
  buf.write('0000000\0', 108, 'ascii');                // uid (108)
  buf.write('0000000\0', 116, 'ascii');                // gid (116)
  buf.write(size.toString(8).padStart(11, '0') + '\0', 124, 'ascii'); // size (124), octal
  buf.write('00000000000\0', 136, 'ascii');            // mtime (136) — fixed 0 → deterministic
  buf.write('        ', 148, 'ascii');                  // checksum placeholder (8 spaces)
  buf.write('0', 156, 'ascii');                         // typeflag '0' = regular file
  buf.write('ustar\0', 257, 'ascii');                   // magic (257)
  buf.write('00', 263, 'ascii');                        // version (263)
  // checksum = sum of all header bytes with the checksum field as spaces
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += buf[i];
  buf.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
  return buf;
}

/**
 * Build a deterministic ustar tarball (uncompressed) from a set of files.
 * Callers gzip the result before uploading to ACR. Exported for unit testing.
 */
export function makeTar(files: TemplateFile[]): Buffer {
  const chunks: Buffer[] = [];
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  for (const f of sorted) {
    const body = Buffer.from(f.content, 'utf8');
    chunks.push(tarHeader(f.path, body.length));
    chunks.push(body);
    const pad = (512 - (body.length % 512)) % 512;
    if (pad) chunks.push(Buffer.alloc(pad, 0));
  }
  // Two 512-byte zero blocks terminate the archive.
  chunks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// Container-app ARM body builder (external ingress, autoscale-to-zero, OAuth).
// ---------------------------------------------------------------------------

export interface BuildAcaBodyOptions {
  /** Container-app name (DNS-label safe). */
  name: string;
  /** Managed-environment resource id. */
  environmentId: string;
  location: string;
  /** UAMI assigned to the app (resolves ACR pull + KV secrets). */
  uamiId: string;
  /** Full image reference (loginServer/repo:tag). */
  image: string;
  /** Ingress target port (matches the container's listen port). */
  targetPort: number;
  /** ACR login server for the registry credential entry. */
  acrLoginServer: string;
  /** Structured env vars (names must be allowlisted — validated here). */
  env?: LoomAppEnvVar[];
  /** DEFAULT-ON scale-to-zero: minReplicas defaults to 0 (rest cost ~$0). */
  minReplicas?: number;
  maxReplicas?: number;
  /** CPU cores (default 0.5). */
  cpu?: number;
  /** Memory (default '1Gi'). */
  memory?: string;
  /** External ingress (public URL). Default true — a hosted app needs a URL. */
  external?: boolean;
}

export class LoomAppSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LoomAppSpecError';
  }
}

/**
 * Build the Microsoft.App/containerApps ARM body for a hosted Loom app. Pure —
 * no I/O. Enforces the env-name allowlist and the scale-to-zero floor so the
 * default-ON, cost-bounded posture (per WAVES.md) is structural, not a gate.
 */
export function buildAcaAppBody(opts: BuildAcaBodyOptions): Record<string, unknown> {
  if (!opts.name) throw new LoomAppSpecError('name required');
  if (!opts.environmentId) throw new LoomAppSpecError('environmentId required');
  if (!opts.image) throw new LoomAppSpecError('image required');
  if (!(opts.targetPort > 0)) throw new LoomAppSpecError('targetPort required');
  for (const e of opts.env || []) {
    if (!isAllowedAppEnvName(e.name)) {
      throw new LoomAppSpecError(`env name "${e.name}" is not allowlisted for the Loom Apps deploy path`);
    }
    if (e.value !== undefined && e.secretRef !== undefined) {
      throw new LoomAppSpecError(`env "${e.name}" cannot set both value and secretRef`);
    }
  }
  const minReplicas = typeof opts.minReplicas === 'number' ? Math.max(0, opts.minReplicas) : 0;
  const maxReplicas = typeof opts.maxReplicas === 'number' ? Math.max(1, opts.maxReplicas) : 3;
  const env = (opts.env || []).map((e) =>
    e.secretRef !== undefined ? { name: e.name, secretRef: e.secretRef } : { name: e.name, value: e.value ?? '' },
  );
  // Always inject PORT so the container binds the ingress target port.
  if (!env.find((e) => e.name === 'PORT')) env.push({ name: 'PORT', value: String(opts.targetPort) });

  return {
    location: opts.location,
    tags: { 'csa-loom': 'loom-app-runtime' },
    identity: {
      type: 'UserAssigned',
      userAssignedIdentities: { [opts.uamiId]: {} },
    },
    properties: {
      managedEnvironmentId: opts.environmentId,
      configuration: {
        activeRevisionsMode: 'Single',
        ingress: {
          external: opts.external !== false,
          targetPort: opts.targetPort,
          transport: 'auto',
          allowInsecure: false,
          traffic: [{ latestRevision: true, weight: 100 }],
        },
        registries: [{ server: opts.acrLoginServer, identity: opts.uamiId }],
      },
      template: {
        containers: [
          {
            name: opts.name,
            image: opts.image,
            env,
            resources: { cpu: opts.cpu ?? 0.5, memory: opts.memory ?? '1Gi' },
          },
        ],
        scale: {
          minReplicas,
          maxReplicas,
          ...(minReplicas === 0
            ? { rules: [{ name: 'http-scale', http: { metadata: { concurrentRequests: '20' } } }] }
            : {}),
        },
      },
    },
  };
}

/**
 * Build the Entra Easy-Auth authConfig child-resource body
 * (Microsoft.App/containerApps/authConfigs/current) so the hosted app requires
 * a Loom-tenant sign-in — the OAuth wrapper the PRP specifies (the app inherits
 * the caller's Entra identity, mirroring Databricks Apps' OAuth-to-UC). Uses the
 * Console's EXISTING MSAL Entra app registration (no new app reg). Pure builder;
 * the client only PUTs it when the MSAL client id + tenant are configured.
 */
export function buildAuthConfigBody(opts: {
  clientId: string;
  /** openIdIssuer, e.g. https://login.microsoftonline.com/<tenantId>/v2.0 */
  openIdIssuer: string;
  /** KV-backed ACA secret name holding the client secret, if wired. */
  clientSecretRef?: string;
}): Record<string, unknown> {
  return {
    properties: {
      platform: { enabled: true },
      globalValidation: {
        unauthenticatedClientAction: 'RedirectToLoginPage',
        redirectToProvider: 'azureactivedirectory',
      },
      identityProviders: {
        azureActiveDirectory: {
          enabled: true,
          registration: {
            clientId: opts.clientId,
            openIdIssuer: opts.openIdIssuer,
            ...(opts.clientSecretRef ? { clientSecretSettingName: opts.clientSecretRef } : {}),
          },
          validation: {
            // Accept the app's own audience; issuer validation is via openIdIssuer.
            allowedAudiences: [`api://${opts.clientId}`, opts.clientId],
          },
        },
      },
      login: { preserveUrlFragmentsForLogins: false },
    },
  };
}

// ---------------------------------------------------------------------------
// Naming helpers
// ---------------------------------------------------------------------------

const APP_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;

export function isValidLoomAppName(name: string): boolean {
  return APP_NAME_RE.test(name);
}

/**
 * Derive a DNS-label-safe Container App name from the Loom item id + a short
 * random suffix (uniqueness within the environment). ≤ 32 chars, starts with a
 * letter, lowercase alnum + single hyphens.
 */
export function loomAppContainerName(itemId: string): string {
  const stem = `app-${itemId}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
  const rand = Math.random().toString(36).slice(2, 6);
  const base = stem.slice(0, 32 - rand.length - 1).replace(/-+$/, '') || 'app';
  const name = `${base}-${rand}`;
  return /^[a-z]/.test(name) ? name : `a${name.slice(0, 31)}`;
}
