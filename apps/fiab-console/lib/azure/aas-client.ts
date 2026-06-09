/**
 * aas-client — TMSL (Tabular Model Scripting Language) builders + the optional
 * write surfaces for the Loom semantic-model "Model view" (relationships +
 * hierarchies).
 *
 * NO-FABRIC-DEPENDENCY (.claude/rules/no-fabric-dependency.md): the semantic
 * model's Azure-native DEFAULT is the Loom-native tabular layer — relationships
 * and hierarchies are persisted in Cosmos (see _lib/semantic-model-store.ts)
 * and the canvas + hierarchy editor render fully with NEITHER a Fabric/Power BI
 * workspace NOR an Analysis Services server. The TMSL produced here is shown
 * read-only in the editor (the "model.bim" preview) so the operator sees exactly
 * what would be written.
 *
 * Two OPT-IN write backends are provided, each honestly gated:
 *   • Azure Analysis Services (XMLA-over-HTTP) — selected when
 *     LOOM_AAS_XMLA_ENDPOINT is set. AAS is the azure-native, no-Fabric option.
 *   • Microsoft Fabric / Power BI Premium (REST updateDefinition) — selected
 *     ONLY when LOOM_SEMANTIC_MODEL_BACKEND=fabric (per the opt-in rule). Never
 *     on the default path.
 *
 * All TMSL builder functions are pure (no I/O) and unit-tested. The write
 * functions return `{ ok, error }` rather than throwing on a non-fatal fault so
 * the BFF route can persist to Cosmos first and surface the backend result as a
 * MessageBar without failing the whole request.
 *
 * TMSL refs:
 *   relationship object  — https://learn.microsoft.com/analysis-services/tmsl/relationships-object-tmsl
 *   hierarchy object     — https://learn.microsoft.com/analysis-services/tmsl/hierarchies-object-tmsl
 *   createOrReplace      — https://learn.microsoft.com/analysis-services/tmsl/createorreplace-command-tmsl
 *   alter command        — https://learn.microsoft.com/analysis-services/tmsl/alter-command-tmsl
 *   XMLA Execute/Command — https://learn.microsoft.com/analysis-services/xmla/xml-elements-commands
 */

import { ChainedTokenCredential, DefaultAzureCredential, ManagedIdentityCredential } from '@azure/identity';
import { buildModelBimTmsl, type TmslRelationship } from './aas-tmsl';

// Re-export the pure TMSL builders + types so callers can import them from
// aas-client (the route does). The builders live in aas-tmsl.ts (zero imports)
// so they stay trivially unit-testable without the @azure/identity weight.
export {
  buildCreateOrReplaceRelationshipTmsl,
  buildDeleteRelationshipTmsl,
  buildAlterTableHierarchyTmsl,
  buildModelBimTmsl,
} from './aas-tmsl';
export type {
  TmslCardinality, TmslCrossFilter, TmslRelationship,
  TmslHierarchyLevel, TmslHierarchy, TmslColumn, TmslTable,
} from './aas-tmsl';

const AAS_XMLA_ENDPOINT = process.env.LOOM_AAS_XMLA_ENDPOINT;
const AAS_SCOPE = process.env.LOOM_AAS_SCOPE || 'https://*.asazure.windows.net/.default';
const FABRIC_BASE = process.env.LOOM_FABRIC_BASE || 'https://api.fabric.microsoft.com/v1';
const FABRIC_SCOPE = 'https://api.fabric.microsoft.com/.default';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential = uamiClientId
  ? new ChainedTokenCredential(new ManagedIdentityCredential({ clientId: uamiClientId }), new DefaultAzureCredential())
  : new DefaultAzureCredential();

/** Azure Analysis Services (XMLA) write availability — azure-native, no Fabric. */
export function aasConfig(): { available: boolean; endpoint?: string } {
  return AAS_XMLA_ENDPOINT ? { available: true, endpoint: AAS_XMLA_ENDPOINT } : { available: false };
}

/**
 * Fabric / Power BI write availability. Per no-fabric-dependency.md this is
 * STRICTLY opt-in: the operator must set LOOM_SEMANTIC_MODEL_BACKEND=fabric.
 * Never true on the default path.
 */
export function fabricWriteEnabled(): boolean {
  return process.env.LOOM_SEMANTIC_MODEL_BACKEND === 'fabric';
}

// ---------------------------------------------------------------------------
// Azure Analysis Services — XMLA over HTTP (SOAP Execute/Command/Statement).
// ---------------------------------------------------------------------------

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function soapEnvelope(tmslJson: string, database: string): string {
  // The TMSL JSON is carried verbatim as the <Statement> text of an XMLA
  // Execute/Command. XML-escape it so braces/quotes survive the SOAP transport.
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<Envelope xmlns="http://schemas.xmlsoap.org/soap/envelope/">' +
    '<Body>' +
    '<Execute xmlns="urn:schemas-microsoft-com:xml-analysis">' +
    '<Command><Statement>' + xmlEscape(tmslJson) + '</Statement></Command>' +
    '<Properties><PropertyList>' +
    '<Catalog>' + xmlEscape(database) + '</Catalog>' +
    '</PropertyList></Properties>' +
    '</Execute>' +
    '</Body>' +
    '</Envelope>'
  );
}

/**
 * Post a TMSL command to the Azure Analysis Services XMLA HTTP endpoint. Returns
 * `{ ok:false, error }` (does not throw) on an XMLA fault so the caller can keep
 * the Cosmos write and surface the backend result.
 */
export async function executeAasXmla(tmslJson: string, database: string): Promise<{ ok: boolean; error?: string }> {
  if (!AAS_XMLA_ENDPOINT) {
    return { ok: false, error: 'LOOM_AAS_XMLA_ENDPOINT is not set — XMLA write is not configured.' };
  }
  let token: string;
  try {
    const t = await credential.getToken(AAS_SCOPE);
    if (!t?.token) return { ok: false, error: `Failed to acquire AAD token for ${AAS_SCOPE}.` };
    token = t.token;
  } catch (e: any) {
    return { ok: false, error: `Token acquisition failed: ${e?.message || String(e)}` };
  }
  try {
    const res = await fetch(AAS_XMLA_ENDPOINT, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${token}`,
        'content-type': 'text/xml; charset=utf-8',
        'soapaction': '"urn:schemas-microsoft-com:xml-analysis:Execute"',
      },
      body: soapEnvelope(tmslJson, database),
      cache: 'no-store',
    });
    const text = await res.text();
    if (!res.ok) {
      return { ok: false, error: `XMLA HTTP ${res.status}: ${text.slice(0, 600)}` };
    }
    // An XMLA fault returns HTTP 200 with a <soap:Fault>/<Exception>/<Error>
    // element in the body — treat that as a backend error.
    if (/<(soap:)?Fault\b/i.test(text) || /<Error\b/i.test(text) || /<Exception\b/i.test(text)) {
      return { ok: false, error: `XMLA fault: ${text.slice(0, 600)}` };
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

// ---------------------------------------------------------------------------
// Fabric / Power BI Premium — REST updateDefinition (opt-in only).
// ---------------------------------------------------------------------------

/**
 * Overwrite a Fabric semantic model's `model.bim` via the REST
 * updateDefinition endpoint. Follows the 202 long-running-operation poll.
 * Opt-in only (gated by fabricWriteEnabled() in the caller).
 */
export async function updateFabricSemanticModelTmsl(
  workspaceId: string,
  semanticModelId: string,
  tmslFullModel: string,
): Promise<{ ok: boolean; error?: string }> {
  let token: string;
  try {
    const t = await credential.getToken(FABRIC_SCOPE);
    if (!t?.token) return { ok: false, error: `Failed to acquire AAD token for ${FABRIC_SCOPE}.` };
    token = t.token;
  } catch (e: any) {
    return { ok: false, error: `Token acquisition failed: ${e?.message || String(e)}` };
  }
  const payloadB64 = Buffer.from(tmslFullModel, 'utf8').toString('base64');
  const url =
    `${FABRIC_BASE}/workspaces/${encodeURIComponent(workspaceId)}` +
    `/semanticModels/${encodeURIComponent(semanticModelId)}/updateDefinition`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'authorization': `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        definition: {
          parts: [{ path: 'model.bim', payload: payloadB64, payloadType: 'InlineBase64' }],
        },
      }),
      cache: 'no-store',
    });
    if (res.status === 200 || res.status === 201) return { ok: true };
    if (res.status === 202) {
      // Long-running operation — poll the Location header until terminal.
      const loc = res.headers.get('location');
      if (!loc) return { ok: true };
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2_000));
        const poll = await fetch(loc, { headers: { 'authorization': `Bearer ${token}` }, cache: 'no-store' });
        if (poll.status === 200 || poll.status === 201) return { ok: true };
        if (poll.status !== 202) {
          const t = await poll.text();
          const j = (() => { try { return JSON.parse(t); } catch { return null; } })();
          const status = j?.status || j?.error?.code;
          if (status && /succeed/i.test(String(status))) return { ok: true };
          if (status && /fail|error/i.test(String(status))) {
            return { ok: false, error: `Fabric LRO ${status}: ${t.slice(0, 400)}` };
          }
        }
      }
      return { ok: false, error: 'Fabric updateDefinition timed out after 30s (still running).' };
    }
    const text = await res.text();
    return { ok: false, error: `Fabric HTTP ${res.status}: ${text.slice(0, 600)}` };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}
