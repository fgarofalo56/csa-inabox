'use client';

/**
 * APIM editors — wired live to Azure API Management (apim-csa-loom-eastus2)
 * via the BFF (/api/items/apim-*). No mock data.
 *
 *   ApimApiEditor       — load operations + spec, edit displayName/path/protocols/subscriptionRequired, Save -> PUT
 *   ApimProductEditor   — load product, edit displayName/description/state/flags, Save -> PUT
 *   ApimPolicyEditor    — load policy XML for a scope, validate well-formed XML client-side, Save -> PUT
 *   DataProductEditor   — visual, but the Publish-to-APIM button POSTs a real product (idempotent upsert)
 *
 * APIM is the API-first glue per the CSA reference architecture: every Loom
 * function, ML endpoint, GraphQL API, and data-product surface is fronted
 * through APIM for auth, rate limiting, observability, and marketplace discovery.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Subtitle2, Body1, Caption1, Badge, Button, Spinner, Input, Textarea, Switch, Dropdown, Option, Field,
  Tab, TabList,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  Dialog, DialogTrigger, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Save20Regular, ArrowSync20Regular, Copy20Regular, CloudArrowUp20Regular,
  Document20Regular, Code20Regular, Library20Regular, Play20Regular, BranchFork20Regular,
  ArrowImport20Regular, Add20Regular, Delete20Regular, Eye20Regular, EyeOff20Regular, Key20Regular,
} from '@fluentui/react-icons';
import { ItemEditorChrome } from './item-editor-chrome';
import { ApimTree } from '@/lib/components/apim/apim-tree';
import { BackendStateBar } from '@/lib/components/backend-state-bar';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';

const useStyles = makeStyles({
  pad: { padding: 16, display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0, flex: 1 },
  toolbar: { display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' },
  form: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, alignItems: 'start' },
  monaco: {
    width: '100%', minHeight: 400,
    fontFamily: 'Consolas, "Cascadia Code", monospace', fontSize: 13, padding: 12,
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 4,
    backgroundColor: tokens.colorNeutralBackground3, color: tokens.colorNeutralForeground1,
    resize: 'vertical',
  },
  specViewer: {
    width: '100%', minHeight: 280, maxHeight: 480,
    fontFamily: 'Consolas, "Cascadia Code", monospace', fontSize: 12, padding: 12,
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 4,
    backgroundColor: tokens.colorNeutralBackground3, color: tokens.colorNeutralForeground1,
    overflow: 'auto', whiteSpace: 'pre',
  },
  cardGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12 },
  card: { padding: 12, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 6 },
  protocolRow: { display: 'flex', gap: 12, flexWrap: 'wrap' },
});

// ============================================================
// Shared helpers
// ============================================================

function StatusBar({ status }: { status: { kind: 'idle' | 'saving' | 'ok' | 'err'; msg?: string } }) {
  if (status.kind === 'idle') return null;
  if (status.kind === 'saving') return <Spinner size="tiny" label="Saving to APIM…" labelPosition="after" />;
  if (status.kind === 'ok') {
    return (
      <MessageBar intent="success">
        <MessageBarBody><MessageBarTitle>Saved</MessageBarTitle>{status.msg}</MessageBarBody>
      </MessageBar>
    );
  }
  return (
    <MessageBar intent="error">
      <MessageBarBody><MessageBarTitle>Save failed</MessageBarTitle>{status.msg || 'Unknown error'}</MessageBarBody>
    </MessageBar>
  );
}

type LoadState<T> = { loading: boolean; data: T | null; error?: string };

// ============================================================
// ApimApiEditor
// ============================================================
// (Ribbon defined inside the component via useMemo so onClick handlers can
// reference inline save / load / loadSpec / copySpec state.)

interface ApimApi {
  id: string;
  name: string;
  displayName: string;
  path: string;
  protocols: string[];
  serviceUrl?: string;
  subscriptionRequired?: boolean;
}

interface ApimParameter {
  name: string;
  type?: string;
  required?: boolean;
  description?: string;
}

interface ApimRepresentation {
  contentType: string;
  example?: string;
}

interface ApimOperationResponse {
  statusCode: number;
  description?: string;
}

interface ApimOperation {
  id: string;
  name: string;
  displayName: string;
  method: string;
  urlTemplate: string;
  description?: string;
  templateParameters?: ApimParameter[];
  request?: {
    description?: string;
    queryParameters?: ApimParameter[];
    headers?: ApimParameter[];
    representations?: ApimRepresentation[];
  };
  responses?: ApimOperationResponse[];
}

// Editable draft for the operation authoring dialog. Params/representations are
// edited as newline/text blocks then parsed on save, keeping the form compact
// while still round-tripping the real ParameterContract / ResponseContract shape.
interface OperationDraft {
  operationId: string;        // empty on a new op → server slugs from displayName
  isNew: boolean;
  displayName: string;
  method: string;
  urlTemplate: string;
  description: string;
  // "name:type:required" per line (type/required optional) for template + query + header params
  templateParams: string;
  queryParams: string;
  headerParams: string;
  // "contentType" per line for request representations
  requestReps: string;
  // "statusCode:description" per line
  responses: string;
}

const EMPTY_OP_DRAFT: OperationDraft = {
  operationId: '', isNew: true, displayName: '', method: 'GET', urlTemplate: '/',
  description: '', templateParams: '', queryParams: '', headerParams: '', requestReps: '', responses: '200:OK',
};

// Parse "name:type:required" lines into ApimParameter[]. type defaults to
// 'string'; a trailing ':required' / ':true' marks the param required.
function parseParams(text: string): ApimParameter[] {
  return text.split('\n').map((l) => l.trim()).filter(Boolean).map((line) => {
    const [name, type, req] = line.split(':').map((x) => x.trim());
    return { name, type: type || 'string', required: req === 'required' || req === 'true' };
  }).filter((p) => p.name);
}

// Parse "statusCode:description" lines into responses.
function parseResponses(text: string): ApimOperationResponse[] {
  return text.split('\n').map((l) => l.trim()).filter(Boolean).map((line) => {
    const ix = line.indexOf(':');
    const code = parseInt(ix < 0 ? line : line.slice(0, ix), 10);
    return { statusCode: code, description: ix < 0 ? undefined : line.slice(ix + 1).trim() || undefined };
  }).filter((r) => Number.isFinite(r.statusCode));
}

function paramsToText(params?: ApimParameter[]): string {
  return (params || []).map((p) => `${p.name}:${p.type || 'string'}${p.required ? ':required' : ''}`).join('\n');
}
function responsesToText(rs?: ApimOperationResponse[]): string {
  return (rs || []).map((r) => `${r.statusCode}${r.description ? ':' + r.description : ''}`).join('\n');
}
function repsToText(reps?: ApimRepresentation[]): string {
  return (reps || []).map((r) => r.contentType).join('\n');
}

const PROTOCOLS = ['https', 'http', 'ws', 'wss'] as const;

export function ApimApiEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const router = useRouter();
  const isNew = id === 'new';
  const [api, setApi] = useState<LoadState<ApimApi>>({ loading: !isNew, data: null });
  const [ops, setOps] = useState<LoadState<ApimOperation[]>>({ loading: false, data: null });
  const [spec, setSpec] = useState<LoadState<{ format: string; value: string }>>({ loading: false, data: null });
  const [status, setStatus] = useState<{ kind: 'idle' | 'saving' | 'ok' | 'err'; msg?: string }>({ kind: 'idle' });

  // Form fields
  const [displayName, setDisplayName] = useState('');
  const [path, setPath] = useState('');
  const [protocols, setProtocols] = useState<string[]>(['https']);
  const [subscriptionRequired, setSubscriptionRequired] = useState(true);
  const [serviceUrl, setServiceUrl] = useState('');
  const [dirty, setDirty] = useState(false);

  // Edit-OpenAPI dialog state — Monaco editor over the OpenAPI document
  // exported by /api/items/apim-api/[id]/spec; PUT writes back via the
  // same upsertApi() backed by ARM /apis/{id}?contentFormat=openapi+json.
  const [specEditorOpen, setSpecEditorOpen] = useState(false);
  const [specDraft, setSpecDraft] = useState('');
  const [specSaving, setSpecSaving] = useState(false);
  const [specError, setSpecError] = useState<string | null>(null);

  // Tab: Design | Operations | Test | Revisions
  const [tab, setTab] = useState<'design' | 'operations' | 'test' | 'revisions'>('design');

  // Operations authoring — editor dialog over a single operation's contract.
  const [opDialogOpen, setOpDialogOpen] = useState(false);
  const [opDraft, setOpDraft] = useState<OperationDraft>(EMPTY_OP_DRAFT);
  const [opBusy, setOpBusy] = useState(false);
  const [opErr, setOpErr] = useState<string | null>(null);
  const [opMsg, setOpMsg] = useState<{ intent: 'success' | 'error'; text: string } | null>(null);
  const [opLoadingDetail, setOpLoadingDetail] = useState(false);

  // Import API dialog (OpenAPI / WSDL / GraphQL).
  const [importOpen, setImportOpen] = useState(false);
  const [importKind, setImportKind] = useState<'openapi' | 'openapi-link' | 'wsdl-link' | 'graphql-link'>('openapi');
  const [importValue, setImportValue] = useState('');
  const [importBusy, setImportBusy] = useState(false);
  const [importErr, setImportErr] = useState<string | null>(null);

  // Import-from-OpenAPI dialog — self-contained "Create from definition →
  // OpenAPI" parity. Collects API id + display name + path + format + spec and
  // POSTs to /api/apim/import (real ARM PUT). Unlike the Import-API dialog
  // above (which patches the *current* API), this can mint a brand-new API
  // from a spec in one shot, then navigates to it.
  const [oasOpen, setOasOpen] = useState(false);
  const [oasApiId, setOasApiId] = useState('');
  const [oasDisplayName, setOasDisplayName] = useState('');
  const [oasPath, setOasPath] = useState('');
  const [oasFormat, setOasFormat] = useState<'openapi+json' | 'openapi-link'>('openapi+json');
  const [oasValue, setOasValue] = useState('');
  const [oasBusy, setOasBusy] = useState(false);
  const [oasErr, setOasErr] = useState<string | null>(null);
  const [oasGate, setOasGate] = useState<string | null>(null);

  // Test console — pick an operation, edit method/template/headers/body, send.
  const [testOpName, setTestOpName] = useState<string>('');
  const [testMethod, setTestMethod] = useState('GET');
  const [testTemplate, setTestTemplate] = useState('/');
  const [testHeaders, setTestHeaders] = useState('');
  const [testBody, setTestBody] = useState('');
  const [testBusy, setTestBusy] = useState(false);
  const [testResp, setTestResp] = useState<{ status: number; statusText: string; headers: Record<string, string>; body: string } | null>(null);
  const [testErr, setTestErr] = useState<string | null>(null);

  // Revisions tab.
  const [revs, setRevs] = useState<LoadState<{ revisions: any[]; releases: any[] }>>({ loading: false, data: null });
  const [newRev, setNewRev] = useState('');
  const [newRevDesc, setNewRevDesc] = useState('');
  const [newRevRelease, setNewRevRelease] = useState(true);
  const [revBusy, setRevBusy] = useState(false);
  const [revMsg, setRevMsg] = useState<{ intent: 'success' | 'error'; text: string } | null>(null);

  const load = useCallback(async () => {
    if (isNew) return;
    setApi({ loading: true, data: null });
    try {
      const r = await fetch(`/api/items/apim-api/${encodeURIComponent(id)}`);
      const j = await r.json();
      if (!j.ok) { setApi({ loading: false, data: null, error: j.error || 'Failed to load' }); return; }
      setApi({ loading: false, data: j.api });
      setDisplayName(j.api.displayName || '');
      setPath(j.api.path || '');
      setProtocols(j.api.protocols?.length ? j.api.protocols : ['https']);
      setSubscriptionRequired(j.api.subscriptionRequired ?? true);
      setServiceUrl(j.api.serviceUrl || '');
      setDirty(false);
    } catch (e: any) {
      setApi({ loading: false, data: null, error: e?.message || String(e) });
    }
  }, [id, isNew]);

  const loadOps = useCallback(async () => {
    if (isNew) return;
    setOps({ loading: true, data: null });
    try {
      const r = await fetch(`/api/items/apim-api/${encodeURIComponent(id)}/operations`);
      const j = await r.json();
      if (!j.ok) { setOps({ loading: false, data: [], error: j.error }); return; }
      setOps({ loading: false, data: j.operations });
    } catch (e: any) {
      setOps({ loading: false, data: [], error: e?.message || String(e) });
    }
  }, [id, isNew]);

  const loadSpec = useCallback(async () => {
    if (isNew) return;
    setSpec({ loading: true, data: null });
    try {
      const r = await fetch(`/api/items/apim-api/${encodeURIComponent(id)}/spec?format=openapi%2Bjson`);
      const j = await r.json();
      if (!j.ok) { setSpec({ loading: false, data: null, error: j.error }); return; }
      setSpec({ loading: false, data: { format: j.format, value: j.value } });
    } catch (e: any) {
      setSpec({ loading: false, data: null, error: e?.message || String(e) });
    }
  }, [id, isNew]);

  useEffect(() => { load(); loadOps(); loadSpec(); }, [load, loadOps, loadSpec]);

  const save = useCallback(async () => {
    if (!displayName.trim() || !path.trim()) {
      setStatus({ kind: 'err', msg: 'displayName and path are required' });
      return;
    }
    if (protocols.length === 0) {
      // APIM rejects an API with no protocols — guard client-side with a clear message.
      setStatus({ kind: 'err', msg: 'Select at least one protocol (https / http / ws / wss).' });
      return;
    }
    setStatus({ kind: 'saving' });
    // Phase 4.5 — capture the body we're about to PUT before the await so
    // if a user keystroke commits to React state mid-request we don't
    // silently report success for bytes that were never sent. Status msg
    // always references the snapshot we actually transmitted.
    const body = { displayName, path, protocols: [...protocols], subscriptionRequired, serviceUrl: serviceUrl || undefined };
    try {
      const r = await fetch(`/api/items/apim-api/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!j.ok) { setStatus({ kind: 'err', msg: j.error || `HTTP ${r.status}` }); return; }
      setStatus({ kind: 'ok', msg: `${j.api.displayName} (${j.api.name}) at ${new Date().toLocaleTimeString()}` });
      setApi({ loading: false, data: j.api });
      setDirty(false);
      loadOps();
    } catch (e: any) {
      setStatus({ kind: 'err', msg: e?.message || String(e) });
    }
  }, [id, displayName, path, protocols, subscriptionRequired, serviceUrl, loadOps]);

  // Phase 4.5 — Ctrl+S / Cmd+S keyboard shortcut for Save.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (dirty && status.kind !== 'saving' && displayName.trim() && path.trim()) save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dirty, status.kind, displayName, path, save]);

  const toggleProtocol = (p: string) => {
    setProtocols((cur) => cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p]);
    setDirty(true);
  };

  const copySpec = () => {
    if (spec.data?.value) navigator.clipboard?.writeText(spec.data.value).catch(() => {});
  };

  const openSpecEditor = useCallback(() => {
    // Seed the draft from the live spec (if any) so users edit-in-place;
    // empty starter only when APIM returned no spec.
    setSpecDraft(spec.data?.value || '{\n  "openapi": "3.0.1",\n  "info": { "title": "", "version": "1.0" },\n  "paths": {}\n}');
    setSpecError(null);
    setSpecEditorOpen(true);
  }, [spec.data?.value]);

  const saveSpec = useCallback(async () => {
    setSpecSaving(true); setSpecError(null);
    try {
      // Validate JSON client-side before round-tripping to APIM.
      try { JSON.parse(specDraft); }
      catch (e: any) { throw new Error(`OpenAPI document is not valid JSON: ${e?.message || String(e)}`); }
      const r = await fetch(`/api/items/apim-api/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          displayName, path,
          protocols: [...protocols],
          subscriptionRequired,
          serviceUrl: serviceUrl || undefined,
          format: 'openapi+json',
          value: specDraft,
        }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setSpecEditorOpen(false);
      setApi({ loading: false, data: j.api });
      setStatus({ kind: 'ok', msg: `OpenAPI spec saved at ${new Date().toLocaleTimeString()}` });
      // Re-export from APIM so the read-only viewer reflects the canonical bytes
      loadSpec();
      loadOps();
    } catch (e: any) {
      setSpecError(e?.message || String(e));
    } finally { setSpecSaving(false); }
  }, [id, specDraft, displayName, path, protocols, subscriptionRequired, serviceUrl, loadSpec, loadOps]);

  // ---- Import API (OpenAPI / WSDL / GraphQL) ----
  const runImport = useCallback(async () => {
    if (!displayName.trim() || !path.trim()) { setImportErr('Set Display name + Path first.'); return; }
    setImportBusy(true); setImportErr(null);
    // Map the import kind to APIM contentFormat + value semantics.
    let format: string; let value = importValue;
    switch (importKind) {
      case 'openapi': format = 'openapi+json'; break;       // inline document
      case 'openapi-link': format = 'openapi-link'; break;   // URL to the spec
      case 'wsdl-link': format = 'wsdl-link'; break;         // URL to a WSDL
      case 'graphql-link': format = 'graphql-link'; break;   // URL to a GraphQL schema
      default: format = 'openapi+json';
    }
    if (importKind === 'openapi') {
      try { JSON.parse(importValue); } catch (e: any) { setImportErr(`Inline OpenAPI is not valid JSON: ${e?.message}`); setImportBusy(false); return; }
    }
    try {
      const r = await fetch(`/api/items/apim-api/${encodeURIComponent(id)}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          displayName, path, protocols: [...protocols], subscriptionRequired,
          serviceUrl: serviceUrl || undefined,
          apiType: importKind === 'graphql-link' ? 'graphql' : importKind === 'wsdl-link' ? 'soap' : 'http',
          format, value,
        }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setImportOpen(false); setImportValue('');
      setApi({ loading: false, data: j.api });
      setStatus({ kind: 'ok', msg: `Imported ${importKind} at ${new Date().toLocaleTimeString()}` });
      loadOps(); loadSpec();
    } catch (e: any) { setImportErr(e?.message || String(e)); }
    finally { setImportBusy(false); }
  }, [id, importKind, importValue, displayName, path, protocols, subscriptionRequired, serviceUrl, loadOps, loadSpec]);

  // ---- Import from OpenAPI (dedicated /api/apim/import) ----
  const openOas = useCallback(() => {
    // Seed from the current editor so importing onto an existing API is a
    // one-click default; on the new-API form everything starts blank.
    setOasApiId(isNew ? '' : id);
    setOasDisplayName(displayName || '');
    setOasPath(path || '');
    setOasFormat('openapi+json');
    setOasValue('');
    setOasErr(null);
    setOasGate(null);
    setOasOpen(true);
  }, [isNew, id, displayName, path]);

  const runOasImport = useCallback(async () => {
    const apiIdTrim = oasApiId.trim();
    const pathTrim = oasPath.trim();
    if (!apiIdTrim) { setOasErr('API id is required.'); return; }
    if (!pathTrim) { setOasErr('URL path is required.'); return; }
    if (!oasValue.trim()) { setOasErr(oasFormat === 'openapi-link' ? 'Spec URL is required.' : 'OpenAPI document is required.'); return; }
    if (oasFormat === 'openapi+json') {
      try { JSON.parse(oasValue); }
      catch (e: any) { setOasErr(`Inline OpenAPI is not valid JSON: ${e?.message || String(e)}`); return; }
    }
    setOasBusy(true); setOasErr(null); setOasGate(null);
    try {
      const r = await fetch('/api/apim/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          apiId: apiIdTrim,
          displayName: oasDisplayName.trim() || undefined,
          path: pathTrim,
          format: oasFormat,
          value: oasValue,
        }),
      });
      const j = await r.json();
      if (r.status === 503 && j?.code === 'not_configured') { setOasGate(j.missing || j.error || 'APIM not configured'); return; }
      if (!j.ok) { setOasErr(j.error || `HTTP ${r.status}`); return; }
      setOasOpen(false);
      setStatus({ kind: 'ok', msg: `Imported ${j.api.displayName || j.api.name} (${j.api.name}) at path /${j.api.path}` });
      // Navigate to the created/updated API so its operations + spec render.
      if (j.api?.name && j.api.name !== id) router.push(`/items/apim-api/${encodeURIComponent(j.api.name)}`);
      else { load(); loadOps(); loadSpec(); }
    } catch (e: any) { setOasErr(e?.message || String(e)); }
    finally { setOasBusy(false); }
  }, [oasApiId, oasPath, oasValue, oasFormat, oasDisplayName, id, router, load, loadOps, loadSpec]);

  // ---- Test console ----
  const sendTest = useCallback(async () => {
    setTestBusy(true); setTestErr(null); setTestResp(null);
    let headers: Record<string, string> = {};
    if (testHeaders.trim()) {
      try {
        for (const line of testHeaders.split('\n')) {
          const ix = line.indexOf(':'); if (ix < 0) continue;
          headers[line.slice(0, ix).trim()] = line.slice(ix + 1).trim();
        }
      } catch { /* ignore */ }
    }
    try {
      const r = await fetch(`/api/items/apim-api/${encodeURIComponent(id)}/test-call`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method: testMethod, urlTemplate: testTemplate, headers, body: testBody || undefined }),
      });
      const j = await r.json();
      if (!j.ok) { setTestErr(j.error || `HTTP ${r.status}`); return; }
      setTestResp({ status: j.status, statusText: j.statusText, headers: j.headers, body: j.body });
    } catch (e: any) { setTestErr(e?.message || String(e)); }
    finally { setTestBusy(false); }
  }, [id, testMethod, testTemplate, testHeaders, testBody]);

  const pickTestOp = useCallback((opName: string) => {
    setTestOpName(opName);
    const op = (ops.data || []).find((o) => o.name === opName);
    if (op) { setTestMethod(op.method || 'GET'); setTestTemplate(op.urlTemplate || '/'); }
  }, [ops.data]);

  // ---- Operations authoring ----
  const openNewOp = useCallback(() => {
    setOpDraft(EMPTY_OP_DRAFT);
    setOpErr(null);
    setOpDialogOpen(true);
  }, []);

  // Open the edit dialog for an existing operation — fetch full detail (the
  // list only carries method/template/displayName) so template/query/header
  // params and responses are populated for editing.
  const openEditOp = useCallback(async (operationName: string) => {
    setOpErr(null); setOpLoadingDetail(true);
    setOpDraft({ ...EMPTY_OP_DRAFT, isNew: false, operationId: operationName });
    setOpDialogOpen(true);
    try {
      const r = await fetch(`/api/items/apim-api/${encodeURIComponent(id)}/operations?operationId=${encodeURIComponent(operationName)}`);
      const j = await r.json();
      if (!j.ok) { setOpErr(j.error || `HTTP ${r.status}`); return; }
      const o: ApimOperation = j.operation;
      setOpDraft({
        operationId: o.name, isNew: false,
        displayName: o.displayName || '', method: o.method || 'GET', urlTemplate: o.urlTemplate || '/',
        description: o.description || '',
        templateParams: paramsToText(o.templateParameters),
        queryParams: paramsToText(o.request?.queryParameters),
        headerParams: paramsToText(o.request?.headers),
        requestReps: repsToText(o.request?.representations),
        responses: responsesToText(o.responses) || '200:OK',
      });
    } catch (e: any) { setOpErr(e?.message || String(e)); }
    finally { setOpLoadingDetail(false); }
  }, [id]);

  const saveOp = useCallback(async () => {
    if (!opDraft.displayName.trim()) { setOpErr('Display name is required.'); return; }
    if (!opDraft.urlTemplate.trim()) { setOpErr('URL template is required.'); return; }
    setOpBusy(true); setOpErr(null); setOpMsg(null);
    const repsList = opDraft.requestReps.split('\n').map((l) => l.trim()).filter(Boolean).map((contentType) => ({ contentType }));
    const payload = {
      operationId: opDraft.isNew ? undefined : opDraft.operationId,
      displayName: opDraft.displayName.trim(),
      method: opDraft.method,
      urlTemplate: opDraft.urlTemplate.trim(),
      description: opDraft.description.trim() || undefined,
      templateParameters: parseParams(opDraft.templateParams),
      request: {
        queryParameters: parseParams(opDraft.queryParams),
        headers: parseParams(opDraft.headerParams),
        representations: repsList,
      },
      responses: parseResponses(opDraft.responses),
    };
    try {
      // POST creates (server slugs the id); PUT replaces an existing op.
      const r = await fetch(`/api/items/apim-api/${encodeURIComponent(id)}/operations`, {
        method: opDraft.isNew ? 'POST' : 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const j = await r.json();
      if (!j.ok) { setOpErr(j.error || `HTTP ${r.status}`); return; }
      setOpDialogOpen(false);
      setOpMsg({ intent: 'success', text: `${opDraft.isNew ? 'Created' : 'Updated'} operation ${j.operation.displayName} (${j.operation.method} ${j.operation.urlTemplate}).` });
      loadOps();
    } catch (e: any) { setOpErr(e?.message || String(e)); }
    finally { setOpBusy(false); }
  }, [id, opDraft, loadOps]);

  const deleteOp = useCallback(async (operationName: string, label: string) => {
    if (typeof window !== 'undefined' && !window.confirm(`Delete operation "${label}"? This cannot be undone.`)) return;
    setOpBusy(true); setOpMsg(null);
    try {
      const r = await fetch(`/api/items/apim-api/${encodeURIComponent(id)}/operations?operationId=${encodeURIComponent(operationName)}`, { method: 'DELETE' });
      const j = await r.json();
      if (!j.ok) { setOpMsg({ intent: 'error', text: j.error || `HTTP ${r.status}` }); return; }
      setOpMsg({ intent: 'success', text: `Deleted operation ${label}.` });
      loadOps();
    } catch (e: any) { setOpMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setOpBusy(false); }
  }, [id, loadOps]);

  // Per-operation policy entry point — deep-links to the policy editor at
  // operation scope (apis/{id}/operations/{opId}/policies/policy).
  const openOpPolicy = useCallback((operationName: string) => {
    router.push(`/items/apim-policy/${encodeURIComponent(id)}?scope=operation&apiId=${encodeURIComponent(id)}&operationId=${encodeURIComponent(operationName)}`);
  }, [router, id]);

  // ---- Revisions ----
  const loadRevs = useCallback(async () => {
    if (isNew) return;
    setRevs({ loading: true, data: null });
    try {
      const r = await fetch(`/api/items/apim-api/${encodeURIComponent(id)}/revisions`);
      const j = await r.json();
      if (!j.ok) { setRevs({ loading: false, data: null, error: j.error }); return; }
      setRevs({ loading: false, data: { revisions: j.revisions || [], releases: j.releases || [] } });
    } catch (e: any) { setRevs({ loading: false, data: null, error: e?.message || String(e) }); }
  }, [id, isNew]);

  useEffect(() => { if (tab === 'revisions') loadRevs(); }, [tab, loadRevs]);

  const createRev = useCallback(async () => {
    if (!newRev.trim()) { setRevMsg({ intent: 'error', text: 'Enter a revision number (e.g. 2).' }); return; }
    setRevBusy(true); setRevMsg(null);
    try {
      const r = await fetch(`/api/items/apim-api/${encodeURIComponent(id)}/revisions`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ apiRevision: newRev.trim(), description: newRevDesc || undefined, release: newRevRelease, notes: newRevDesc || undefined }),
      });
      const j = await r.json();
      if (!j.ok) { setRevMsg({ intent: 'error', text: j.error || `HTTP ${r.status}` }); return; }
      setRevMsg({ intent: 'success', text: `Created revision ${newRev}${newRevRelease ? ' and released (now current)' : ''}.` });
      setNewRev(''); setNewRevDesc('');
      loadRevs();
    } catch (e: any) { setRevMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setRevBusy(false); }
  }, [id, newRev, newRevDesc, newRevRelease, loadRevs]);

  // Ribbon — Save / Reload / Copy spec / Import / Edit OpenAPI / Test / Revisions /
  // Open policy editor. All actions are real; no disabled "deferred" buttons.
  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'API', actions: [
        { label: status.kind === 'saving' ? 'Saving…' : 'Save', onClick: status.kind !== 'saving' && (isNew || dirty) && displayName.trim() && path.trim() && protocols.length > 0 ? save : undefined, disabled: status.kind === 'saving' || (!isNew && !dirty) || !displayName.trim() || !path.trim() || protocols.length === 0, title: !displayName.trim() || !path.trim() ? 'displayName and path are required' : protocols.length === 0 ? 'Select at least one protocol' : (!dirty && !isNew ? 'No unsaved changes' : undefined) },
        { label: 'Reload', onClick: !isNew ? () => { load(); loadOps(); loadSpec(); } : undefined, disabled: isNew, title: isNew ? 'Save the API first' : undefined },
      ]},
      { label: 'Definition', actions: [
        { label: 'Import from OpenAPI', onClick: openOas, title: 'Create or replace an API from an OpenAPI definition (inline or URL)' },
        { label: 'Import API', onClick: () => { setImportErr(null); setImportOpen(true); }, title: 'Import OpenAPI / WSDL / GraphQL into the current API' },
        { label: 'Edit OpenAPI', onClick: !isNew ? openSpecEditor : undefined, disabled: isNew, title: isNew ? 'Save the API first, then edit the spec' : undefined },
        { label: 'Copy spec', onClick: spec.data?.value ? copySpec : undefined, disabled: !spec.data?.value, title: !spec.data?.value ? 'No spec attached to this API' : undefined },
      ]},
      { label: 'Design', actions: [
        { label: 'Operations', onClick: !isNew ? () => setTab('operations') : undefined, disabled: isNew, title: isNew ? 'Save the API first' : 'Create / edit / delete operations' },
        { label: 'Add operation', onClick: !isNew ? () => { setTab('operations'); openNewOp(); } : undefined, disabled: isNew, title: isNew ? 'Save the API first' : undefined },
      ]},
      { label: 'Run', actions: [
        { label: 'Test', onClick: !isNew ? () => setTab('test') : undefined, disabled: isNew, title: isNew ? 'Save the API first' : undefined },
        { label: 'Revisions', onClick: !isNew ? () => setTab('revisions') : undefined, disabled: isNew, title: isNew ? 'Save the API first' : undefined },
      ]},
      { label: 'Policy', actions: [
        { label: 'API policy', onClick: !isNew ? () => router.push(`/items/apim-policy/${encodeURIComponent(id)}?scope=api&apiId=${encodeURIComponent(id)}`) : undefined, disabled: isNew, title: isNew ? 'Save the API first' : 'Edit the API-scope policy XML' },
      ]},
    ]},
  ], [status.kind, isNew, dirty, displayName, path, protocols, save, load, loadOps, loadSpec, spec.data, openSpecEditor, openOas, openNewOp, router, id]);

  const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

  return (
    <ItemEditorChrome
      item={item}
      id={id}
      ribbon={ribbon}
      leftPanel={
        // Full Azure API Management service navigator (parity with the ADF /
        // Synapse / Databricks resource panes): typed groups for APIs (expand →
        // operations) / Products / Named values / Backends / Subscriptions /
        // Gateways with live counts, ＋New, filter, create dialog and inline
        // delete — all on real ARM REST through /api/apim/*. Selecting an API
        // opens it here; "New API" resets this editor to the new-API form;
        // selecting a product opens the product editor.
        <ApimTree
          selectedApiName={isNew ? null : id}
          onOpenApi={(apiName) => { if (apiName !== id) router.push(`/items/apim-api/${encodeURIComponent(apiName)}`); }}
          onNewApi={() => router.push(`/items/apim-api/new`)}
          onOpenProduct={(productName) => router.push(`/items/apim-product/${encodeURIComponent(productName)}`)}
        />
      }
      main={
        <div className={s.pad}>
          <div className={s.toolbar}>
            <Badge appearance="filled" color="brand">APIM API</Badge>
            <Badge appearance="outline">{api.data?.name || id}</Badge>
            {subscriptionRequired && <Badge appearance="outline">Subscription required</Badge>}
            {dirty && <Badge appearance="outline" color="warning">unsaved</Badge>}
            <Button
              appearance="primary"
              icon={<Save20Regular />}
              onClick={save}
              disabled={status.kind === 'saving' || (!isNew && !dirty) || !displayName.trim() || !path.trim() || protocols.length === 0}
              title={!displayName.trim() || !path.trim() ? 'Display name and path are required' : protocols.length === 0 ? 'Select at least one protocol' : (!dirty && !isNew ? 'No unsaved changes' : undefined)}
            >
              {status.kind === 'saving' ? 'Saving…' : isNew ? 'Create' : 'Save'}
            </Button>
            <Button appearance="outline" icon={<CloudArrowUp20Regular />} onClick={openOas}>Import from OpenAPI</Button>
            <Button appearance="outline" icon={<ArrowImport20Regular />} onClick={() => { setImportErr(null); setImportOpen(true); }}>Import</Button>
            <Button appearance="outline" icon={<ArrowSync20Regular />} onClick={() => { load(); loadOps(); loadSpec(); }}>
              Reload
            </Button>
          </div>
          <StatusBar status={status} />
          {api.loading && <Spinner size="small" label="Loading API from APIM…" labelPosition="after" />}
          {api.error && !api.loading && (
            <BackendStateBar error={api.error} title="APIM API" />
          )}

          <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as typeof tab)}>
            <Tab value="design" icon={<Document20Regular />}>Design</Tab>
            <Tab value="operations" icon={<Code20Regular />} disabled={isNew}>Operations</Tab>
            <Tab value="test" icon={<Play20Regular />} disabled={isNew}>Test console</Tab>
            <Tab value="revisions" icon={<BranchFork20Regular />} disabled={isNew}>Revisions</Tab>
          </TabList>

          {tab === 'design' && (
            <>
              <div className={s.form}>
                <Field label="Display name" required>
                  <Input value={displayName} onChange={(_, d) => { setDisplayName(d.value); setDirty(true); }} />
                </Field>
                <Field label="Path" required hint="URL suffix after the gateway hostname, e.g. 'orders'">
                  <Input value={path} onChange={(_, d) => { setPath(d.value); setDirty(true); }} />
                </Field>
                <Field label="Service URL" hint="Backend base URL (optional)">
                  <Input value={serviceUrl} onChange={(_, d) => { setServiceUrl(d.value); setDirty(true); }} placeholder="https://backend.example.com" />
                </Field>
                <Field label="Subscription required">
                  <Switch checked={subscriptionRequired} onChange={(_, d) => { setSubscriptionRequired(d.checked); setDirty(true); }} label={subscriptionRequired ? 'Yes' : 'No'} />
                </Field>
                <Field label="Protocols" hint="At least one">
                  <div className={s.protocolRow}>
                    {PROTOCOLS.map((p) => (
                      <Switch key={p} checked={protocols.includes(p)} label={p} onChange={() => toggleProtocol(p)} />
                    ))}
                  </div>
                </Field>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 8 }}>
                <Subtitle2>OpenAPI spec</Subtitle2>
                <Badge appearance="outline">{spec.data?.format || 'openapi+json'}</Badge>
                <Button size="small" icon={<Copy20Regular />} onClick={copySpec} disabled={!spec.data?.value}>Copy</Button>
                <Button size="small" icon={<ArrowSync20Regular />} onClick={loadSpec}>Refresh</Button>
                <Button size="small" onClick={openSpecEditor} disabled={isNew}>Edit OpenAPI</Button>
              </div>
              {spec.loading && <Spinner size="tiny" label="Exporting from APIM…" labelPosition="after" />}
              {!spec.loading && spec.error && <Caption1>Spec unavailable: {spec.error}</Caption1>}
              {!spec.loading && !spec.error && (
                <div className={s.specViewer} role="region" aria-label="OpenAPI spec (read-only)">
                  {spec.data?.value || (isNew ? 'Save the API first, then import a spec.' : '(no spec attached to this API)')}
                </div>
              )}
            </>
          )}

          {tab === 'operations' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                <Body1>Create, edit, and delete the API's operations — method, URL template, parameters, and declared responses. Writes go straight to APIM via real ARM REST.</Body1>
                <Button appearance="primary" icon={<Add20Regular />} onClick={openNewOp} style={{ marginLeft: 'auto' }}>Add operation</Button>
                <Button appearance="outline" icon={<ArrowSync20Regular />} onClick={loadOps}>Reload</Button>
              </div>
              {opMsg && <MessageBar intent={opMsg.intent}><MessageBarBody>{opMsg.text}</MessageBarBody></MessageBar>}
              {ops.loading && <Spinner size="tiny" label="Loading operations…" labelPosition="after" />}
              {ops.error && !ops.loading && <MessageBar intent="warning"><MessageBarBody><MessageBarTitle>Could not load operations</MessageBarTitle>{ops.error}</MessageBarBody></MessageBar>}
              {!ops.loading && !ops.error && (
                <Table size="small" aria-label="Operations">
                  <TableHeader><TableRow>
                    <TableHeaderCell>Method</TableHeaderCell>
                    <TableHeaderCell>Display name</TableHeaderCell>
                    <TableHeaderCell>URL template</TableHeaderCell>
                    <TableHeaderCell>Actions</TableHeaderCell>
                  </TableRow></TableHeader>
                  <TableBody>
                    {(ops.data || []).length === 0 && (
                      <TableRow><TableCell colSpan={4}><Caption1>No operations yet. Click <strong>Add operation</strong> or import an OpenAPI spec.</Caption1></TableCell></TableRow>
                    )}
                    {(ops.data || []).map((op) => (
                      <TableRow key={op.name}>
                        <TableCell><Badge appearance="tint" color={op.method === 'GET' ? 'success' : op.method === 'DELETE' ? 'danger' : 'brand'}>{op.method}</Badge></TableCell>
                        <TableCell>{op.displayName || op.name}</TableCell>
                        <TableCell><code>{op.urlTemplate}</code></TableCell>
                        <TableCell>
                          <div style={{ display: 'flex', gap: 6 }}>
                            <Button size="small" onClick={() => openEditOp(op.name)}>Edit</Button>
                            <Button size="small" appearance="outline" icon={<Code20Regular />} onClick={() => openOpPolicy(op.name)}>Policy</Button>
                            <Button size="small" appearance="outline" icon={<Delete20Regular />} onClick={() => deleteOp(op.name, op.displayName || op.name)} disabled={opBusy}>Delete</Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </div>
          )}

          {tab === 'test' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <Body1>Sends a real request through the APIM gateway. The all-access subscription key is attached server-side; it never reaches the browser.</Body1>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <Field label="Operation (fills method + template)">
                  <Dropdown
                    placeholder={(ops.data?.length ?? 0) ? 'Select an operation' : 'No operations — type a path below'}
                    value={testOpName}
                    selectedOptions={testOpName ? [testOpName] : []}
                    onOptionSelect={(_, d) => d.optionValue && pickTestOp(d.optionValue)}
                  >
                    {(ops.data || []).map((op) => <Option key={op.name} value={op.name}>{`${op.method} ${op.urlTemplate}`}</Option>)}
                  </Dropdown>
                </Field>
                <Field label="Method">
                  <Dropdown value={testMethod} selectedOptions={[testMethod]} onOptionSelect={(_, d) => d.optionValue && setTestMethod(d.optionValue)}>
                    {HTTP_METHODS.map((m) => <Option key={m} value={m}>{m}</Option>)}
                  </Dropdown>
                </Field>
                <Field label="URL template (appended to the API path)" style={{ gridColumn: '1 / -1' }}>
                  <Input value={testTemplate} onChange={(_, d) => setTestTemplate(d.value)} placeholder="/orders/{id}" />
                </Field>
                <Field label="Request headers (one per line, Name: value)" style={{ gridColumn: '1 / -1' }}>
                  <Textarea value={testHeaders} onChange={(_, d) => setTestHeaders(d.value)} rows={2} placeholder={'Accept: application/json'} />
                </Field>
                {!['GET', 'HEAD'].includes(testMethod) && (
                  <Field label="Request body" style={{ gridColumn: '1 / -1' }}>
                    <Textarea value={testBody} onChange={(_, d) => setTestBody(d.value)} rows={4} placeholder={'{ "name": "value" }'} />
                  </Field>
                )}
              </div>
              <Button appearance="primary" icon={<Play20Regular />} onClick={sendTest} disabled={testBusy} style={{ alignSelf: 'flex-start' }}>
                {testBusy ? 'Sending…' : 'Send'}
              </Button>
              {testErr && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Request failed</MessageBarTitle>{testErr}</MessageBarBody></MessageBar>}
              {testResp && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <Badge appearance="filled" color={testResp.status < 400 ? 'success' : testResp.status < 500 ? 'warning' : 'danger'}>
                      {testResp.status} {testResp.statusText}
                    </Badge>
                    <Caption1>{testResp.headers['content-type'] || ''}</Caption1>
                  </div>
                  <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Response headers</Caption1>
                  <div className={s.specViewer} style={{ maxHeight: 140 }}>
                    {Object.entries(testResp.headers).map(([k, v]) => `${k}: ${v}`).join('\n')}
                  </div>
                  <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Response body</Caption1>
                  <div className={s.specViewer}>{testResp.body || '(empty)'}</div>
                </div>
              )}
            </div>
          )}

          {tab === 'revisions' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {/* Honest gate per ui-parity.md: APIM also offers API *versions* /
                  version sets (segment/header/query scheme) alongside revisions.
                  That is a distinct, heavier ARM surface (apiVersionSets +
                  per-version apis) with no BFF route yet, so it is flagged rather
                  than stubbed. Revisions below are fully live. */}
              <MessageBar intent="info">
                <MessageBarBody>
                  <MessageBarTitle>Revisions are live. Versions / version sets are a tracked gap.</MessageBarTitle>
                  API <em>versions</em> (segment / header / query-string scheme via <code>apiVersionSets</code>) are not built yet — they need a dedicated <code>/api/apim/version-sets</code> route. Revision list, create, and release (make-current) below all call real ARM.
                </MessageBarBody>
              </MessageBar>
              <div style={{ border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 6, padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <Subtitle2>Create revision</Subtitle2>
                <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                  <Field label="Revision number"><Input value={newRev} onChange={(_, d) => setNewRev(d.value)} placeholder="2" style={{ width: 100 }} /></Field>
                  <Field label="Description" style={{ flex: 1, minWidth: 200 }}><Input value={newRevDesc} onChange={(_, d) => setNewRevDesc(d.value)} placeholder="Added new operation" /></Field>
                  <Switch checked={newRevRelease} onChange={(_, d) => setNewRevRelease(d.checked)} label="Release (make current)" />
                  <Button appearance="primary" icon={<BranchFork20Regular />} onClick={createRev} disabled={revBusy}>{revBusy ? 'Creating…' : 'Create revision'}</Button>
                </div>
                {revMsg && <MessageBar intent={revMsg.intent}><MessageBarBody>{revMsg.text}</MessageBarBody></MessageBar>}
              </div>
              {revs.loading && <Spinner size="tiny" label="Loading revisions…" labelPosition="after" />}
              {revs.error && <MessageBar intent="warning"><MessageBarBody>{revs.error}</MessageBarBody></MessageBar>}
              {revs.data && (
                <>
                  <Subtitle2>Revisions ({revs.data.revisions.length})</Subtitle2>
                  <Table size="small" aria-label="Revisions">
                    <TableHeader><TableRow>
                      <TableHeaderCell>Revision</TableHeaderCell>
                      <TableHeaderCell>Current</TableHeaderCell>
                      <TableHeaderCell>Online</TableHeaderCell>
                      <TableHeaderCell>Description</TableHeaderCell>
                      <TableHeaderCell>Updated</TableHeaderCell>
                    </TableRow></TableHeader>
                    <TableBody>
                      {revs.data.revisions.map((r: any) => (
                        <TableRow key={r.apiRevision}>
                          <TableCell><strong>{r.apiRevision}</strong></TableCell>
                          <TableCell>{r.isCurrent ? <Badge color="success">current</Badge> : '—'}</TableCell>
                          <TableCell>{r.isOnline ? 'yes' : 'no'}</TableCell>
                          <TableCell>{r.description || '—'}</TableCell>
                          <TableCell>{r.updatedDateTime || '—'}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  <Subtitle2>Releases / change log ({revs.data.releases.length})</Subtitle2>
                  <Table size="small" aria-label="Releases">
                    <TableHeader><TableRow>
                      <TableHeaderCell>Release</TableHeaderCell>
                      <TableHeaderCell>Notes</TableHeaderCell>
                      <TableHeaderCell>Created</TableHeaderCell>
                    </TableRow></TableHeader>
                    <TableBody>
                      {revs.data.releases.map((r: any) => (
                        <TableRow key={r.id || r.name}>
                          <TableCell><code>{r.name}</code></TableCell>
                          <TableCell>{r.notes || '—'}</TableCell>
                          <TableCell>{r.createdDateTime || '—'}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </>
              )}
            </div>
          )}

          {/* Import API dialog — OpenAPI / WSDL / GraphQL */}
          <Dialog open={importOpen} onOpenChange={(_, d) => { if (!d.open) setImportOpen(false); }}>
            <DialogSurface>
              <DialogBody>
                <DialogTitle>Import API definition</DialogTitle>
                <DialogContent>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    <Body1>Imports into <strong>{displayName || id}</strong> at path <code>{path || '(set path first)'}</code>.</Body1>
                    <Field label="Format">
                      <Dropdown value={importKind} selectedOptions={[importKind]} onOptionSelect={(_, d) => d.optionValue && setImportKind(d.optionValue as typeof importKind)}>
                        <Option value="openapi">OpenAPI (inline JSON)</Option>
                        <Option value="openapi-link">OpenAPI (link to spec URL)</Option>
                        <Option value="wsdl-link">WSDL (link to .wsdl URL)</Option>
                        <Option value="graphql-link">GraphQL (link to schema URL)</Option>
                      </Dropdown>
                    </Field>
                    {importKind === 'openapi' ? (
                      <Field label="OpenAPI document (JSON)">
                        <Textarea value={importValue} onChange={(_, d) => setImportValue(d.value)} rows={8} placeholder={'{ "openapi": "3.0.1", "info": {"title":"","version":"1.0"}, "paths": {} }'} />
                      </Field>
                    ) : (
                      <Field label="URL">
                        <Input value={importValue} onChange={(_, d) => setImportValue(d.value)} placeholder="https://example.com/openapi.json" />
                      </Field>
                    )}
                    {importErr && <MessageBar intent="error"><MessageBarBody>{importErr}</MessageBarBody></MessageBar>}
                  </div>
                </DialogContent>
                <DialogActions>
                  <Button onClick={() => setImportOpen(false)}>Cancel</Button>
                  <Button appearance="primary" onClick={runImport} disabled={importBusy || !importValue.trim()}>{importBusy ? 'Importing…' : 'Import'}</Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>

          {/* Import from OpenAPI dialog — dedicated /api/apim/import (real ARM PUT) */}
          <Dialog open={oasOpen} onOpenChange={(_, d) => { if (!d.open) setOasOpen(false); }}>
            <DialogSurface style={{ maxWidth: '90vw', width: 760 }}>
              <DialogBody>
                <DialogTitle>Import from OpenAPI</DialogTitle>
                <DialogContent>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    <Body1>
                      Creates or replaces an API from an OpenAPI definition. APIM parses the spec
                      into operations and schemas — the same as the portal's <em>Create from definition → OpenAPI</em>.
                    </Body1>
                    <div className={s.form}>
                      <Field label="API id" required hint="Resource name (lowercase, e.g. 'petstore')">
                        <Input value={oasApiId} onChange={(_, d) => setOasApiId(d.value)} placeholder="petstore" />
                      </Field>
                      <Field label="Display name" hint="Defaults to the spec's info.title">
                        <Input value={oasDisplayName} onChange={(_, d) => setOasDisplayName(d.value)} placeholder="Pet Store" />
                      </Field>
                      <Field label="URL path" required hint="Suffix after the gateway hostname, e.g. 'petstore'">
                        <Input value={oasPath} onChange={(_, d) => setOasPath(d.value)} placeholder="petstore" />
                      </Field>
                      <Field label="Source">
                        <Dropdown
                          value={oasFormat === 'openapi-link' ? 'OpenAPI (link to spec URL)' : 'OpenAPI (inline JSON)'}
                          selectedOptions={[oasFormat]}
                          onOptionSelect={(_, d) => d.optionValue && setOasFormat(d.optionValue as typeof oasFormat)}
                        >
                          <Option value="openapi+json">OpenAPI (inline JSON)</Option>
                          <Option value="openapi-link">OpenAPI (link to spec URL)</Option>
                        </Dropdown>
                      </Field>
                    </div>
                    {oasFormat === 'openapi-link' ? (
                      <Field label="Spec URL" required>
                        <Input value={oasValue} onChange={(_, d) => setOasValue(d.value)} placeholder="https://petstore3.swagger.io/api/v3/openapi.json" />
                      </Field>
                    ) : (
                      <Field label="OpenAPI document (JSON)" required>
                        <MonacoTextarea value={oasValue} onChange={setOasValue} language="json" height={300} minHeight={220} ariaLabel="OpenAPI document to import" />
                      </Field>
                    )}
                    {oasGate && (
                      <MessageBar intent="warning">
                        <MessageBarBody>
                          <MessageBarTitle>APIM not configured</MessageBarTitle>
                          This deployment has no target APIM service. Set <code>{oasGate}</code> on the Console app, then retry.
                        </MessageBarBody>
                      </MessageBar>
                    )}
                    {oasErr && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Import failed</MessageBarTitle>{oasErr}</MessageBarBody></MessageBar>}
                  </div>
                </DialogContent>
                <DialogActions>
                  <Button onClick={() => setOasOpen(false)}>Cancel</Button>
                  <Button appearance="primary" icon={<CloudArrowUp20Regular />} onClick={runOasImport} disabled={oasBusy || !oasApiId.trim() || !oasPath.trim() || !oasValue.trim()}>
                    {oasBusy ? 'Importing…' : 'Import'}
                  </Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>

          {/* Edit OpenAPI dialog */}
          <Dialog open={specEditorOpen} onOpenChange={(_, d) => { if (!d.open) setSpecEditorOpen(false); }}>
            <DialogSurface style={{ maxWidth: '90vw', width: 900 }}>
              <DialogBody>
                <DialogTitle>Edit OpenAPI document</DialogTitle>
                <DialogContent>
                  <MonacoTextarea value={specDraft} onChange={setSpecDraft} language="json" height={420} minHeight={320} ariaLabel="OpenAPI document" />
                  {specError && <MessageBar intent="error"><MessageBarBody>{specError}</MessageBarBody></MessageBar>}
                </DialogContent>
                <DialogActions>
                  <Button onClick={() => setSpecEditorOpen(false)}>Cancel</Button>
                  <Button appearance="primary" onClick={saveSpec} disabled={specSaving}>{specSaving ? 'Saving…' : 'Save spec'}</Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>

          {/* Operation authoring dialog — create / edit a single operation */}
          <Dialog open={opDialogOpen} onOpenChange={(_, d) => { if (!d.open) setOpDialogOpen(false); }}>
            <DialogSurface style={{ maxWidth: '90vw', width: 760 }}>
              <DialogBody>
                <DialogTitle>{opDraft.isNew ? 'Add operation' : `Edit operation${opDraft.operationId ? ` — ${opDraft.operationId}` : ''}`}</DialogTitle>
                <DialogContent>
                  {opLoadingDetail ? (
                    <Spinner size="tiny" label="Loading operation…" labelPosition="after" />
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                      <div className={s.form}>
                        <Field label="Display name" required>
                          <Input value={opDraft.displayName} onChange={(_, d) => setOpDraft((o) => ({ ...o, displayName: d.value }))} placeholder="Get order by id" />
                        </Field>
                        <Field label="Method" required>
                          <Dropdown value={opDraft.method} selectedOptions={[opDraft.method]} onOptionSelect={(_, d) => d.optionValue && setOpDraft((o) => ({ ...o, method: d.optionValue! }))}>
                            {['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE'].map((m) => <Option key={m} value={m}>{m}</Option>)}
                          </Dropdown>
                        </Field>
                        <Field label="URL template" required hint="Relative to the API path, e.g. /orders/{id}" style={{ gridColumn: '1 / -1' }}>
                          <Input value={opDraft.urlTemplate} onChange={(_, d) => setOpDraft((o) => ({ ...o, urlTemplate: d.value }))} placeholder="/orders/{id}" />
                        </Field>
                        <Field label="Description" style={{ gridColumn: '1 / -1' }}>
                          <Input value={opDraft.description} onChange={(_, d) => setOpDraft((o) => ({ ...o, description: d.value }))} placeholder="Returns a single order" />
                        </Field>
                        <Field label="Template parameters" hint="One per line: name:type:required (one for each {token} in the URL)">
                          <Textarea value={opDraft.templateParams} onChange={(_, d) => setOpDraft((o) => ({ ...o, templateParams: d.value }))} rows={3} placeholder={'id:string:required'} />
                        </Field>
                        <Field label="Query parameters" hint="One per line: name:type:required">
                          <Textarea value={opDraft.queryParams} onChange={(_, d) => setOpDraft((o) => ({ ...o, queryParams: d.value }))} rows={3} placeholder={'expand:boolean'} />
                        </Field>
                        <Field label="Request headers" hint="One per line: name:type:required">
                          <Textarea value={opDraft.headerParams} onChange={(_, d) => setOpDraft((o) => ({ ...o, headerParams: d.value }))} rows={3} placeholder={'X-Trace-Id:string'} />
                        </Field>
                        <Field label="Request representations" hint="One content-type per line">
                          <Textarea value={opDraft.requestReps} onChange={(_, d) => setOpDraft((o) => ({ ...o, requestReps: d.value }))} rows={3} placeholder={'application/json'} />
                        </Field>
                        <Field label="Responses" hint="One per line: statusCode:description" style={{ gridColumn: '1 / -1' }}>
                          <Textarea value={opDraft.responses} onChange={(_, d) => setOpDraft((o) => ({ ...o, responses: d.value }))} rows={3} placeholder={'200:OK\n404:Not found'} />
                        </Field>
                      </div>
                      {opErr && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Save failed</MessageBarTitle>{opErr}</MessageBarBody></MessageBar>}
                    </div>
                  )}
                </DialogContent>
                <DialogActions>
                  <Button onClick={() => setOpDialogOpen(false)}>Cancel</Button>
                  <Button appearance="primary" icon={<Save20Regular />} onClick={saveOp} disabled={opBusy || opLoadingDetail || !opDraft.displayName.trim() || !opDraft.urlTemplate.trim()}>
                    {opBusy ? 'Saving…' : opDraft.isNew ? 'Create operation' : 'Save operation'}
                  </Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>
        </div>
      }
    />
  );
}

// ============================================================
// ApimProductEditor
// ============================================================
// (Ribbon defined inside the component via useMemo.)

interface ApimProduct {
  id: string;
  name: string;
  displayName: string;
  description?: string;
  subscriptionRequired?: boolean;
  approvalRequired?: boolean;
  state?: string;
}

export function ApimProductEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const router = useRouter();
  const isNew = id === 'new';
  const [product, setProduct] = useState<LoadState<ApimProduct>>({ loading: !isNew, data: null });
  const [status, setStatus] = useState<{ kind: 'idle' | 'saving' | 'ok' | 'err'; msg?: string }>({ kind: 'idle' });

  const [displayName, setDisplayName] = useState('');
  const [description, setDescription] = useState('');
  const [state, setState] = useState<'published' | 'notPublished'>('notPublished');
  const [subscriptionRequired, setSubscriptionRequired] = useState(true);
  const [approvalRequired, setApprovalRequired] = useState(false);
  const [dirty, setDirty] = useState(false);

  // Tabs: Settings | APIs | Subscriptions
  const [tab, setTab] = useState<'settings' | 'apis' | 'subs'>('settings');

  // APIs-in-product.
  const [apis, setApis] = useState<LoadState<{ productApis: any[]; allApis: any[] }>>({ loading: false, data: null });
  const [addApiId, setAddApiId] = useState('');
  const [apiBusy, setApiBusy] = useState(false);
  const [apiMsg, setApiMsg] = useState<{ intent: 'success' | 'error'; text: string } | null>(null);

  // Subscriptions.
  const [subs, setSubs] = useState<LoadState<any[]>>({ loading: false, data: null });
  // Per-subscription key reveal. APIM never returns keys on GET; the real
  // POST /api/marketplace/subscriptions/[sid]/keys route resolves them via
  // listSecrets server-side. Keyed by subscription name; cleared on tab leave.
  const [subKeys, setSubKeys] = useState<Record<string, { primaryKey?: string; secondaryKey?: string }>>({});
  const [subKeyBusy, setSubKeyBusy] = useState<string | null>(null);
  const [subKeyErr, setSubKeyErr] = useState<{ sid: string; msg: string } | null>(null);

  const revealSubKeys = useCallback(async (sid: string) => {
    // Toggle off if already revealed.
    if (subKeys[sid]) { setSubKeys((cur) => { const n = { ...cur }; delete n[sid]; return n; }); return; }
    setSubKeyBusy(sid); setSubKeyErr(null);
    try {
      const r = await fetch(`/api/marketplace/subscriptions/${encodeURIComponent(sid)}/keys`, { method: 'POST' });
      const j = await r.json();
      if (!j.ok) { setSubKeyErr({ sid, msg: j.error || `HTTP ${r.status}` }); return; }
      setSubKeys((cur) => ({ ...cur, [sid]: { primaryKey: j.primaryKey, secondaryKey: j.secondaryKey } }));
    } catch (e: any) { setSubKeyErr({ sid, msg: e?.message || String(e) }); }
    finally { setSubKeyBusy(null); }
  }, [subKeys]);

  const loadApis = useCallback(async () => {
    if (isNew) return;
    setApis({ loading: true, data: null });
    try {
      const r = await fetch(`/api/items/apim-product/${encodeURIComponent(id)}/apis`);
      const j = await r.json();
      if (!j.ok) { setApis({ loading: false, data: null, error: j.error }); return; }
      setApis({ loading: false, data: { productApis: j.productApis || [], allApis: j.allApis || [] } });
    } catch (e: any) { setApis({ loading: false, data: null, error: e?.message || String(e) }); }
  }, [id, isNew]);

  const loadSubs = useCallback(async () => {
    if (isNew) return;
    setSubs({ loading: true, data: null });
    setSubKeys({}); setSubKeyErr(null); // re-conceal keys on every reload
    try {
      const r = await fetch(`/api/items/apim-product/${encodeURIComponent(id)}/subscriptions`);
      const j = await r.json();
      if (!j.ok) { setSubs({ loading: false, data: null, error: j.error }); return; }
      setSubs({ loading: false, data: j.subscriptions || [] });
    } catch (e: any) { setSubs({ loading: false, data: null, error: e?.message || String(e) }); }
  }, [id, isNew]);

  useEffect(() => { if (tab === 'apis') loadApis(); if (tab === 'subs') loadSubs(); }, [tab, loadApis, loadSubs]);

  const addApi = useCallback(async () => {
    if (!addApiId) return;
    setApiBusy(true); setApiMsg(null);
    try {
      const r = await fetch(`/api/items/apim-product/${encodeURIComponent(id)}/apis`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ apiId: addApiId }),
      });
      const j = await r.json();
      if (!j.ok) { setApiMsg({ intent: 'error', text: j.error || `HTTP ${r.status}` }); return; }
      setApis((cur) => ({ loading: false, data: { productApis: j.productApis || [], allApis: cur.data?.allApis || [] } }));
      setApiMsg({ intent: 'success', text: `Added ${addApiId} to the product.` });
      setAddApiId('');
    } catch (e: any) { setApiMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setApiBusy(false); }
  }, [id, addApiId]);

  const removeApi = useCallback(async (apiName: string) => {
    setApiBusy(true); setApiMsg(null);
    try {
      const r = await fetch(`/api/items/apim-product/${encodeURIComponent(id)}/apis?apiId=${encodeURIComponent(apiName)}`, { method: 'DELETE' });
      const j = await r.json();
      if (!j.ok) { setApiMsg({ intent: 'error', text: j.error || `HTTP ${r.status}` }); return; }
      setApis((cur) => ({ loading: false, data: { productApis: j.productApis || [], allApis: cur.data?.allApis || [] } }));
      setApiMsg({ intent: 'success', text: `Removed ${apiName}.` });
    } catch (e: any) { setApiMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setApiBusy(false); }
  }, [id]);

  const load = useCallback(async () => {
    if (isNew) return;
    setProduct({ loading: true, data: null });
    try {
      const r = await fetch(`/api/items/apim-product/${encodeURIComponent(id)}`);
      const j = await r.json();
      if (!j.ok) { setProduct({ loading: false, data: null, error: j.error || 'Failed to load' }); return; }
      setProduct({ loading: false, data: j.product });
      setDisplayName(j.product.displayName || '');
      setDescription(j.product.description || '');
      setState((j.product.state as any) || 'notPublished');
      setSubscriptionRequired(j.product.subscriptionRequired ?? true);
      setApprovalRequired(j.product.approvalRequired ?? false);
      setDirty(false);
    } catch (e: any) {
      setProduct({ loading: false, data: null, error: e?.message || String(e) });
    }
  }, [id, isNew]);

  useEffect(() => { load(); }, [load]);

  const save = useCallback(async () => {
    if (!displayName.trim()) { setStatus({ kind: 'err', msg: 'displayName is required' }); return; }
    setStatus({ kind: 'saving' });
    // Phase 4.5 — snapshot body before await so the user can keep typing
    // without the request landing on bytes that differ from what we sent.
    const body = { displayName, description, state, subscriptionRequired, approvalRequired };
    try {
      const r = await fetch(`/api/items/apim-product/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!j.ok) { setStatus({ kind: 'err', msg: j.error || `HTTP ${r.status}` }); return; }
      setStatus({ kind: 'ok', msg: `${j.product.displayName} (${j.product.state}) at ${new Date().toLocaleTimeString()}` });
      setProduct({ loading: false, data: j.product });
      setDirty(false);
    } catch (e: any) {
      setStatus({ kind: 'err', msg: e?.message || String(e) });
    }
  }, [id, displayName, description, state, subscriptionRequired, approvalRequired]);

  // Phase 4.5 — Ctrl+S / Cmd+S keyboard shortcut for Save.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (dirty && status.kind !== 'saving' && displayName.trim()) save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dirty, status.kind, displayName, save]);

  // Ribbon — Save / Reload wire to inline handlers; Publish/Unpublish flip the
  // lifecycle state and re-save in one click.
  const publishToggle = useCallback(async (next: 'published' | 'notPublished') => {
    setState(next);
    setDirty(true);
    // Defer save to next tick so React commits the state change before we read
    // it from closure. The save() above captures `state` via closure, so we
    // can't just await save() — instead we hand-roll a parallel PUT here that
    // takes the override.
    setStatus({ kind: 'saving' });
    try {
      const r = await fetch(`/api/items/apim-product/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ displayName, description, state: next, subscriptionRequired, approvalRequired }),
      });
      const j = await r.json();
      if (!j.ok) { setStatus({ kind: 'err', msg: j.error || `HTTP ${r.status}` }); return; }
      setStatus({ kind: 'ok', msg: `${j.product.displayName} (${j.product.state}) at ${new Date().toLocaleTimeString()}` });
      setProduct({ loading: false, data: j.product });
      setDirty(false);
    } catch (e: any) {
      setStatus({ kind: 'err', msg: e?.message || String(e) });
    }
  }, [id, displayName, description, subscriptionRequired, approvalRequired]);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Product', actions: [
        { label: status.kind === 'saving' ? 'Saving…' : 'Save', onClick: status.kind !== 'saving' && (isNew || dirty) && displayName.trim() ? save : undefined, disabled: status.kind === 'saving' || (!isNew && !dirty) || !displayName.trim(), title: !displayName.trim() ? 'displayName is required' : (!dirty && !isNew ? 'No unsaved changes' : undefined) },
        { label: 'Reload', onClick: !isNew ? load : undefined, disabled: isNew, title: isNew ? 'Save the product first' : undefined },
      ]},
      { label: 'Lifecycle', actions: [
        { label: 'Publish', onClick: status.kind !== 'saving' && state !== 'published' && displayName.trim() ? () => publishToggle('published') : undefined, disabled: status.kind === 'saving' || state === 'published' || !displayName.trim(), title: state === 'published' ? 'Already published' : (!displayName.trim() ? 'displayName is required' : undefined) },
        { label: 'Unpublish', onClick: status.kind !== 'saving' && state === 'published' ? () => publishToggle('notPublished') : undefined, disabled: status.kind === 'saving' || state !== 'published', title: state !== 'published' ? 'Already not published' : undefined },
      ]},
      { label: 'Configure', actions: [
        { label: 'APIs', onClick: !isNew ? () => setTab('apis') : undefined, disabled: isNew, title: isNew ? 'Save the product first' : undefined },
        { label: 'Subscriptions', onClick: !isNew ? () => setTab('subs') : undefined, disabled: isNew, title: isNew ? 'Save the product first' : undefined },
        { label: 'Product policy', onClick: !isNew ? () => router.push(`/items/apim-policy/${encodeURIComponent(id)}?scope=product&productId=${encodeURIComponent(id)}`) : undefined, disabled: isNew, title: isNew ? 'Save the product first' : undefined },
      ]},
    ]},
  ], [status.kind, isNew, dirty, displayName, save, load, state, publishToggle, router, id]);

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={
      <div className={s.pad}>
        <div className={s.toolbar}>
          <Badge appearance="filled" color="brand">APIM Product</Badge>
          <Badge appearance="outline">{product.data?.name || id}</Badge>
          {product.data?.state && (
            <Badge appearance="outline" color={product.data.state === 'published' ? 'success' : 'informative'}>
              {product.data.state}
            </Badge>
          )}
          {dirty && <Badge appearance="outline" color="warning">unsaved</Badge>}
          <Button appearance="primary" icon={<Save20Regular />} onClick={save} disabled={status.kind === 'saving' || (!isNew && !dirty)}>
            {status.kind === 'saving' ? 'Saving…' : isNew ? 'Create' : 'Save'}
          </Button>
          <Button appearance="outline" icon={<ArrowSync20Regular />} onClick={load}>Reload</Button>
        </div>
        <StatusBar status={status} />
        {product.loading && <Spinner size="small" label="Loading product…" labelPosition="after" />}
        {product.error && !product.loading && (
          <BackendStateBar error={product.error} title="APIM Product" />
        )}

        <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as typeof tab)}>
          <Tab value="settings" icon={<Document20Regular />}>Settings</Tab>
          <Tab value="apis" icon={<Code20Regular />} disabled={isNew}>APIs</Tab>
          <Tab value="subs" icon={<Key20Regular />} disabled={isNew}>Subscriptions</Tab>
        </TabList>

        {tab === 'settings' && (
          <div className={s.form}>
            <Field label="Display name" required>
              <Input value={displayName} onChange={(_, d) => { setDisplayName(d.value); setDirty(true); }} />
            </Field>
            <Field label="Lifecycle state">
              <Dropdown
                value={state}
                selectedOptions={[state]}
                onOptionSelect={(_, d) => { if (d.optionValue) { setState(d.optionValue as 'published' | 'notPublished'); setDirty(true); } }}
              >
                <Option value="notPublished">Not published</Option>
                <Option value="published">Published</Option>
              </Dropdown>
            </Field>
            <div style={{ gridColumn: '1 / span 2' }}>
              <Field label="Description" hint="Shown in the developer portal">
                <Textarea value={description} onChange={(_, d) => { setDescription(d.value); setDirty(true); }} rows={4} />
              </Field>
            </div>
            <Field label="Subscription required">
              <Switch checked={subscriptionRequired} onChange={(_, d) => { setSubscriptionRequired(d.checked); setDirty(true); }} label={subscriptionRequired ? 'Yes' : 'No'} />
            </Field>
            <Field label="Approval required" hint="Only meaningful when subscription is required">
              <Switch checked={approvalRequired} onChange={(_, d) => { setApprovalRequired(d.checked); setDirty(true); }} disabled={!subscriptionRequired} label={approvalRequired ? 'Yes' : 'No'} />
            </Field>
          </div>
        )}

        {tab === 'apis' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <Field label="Add an API to this product" style={{ minWidth: 280 }}>
                <Dropdown
                  placeholder={apis.loading ? 'Loading…' : 'Select an API'}
                  value={(apis.data?.allApis || []).find((a: any) => a.name === addApiId)?.displayName || addApiId}
                  selectedOptions={addApiId ? [addApiId] : []}
                  onOptionSelect={(_, d) => setAddApiId(d.optionValue || '')}
                >
                  {(apis.data?.allApis || []).map((a: any) => <Option key={a.name} value={a.name}>{`${a.displayName} (${a.name})`}</Option>)}
                </Dropdown>
              </Field>
              <Button appearance="primary" icon={<Add20Regular />} onClick={addApi} disabled={apiBusy || !addApiId}>Add</Button>
              <Button appearance="outline" icon={<ArrowSync20Regular />} onClick={loadApis}>Reload</Button>
            </div>
            {apiMsg && <MessageBar intent={apiMsg.intent}><MessageBarBody>{apiMsg.text}</MessageBarBody></MessageBar>}
            {apis.loading && <Spinner size="tiny" label="Loading product APIs…" labelPosition="after" />}
            {apis.error && <MessageBar intent="warning"><MessageBarBody>{apis.error}</MessageBarBody></MessageBar>}
            {apis.data && (
              <Table size="small" aria-label="Product APIs">
                <TableHeader><TableRow>
                  <TableHeaderCell>API</TableHeaderCell>
                  <TableHeaderCell>Path</TableHeaderCell>
                  <TableHeaderCell />
                </TableRow></TableHeader>
                <TableBody>
                  {apis.data.productApis.length === 0 && (
                    <TableRow><TableCell>No APIs in this product yet.</TableCell><TableCell /><TableCell /></TableRow>
                  )}
                  {apis.data.productApis.map((a: any) => (
                    <TableRow key={a.name}>
                      <TableCell><strong>{a.displayName}</strong> <Caption1>· {a.name}</Caption1></TableCell>
                      <TableCell><code>{a.path}</code></TableCell>
                      <TableCell><Button size="small" icon={<Delete20Regular />} onClick={() => removeApi(a.name)} disabled={apiBusy}>Remove</Button></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        )}

        {tab === 'subs' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <Button appearance="outline" icon={<ArrowSync20Regular />} onClick={loadSubs}>Reload</Button>
              <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                Subscriptions scoped to this product. Use <strong>Show keys</strong> to reveal the primary/secondary key (resolved server-side via listSecrets — keys never persist in the browser).
              </Caption1>
            </div>
            {/* Honest gate: APIM exposes Suspend / Activate / Cancel state transitions and
                key regeneration on subscriptions. Those write-paths have no BFF route in
                this deployment yet, so they are surfaced as a tracked gap rather than a
                dead button. */}
            <MessageBar intent="info">
              <MessageBarBody>
                <MessageBarTitle>Read + reveal only</MessageBarTitle>
                State transitions (Suspend / Activate / Cancel) and key <em>regeneration</em> are not yet wired — they need a
                {' '}<code>PATCH/POST /api/apim/subscriptions/&#123;sid&#125;</code> route (<code>updateSubscriptionState</code> / <code>regenerateSubscriptionKey</code> on the ARM client). Reveal + copy below are live.
              </MessageBarBody>
            </MessageBar>
            {subs.loading && <Spinner size="tiny" label="Loading subscriptions…" labelPosition="after" />}
            {subs.error && <MessageBar intent="warning"><MessageBarBody>{subs.error}</MessageBarBody></MessageBar>}
            {subs.data && (
              <Table size="small" aria-label="Subscriptions">
                <TableHeader><TableRow>
                  <TableHeaderCell>Name</TableHeaderCell>
                  <TableHeaderCell>Display name</TableHeaderCell>
                  <TableHeaderCell>State</TableHeaderCell>
                  <TableHeaderCell>Created</TableHeaderCell>
                  <TableHeaderCell>Keys</TableHeaderCell>
                </TableRow></TableHeader>
                <TableBody>
                  {subs.data.length === 0 && (
                    <TableRow><TableCell>No subscriptions to this product.</TableCell><TableCell /><TableCell /><TableCell /><TableCell /></TableRow>
                  )}
                  {subs.data.map((sub: any) => {
                    const revealed = subKeys[sub.name];
                    return (
                      <TableRow key={sub.name}>
                        <TableCell><code>{sub.name}</code></TableCell>
                        <TableCell>{sub.displayName || '—'}</TableCell>
                        <TableCell><Badge appearance="outline" color={sub.state === 'active' ? 'success' : 'informative'}>{sub.state || '—'}</Badge></TableCell>
                        <TableCell>{sub.createdDate || '—'}</TableCell>
                        <TableCell>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                            <Button
                              size="small"
                              icon={revealed ? <EyeOff20Regular /> : <Eye20Regular />}
                              onClick={() => revealSubKeys(sub.name)}
                              disabled={subKeyBusy === sub.name}
                              aria-label={revealed ? `Hide keys for ${sub.name}` : `Show keys for ${sub.name}`}
                            >
                              {subKeyBusy === sub.name ? 'Revealing…' : revealed ? 'Hide keys' : 'Show keys'}
                            </Button>
                            {subKeyErr && subKeyErr.sid === sub.name && <Caption1 style={{ color: tokens.colorPaletteRedForeground1 }}>{subKeyErr.msg}</Caption1>}
                            {revealed && (
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                                {(['primaryKey', 'secondaryKey'] as const).map((k) => (
                                  <div key={k} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                                    <Caption1 style={{ color: tokens.colorNeutralForeground3, minWidth: 64 }}>{k === 'primaryKey' ? 'Primary' : 'Secondary'}</Caption1>
                                    <code style={{ fontSize: 11, wordBreak: 'break-all', maxWidth: 240 }}>{revealed[k] || '—'}</code>
                                    {revealed[k] && (
                                      <Button size="small" appearance="transparent" icon={<Copy20Regular />} aria-label={`Copy ${k === 'primaryKey' ? 'primary' : 'secondary'} key`} onClick={() => navigator.clipboard?.writeText(revealed[k]!).catch(() => {})} />
                                    )}
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </div>
        )}
      </div>
    } />
  );
}

// ============================================================
// ApimPolicyEditor
// ============================================================
// (Ribbon defined inside the component via useMemo so onClick handlers can
// reference inline save / load / setScopeKind state.)

// v3.27: added 'operation' scope — APIM's finest-grain policy attach point.
type PolicyScopeKind = 'service' | 'api' | 'product' | 'operation';

const DEFAULT_POLICY_XML =
  `<policies>\n  <inbound>\n    <base />\n    <!-- example: validate Entra JWT -->\n    <!-- <validate-jwt header-name="Authorization" failed-validation-httpcode="401">\n      <openid-config url="https://login.microsoftonline.com/{tenant}/v2.0/.well-known/openid-configuration" />\n    </validate-jwt> -->\n    <rate-limit calls="120" renewal-period="60" />\n  </inbound>\n  <backend>\n    <base />\n  </backend>\n  <outbound>\n    <base />\n  </outbound>\n  <on-error>\n    <base />\n  </on-error>\n</policies>`;

// The proven APIM policy snippets the portal "+ Add policy" gallery ships.
const POLICY_SNIPPETS: { key: string; label: string; section: 'inbound' | 'outbound'; xml: string }[] = [
  { key: 'rate-limit', label: 'Limit call rate', section: 'inbound', xml: `<rate-limit calls="120" renewal-period="60" />` },
  { key: 'quota', label: 'Set usage quota', section: 'inbound', xml: `<quota calls="10000" renewal-period="86400" />` },
  { key: 'validate-jwt', label: 'Validate Entra JWT', section: 'inbound', xml: `<validate-jwt header-name="Authorization" failed-validation-httpcode="401" failed-validation-error-message="Unauthorized">\n      <openid-config url="https://login.microsoftonline.com/{tenant}/v2.0/.well-known/openid-configuration" />\n      <audiences><audience>api://your-api</audience></audiences>\n    </validate-jwt>` },
  { key: 'cors', label: 'Allow cross-origin (CORS)', section: 'inbound', xml: `<cors allow-credentials="false">\n      <allowed-origins><origin>*</origin></allowed-origins>\n      <allowed-methods><method>GET</method><method>POST</method></allowed-methods>\n      <allowed-headers><header>*</header></allowed-headers>\n    </cors>` },
  { key: 'ip-filter', label: 'Restrict caller IPs', section: 'inbound', xml: `<ip-filter action="allow">\n      <address-range from="10.0.0.0" to="10.255.255.255" />\n    </ip-filter>` },
  { key: 'set-header-in', label: 'Set request header', section: 'inbound', xml: `<set-header name="X-Forwarded-By" exists-action="override">\n      <value>csa-loom</value>\n    </set-header>` },
  { key: 'set-backend', label: 'Set backend service', section: 'inbound', xml: `<set-backend-service base-url="https://backend.example.com" />` },
  { key: 'mock', label: 'Mock response', section: 'inbound', xml: `<mock-response status-code="200" content-type="application/json" />` },
  { key: 'set-header-out', label: 'Set response header', section: 'outbound', xml: `<set-header name="X-Powered-By" exists-action="override">\n      <value>CSA Loom APIM</value>\n    </set-header>` },
  { key: 'cache-lookup', label: 'Cache responses', section: 'inbound', xml: `<cache-lookup vary-by-developer="false" vary-by-developer-groups="false" downstream-caching-type="none" />` },
  // ── AI gateway (LLM) policies — for Azure OpenAI / Foundry-backed APIs ──
  { key: 'llm-token-limit', label: 'AI: token-per-minute limit', section: 'inbound', xml: `<llm-token-limit counter-key="@(context.Subscription.Id)" tokens-per-minute="5000" estimate-prompt-tokens="true" remaining-tokens-header-name="x-remaining-tokens" tokens-consumed-header-name="x-consumed-tokens" />` },
  { key: 'llm-content-safety', label: 'AI: content safety check', section: 'inbound', xml: `<llm-content-safety backend-id="content-safety-backend" shield-prompt="true">\n      <categories output-type="EightSeverityLevels">\n        <category name="Hate" threshold="4" />\n        <category name="Violence" threshold="4" />\n        <category name="Sexual" threshold="4" />\n        <category name="SelfHarm" threshold="4" />\n      </categories>\n    </llm-content-safety>` },
  { key: 'llm-semantic-cache-lookup', label: 'AI: semantic cache lookup', section: 'inbound', xml: `<llm-semantic-cache-lookup score-threshold="0.05" embeddings-backend-id="embeddings-backend" embeddings-backend-auth="system-assigned">\n      <vary-by>@(context.Subscription.Id)</vary-by>\n    </llm-semantic-cache-lookup>` },
  { key: 'llm-semantic-cache-store', label: 'AI: semantic cache store', section: 'outbound', xml: `<llm-semantic-cache-store duration="60" />` },
  { key: 'llm-emit-token-metric', label: 'AI: emit token metrics', section: 'inbound', xml: `<llm-emit-token-metric namespace="openai">\n      <dimension name="API ID" value="@(context.Api.Id)" />\n      <dimension name="Subscription ID" value="@(context.Subscription.Id)" />\n    </llm-emit-token-metric>` },
];

function isWellFormedXml(xml: string): { ok: true } | { ok: false; error: string } {
  try {
    if (typeof DOMParser === 'undefined') return { ok: true }; // SSR fallback
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    const err = doc.getElementsByTagName('parsererror')[0];
    if (err) return { ok: false, error: err.textContent || 'XML parse error' };
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

export function ApimPolicyEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const [scopeKind, setScopeKind] = useState<PolicyScopeKind>('service');
  const [apiId, setApiId] = useState('');
  const [productId, setProductId] = useState('');
  const [operationId, setOperationId] = useState('');
  const [value, setValue] = useState(DEFAULT_POLICY_XML);
  const [loadState, setLoadState] = useState<LoadState<{ value: string; format: string }>>({ loading: true, data: null });
  const [status, setStatus] = useState<{ kind: 'idle' | 'saving' | 'ok' | 'err'; msg?: string }>({ kind: 'idle' });
  const [dirty, setDirty] = useState(false);

  const scopeQuery = useMemo(() => {
    const sp = new URLSearchParams({ scope: scopeKind });
    if ((scopeKind === 'api' || scopeKind === 'operation') && apiId) sp.set('apiId', apiId);
    if (scopeKind === 'product' && productId) sp.set('productId', productId);
    if (scopeKind === 'operation' && operationId) sp.set('operationId', operationId);
    return sp.toString();
  }, [scopeKind, apiId, productId, operationId]);

  const load = useCallback(async () => {
    setLoadState({ loading: true, data: null });
    try {
      const r = await fetch(`/api/items/apim-policy/${encodeURIComponent(id)}?${scopeQuery}`);
      const j = await r.json();
      if (!j.ok) { setLoadState({ loading: false, data: null, error: j.error }); return; }
      setLoadState({ loading: false, data: { value: j.value, format: j.format } });
      if (j.value) setValue(j.value);
      else setValue(DEFAULT_POLICY_XML);
      setDirty(false);
    } catch (e: any) {
      setLoadState({ loading: false, data: null, error: e?.message || String(e) });
    }
  }, [id, scopeQuery]);

  useEffect(() => {
    // Only auto-load when scope is fully specified.
    if (scopeKind === 'service') load();
    else if (scopeKind === 'api' && apiId) load();
    else if (scopeKind === 'product' && productId) load();
    else if (scopeKind === 'operation' && apiId && operationId) load();
    else setLoadState({ loading: false, data: null });
  }, [load, scopeKind, apiId, productId, operationId]);

  const save = useCallback(async () => {
    // Phase 4.5 — snapshot the XML buffer via functional setter so the
    // bytes validated, sent, and reflected back in the status match the
    // user's actual edit even if Monaco fires another onChange during the
    // await. Mirrors notebook-editor.tsx patchCell snapshot pattern.
    let snapshot = value;
    setValue((prev) => { snapshot = prev; return prev; });
    const check = isWellFormedXml(snapshot);
    if (!check.ok) { setStatus({ kind: 'err', msg: `Invalid XML: ${check.error}` }); return; }
    if (scopeKind === 'api' && !apiId) { setStatus({ kind: 'err', msg: 'apiId is required for API scope' }); return; }
    if (scopeKind === 'product' && !productId) { setStatus({ kind: 'err', msg: 'productId is required for product scope' }); return; }
    if (scopeKind === 'operation' && (!apiId || !operationId)) { setStatus({ kind: 'err', msg: 'apiId and operationId are required for operation scope' }); return; }
    setStatus({ kind: 'saving' });
    try {
      const r = await fetch(`/api/items/apim-policy/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scope: scopeKind, apiId, productId, operationId, value: snapshot }),
      });
      const j = await r.json();
      if (!j.ok) { setStatus({ kind: 'err', msg: j.error || `HTTP ${r.status}` }); return; }
      setStatus({ kind: 'ok', msg: `Policy saved at scope: ${j.scope} at ${new Date().toLocaleTimeString()}` });
      setDirty(false);
    } catch (e: any) {
      setStatus({ kind: 'err', msg: e?.message || String(e) });
    }
  }, [id, scopeKind, apiId, productId, operationId, value]);

  // Phase 4.5 — Ctrl+S / Cmd+S keyboard shortcut for Save.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (dirty && status.kind !== 'saving') save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dirty, status.kind, save]);

  // Ribbon — Save / Reload wired inline; Validate XML runs the existing
  // isWellFormedXml check; Global/API/Product/Operation set the local scopeKind.
  const validateXml = useCallback(() => {
    const check = isWellFormedXml(value);
    if (check.ok) {
      setStatus({ kind: 'ok', msg: 'XML is well-formed.' });
    } else {
      setStatus({ kind: 'err', msg: `Invalid XML: ${check.error}` });
    }
  }, [value]);

  // Policy snippet gallery — the same proven snippets APIM's "+ Add policy"
  // gallery ships. Inserting drops the fragment into the <inbound> (or
  // <outbound> for set-header-out) section of the current buffer.
  const insertSnippet = useCallback((snippet: string, section: 'inbound' | 'outbound' = 'inbound') => {
    setValue((prev) => {
      const tag = `<${section}>`;
      const ix = prev.indexOf(tag);
      if (ix < 0) return prev + '\n' + snippet;
      const insertAt = ix + tag.length;
      return prev.slice(0, insertAt) + '\n    ' + snippet.trim() + prev.slice(insertAt);
    });
    setDirty(true);
  }, []);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Edit', actions: [
        { label: status.kind === 'saving' ? 'Saving…' : 'Save', onClick: status.kind !== 'saving' && dirty ? save : undefined, disabled: status.kind === 'saving' || !dirty, title: !dirty ? 'No unsaved changes' : undefined },
        { label: 'Reload', onClick: load },
        { label: 'Validate XML', onClick: validateXml },
      ]},
      { label: 'Scope', actions: [
        { label: 'Global', onClick: () => setScopeKind('service') },
        { label: 'API', onClick: () => setScopeKind('api') },
        { label: 'Product', onClick: () => setScopeKind('product') },
        { label: 'Operation', onClick: () => setScopeKind('operation') },
      ]},
    ]},
  ], [status.kind, dirty, save, load, validateXml]);

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={
      <div className={s.pad}>
        <div className={s.toolbar}>
          <Badge appearance="filled" color="brand">APIM Policy</Badge>
          <Field label="Scope">
            <Dropdown
              value={scopeKind}
              selectedOptions={[scopeKind]}
              onOptionSelect={(_, d) => d.optionValue && setScopeKind(d.optionValue as PolicyScopeKind)}
            >
              <Option value="service">Global (service)</Option>
              <Option value="api">API</Option>
              <Option value="product">Product</Option>
              <Option value="operation">API operation</Option>
            </Dropdown>
          </Field>
          {(scopeKind === 'api' || scopeKind === 'operation') && (
            <Field label="API id">
              <Input value={apiId} onChange={(_, d) => setApiId(d.value)} placeholder="e.g. orders-api" />
            </Field>
          )}
          {scopeKind === 'operation' && (
            <Field label="Operation id">
              <Input value={operationId} onChange={(_, d) => setOperationId(d.value)} placeholder="e.g. getOrderById" />
            </Field>
          )}
          {scopeKind === 'product' && (
            <Field label="Product id">
              <Input value={productId} onChange={(_, d) => setProductId(d.value)} placeholder="e.g. customer-360" />
            </Field>
          )}
          {dirty && <Badge appearance="outline" color="warning" style={{ marginLeft: 'auto' }}>unsaved</Badge>}
          <Button
            appearance="primary"
            icon={<Save20Regular />}
            onClick={save}
            disabled={status.kind === 'saving' || !dirty}
            style={dirty ? undefined : { marginLeft: 'auto' }}
          >
            {status.kind === 'saving' ? 'Saving…' : 'Save policy'}
          </Button>
          <Button appearance="outline" icon={<ArrowSync20Regular />} onClick={load}>Reload</Button>
        </div>
        <StatusBar status={status} />
        {loadState.loading && <Spinner size="tiny" label="Loading policy…" labelPosition="after" />}
        {loadState.error && !loadState.loading && (
          <MessageBar intent="warning">
            <MessageBarBody>
              <MessageBarTitle>Could not load existing policy</MessageBarTitle>
              {loadState.error}
            </MessageBarBody>
          </MessageBar>
        )}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Add policy snippet:</Caption1>
          <Dropdown
            aria-label="Add a policy snippet to the editor"
            placeholder="Choose a snippet…"
            selectedOptions={[]}
            value=""
            onOptionSelect={(_, d) => {
              const snip = POLICY_SNIPPETS.find((p) => p.key === d.optionValue);
              if (snip) insertSnippet(snip.xml, snip.section);
            }}
          >
            {POLICY_SNIPPETS.map((p) => <Option key={p.key} value={p.key}>{p.label}</Option>)}
          </Dropdown>
          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Inserts into the matching inbound/outbound section.</Caption1>
        </div>
        {/* Honest gate per ui-parity.md: the Azure portal also ships a form-based
            "+ Add policy" guided editor, an effective-policy (inherited base
            resolution) view, and reusable policy fragments. The code editor below
            is full-fidelity, but those three surfaces are genuinely heavy and
            backend-gated, so they are flagged as tracked gaps rather than faked. */}
        <MessageBar intent="info">
          <MessageBarBody>
            <MessageBarTitle>Code editor (full XML). Three portal surfaces are tracked gaps.</MessageBarTitle>
            The form-based guided editor, <em>Calculate effective policy</em> (inherited <code>&lt;base/&gt;</code> resolution), and reusable <em>policy fragments</em> are not built yet — each needs a dedicated ARM read (<code>policies?format=rawxml</code> effective resolution / <code>policyFragments</code> CRUD). The XML editor, snippet gallery, scope selector, validation, and save are all live.
          </MessageBarBody>
        </MessageBar>
        <MonacoTextarea
          value={value}
          onChange={(v) => { setValue(v); setDirty(true); }}
          language="xml"
          height={320}
          minHeight={240}
          ariaLabel="APIM policy XML"
        />
      </div>
    } />
  );
}

// ============================================================
// DataProductEditor
// ============================================================
// (Ribbon defined inside the component via useMemo.)

interface DataProductDataset { name: string; typeName: string; qualifiedName: string; classifications: string[]; guid?: string; }
interface DataProductGlossaryLink { name: string; guid?: string; }
interface DataProductState {
  displayName: string;
  description: string;
  domain: string;
  owner: string;
  certified: boolean;
  sla: string;
  bundle: string[];
  // Phase 2 parity surfaces — datasets/assets, linked glossary terms.
  datasets?: DataProductDataset[];
  glossaryLinks?: DataProductGlossaryLink[];
  // Phase 1 Purview Unified Catalog wiring — populated by
  // POST /api/items/data-product/[id]/register-purview on success.
  purviewDataProductId?: string;
  lastRegisteredAt?: string;
  // F21 Publish-as-API edge — populated by
  // POST /api/items/data-product/[id]/publish-api on success. The subscription
  // KEY is deliberately NOT stored here (ephemeral, shown once in the receipt).
  apimApiId?: string;
  apimProductId?: string;
  apimSubscriptionId?: string;
  apimGatewayUrl?: string;
  apimServiceUrl?: string;
  apimApiPath?: string;
  apimPublishedAt?: string;
}

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DP_EMPTY: DataProductState = {
  displayName: '',
  description: '',
  domain: '',
  owner: '',
  certified: false,
  sla: '',
  bundle: [],
};

/**
 * Project a bundle-installed data product's `state.content` (DataProductContent
 * — datasets/glossaryTerms/owner/endorsement per content-bundles/types.ts) into
 * the editor's DataProductState so an app-installed data product opens FULLY
 * BUILT-OUT (its datasets, glossary terms, owner, endorsement) instead of an
 * empty form. The editor's existing direct state fields win when present
 * (e.g. after the user has edited + saved); content only fills gaps. This
 * keeps Register-with-Purview / dataset registration hitting the real backend.
 */
function projectDataProductContent(state: Record<string, unknown>): Partial<DataProductState> {
  const out: Partial<DataProductState> = { ...(state as Partial<DataProductState>) };
  const content = (state?.content as any);
  if (!content || content.kind !== 'data-product') return out;

  // Datasets: content { id, name, description, classification } → editor
  // DataProductDataset { name, typeName, qualifiedName, classifications[] }.
  if ((!out.datasets || out.datasets.length === 0) && Array.isArray(content.datasets)) {
    out.datasets = content.datasets.map((d: any) => ({
      name: d.name,
      typeName: 'fabric_data_product',
      qualifiedName: d.id || d.name,
      classifications: d.classification ? [String(d.classification)] : [],
    }));
  }
  // Glossary terms: content { term, definition } → editor { name }.
  if ((!out.glossaryLinks || out.glossaryLinks.length === 0) && Array.isArray(content.glossaryTerms)) {
    out.glossaryLinks = content.glossaryTerms.map((t: any) => ({ name: t.term }));
  }
  // Owner: content { name, email? } → editor owner string.
  if (!out.owner && content.owner) {
    out.owner = content.owner.email
      ? `${content.owner.name} <${content.owner.email}>`
      : (content.owner.name || '');
  }
  // Endorsement → certified flag (editor's only endorsement surface).
  if (out.certified === undefined && content.endorsement) {
    out.certified = content.endorsement === 'certified';
  }
  return out;
}

// Hint payload returned with HTTP 501 from /register-purview when the
// LOOM_PURVIEW_ACCOUNT env var is not set. Mirrors PurviewNotConfiguredHint
// in lib/azure/purview-client.ts.
interface PurviewNotConfiguredHint {
  missingEnvVar: string;
  bicepModule: string;
  bicepStatus: string;
  rolesRequired: { name: string; scope: string; reason: string }[];
  followUp: string;
}

// Workspace picker source for creating a brand-new data product on /new.
function useDataProductWorkspaces() {
  const [workspaces, setWorkspaces] = useState<{ id: string; name: string }[] | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch('/api/loom/workspaces');
        const j = await r.json();
        setWorkspaces(j.ok ? (j.workspaces || []) : []);
      } catch { setWorkspaces([]); }
      finally { setLoading(false); }
    })();
  }, []);
  return { workspaces, loading };
}

// Governance-domain picker source — resolves the Purview businessDomainId GUID
// that register-purview requires. Honest gate: 501 (Purview unprovisioned)
// surfaces as `notConfigured` so the form still renders.
function useGovernanceDomains() {
  const [domains, setDomains] = useState<{ id: string; name: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notConfigured, setNotConfigured] = useState(false);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch('/api/catalog/domains');
        const j = await r.json();
        if (r.status === 501) { setNotConfigured(true); setDomains([]); }
        else if (!j.ok) { setError(j.error || `HTTP ${r.status}`); setDomains([]); }
        else setDomains(j.domains || []);
      } catch (e: any) { setError(e?.message || String(e)); setDomains([]); }
      finally { setLoading(false); }
    })();
  }, []);
  return { domains, error, notConfigured, loading };
}

/**
 * F21 — Publish-as-API dialog. Captures the backing query endpoint, POSTs to
 * /publish-api, and on success renders the consumable URL + masked subscription
 * key + a copy-paste curl example. Honest-gates when APIM env vars are absent.
 */
function PublishAsApiDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  serviceUrl: string;
  onServiceUrlChange: (v: string) => void;
  busy: boolean;
  result: { callableUrl: string; primaryKey?: string; apiId: string; productId: string; sid: string; gatewayUrl: string } | null;
  gate: { hint: string; missing?: string; bicepModule?: string } | null;
  err: string | null;
  keyVisible: boolean;
  onToggleKey: () => void;
  onPublish: () => void;
  republish: boolean;
}) {
  const { open, onOpenChange, serviceUrl, onServiceUrlChange, busy, result, gate, err, keyVisible, onToggleKey, onPublish, republish } = props;
  const copy = (text: string) => { try { void navigator.clipboard?.writeText(text); } catch { /* clipboard unavailable */ } };
  const curl = result
    ? `curl "${result.callableUrl}" \\\n  -H "Ocp-Apim-Subscription-Key: ${result.primaryKey || '<your-subscription-key>'}"`
    : '';
  return (
    <Dialog open={open} onOpenChange={(_, d) => onOpenChange(d.open)}>
      <DialogSurface style={{ maxWidth: 640 }}>
        <DialogBody>
          <DialogTitle>{republish ? 'Re-publish data product as API' : 'Publish data product as API'}</DialogTitle>
          <DialogContent>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <Body1>
                Front this data product&apos;s backing query endpoint with Azure API Management. Loom creates an APIM
                API + published product, mints an active subscription key, and returns a consumable URL. The API ref is
                persisted on the data product.
              </Body1>
              {gate && (
                <MessageBar intent="warning">
                  <MessageBarBody>
                    <MessageBarTitle>Azure API Management is not configured in this deployment</MessageBarTitle>
                    {gate.missing && <>Missing env var: <code>{gate.missing}</code>. </>}
                    {gate.hint}
                    {gate.bicepModule && <> Bicep module: <code>{gate.bicepModule}</code>.</>}
                  </MessageBarBody>
                </MessageBar>
              )}
              {err && <MessageBar intent="error"><MessageBarBody>{err}</MessageBarBody></MessageBar>}
              {!result && (
                <Field label="Backing service URL (the query endpoint APIM proxies to)" required
                  hint="The HTTPS endpoint that serves this data product's data — e.g. a Data API Builder route, a Function, or a Synapse SQL serverless REST surface.">
                  <Input value={serviceUrl} onChange={(_, d) => onServiceUrlChange(d.value)} placeholder="https://dab.internal.example.com/api/silver_revenue" />
                </Field>
              )}
              {result && (
                <MessageBar intent="success">
                  <MessageBarBody>
                    <MessageBarTitle>API published — endpoint is live</MessageBarTitle>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <strong>Consumable URL:</strong>
                        <code style={{ wordBreak: 'break-all' }}>{result.callableUrl}</code>
                        <Button size="small" appearance="subtle" icon={<Copy20Regular />} onClick={() => copy(result.callableUrl)}>Copy</Button>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <strong>Header:</strong>
                        <code>Ocp-Apim-Subscription-Key:</code>
                        <code>{keyVisible ? (result.primaryKey || '—') : '••••••••••••••••'}</code>
                        <Button size="small" appearance="subtle" icon={keyVisible ? <EyeOff20Regular /> : <Eye20Regular />} onClick={onToggleKey}>{keyVisible ? 'Hide' : 'Reveal'}</Button>
                        {result.primaryKey && <Button size="small" appearance="subtle" icon={<Copy20Regular />} onClick={() => copy(result.primaryKey!)}>Copy key</Button>}
                      </div>
                      <Caption1>This subscription key is shown once and is not stored on the item — copy it now. Manage or regenerate it in the APIM navigator (subscription <code>{result.sid}</code>).</Caption1>
                      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                        <pre style={{ flex: 1, margin: 0, padding: 8, background: tokens.colorNeutralBackground3, borderRadius: 4, fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{curl}</pre>
                        <Button size="small" appearance="subtle" icon={<Copy20Regular />} onClick={() => copy(curl)}>Copy curl</Button>
                      </div>
                      <Caption1>API <code>{result.apiId}</code> · Product <code>{result.productId}</code> · Gateway <code>{result.gatewayUrl}</code></Caption1>
                    </div>
                  </MessageBarBody>
                </MessageBar>
              )}
            </div>
          </DialogContent>
          <DialogActions>
            {!result && (
              <Button appearance="primary" icon={<Key20Regular />} onClick={onPublish} disabled={busy || !serviceUrl.trim() || !!gate}>
                {busy ? 'Publishing…' : republish ? 'Re-publish API' : 'Publish API'}
              </Button>
            )}
            <DialogTrigger disableButtonEnhancement>
              <Button appearance="secondary">{result ? 'Done' : 'Cancel'}</Button>
            </DialogTrigger>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

export function DataProductEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const router = useRouter();
  const ws = useDataProductWorkspaces();
  const [workspaceId, setWorkspaceId] = useState('');
  const [state, setState] = useState<DataProductState>(DP_EMPTY);
  const [loading, setLoading] = useState(id !== 'new');
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [status, setStatus] = useState<{ kind: 'idle' | 'saving' | 'ok' | 'err'; msg?: string }>({ kind: 'idle' });
  const [dirty, setDirty] = useState(false);
  // Phase 1: when /register-purview returns 501, we surface the structured
  // hint payload as a dedicated MessageBar so the operator sees the bicep
  // module path + roles to grant.
  const [purviewHint, setPurviewHint] = useState<PurviewNotConfiguredHint | null>(null);

  // F21 Publish-as-API — dialog state. The serviceUrl is the backing query
  // endpoint APIM proxies to; the receipt carries the callable URL + key.
  const [publishApiOpen, setPublishApiOpen] = useState(false);
  const [publishApiServiceUrl, setPublishApiServiceUrl] = useState('');
  const [publishApiBusy, setPublishApiBusy] = useState(false);
  const [publishApiResult, setPublishApiResult] = useState<{
    callableUrl: string; primaryKey?: string; apiId: string; productId: string; sid: string; gatewayUrl: string;
  } | null>(null);
  const [publishApiGate, setPublishApiGate] = useState<{ hint: string; missing?: string; bicepModule?: string } | null>(null);
  const [publishApiErr, setPublishApiErr] = useState<string | null>(null);
  const [publishApiKeyVisible, setPublishApiKeyVisible] = useState(false);

  const domains = useGovernanceDomains();

  // Tabs: Overview | Datasets | Glossary | Lineage | Access policies
  const [tab, setTab] = useState<'overview' | 'datasets' | 'glossary' | 'lineage' | 'policies'>('overview');

  // Dataset (Atlas entity) registration form.
  const [dsName, setDsName] = useState('');
  const [dsType, setDsType] = useState('fabric_lakehouse');
  const [dsQName, setDsQName] = useState('');
  const [dsClass, setDsClass] = useState('');
  // Governance label taxonomy (/api/governance/classification-types) so dataset
  // classifications are PICKED from the tenant's standard set, not free-typed.
  const [classTypes, setClassTypes] = useState<string[]>([]);
  useEffect(() => {
    fetch('/api/governance/classification-types')
      .then((r) => r.json())
      .then((j) => { if (j?.ok) setClassTypes((j.types || []).map((t: any) => t.name).filter(Boolean)); })
      .catch(() => {});
  }, []);
  const dsClassSelected = dsClass.split(',').map((c) => c.trim()).filter(Boolean);
  const [dsBusy, setDsBusy] = useState(false);
  const [dsMsg, setDsMsg] = useState<{ intent: 'success' | 'error'; text: string } | null>(null);

  // Glossary term create/link.
  const [glName, setGlName] = useState('');
  const [glDesc, setGlDesc] = useState('');
  const [glBusy, setGlBusy] = useState(false);
  const [glMsg, setGlMsg] = useState<{ intent: 'success' | 'error'; text: string } | null>(null);

  // Lineage.
  const [lineage, setLineage] = useState<{ nodes: any[]; edges: any[] } | null>(null);
  const [lineageBusy, setLineageBusy] = useState(false);
  const [lineageErr, setLineageErr] = useState<string | null>(null);

  // Access policies (Cosmos governance policies, kind=Access).
  const [policies, setPolicies] = useState<any[] | null>(null);
  const [polName, setPolName] = useState('');
  const [polApprovers, setPolApprovers] = useState('');
  const [polLimit, setPolLimit] = useState('1 year');
  const [polBusy, setPolBusy] = useState(false);
  const [polMsg, setPolMsg] = useState<{ intent: 'success' | 'error'; text: string } | null>(null);

  // Phase 4.5 — all field mutations use functional updates so that if an
  // async response (e.g. registerPurview hydrating purviewDataProductId)
  // lands between the user's keystroke and React's commit, neither edit
  // clobbers the other. Same pattern as notebook-editor.tsx patchCell fix.
  const patchState = useCallback((patch: Partial<DataProductState>) => {
    setState((prev) => ({ ...prev, ...patch }));
    setDirty(true);
  }, []);

  // v3.27: F-vaporware fix — Cosmos-backed load, removes hardcoded
  // 'Customer 360' / alice@contoso / fixed bundle grid.
  useEffect(() => {
    if (id === 'new') { setLoading(false); return; }
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/cosmos-items/data-product/${encodeURIComponent(id)}`);
        const j = await r.json();
        if (cancelled) return;
        // /api/cosmos-items/[type]/[id] returns the bare WorkspaceItem record
        // (state lives at the top level), not an { ok, item } envelope. On
        // error it returns { ok:false, error }. Read state from the top level
        // (with a legacy j.item.state fallback) so a bundle-installed data
        // product opens FULLY BUILT-OUT — its datasets, glossary terms, owner,
        // and endorsement from state.content — instead of an empty form.
        const itemState = (j?.state ?? j?.item?.state) as Record<string, unknown> | undefined;
        if (j?.ok === false) {
          // 404 on fresh items is expected; show empty form rather than error.
          if (r.status !== 404) setLoadErr(j.error || `HTTP ${r.status}`);
        } else if (itemState) {
          setState({ ...DP_EMPTY, ...projectDataProductContent(itemState) });
          setDirty(false);
        }
      } catch (e: any) {
        if (!cancelled) setLoadErr(e?.message || String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [id]);

  const save = useCallback(async () => {
    setStatus({ kind: 'saving' });
    setPurviewHint(null);
    // Snapshot current state from the latest committed render via functional
    // setter — guarantees we PUT the user's freshest field values, not a
    // stale closure capture from when the Save callback was last memoised.
    let snapshot: DataProductState = DP_EMPTY;
    setState((prev) => { snapshot = prev; return prev; });
    const displayName = snapshot.displayName || 'Untitled data product';
    try {
      if (id === 'new') {
        // Create a real Cosmos item, then navigate to the persisted editor
        // where Register-with-Purview / Publish-to-APIM act on a real id.
        if (!workspaceId) { setStatus({ kind: 'err', msg: 'Select a workspace before saving.' }); return; }
        const r = await fetch(`/api/cosmos-items/data-product`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ workspaceId, displayName, state: snapshot }),
        });
        const j = await r.json();
        if (!j.ok || !j.item?.id) { setStatus({ kind: 'err', msg: j.error || `HTTP ${r.status}` }); return; }
        setDirty(false);
        router.push(`/items/data-product/${encodeURIComponent(j.item.id)}`);
        return;
      }
      const r = await fetch(`/api/cosmos-items/data-product/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ state: snapshot, displayName }),
      });
      const j = await r.json();
      if (!j.ok) { setStatus({ kind: 'err', msg: j.error || `HTTP ${r.status}` }); return; }
      setDirty(false);
      setStatus({ kind: 'ok', msg: snapshot.purviewDataProductId
        ? 'Saved to Cosmos. Re-register with Purview to propagate edits to the Unified Catalog.'
        : 'Saved to Cosmos. Click Register with Purview to publish to the Unified Catalog.' });
    } catch (e: any) {
      setStatus({ kind: 'err', msg: e?.message || String(e) });
    }
  }, [id, workspaceId, router]);

  const publishApimMirror = useCallback(async () => {
    setStatus({ kind: 'saving' });
    setPurviewHint(null);
    // Snapshot to avoid stale closure of state.displayName/description.
    let snapshot: DataProductState = DP_EMPTY;
    setState((prev) => { snapshot = prev; return prev; });
    try {
      const r = await fetch(`/api/items/apim-product`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id,
          displayName: snapshot.displayName || 'Untitled data product',
          description: snapshot.description,
          state: 'published',
          subscriptionRequired: true,
          approvalRequired: false,
        }),
      });
      const j = await r.json();
      if (!j.ok) { setStatus({ kind: 'err', msg: j.error || `HTTP ${r.status}` }); return; }
      setStatus({ kind: 'ok', msg: `Published API consumer surface as APIM product '${j.product.name}'. (Note: this is the API access layer, NOT the Purview Data Product registration.)` });
    } catch (e: any) {
      setStatus({ kind: 'err', msg: e?.message || String(e) });
    }
  }, [id]);

  // F21 — Publish-as-API: create a real APIM API + product + active subscription
  // fronting the data product's backing query endpoint, then persist the API
  // ref to Cosmos and surface the callable URL + subscription key.
  const publishAsApi = useCallback(async () => {
    if (!publishApiServiceUrl.trim()) { setPublishApiErr('Backing service URL is required.'); return; }
    setPublishApiBusy(true); setPublishApiErr(null); setPublishApiGate(null); setPublishApiResult(null);
    // Snapshot so the request body uses the freshest name/description.
    let snapshot: DataProductState = DP_EMPTY;
    setState((prev) => { snapshot = prev; return prev; });
    try {
      const r = await fetch(`/api/items/data-product/${encodeURIComponent(id)}/publish-api`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          serviceUrl: publishApiServiceUrl.trim(),
          displayName: snapshot.displayName || undefined,
          description: snapshot.description || undefined,
        }),
      });
      const j = await r.json();
      if (r.status === 503 && j?.gated) {
        setPublishApiGate({ hint: j.hint || j.error || 'APIM not configured', missing: j.missing, bicepModule: j.bicepModule });
        return;
      }
      if (!j.ok) { setPublishApiErr(j.error || `HTTP ${r.status}`); return; }
      // Hydrate the Cosmos-persisted refs from the receipt (no reload needed).
      setState((prev) => ({
        ...prev,
        apimApiId: j.apiId,
        apimProductId: j.productId,
        apimSubscriptionId: j.sid,
        apimGatewayUrl: j.gatewayUrl,
        apimServiceUrl: publishApiServiceUrl.trim(),
        apimApiPath: j.apimCreate?.api?.path,
        apimPublishedAt: j.apimPublishedAt,
      }));
      setPublishApiResult({
        callableUrl: j.callableUrl,
        primaryKey: j.primaryKey,
        apiId: j.apiId,
        productId: j.productId,
        sid: j.sid,
        gatewayUrl: j.gatewayUrl,
      });
    } catch (e: any) { setPublishApiErr(e?.message || String(e)); }
    finally { setPublishApiBusy(false); }
  }, [id, publishApiServiceUrl]);

  const registerPurview = useCallback(async () => {
    setStatus({ kind: 'saving' });
    setPurviewHint(null);
    try {
      const r = await fetch(`/api/items/data-product/${encodeURIComponent(id)}/register-purview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      });
      const j = await r.json();
      if (r.status === 501 && j?.hint) {
        // Honest config-only state per .claude/rules/no-vaporware.md — the
        // backend is gated, surface the actionable hint to the operator.
        setPurviewHint(j.hint as PurviewNotConfiguredHint);
        setStatus({ kind: 'idle' });
        return;
      }
      if (!j.ok) {
        const detail = j.hint?.followUp ? ` Hint: ${j.hint.followUp}` : (j.hint ? ` Hint: ${j.hint}` : '');
        setStatus({ kind: 'err', msg: `${j.error || `HTTP ${r.status}`}${detail}` });
        return;
      }
      // Success — hydrate the local state with the returned id + timestamp
      // so the MessageBar flips from "pending" to "registered" without a reload.
      setState((prev) => ({
        ...prev,
        purviewDataProductId: j.purviewDataProductId,
        lastRegisteredAt: j.lastRegisteredAt,
      }));
      setStatus({
        kind: 'ok',
        msg: `Registered with Purview Unified Catalog. dataProductId=${j.purviewDataProductId} · lastRegisteredAt=${j.lastRegisteredAt}`,
      });
    } catch (e: any) {
      setStatus({ kind: 'err', msg: e?.message || String(e) });
    }
  }, [id]);

  const setBundleText = (text: string) => patchState({ bundle: text.split('\n').map(s => s.trim()).filter(Boolean) });

  // ---- Datasets (register Atlas entity + classifications) ----
  const registerDataset = useCallback(async () => {
    if (!dsName.trim() || !dsQName.trim()) { setDsMsg({ intent: 'error', text: 'Name and qualified name are required.' }); return; }
    setDsBusy(true); setDsMsg(null);
    const classifications = dsClass.split(',').map((c) => c.trim()).filter(Boolean);
    try {
      // register-via-Atlas through the existing cross-source register route.
      const r = await fetch('/api/catalog/register', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          source: dsType.startsWith('databricks') ? 'unity-catalog' : 'onelake',
          displayName: dsName.trim(),
          // For onelake source, the route resolves workspaceId/itemId; for a
          // direct Atlas upsert we pass the qualifiedName + classifications.
          fullName: dsQName.trim(),
          qualifiedName: dsQName.trim(),
          typeName: dsType,
          classifications,
          domain: GUID_RE.test(state.domain) ? state.domain : undefined,
        }),
      });
      const j = await r.json();
      if (r.status === 501) { setDsMsg({ intent: 'error', text: 'Purview not provisioned in this deployment — set LOOM_PURVIEW_ACCOUNT to register datasets.' }); return; }
      if (!j.ok) { setDsMsg({ intent: 'error', text: j.error || `HTTP ${r.status}` }); return; }
      const ds: DataProductDataset = { name: dsName.trim(), typeName: dsType, qualifiedName: dsQName.trim(), classifications, guid: j.guid || j.primaryGuid };
      setState((prev) => ({ ...prev, datasets: [...(prev.datasets || []), ds] }));
      setDirty(true);
      setDsMsg({ intent: 'success', text: `Registered ${dsName} (guid ${ds.guid || 'assigned'}). Save to persist the link.` });
      setDsName(''); setDsQName(''); setDsClass('');
    } catch (e: any) { setDsMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setDsBusy(false); }
  }, [dsName, dsType, dsQName, dsClass, state.domain]);

  const removeDataset = (qn: string) => { setState((prev) => ({ ...prev, datasets: (prev.datasets || []).filter((d) => d.qualifiedName !== qn) })); setDirty(true); };

  // ---- Glossary terms (create + link to the product) ----
  const createGlossaryLink = useCallback(async () => {
    if (!glName.trim()) { setGlMsg({ intent: 'error', text: 'Term name is required.' }); return; }
    setGlBusy(true); setGlMsg(null);
    try {
      const r = await fetch('/api/catalog/glossary', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          term: { name: glName.trim(), longDescription: glDesc || undefined },
          ...(state.purviewDataProductId ? { applyTo: { source: 'purview', entityGuid: state.purviewDataProductId } } : {}),
        }),
      });
      const j = await r.json();
      if (r.status === 501) { setGlMsg({ intent: 'error', text: 'Purview not provisioned — set LOOM_PURVIEW_ACCOUNT to manage glossary terms.' }); return; }
      if (!j.ok) { setGlMsg({ intent: 'error', text: j.error || `HTTP ${r.status}` }); return; }
      const link: DataProductGlossaryLink = { name: j.term?.name || glName.trim(), guid: j.term?.guid };
      setState((prev) => ({ ...prev, glossaryLinks: [...(prev.glossaryLinks || []), link] }));
      setDirty(true);
      setGlMsg({ intent: 'success', text: `Created term '${link.name}'${j.applied ? ' and linked to the data product' : ''}. Save to persist.` });
      setGlName(''); setGlDesc('');
    } catch (e: any) { setGlMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setGlBusy(false); }
  }, [glName, glDesc, state.purviewDataProductId]);

  const removeGlossaryLink = (name: string) => { setState((prev) => ({ ...prev, glossaryLinks: (prev.glossaryLinks || []).filter((g) => g.name !== name) })); setDirty(true); };

  // ---- Lineage ----
  const loadLineage = useCallback(async () => {
    const guid = state.datasets?.[0]?.guid || state.purviewDataProductId;
    if (!guid) { setLineageErr('Register a dataset (or the data product with Purview) first — lineage is centered on a Purview entity GUID.'); return; }
    setLineageBusy(true); setLineageErr(null); setLineage(null);
    try {
      const r = await fetch(`/api/catalog/lineage?source=purview&id=${encodeURIComponent(guid)}`);
      const j = await r.json();
      if (r.status === 501) { setLineageErr('Purview not provisioned — lineage requires LOOM_PURVIEW_ACCOUNT.'); return; }
      if (!j.ok) { setLineageErr(j.error || `HTTP ${r.status}`); return; }
      setLineage({ nodes: j.nodes || [], edges: j.edges || [] });
    } catch (e: any) { setLineageErr(e?.message || String(e)); }
    finally { setLineageBusy(false); }
  }, [state.datasets, state.purviewDataProductId]);

  // ---- Access policies ----
  const loadPolicies = useCallback(async () => {
    try {
      const r = await fetch('/api/governance/policies');
      const j = await r.json();
      if (j.ok) setPolicies((j.items || []).filter((p: any) => p.kind === 'Access'));
    } catch { /* leave null */ }
  }, []);

  const createPolicy = useCallback(async () => {
    if (!polName.trim()) { setPolMsg({ intent: 'error', text: 'Policy name is required.' }); return; }
    setPolBusy(true); setPolMsg(null);
    try {
      const r = await fetch('/api/governance/policies', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: polName.trim(), kind: 'Access',
          scope: `data-product:${id}`,
          rule: JSON.stringify({ accessTimeLimit: polLimit, approvers: polApprovers.split(',').map((a) => a.trim()).filter(Boolean) }),
          enabled: true,
        }),
      });
      const j = await r.json();
      if (!j.ok) { setPolMsg({ intent: 'error', text: j.error || `HTTP ${r.status}` }); return; }
      setPolMsg({ intent: 'success', text: `Access policy '${polName}' saved.` });
      setPolName(''); setPolApprovers('');
      loadPolicies();
    } catch (e: any) { setPolMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setPolBusy(false); }
  }, [polName, polApprovers, polLimit, id, loadPolicies]);

  useEffect(() => {
    if (tab === 'lineage') loadLineage();
    if (tab === 'policies') loadPolicies();
  }, [tab, loadLineage, loadPolicies]);

  // Phase 4.5 — Ctrl+S / Cmd+S shortcut for Save. Matches notebook-editor.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (dirty && status.kind !== 'saving' && state.displayName) save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dirty, status.kind, state.displayName, save]);

  // Ribbon — Save + Publish to APIM + the full Purview governance surface
  // (Datasets / Glossary / Lineage / Access policies). No disabled buttons.
  const isNew = id === 'new';
  // On /new the primary action is "Create": enabled once a name + workspace
  // are set. On an existing item it's "Save", enabled when there are edits.
  const canSave = status.kind !== 'saving' && (isNew
    ? (!!state.displayName.trim() && !!workspaceId)
    : dirty);
  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Product', actions: [
        { label: status.kind === 'saving' ? (isNew ? 'Creating…' : 'Saving…') : (isNew ? 'Create' : 'Save'),
          onClick: canSave ? save : undefined, disabled: !canSave,
          title: isNew ? (!state.displayName.trim() ? 'Enter a name' : !workspaceId ? 'Select a workspace' : undefined) : (!dirty ? 'No unsaved changes' : undefined) },
        { label: 'Publish to APIM', onClick: !isNew && status.kind !== 'saving' && state.displayName ? publishApimMirror : undefined, disabled: isNew || status.kind === 'saving' || !state.displayName, title: isNew ? 'Create the data product first' : !state.displayName ? 'displayName is required' : undefined },
        { label: 'Publish as API', onClick: !isNew && status.kind !== 'saving' ? () => {
            setPublishApiServiceUrl(state.apimServiceUrl || '');
            setPublishApiResult(null);
            setPublishApiGate(null);
            setPublishApiErr(null);
            setPublishApiKeyVisible(false);
            setPublishApiOpen(true);
          } : undefined,
          disabled: isNew || status.kind === 'saving',
          title: isNew ? 'Create the data product first' : 'Expose this data product as a consumable APIM API with a subscription key' },
      ]},
      { label: 'Govern', actions: [
        { label: 'Datasets', onClick: () => setTab('datasets') },
        { label: 'Glossary', onClick: () => setTab('glossary') },
        { label: 'Lineage', onClick: () => setTab('lineage') },
        { label: 'Access policies', onClick: () => setTab('policies') },
      ]},
    ]},
  ], [status.kind, isNew, canSave, dirty, save, state.displayName, state.apimServiceUrl, workspaceId, publishApimMirror]);

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={
      <div className={s.pad}>
        {state.purviewDataProductId ? (
          <MessageBar intent="success">
            <MessageBarBody>
              <MessageBarTitle>Registered with Purview Unified Catalog</MessageBarTitle>
              Data product <code>{state.purviewDataProductId}</code> is live in the catalog.{' '}
              {state.lastRegisteredAt && <>Last registered <code>{state.lastRegisteredAt}</code>.{' '}</>}
              Re-click <strong>Register with Purview</strong> after edits to push updates. APIM publish remains a separate, API-access-layer concern.
            </MessageBarBody>
          </MessageBar>
        ) : (
          <MessageBar intent="warning">
            <MessageBarBody>
              <MessageBarTitle>Not yet registered with Purview Unified Catalog</MessageBarTitle>
              The item persists configuration to Cosmos, but it has not been published to the canonical Purview Data Product catalog. Click <strong>Register with Purview</strong> below to create the Unified Catalog data product via <code>POST /datagovernance/catalog/dataProducts</code>. Requires a Purview account (<code>LOOM_PURVIEW_ACCOUNT</code>), a <code>businessDomainId</code> GUID in <code>state.domain</code>, and the Loom UAMI to hold the <code>Data Curator</code> + <code>Data Product Owner</code> roles. See <code>docs/fiab/data-product-parity-spec.md</code>.
            </MessageBarBody>
          </MessageBar>
        )}

        {purviewHint && (
          <MessageBar intent="warning">
            <MessageBarBody>
              <MessageBarTitle>Purview is not provisioned in this deployment</MessageBarTitle>
              Missing env var: <code>{purviewHint.missingEnvVar}</code>.{' '}
              Bicep module: <code>{purviewHint.bicepModule}</code> — {purviewHint.bicepStatus}{' '}
              Required Purview roles (granted via the Purview portal, NOT ARM RBAC):
              <ul style={{ margin: '6px 0 6px 18px' }}>
                {purviewHint.rolesRequired.map((r) => (
                  <li key={r.name}><strong>{r.name}</strong> at {r.scope} — {r.reason}</li>
                ))}
              </ul>
              {purviewHint.followUp}
            </MessageBarBody>
          </MessageBar>
        )}

        {loadErr && <MessageBar intent="error"><MessageBarBody>{loadErr}</MessageBarBody></MessageBar>}
        {loading && <Spinner size="tiny" label="Loading…" />}

        <div className={s.toolbar}>
          {state.domain && <Badge appearance="filled" color="brand">Domain: {state.domain}</Badge>}
          {state.owner && <Badge appearance="outline">Owner: {state.owner}</Badge>}
          {state.certified && <Badge appearance="outline" color="success">Certified</Badge>}
          {state.purviewDataProductId && <Badge appearance="outline" color="success">Purview: {state.purviewDataProductId.slice(0, 8)}…</Badge>}
          {state.apimApiId && <Badge appearance="outline" color="success" icon={<Key20Regular />}>APIM API: {state.apimApiId}</Badge>}
          {dirty && <Badge appearance="outline" color="warning">unsaved</Badge>}
          <Button appearance={isNew ? 'primary' : 'secondary'} icon={<Save20Regular />} onClick={save} disabled={!canSave}>
            {status.kind === 'saving' ? (isNew ? 'Creating…' : 'Saving…') : isNew ? 'Create' : 'Save'}
          </Button>
          <Button
            appearance={state.purviewDataProductId ? 'secondary' : 'primary'}
            icon={<Library20Regular />}
            onClick={registerPurview}
            disabled={isNew || status.kind === 'saving' || !state.displayName}
            title={isNew ? 'Create the data product first' : undefined}
            style={{ marginLeft: 'auto' }}
          >
            {status.kind === 'saving'
              ? 'Registering…'
              : state.purviewDataProductId ? 'Re-register with Purview' : 'Register with Purview'}
          </Button>
          <Button appearance="secondary" icon={<CloudArrowUp20Regular />} onClick={publishApimMirror} disabled={isNew || status.kind === 'saving' || !state.displayName} title={isNew ? 'Create the data product first' : undefined}>
            {status.kind === 'saving' ? 'Publishing…' : 'Publish to APIM'}
          </Button>
          <Button
            appearance="primary"
            icon={<Key20Regular />}
            onClick={() => {
              setPublishApiServiceUrl(state.apimServiceUrl || '');
              setPublishApiResult(null);
              setPublishApiGate(null);
              setPublishApiErr(null);
              setPublishApiKeyVisible(false);
              setPublishApiOpen(true);
            }}
            disabled={isNew || status.kind === 'saving'}
            title={isNew ? 'Create the data product first' : 'Expose this data product as a consumable APIM API with a subscription key'}
          >
            {state.apimApiId ? 'Re-publish as API' : 'Publish as API'}
          </Button>
        </div>
        <StatusBar status={status} />

        <PublishAsApiDialog
          open={publishApiOpen}
          onOpenChange={setPublishApiOpen}
          serviceUrl={publishApiServiceUrl}
          onServiceUrlChange={setPublishApiServiceUrl}
          busy={publishApiBusy}
          result={publishApiResult}
          gate={publishApiGate}
          err={publishApiErr}
          keyVisible={publishApiKeyVisible}
          onToggleKey={() => setPublishApiKeyVisible((v) => !v)}
          onPublish={publishAsApi}
          republish={!!state.apimApiId}
        />


        <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as typeof tab)}>
          <Tab value="overview" icon={<Document20Regular />}>Overview</Tab>
          <Tab value="datasets" icon={<Code20Regular />}>Datasets</Tab>
          <Tab value="glossary" icon={<Library20Regular />}>Glossary</Tab>
          <Tab value="lineage" icon={<BranchFork20Regular />}>Lineage</Tab>
          <Tab value="policies" icon={<Library20Regular />}>Access policies</Tab>
        </TabList>

        {tab === 'overview' && (
          <>
            <div className={s.form}>
              {isNew && (
                <Field label="Workspace (required to create)" style={{ gridColumn: '1 / -1' }}>
                  <Dropdown
                    placeholder={ws.loading ? 'Loading workspaces…' : (ws.workspaces?.length ?? 0) === 0 ? 'No workspaces — create one first' : 'Select a workspace'}
                    value={(ws.workspaces || []).find((w) => w.id === workspaceId)?.name || ''}
                    selectedOptions={workspaceId ? [workspaceId] : []}
                    disabled={ws.loading || (ws.workspaces?.length ?? 0) === 0}
                    onOptionSelect={(_, d) => setWorkspaceId(d.optionValue || '')}
                  >
                    {(ws.workspaces || []).map((w) => <Option key={w.id} value={w.id}>{w.name}</Option>)}
                  </Dropdown>
                </Field>
              )}
              <Field label="Display name"><Input value={state.displayName} onChange={(_, d) => patchState({ displayName: d.value })} /></Field>
              <Field
                label="Governance domain"
                hint={domains.notConfigured ? 'Purview not provisioned — set LOOM_PURVIEW_ACCOUNT to populate domains. You can still type a businessDomainId GUID below.' : 'Resolves to the Purview businessDomainId GUID required for registration.'}
              >
                {(domains.domains?.length ?? 0) > 0 ? (
                  <Dropdown
                    placeholder="Select a governance domain"
                    value={(domains.domains || []).find((dm) => dm.id === state.domain)?.name || state.domain}
                    selectedOptions={state.domain ? [state.domain] : []}
                    onOptionSelect={(_, d) => patchState({ domain: d.optionValue || '' })}
                  >
                    {(domains.domains || []).map((dm) => <Option key={dm.id} value={dm.id}>{dm.name}</Option>)}
                  </Dropdown>
                ) : (
                  <Input value={state.domain} onChange={(_, d) => patchState({ domain: d.value })} placeholder="0a1b2c3d-4e5f-6789-abcd-ef0123456789" />
                )}
              </Field>
              <Field label="Owner (email)"><Input value={state.owner} onChange={(_, d) => patchState({ owner: d.value })} placeholder="owner@contoso.com" /></Field>
              <Field label="SLA"><Input value={state.sla} onChange={(_, d) => patchState({ sla: d.value })} placeholder="99.9% · P95 < 200 ms" /></Field>
              <Field label="Description" style={{ gridColumn: '1 / -1' }}>
                <Textarea value={state.description} onChange={(_, d) => patchState({ description: d.value })} rows={3} />
              </Field>
              <Field label="Certified" style={{ gridColumn: '1 / -1' }}>
                <Switch checked={state.certified} onChange={(_, d) => patchState({ certified: d.checked })} label={state.certified ? 'Certified by data governance' : 'Not certified'} />
              </Field>
              <Field label="Bundle (one per line — datasets, contracts, APIs, policies)" style={{ gridColumn: '1 / -1' }}>
                <Textarea value={state.bundle.join('\n')} onChange={(_, d) => setBundleText(d.value)} rows={6} placeholder={'Dataset: silver_revenue (Delta)\nSemantic contract: orders.yaml (v2)\nAPIM API: orders-api v2.1'} />
              </Field>
            </div>
            {state.bundle.length > 0 && (
              <>
                <Subtitle2 style={{ marginTop: 8 }}>Bundle preview</Subtitle2>
                <div className={s.cardGrid}>
                  {state.bundle.map((b, i) => <div key={i} className={s.card}>{b}</div>)}
                </div>
              </>
            )}
          </>
        )}

        {tab === 'datasets' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <Body1>Register data assets (Atlas entities) into Purview and map them to this data product. Classifications attach inline.</Body1>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <Field label="Asset name"><Input value={dsName} onChange={(_, d) => setDsName(d.value)} placeholder="silver_revenue" /></Field>
              <Field label="Type">
                <Dropdown value={dsType} selectedOptions={[dsType]} onOptionSelect={(_, d) => d.optionValue && setDsType(d.optionValue)}>
                  <Option value="fabric_lakehouse">OneLake / Fabric lakehouse</Option>
                  <Option value="databricks_table">Databricks (Unity Catalog) table</Option>
                  <Option value="azure_sql_table">Azure SQL table</Option>
                  <Option value="DataSet">Generic dataset</Option>
                </Dropdown>
              </Field>
              <Field label="Qualified name (unique asset id)" style={{ gridColumn: '1 / -1' }}>
                <Input value={dsQName} onChange={(_, d) => setDsQName(d.value)} placeholder="https://onelake.dfs.fabric.microsoft.com/<ws>/<lh>.Lakehouse/Tables/silver_revenue" />
              </Field>
              <Field label="Classifications" hint="Pick from the tenant label taxonomy (manage in Governance → Classifications)." style={{ gridColumn: '1 / -1' }}>
                {classTypes.length > 0 ? (
                  <Dropdown multiselect placeholder="Select labels…"
                    value={dsClassSelected.join(', ')} selectedOptions={dsClassSelected}
                    onOptionSelect={(_, d) => setDsClass((d.selectedOptions || []).join(', '))}>
                    {classTypes.map((c) => <Option key={c} value={c}>{c}</Option>)}
                  </Dropdown>
                ) : (
                  <Input value={dsClass} onChange={(_, d) => setDsClass(d.value)} placeholder="PII, Confidential (comma-separated)" />
                )}
              </Field>
            </div>
            <Button appearance="primary" icon={<Add20Regular />} onClick={registerDataset} disabled={dsBusy} style={{ alignSelf: 'flex-start' }}>
              {dsBusy ? 'Registering…' : 'Register dataset'}
            </Button>
            {dsMsg && <MessageBar intent={dsMsg.intent}><MessageBarBody>{dsMsg.text}</MessageBarBody></MessageBar>}
            <Table size="small" aria-label="Datasets">
              <TableHeader><TableRow>
                <TableHeaderCell>Name</TableHeaderCell>
                <TableHeaderCell>Type</TableHeaderCell>
                <TableHeaderCell>Classifications</TableHeaderCell>
                <TableHeaderCell>GUID</TableHeaderCell>
                <TableHeaderCell />
              </TableRow></TableHeader>
              <TableBody>
                {(state.datasets || []).length === 0 && <TableRow><TableCell>No datasets mapped yet.</TableCell><TableCell /><TableCell /><TableCell /><TableCell /></TableRow>}
                {(state.datasets || []).map((d) => (
                  <TableRow key={d.qualifiedName}>
                    <TableCell><strong>{d.name}</strong></TableCell>
                    <TableCell><code>{d.typeName}</code></TableCell>
                    <TableCell>{d.classifications.map((c) => <Badge key={c} appearance="outline" style={{ marginRight: 4 }}>{c}</Badge>)}</TableCell>
                    <TableCell><code style={{ fontSize: 11 }}>{d.guid?.slice(0, 12) || '—'}</code></TableCell>
                    <TableCell><Button size="small" icon={<Delete20Regular />} onClick={() => removeDataset(d.qualifiedName)}>Remove</Button></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {tab === 'glossary' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <Body1>Create glossary terms and link them to this data product. {state.purviewDataProductId ? 'Terms are applied to the registered Purview data product.' : 'Register the data product with Purview to auto-apply created terms.'}</Body1>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 12, alignItems: 'flex-end' }}>
              <Field label="Term name"><Input value={glName} onChange={(_, d) => setGlName(d.value)} placeholder="Net Revenue" /></Field>
              <Field label="Definition"><Input value={glDesc} onChange={(_, d) => setGlDesc(d.value)} placeholder="Revenue after returns and discounts" /></Field>
            </div>
            <Button appearance="primary" icon={<Add20Regular />} onClick={createGlossaryLink} disabled={glBusy} style={{ alignSelf: 'flex-start' }}>
              {glBusy ? 'Creating…' : 'Create + link term'}
            </Button>
            {glMsg && <MessageBar intent={glMsg.intent}><MessageBarBody>{glMsg.text}</MessageBarBody></MessageBar>}
            <Table size="small" aria-label="Glossary terms">
              <TableHeader><TableRow><TableHeaderCell>Term</TableHeaderCell><TableHeaderCell>GUID</TableHeaderCell><TableHeaderCell /></TableRow></TableHeader>
              <TableBody>
                {(state.glossaryLinks || []).length === 0 && <TableRow><TableCell>No glossary terms linked yet.</TableCell><TableCell /><TableCell /></TableRow>}
                {(state.glossaryLinks || []).map((g) => (
                  <TableRow key={g.name}>
                    <TableCell><strong>{g.name}</strong></TableCell>
                    <TableCell><code style={{ fontSize: 11 }}>{g.guid?.slice(0, 12) || '—'}</code></TableCell>
                    <TableCell><Button size="small" icon={<Delete20Regular />} onClick={() => removeGlossaryLink(g.name)}>Unlink</Button></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {tab === 'lineage' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <Button appearance="outline" icon={<ArrowSync20Regular />} onClick={loadLineage} disabled={lineageBusy}>{lineageBusy ? 'Loading…' : 'Refresh lineage'}</Button>
              <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Centered on the first registered dataset (or the Purview data product) GUID.</Caption1>
            </div>
            {lineageErr && <MessageBar intent="warning"><MessageBarBody>{lineageErr}</MessageBarBody></MessageBar>}
            {lineage && (
              <>
                <Subtitle2>Nodes ({lineage.nodes.length})</Subtitle2>
                <Table size="small" aria-label="Lineage nodes">
                  <TableHeader><TableRow><TableHeaderCell>Asset</TableHeaderCell><TableHeaderCell>Type</TableHeaderCell><TableHeaderCell>Source</TableHeaderCell></TableRow></TableHeader>
                  <TableBody>
                    {lineage.nodes.map((n: any) => (
                      <TableRow key={n.id}>
                        <TableCell>{n.label || n.id}</TableCell>
                        <TableCell><code>{n.type || '—'}</code></TableCell>
                        <TableCell>{n.source || 'purview'}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <Subtitle2>Edges ({lineage.edges.length})</Subtitle2>
                <div className={s.specViewer} style={{ maxHeight: 200 }}>
                  {lineage.edges.map((e: any, i: number) => `${e.from} → ${e.to}${e.label ? ` (${e.label})` : ''}`).join('\n') || '(no edges)'}
                </div>
              </>
            )}
          </div>
        )}

        {tab === 'policies' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <Body1>Access request policies for this data product (time limit + approvers). Mirrors Purview "Manage policies".</Body1>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, alignItems: 'flex-end' }}>
              <Field label="Policy name"><Input value={polName} onChange={(_, d) => setPolName(d.value)} placeholder="Standard access" /></Field>
              <Field label="Access time limit"><Input value={polLimit} onChange={(_, d) => setPolLimit(d.value)} placeholder="1 year" /></Field>
              <Field label="Approvers (comma-separated emails)"><Input value={polApprovers} onChange={(_, d) => setPolApprovers(d.value)} placeholder="owner@contoso.com" /></Field>
            </div>
            <Button appearance="primary" icon={<Add20Regular />} onClick={createPolicy} disabled={polBusy} style={{ alignSelf: 'flex-start' }}>
              {polBusy ? 'Saving…' : 'Save access policy'}
            </Button>
            {polMsg && <MessageBar intent={polMsg.intent}><MessageBarBody>{polMsg.text}</MessageBarBody></MessageBar>}
            <Table size="small" aria-label="Access policies">
              <TableHeader><TableRow><TableHeaderCell>Name</TableHeaderCell><TableHeaderCell>Scope</TableHeaderCell><TableHeaderCell>Rule</TableHeaderCell><TableHeaderCell>Enabled</TableHeaderCell></TableRow></TableHeader>
              <TableBody>
                {(policies || []).length === 0 && <TableRow><TableCell>No access policies yet.</TableCell><TableCell /><TableCell /><TableCell /></TableRow>}
                {(policies || []).map((p: any) => (
                  <TableRow key={p.id}>
                    <TableCell><strong>{p.name}</strong></TableCell>
                    <TableCell><code style={{ fontSize: 11 }}>{p.scope}</code></TableCell>
                    <TableCell><code style={{ fontSize: 11 }}>{p.rule}</code></TableCell>
                    <TableCell>{p.enabled ? 'yes' : 'no'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    } />
  );
}
