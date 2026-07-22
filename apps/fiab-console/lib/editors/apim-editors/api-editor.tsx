'use client';

// api-editor.tsx — ApimApiEditor + its private types/helpers, extracted
// verbatim from apim-editors.tsx (WS-E1 decomposition). Re-exported from the
// parent barrel so `import { ApimApiEditor } from '../apim-editors'` resolves.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Subtitle2, Body1, Caption1, Badge, Button, Spinner, Input, Textarea, Switch, Dropdown, Option, Field,
  Tab, TabList,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  tokens,
} from '@fluentui/react-components';
import {
  Save20Regular, ArrowSync20Regular, Copy20Regular, CloudArrowUp20Regular,
  Document20Regular, Code20Regular, Play20Regular, BranchFork20Regular,
  ArrowImport20Regular, Add20Regular, Delete20Regular,
} from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';
import { ItemEditorChrome } from '../item-editor-chrome';
import { EmptyState } from '@/lib/components/empty-state';
import { ApimTree } from '@/lib/components/apim/apim-tree';
import { BackendStateBar } from '@/lib/components/backend-state-bar';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';
import { useRegisterRibbonCommands } from '@/lib/components/shared/ribbon-commands';
import { useStyles } from './styles';
import { StatusBar, type LoadState } from './shared';

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
  const [testResp, setTestResp] = useState<{ status: number; statusText: string; headers: Record<string, string>; body: string; keySource?: string } | null>(null);
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
      const r = await clientFetch(`/api/items/apim-api/${encodeURIComponent(id)}`);
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
      const r = await clientFetch(`/api/items/apim-api/${encodeURIComponent(id)}/operations`);
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
      const r = await clientFetch(`/api/items/apim-api/${encodeURIComponent(id)}/spec?format=openapi%2Bjson`);
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
      const r = await clientFetch(`/api/items/apim-api/${encodeURIComponent(id)}`, {
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
      const r = await clientFetch(`/api/items/apim-api/${encodeURIComponent(id)}`, {
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
      const r = await clientFetch(`/api/items/apim-api/${encodeURIComponent(id)}`, {
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
      const r = await clientFetch('/api/apim/import', {
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
      const r = await clientFetch(`/api/items/apim-api/${encodeURIComponent(id)}/test-call`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method: testMethod, urlTemplate: testTemplate, headers, body: testBody || undefined }),
      });
      const j = await r.json();
      if (!j.ok) { setTestErr(j.error || `HTTP ${r.status}`); return; }
      setTestResp({ status: j.status, statusText: j.statusText, headers: j.headers, body: j.body, keySource: j.keySource });
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
      const r = await clientFetch(`/api/items/apim-api/${encodeURIComponent(id)}/operations?operationId=${encodeURIComponent(operationName)}`);
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
      const r = await clientFetch(`/api/items/apim-api/${encodeURIComponent(id)}/operations`, {
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
      const r = await clientFetch(`/api/items/apim-api/${encodeURIComponent(id)}/operations?operationId=${encodeURIComponent(operationName)}`, { method: 'DELETE' });
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
      const r = await clientFetch(`/api/items/apim-api/${encodeURIComponent(id)}/revisions`);
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
      const r = await clientFetch(`/api/items/apim-api/${encodeURIComponent(id)}/revisions`, {
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
  useRegisterRibbonCommands(ribbon, item.slug);

  const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

  return (
    <ItemEditorChrome splitKeyPrefix={item.slug}
      item={item}
      id={id}
      ribbon={ribbon} commandSearch
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

              <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM, marginTop: tokens.spacingVerticalS }}>
                <Subtitle2><Document20Regular style={{ verticalAlign: 'text-bottom', marginRight: tokens.spacingHorizontalXS }} />OpenAPI spec</Subtitle2>
                <Badge appearance="outline">{spec.data?.format || 'openapi+json'}</Badge>
                <Button size="small" icon={<Copy20Regular />} onClick={copySpec} disabled={!spec.data?.value}>Copy</Button>
                <Button size="small" icon={<ArrowSync20Regular />} onClick={loadSpec}>Refresh</Button>
                <Button size="small" onClick={openSpecEditor} disabled={isNew}>Edit OpenAPI</Button>
              </div>
              {spec.loading && <Spinner size="tiny" label="Exporting from APIM…" labelPosition="after" />}
              {!spec.loading && spec.error && (
                <MessageBar intent="info" style={{ marginTop: tokens.spacingVerticalXS }}>
                  <MessageBarBody>
                    <MessageBarTitle>No exportable spec</MessageBarTitle>
                    {spec.error} APIs imported by reference (OpenAPI / WSDL / GraphQL link) have no inline
                    OpenAPI document to export — Copy is disabled. Use &quot;Edit OpenAPI&quot; to attach a spec,
                    or open the source link directly.
                  </MessageBarBody>
                </MessageBar>
              )}
              {!spec.loading && !spec.error && (
                spec.data?.value ? (
                  <div className={s.specViewer} role="region" aria-label="OpenAPI spec (read-only)">
                    {spec.data.value}
                  </div>
                ) : (
                  <EmptyState
                    icon={<Document20Regular />}
                    title="No spec attached"
                    body={isNew
                      ? 'Save the API first, then import or author an OpenAPI document to attach a spec.'
                      : 'This API has no inline OpenAPI document yet. Use “Edit OpenAPI” to author one, or “Import API” to attach a spec.'}
                    primaryAction={isNew ? undefined : { label: 'Edit OpenAPI', onClick: openSpecEditor }}
                  />
                )
              )}
            </>
          )}

          {tab === 'operations' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
              <div style={{ display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'center', flexWrap: 'wrap' }}>
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
                        <TableCell><code style={{ wordBreak: 'break-all', overflowWrap: 'anywhere' }}>{op.urlTemplate}</code></TableCell>
                        <TableCell>
                          <div style={{ display: 'flex', gap: tokens.spacingHorizontalXS }}>
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
            <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
              <Body1>Sends a real request through the APIM gateway. The all-access subscription key is attached server-side; it never reaches the browser.</Body1>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: tokens.spacingVerticalM }}>
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
                <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS }}>
                  <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center' }}>
                    <Badge appearance="filled" color={testResp.status < 400 ? 'success' : testResp.status < 500 ? 'warning' : 'danger'}>
                      {testResp.status} {testResp.statusText}
                    </Badge>
                    <Caption1>{testResp.headers['content-type'] || ''}</Caption1>
                    {testResp.keySource && testResp.keySource !== 'none' && (
                      <Badge appearance="tint" size="small"
                        title="Which Ocp-Apim-Subscription-Key the gateway call used (manual key → selected subscription → all-access master fallback)">
                        key: {testResp.keySource === 'master' ? 'master (all-access)' : testResp.keySource}
                      </Badge>
                    )}
                  </div>
                  <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Response headers</Caption1>
                  <div className={s.specViewer} style={{ maxHeight: 140, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                    {Object.entries(testResp.headers).map(([k, v]) => `${k}: ${v}`).join('\n')}
                  </div>
                  <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Response body</Caption1>
                  <div className={s.specViewer} style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{testResp.body || '(empty)'}</div>
                </div>
              )}
            </div>
          )}

          {tab === 'revisions' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
              {/* Honest gate per ui-parity.md: APIM also offers API *versions* /
                  version sets (segment/header/query scheme) alongside revisions.
                  That is a distinct, heavier ARM surface (apiVersionSets +
                  per-version apis) with no BFF route yet, so it is flagged rather
                  than stubbed. Revisions below are fully live. */}
              <MessageBar intent="info">
                <MessageBarBody>
                  <MessageBarTitle>Revisions are live.</MessageBarTitle>
                  Revision list, create, and release (make-current) all call real ARM. API <em>version sets</em> (segment / header / query-string scheme via <code>apiVersionSets</code>) are configured in the Azure portal; this surface manages revisions.
                </MessageBarBody>
              </MessageBar>
              <div className={s.panel}>
                <Subtitle2><BranchFork20Regular style={{ verticalAlign: 'text-bottom', marginRight: tokens.spacingHorizontalXS }} />Create revision</Subtitle2>
                <div style={{ display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'flex-end', flexWrap: 'wrap' }}>
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
                          <TableCell><code style={{ wordBreak: 'break-all', overflowWrap: 'anywhere' }}>{r.name}</code></TableCell>
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
                  <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
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
                  <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
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
                    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
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
