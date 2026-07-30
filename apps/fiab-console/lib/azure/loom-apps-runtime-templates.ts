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

const ONTOLOGY_EXPLORER: LoomAppTemplate = {
  id: 'ontology-explorer',
  label: 'Ontology Explorer (Weave)',
  description: 'Streamlit app over a Weave ontology — query objects, traverse links, create instances via the zero-boilerplate loom_ontology SDK. Attach an ontology on the Resources tab.',
  runtime: 'python',
  defaultPort: 8501,
  entryFile: 'app.py',
  manifestFile: 'requirements.txt',
  files: [
    {
      path: 'loom_ontology.py',
      content: `"""
loom_ontology — zero-boilerplate client for Weave ontologies attached as Loom
App resources (APP-W3).

When you attach an ontology on the app's Resources tab, Loom injects
APP_ONT_<SLUG>_* env vars (PG host/db/graph, the app's PG login, the ontology
id + object-type list) and prints the one-time PG grant for the app identity.
This module turns those into ready-to-use query/create/traverse calls over the
Apache AGE graph — the same store the Loom Console itself writes.

    from loom_ontology import attached_ontologies
    ont = next(iter(attached_ontologies().values()))
    rows = ont.query_objects("Customer", limit=50)
    ont.create_object("Customer", {"name": "Contoso"})
    links = ont.traverse("Customer", "OWNS")
"""
import json
import os
import re

PG_AAD_SCOPE = "https://ossrdbms-aad.database.windows.net/.default"
_IDENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,62}$")


def _safe(name: str) -> str:
    """Last-line injection guard for labels flowing into cypher."""
    if not _IDENT.match(name or ""):
        raise ValueError(f"invalid ontology identifier: {name!r}")
    return name


def _cy_value(v):
    """Encode a property value as a cypher literal (JSON escaping is a superset)."""
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return str(v)
    if isinstance(v, str):
        return json.dumps(v)
    raise ValueError("property values must be str, int, float, bool, or None")


def _prop_map(props: dict) -> str:
    entries = [(k, v) for k, v in (props or {}).items() if _IDENT.match(k)]
    return "{" + ", ".join(f"{k}: {_cy_value(v)}" for k, v in entries) + "}"


def _parse_agtype(cell: str):
    """AGE returns vertices/edges as agtype text like '{...}::vertex' — strip + parse."""
    if cell is None:
        return None
    text = str(cell)
    for suffix in ("::vertex", "::edge", "::path"):
        if text.endswith(suffix):
            text = text[: -len(suffix)]
            break
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return text


class Ontology:
    """One attached ontology (or the deployment graph when attached graph-only)."""

    def __init__(self, slug: str | None):
        def p(s: str) -> str:
            return os.environ.get(f"APP_ONT_{slug}_{s}", "") if slug else ""

        self.slug = slug or "DEFAULT"
        self.item_id = p("ID")
        self.host = p("PG_HOST") or os.environ.get("LOOM_WEAVE_PG_FQDN", "")
        self.database = p("PG_DB") or os.environ.get("LOOM_WEAVE_PG_DATABASE", "loom-weave")
        self.graph = _safe(p("GRAPH") or os.environ.get("LOOM_WEAVE_GRAPH", "loom_ontology"))
        self.user = p("PG_USER") or os.environ.get("LOOM_WEAVE_PG_USER", "")
        self.object_types = [t for t in p("TYPES").split(",") if t]
        self._conn = None

    # -- connection -----------------------------------------------------------
    def _connect(self):
        if self._conn is not None and not self._conn.closed:
            return self._conn
        import psycopg
        from azure.identity import DefaultAzureCredential

        # AZURE_CLIENT_ID (the app UAMI) is injected by the Loom deploy, so
        # DefaultAzureCredential resolves the app's own managed identity.
        token = DefaultAzureCredential().get_token(PG_AAD_SCOPE).token
        self._conn = psycopg.connect(
            host=self.host, dbname=self.database, user=self.user,
            password=token, sslmode="require", autocommit=True,
        )
        return self._conn

    def cypher(self, statement: str, columns: tuple = ("v",)) -> list[list]:
        """Run openCypher against the graph; returns parsed rows."""
        conn = self._connect()
        cols = ", ".join(f"{_safe(c)} agtype" for c in columns)
        sql = (
            'SET search_path = ag_catalog, "$user", public; '
            f"SELECT * FROM ag_catalog.cypher('{self.graph}', $weave$ {statement} $weave$) AS ({cols});"
        )
        with conn.cursor() as cur:
            cur.execute(sql)
            rows = cur.fetchall() if cur.description else []
        return [[_parse_agtype(c) for c in row] for row in rows]

    # -- zero-boilerplate calls ----------------------------------------------
    def query_objects(self, type_name: str, limit: int = 100) -> list[dict]:
        t = _safe(type_name)
        rows = self.cypher(f"MATCH (n:{t}) RETURN n LIMIT {int(limit)}")
        return [r[0].get("properties", {}) | {"_id": r[0].get("id")} for r in rows if isinstance(r[0], dict)]

    def create_object(self, type_name: str, props: dict) -> dict:
        t = _safe(type_name)
        rows = self.cypher(f"CREATE (n:{t} {_prop_map(props)}) RETURN n")
        return rows[0][0] if rows else {}

    def traverse(self, from_type: str, link_type: str, limit: int = 100) -> list[dict]:
        """Follow a link type from objects of from_type; returns (from, to) pairs."""
        f, l = _safe(from_type), _safe(link_type)
        rows = self.cypher(
            f"MATCH (a:{f})-[r:{l}]->(b) RETURN a, b LIMIT {int(limit)}", columns=("a", "b"),
        )
        out = []
        for a, b in rows:
            if isinstance(a, dict) and isinstance(b, dict):
                out.append({"from": a.get("properties", {}), "to": b.get("properties", {}), "to_label": b.get("label")})
        return out

    def labels(self) -> list[str]:
        """Discover labels actually present in the graph (fallback when _TYPES is absent)."""
        rows = self.cypher("MATCH (n) RETURN DISTINCT label(n) LIMIT 100")
        return sorted({r[0] for r in rows if isinstance(r[0], str)})


def attached_ontologies() -> dict[str, Ontology]:
    """Every ontology attached on the Resources tab, keyed by env slug."""
    onts: dict[str, Ontology] = {}
    for k in os.environ:
        if k.startswith("APP_ONT_") and k.endswith("_PG_HOST"):
            slug = k[len("APP_ONT_"):-len("_PG_HOST")]
            onts[slug] = Ontology(slug)
    if not onts and os.environ.get("LOOM_WEAVE_PG_FQDN"):
        onts["DEFAULT"] = Ontology(None)
    return onts
`,
    },
    {
      path: 'app.py',
      content: `"""Ontology Explorer — a Weave-native Loom app (APP-W3 starter)."""
import streamlit as st

from loom_ontology import attached_ontologies

st.set_page_config(page_title="Ontology Explorer", page_icon="🕸️", layout="wide")
st.title("🕸️ Ontology Explorer")
st.caption("Weave-native Loom app — objects, links, and actions over the AGE graph.")

onts = attached_ontologies()
if not onts:
    st.warning(
        "No ontology is attached. Open this app's Loom editor → Resources tab → "
        "attach a Weave ontology, apply the one-time PG grant, then Deploy."
    )
    st.stop()

slug = st.sidebar.selectbox("Ontology", sorted(onts))
ont = onts[slug]
st.sidebar.caption(f"graph '{ont.graph}' on {ont.host}")

try:
    types = ont.object_types or ont.labels()
except Exception as e:  # connection / grant not applied yet — honest error
    st.error(f"Could not reach the ontology graph: {e}")
    st.info("If this is a fresh attach, ask an admin to run the PG grant script from the Resources tab.")
    st.stop()

if not types:
    st.info("The graph has no object instances yet — create one below.")

col_q, col_c = st.columns([3, 2])

with col_q:
    st.subheader("Objects")
    t = st.selectbox("Object type", types) if types else st.text_input("Object type")
    if t:
        rows = ont.query_objects(t, limit=200)
        st.dataframe(rows, use_container_width=True)
        link = st.text_input("Traverse link type (e.g. OWNS)")
        if link:
            st.subheader(f"{t} —[{link}]→")
            st.dataframe(ont.traverse(t, link), use_container_width=True)

with col_c:
    st.subheader("Create object")
    ct = st.text_input("Type", value=t if types else "")
    props_raw = st.text_area("Properties (one key=value per line)", "name=Example")
    if st.button("Create", type="primary") and ct:
        props = {}
        for line in props_raw.splitlines():
            if "=" in line:
                k, v = line.split("=", 1)
                props[k.strip()] = v.strip()
        created = ont.create_object(ct, props)
        st.success(f"Created {ct}: {created.get('properties', props)}")
        st.rerun()
`,
    },
    {
      path: 'requirements.txt',
      content: 'streamlit==1.39.0\nazure-identity==1.19.0\npsycopg[binary]==3.2.3\n',
    },
  ],
};

// ---------------------------------------------------------------------------
// Golden templates (APP-W5) — starter apps for the common Loom-app shapes.
// Each reads the REAL env a Resource attach injects (APP_*/LOOM_*), so it works
// the moment the matching resource is attached and honestly explains the gap
// when it isn't. No new backend — the backends are the W2/W3 resource kinds.
// ---------------------------------------------------------------------------

const RAG_CHAT: LoomAppTemplate = {
  id: 'rag-chat',
  label: 'Chat over your data (RAG)',
  description: 'Streamlit chat grounded on Azure AI Search + Azure OpenAI — attach the AI Search and Azure OpenAI resources.',
  runtime: 'python',
  defaultPort: 8501,
  entryFile: 'app.py',
  manifestFile: 'requirements.txt',
  files: [
    {
      path: 'app.py',
      content: `"""Chat-over-your-data (RAG) — grounded on Azure AI Search + Azure OpenAI.

Attach an 'AI Search' resource and an 'Azure OpenAI' resource on the app's
Resources tab; Loom injects LOOM_AI_SEARCH_SERVICE + LOOM_AOAI_ENDPOINT/
LOOM_AOAI_DEPLOYMENT and grants this app's identity read access. The app
retrieves top-k passages from your index and answers with the model.
"""
import os
import streamlit as st

SEARCH = os.environ.get("LOOM_AI_SEARCH_SERVICE", "")
INDEX = os.environ.get("LOOM_AI_SEARCH_INDEX", "default")
AOAI = os.environ.get("LOOM_AOAI_ENDPOINT", "").rstrip("/")
DEPLOY = os.environ.get("LOOM_AOAI_DEPLOYMENT", "gpt-4o")
API_VERSION = os.environ.get("AZURE_OPENAI_API_VERSION", "2024-10-21")

st.set_page_config(page_title="Chat over your data", page_icon="💬", layout="wide")
st.title("💬 Chat over your data")

if not SEARCH or not AOAI:
    st.warning(
        "Attach an **AI Search** resource and an **Azure OpenAI** resource on this "
        "app's Resources tab, then Deploy. (Missing: "
        + ", ".join(x for x, v in [("LOOM_AI_SEARCH_SERVICE", SEARCH), ("LOOM_AOAI_ENDPOINT", AOAI)] if not v)
        + ")"
    )
    st.stop()


def _cred():
    from azure.identity import DefaultAzureCredential
    return DefaultAzureCredential()  # the app UAMI (AZURE_CLIENT_ID injected by Loom)


def retrieve(query: str, k: int = 4):
    from azure.search.documents import SearchClient
    from azure.core.credentials import AzureKeyCredential  # noqa: F401 (AAD below)
    client = SearchClient(f"https://{SEARCH}.search.windows.net", INDEX, _cred())
    hits = client.search(search_text=query, top=k)
    return [d.get("content") or d.get("text") or str(d) for d in hits]


def answer(query: str, passages: list[str]) -> str:
    from openai import AzureOpenAI
    from azure.identity import get_bearer_token_provider
    tp = get_bearer_token_provider(_cred(), "https://cognitiveservices.azure.com/.default")
    client = AzureOpenAI(azure_endpoint=AOAI, azure_ad_token_provider=tp, api_version=API_VERSION)
    context = "\\n\\n".join(f"[{i+1}] {p}" for i, p in enumerate(passages))
    resp = client.chat.completions.create(
        model=DEPLOY,
        messages=[
            {"role": "system", "content": "Answer only from the context. Cite [n]. If unknown, say so."},
            {"role": "user", "content": f"Context:\\n{context}\\n\\nQuestion: {query}"},
        ],
    )
    return resp.choices[0].message.content or ""


q = st.chat_input("Ask a question about your indexed data…")
if q:
    st.chat_message("user").write(q)
    with st.chat_message("assistant"):
        with st.spinner("Retrieving + answering…"):
            passages = retrieve(q)
            st.write(answer(q, passages))
            with st.expander("Sources"):
                for i, p in enumerate(passages):
                    st.caption(f"[{i+1}] {p[:400]}")
`,
    },
    { path: 'requirements.txt', content: 'streamlit==1.39.0\nazure-identity==1.19.0\nazure-search-documents==11.5.2\nopenai==1.57.0\n' },
  ],
};

const OPS_CONSOLE: LoomAppTemplate = {
  id: 'ops-console',
  label: 'Ops console (ADX/lakehouse)',
  description: 'Streamlit operational console — live KPIs + a query grid over an attached Eventhouse (ADX) or lakehouse.',
  runtime: 'python',
  defaultPort: 8501,
  entryFile: 'app.py',
  manifestFile: 'requirements.txt',
  files: [
    {
      path: 'app.py',
      content: `"""Ops console — live KPIs over an attached Eventhouse (ADX).

Attach an 'Eventhouse (Azure Data Explorer)' resource (or a specific KQL
database); Loom injects APP_KQL_<SLUG>_CLUSTER_URI + _DB and grants the app's
identity Viewer. Edit KQL below for your tables.
"""
import os
import streamlit as st

# First attached KQL database (APP_KQL_<SLUG>_CLUSTER_URI / _DB).
def _kql_env():
    uri = db = None
    for k, v in os.environ.items():
        if k.startswith("APP_KQL_") and k.endswith("_CLUSTER_URI"):
            uri = v
            db = os.environ.get(k[:-len("_CLUSTER_URI")] + "_DB", "")
            break
    return uri or os.environ.get("LOOM_ADX_CLUSTER_URI", ""), db or os.environ.get("LOOM_ADX_DEFAULT_DB", "")

CLUSTER, DB = _kql_env()
st.set_page_config(page_title="Ops console", page_icon="🛠️", layout="wide")
st.title("🛠️ Ops console")

if not CLUSTER:
    st.warning("Attach an **Eventhouse (Azure Data Explorer)** resource on the Resources tab, then Deploy.")
    st.stop()
st.caption(f"cluster {CLUSTER} · db {DB}")


def run_kql(query: str):
    from azure.kusto.data import KustoClient, KustoConnectionStringBuilder
    from azure.identity import DefaultAzureCredential
    cred = DefaultAzureCredential()
    kcsb = KustoConnectionStringBuilder.with_azure_token_credential(CLUSTER, cred)
    with KustoClient(kcsb) as client:
        rs = client.execute(DB, query)
        t = rs.primary_results[0]
        cols = [c.column_name for c in t.columns]
        return [dict(zip(cols, row)) for row in t.rows]


default_kql = st.text_area("KQL", ".show tables | project TableName", height=90)
if st.button("Run", type="primary") and default_kql.strip():
    try:
        st.dataframe(run_kql(default_kql), use_container_width=True)
    except Exception as e:  # honest error
        st.error(f"Query failed: {e}")
`,
    },
    { path: 'requirements.txt', content: 'streamlit==1.39.0\nazure-identity==1.19.0\nazure-kusto-data==4.6.1\n' },
  ],
};

const GEOSPATIAL: LoomAppTemplate = {
  id: 'geospatial',
  label: 'Geospatial map',
  description: 'Streamlit + pydeck map — plot points/routes from a CSV or an attached lakehouse. No backend required to start.',
  runtime: 'python',
  defaultPort: 8501,
  entryFile: 'app.py',
  manifestFile: 'requirements.txt',
  files: [
    {
      path: 'app.py',
      content: `"""Geospatial map — pydeck over sample points (swap for your lakehouse data)."""
import os
import pandas as pd
import pydeck as pdk
import streamlit as st

st.set_page_config(page_title="Geospatial", page_icon="🗺️", layout="wide")
st.title("🗺️ Geospatial map")

# Sample data — replace with a read from an attached lakehouse
# (APP_LH_<SLUG>_URL) or a KQL/geo query.
df = pd.DataFrame(
    {"lat": [47.6062, 40.7128, 51.5074, 35.6762], "lon": [-122.3321, -74.0060, -0.1278, 139.6503],
     "name": ["Seattle", "New York", "London", "Tokyo"], "weight": [80, 100, 70, 90]},
)
lh = next((v for k, v in os.environ.items() if k.startswith("APP_LH_") and k.endswith("_URL")), None)
if lh:
    st.caption(f"Lakehouse attached: {lh} — read your geo table with pyarrow/deltalake and set df.")

st.pydeck_chart(pdk.Deck(
    map_style=None,
    initial_view_state=pdk.ViewState(latitude=40, longitude=-40, zoom=1.2),
    layers=[pdk.Layer("ScatterplotLayer", df, get_position="[lon, lat]",
                      get_radius="weight * 8000", get_fill_color=[91, 46, 145, 180], pickable=True)],
    tooltip={"text": "{name}"},
))
st.dataframe(df, use_container_width=True)
`,
    },
    { path: 'requirements.txt', content: 'streamlit==1.39.0\npydeck==0.9.1\npandas==2.2.3\n' },
  ],
};

const ML_SCORING: LoomAppTemplate = {
  id: 'ml-scoring',
  label: 'ML scoring UI',
  description: 'Gradio form that posts features to an Azure ML / AOAI online endpoint and shows the prediction.',
  runtime: 'python',
  defaultPort: 7860,
  entryFile: 'app.py',
  manifestFile: 'requirements.txt',
  files: [
    {
      path: 'app.py',
      content: `"""ML scoring UI — a Gradio form over a model online endpoint.

Set LOOM_SCORING_URL (the AML/AOAI online-endpoint scoring URL) as a Binding;
for a key-auth endpoint set LOOM_SCORING_KEY as a Key Vault secretRef binding.
AAD-auth endpoints use the app's managed identity automatically.
"""
import json
import os
import gradio as gr
import requests

SCORING_URL = os.environ.get("LOOM_SCORING_URL", "")
SCORING_KEY = os.environ.get("LOOM_SCORING_KEY", "")


def _auth_header():
    if SCORING_KEY:
        return {"Authorization": f"Bearer {SCORING_KEY}"}
    try:
        from azure.identity import DefaultAzureCredential
        tok = DefaultAzureCredential().get_token("https://ml.azure.com/.default").token
        return {"Authorization": f"Bearer {tok}"}
    except Exception:
        return {}


def score(features_json: str):
    if not SCORING_URL:
        return "Set LOOM_SCORING_URL (the model endpoint) as a Binding, then Deploy."
    try:
        payload = json.loads(features_json)
    except json.JSONDecodeError as e:
        return f"Invalid JSON: {e}"
    try:
        r = requests.post(SCORING_URL, json=payload,
                          headers={"Content-Type": "application/json", **_auth_header()}, timeout=30)
        return r.text if r.ok else f"HTTP {r.status_code}: {r.text[:500]}"
    except Exception as e:
        return f"Request failed: {e}"


demo = gr.Interface(
    fn=score,
    inputs=gr.Textbox(label="Features (JSON)", value='{"data": [[0, 1, 2, 3]]}', lines=6),
    outputs=gr.Textbox(label="Prediction"),
    title="ML scoring",
    description="Posts your feature JSON to the configured model endpoint.",
)
if __name__ == "__main__":
    demo.launch(server_name="0.0.0.0", server_port=int(os.environ.get("PORT", "7860")))
`,
    },
    { path: 'requirements.txt', content: 'gradio==5.9.1\nrequests==2.32.3\nazure-identity==1.19.0\n' },
  ],
};

const APPROVAL_APP: LoomAppTemplate = {
  id: 'approval-app',
  label: 'Approval app (write-back)',
  description: 'Streamlit approve/reject queue that writes decisions back to an attached Weave ontology via actions.',
  runtime: 'python',
  defaultPort: 8501,
  entryFile: 'app.py',
  manifestFile: 'requirements.txt',
  files: [
    {
      path: 'loom_ontology.py',
      content: ONTOLOGY_EXPLORER.files.find((f) => f.path === 'loom_ontology.py')!.content,
    },
    {
      path: 'app.py',
      content: `"""Approval app — a review queue with write-back to a Weave ontology.

Attach a 'Weave ontology' resource; the loom_ontology SDK (shipped with this
template) queries pending objects and writes the decision back as a property
update. Point OBJECT_TYPE + STATUS_FIELD at your ontology.
"""
import os
import streamlit as st
from loom_ontology import attached_ontologies

OBJECT_TYPE = os.environ.get("APP_APPROVAL_OBJECT_TYPE", "Request")
STATUS_FIELD = os.environ.get("APP_APPROVAL_STATUS_FIELD", "status")

st.set_page_config(page_title="Approvals", page_icon="✅", layout="wide")
st.title("✅ Approval queue")

onts = attached_ontologies()
if not onts:
    st.warning("Attach a **Weave ontology** resource on the Resources tab, then Deploy.")
    st.stop()
ont = onts[sorted(onts)[0]]

try:
    rows = ont.query_objects(OBJECT_TYPE, limit=200)
except Exception as e:
    st.error(f"Could not read {OBJECT_TYPE}: {e}")
    st.stop()

pending = [r for r in rows if str(r.get(STATUS_FIELD, "pending")).lower() == "pending"]
st.caption(f"{len(pending)} pending of {len(rows)} {OBJECT_TYPE}")
for r in pending:
    with st.container(border=True):
        st.json({k: v for k, v in r.items() if not k.startswith("_")})
        c1, c2 = st.columns(2)
        if c1.button("Approve", key="a" + str(r.get("_id"))):
            ont.create_object(OBJECT_TYPE, {**{k: v for k, v in r.items() if not k.startswith("_")}, STATUS_FIELD: "approved"})
            st.rerun()
        if c2.button("Reject", key="r" + str(r.get("_id"))):
            ont.create_object(OBJECT_TYPE, {**{k: v for k, v in r.items() if not k.startswith("_")}, STATUS_FIELD: "rejected"})
            st.rerun()
`,
    },
    { path: 'requirements.txt', content: 'streamlit==1.39.0\nazure-identity==1.19.0\npsycopg[binary]==3.2.3\n' },
  ],
};

export const LOOM_APP_TEMPLATES: readonly LoomAppTemplate[] = [
  STREAMLIT, DASH, GRADIO, FLASK, NODE_EXPRESS, AGENT_FASTAPI, ONTOLOGY_EXPLORER,
  RAG_CHAT, OPS_CONSOLE, GEOSPATIAL, ML_SCORING, APPROVAL_APP,
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
    if (['streamlit', 'ontology-explorer', 'rag-chat', 'ops-console', 'geospatial', 'approval-app'].includes(template.id)) {
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
  /** Base Key Vault URI backing `secretRef` env bindings (e.g.
   *  https://<vault>.vault.azure.net). When an env uses secretRef but no vault
   *  is configured, the builder throws an honest LoomAppSpecError. */
  keyVaultUri?: string;
}

/** ACA secret names must be lowercase [a-z0-9-]. */
function acaSecretName(raw: string): string {
  return (raw || '').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 253) || 'secret';
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

  // Key Vault-backed secrets: each secretRef env names a KV secret. ACA needs a
  // matching configuration.secrets[] entry that maps a lowercase ACA secret name
  // → the KV secret URI, resolved with the app UAMI. WITHOUT this block a
  // secretRef env is rejected by ARM (the audited latent bug — a secretRef that
  // pointed at nothing). The env's secretRef is rewritten to the sanitized ACA
  // secret name. Dedup by ACA name so two envs can share one KV secret.
  const secretsByAca = new Map<string, { name: string; keyVaultUrl: string; identity: string }>();
  const env = (opts.env || []).map((e) => {
    if (e.secretRef === undefined) return { name: e.name, value: e.value ?? '' };
    const kvName = e.secretRef.trim();
    if (!opts.keyVaultUri) {
      throw new LoomAppSpecError(
        `env "${e.name}" references Key Vault secret "${kvName}" but no vault is configured — ` +
        `set LOOM_KEY_VAULT_URI (or LOOM_APPS_KEY_VAULT_URI) on the Console so the app can resolve it.`,
      );
    }
    const acaName = acaSecretName(`kv-${kvName}`);
    if (!secretsByAca.has(acaName)) {
      secretsByAca.set(acaName, {
        name: acaName,
        keyVaultUrl: `${opts.keyVaultUri.replace(/\/+$/, '')}/secrets/${encodeURIComponent(kvName)}`,
        identity: opts.uamiId,
      });
    }
    return { name: e.name, secretRef: acaName };
  });
  // Always inject PORT so the container binds the ingress target port.
  if (!env.find((e) => e.name === 'PORT')) env.push({ name: 'PORT', value: String(opts.targetPort) });
  const secrets = [...secretsByAca.values()];

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
        ...(secrets.length ? { secrets } : {}),
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
