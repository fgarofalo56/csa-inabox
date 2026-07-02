'use client';

/**
 * AddDataAssetsPanel — F9 "Add data assets" modal for the Data Product editor.
 *
 * Domain-scoped search over the classic Microsoft Purview Data Map:
 *   - keyword search (debounced)
 *   - Table / View / File type-filter chips
 *   - pagination (offset/limit)
 *   - multi-select + Add
 *
 * Every result is a REAL Atlas entity returned by
 *   GET /api/data-products/{id}/assets?search=1&q=&type=&offset=&limit=
 * which calls searchDataMapAssets() against the Data Map Discovery query API.
 * No mock list. When Purview is unprovisioned the route returns HTTP 501 with a
 * structured hint, rendered here as an honest Fluent MessageBar naming the env
 * var / role / bicep module to set (per .claude/rules/no-vaporware.md).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  Button, Input, Spinner, Checkbox, Badge, Caption1, Body1,
  ToggleButton,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  tokens,
} from '@fluentui/react-components';
import { Search20Regular, Add20Regular, ChevronLeft20Regular, ChevronRight20Regular } from '@fluentui/react-icons';

export interface DataAssetRef {
  guid: string;
  name: string;
  qualifiedName?: string;
  entityType?: string;
  addedAt?: string;
  deleted?: boolean;
  dqRunning?: boolean;
  dqRuleName?: string;
}

interface SearchHit {
  id: string;
  name: string;
  qualifiedName?: string;
  entityType?: string;
  classification?: string[];
  description?: string;
}

interface PurviewHint {
  missingEnvVar?: string;
  bicepModule?: string;
  bicepStatus?: string;
  rolesRequired?: { name: string; scope: string; reason: string }[];
  followUp?: string;
}

const TYPE_CHIPS = ['All', 'Table', 'View', 'File'] as const;
type TypeChip = (typeof TYPE_CHIPS)[number];
const LIMIT = 20;

export function AddDataAssetsPanel({
  productId,
  open,
  onClose,
  onAdded,
  existingGuids,
}: {
  productId: string;
  open: boolean;
  onClose: () => void;
  onAdded: (next: DataAssetRef[]) => void;
  existingGuids: Set<string>;
}) {
  const [q, setQ] = useState('');
  const [typeFilter, setTypeFilter] = useState<TypeChip>('All');
  const [offset, setOffset] = useState(0);
  const [results, setResults] = useState<SearchHit[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [hint, setHint] = useState<PurviewHint | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [addResult, setAddResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const runSearch = useCallback(async (nextOffset: number) => {
    setLoading(true); setErr(null); setHint(null);
    try {
      const params = new URLSearchParams({ search: '1', q, offset: String(nextOffset), limit: String(LIMIT) });
      if (typeFilter !== 'All') params.set('type', typeFilter);
      const r = await fetch(`/api/data-products/${encodeURIComponent(productId)}/assets?${params.toString()}`);
      const j = await r.json();
      if (r.status === 501) { setHint((j.hint as PurviewHint) || {}); setResults([]); setHasMore(false); return; }
      if (!j.ok) { setErr(j.error || `HTTP ${r.status}`); setResults([]); setHasMore(false); return; }
      setResults(j.results || []);
      setHasMore(!!j.hasMore);
    } catch (e: any) {
      setErr(e?.message || String(e)); setResults([]); setHasMore(false);
    } finally {
      setLoading(false);
    }
  }, [productId, q, typeFilter]);

  // Debounced search on q / typeFilter / offset changes while the dialog is open.
  useEffect(() => {
    if (!open) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => { void runSearch(offset); }, 300);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [open, q, typeFilter, offset, runSearch]);

  // Reset transient state each time the dialog opens.
  useEffect(() => {
    if (open) {
      setSelected(new Set());
      setAddResult(null);
      setOffset(0);
    }
  }, [open]);

  const toggle = (guid: string) => {
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(guid)) n.delete(guid); else n.add(guid);
      return n;
    });
  };

  const onTypeChange = (t: TypeChip) => { setTypeFilter(t); setOffset(0); };
  const onQChange = (v: string) => { setQ(v); setOffset(0); };

  const add = useCallback(async () => {
    const toAdd = results
      .filter((r) => selected.has(r.id))
      .map((r) => ({ guid: r.id, name: r.name, qualifiedName: r.qualifiedName, entityType: r.entityType }));
    if (toAdd.length === 0) return;
    setAdding(true); setAddResult(null);
    try {
      const r = await fetch(`/api/data-products/${encodeURIComponent(productId)}/assets`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ assets: toAdd }),
      });
      const j = await r.json();
      if (!j.ok) { setAddResult({ ok: false, msg: j.error || `HTTP ${r.status}` }); return; }
      setAddResult({ ok: true, msg: `Added ${j.added} asset${j.added === 1 ? '' : 's'} to the data product.` });
      setSelected(new Set());
      onAdded(j.dataAssets || []);
    } catch (e: any) {
      setAddResult({ ok: false, msg: e?.message || String(e) });
    } finally {
      setAdding(false);
    }
  }, [productId, results, selected, onAdded]);

  return (
    <Dialog open={open} onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface style={{ maxWidth: 880 }}>
        <DialogBody>
          <DialogTitle>Add data assets</DialogTitle>
          <DialogContent>
            <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
              <Body1>
                Search the Microsoft Purview Data Map for physical assets this data product wraps.
                Results are scoped to the product&apos;s governance domain collection.
              </Body1>

              <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' }}>
                <Input
                  style={{ flex: 1, minWidth: 240 }}
                  value={q}
                  onChange={(_, d) => onQChange(d.value)}
                  contentBefore={<Search20Regular />}
                  placeholder="Search assets by keyword (e.g. sales, revenue, customer)…"
                />
                <div style={{ display: 'flex', gap: tokens.spacingHorizontalXS }}>
                  {TYPE_CHIPS.map((t) => (
                    <ToggleButton
                      key={t}
                      checked={typeFilter === t}
                      appearance={typeFilter === t ? 'primary' : 'subtle'}
                      size="small"
                      onClick={() => onTypeChange(t)}
                    >
                      {t}
                    </ToggleButton>
                  ))}
                </div>
              </div>

              {hint && (
                <MessageBar intent="warning">
                  <MessageBarBody>
                    <MessageBarTitle>Microsoft Purview is not provisioned in this deployment</MessageBarTitle>
                    {hint.missingEnvVar && <>Set <code>{hint.missingEnvVar}</code>. </>}
                    {hint.bicepModule && <>Bicep module: <code>{hint.bicepModule}</code>{hint.bicepStatus ? ` — ${hint.bicepStatus}` : ''}. </>}
                    {Array.isArray(hint.rolesRequired) && hint.rolesRequired.length > 0 && (
                      <ul style={{ margin: `${tokens.spacingVerticalS} 0 ${tokens.spacingVerticalS} 18px` }}>
                        {hint.rolesRequired.map((role) => (
                          <li key={role.name}><strong>{role.name}</strong> at {role.scope} — {role.reason}</li>
                        ))}
                      </ul>
                    )}
                    {hint.followUp}
                  </MessageBarBody>
                </MessageBar>
              )}

              {err && <MessageBar intent="error"><MessageBarBody>{err}</MessageBarBody></MessageBar>}

              {loading && <Spinner size="tiny" label="Searching the Data Map…" />}

              {!hint && (
                <div style={{ maxHeight: 360, overflow: 'auto', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium }}>
                  <Table size="small" aria-label="Data Map search results">
                    <TableHeader>
                      <TableRow>
                        <TableHeaderCell style={{ width: 36 }} />
                        <TableHeaderCell>Name</TableHeaderCell>
                        <TableHeaderCell>Type</TableHeaderCell>
                        <TableHeaderCell>Qualified name</TableHeaderCell>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {!loading && results.length === 0 && (
                        <TableRow><TableCell>No matching assets in the Data Map for this domain. Try a different keyword or type.</TableCell><TableCell /><TableCell /><TableCell /></TableRow>
                      )}
                      {results.map((r) => {
                        const already = existingGuids.has(r.id);
                        return (
                          <TableRow key={r.id}>
                            <TableCell>
                              <Checkbox
                                checked={selected.has(r.id)}
                                disabled={already}
                                onChange={() => toggle(r.id)}
                                aria-label={`Select ${r.name}`}
                              />
                            </TableCell>
                            <TableCell>
                              <strong>{r.name}</strong>
                              {already && <Badge appearance="outline" color="informative" style={{ marginLeft: tokens.spacingHorizontalS }}>attached</Badge>}
                            </TableCell>
                            <TableCell><code style={{ fontSize: tokens.fontSizeBase100 }}>{r.entityType || '—'}</code></TableCell>
                            <TableCell><code style={{ fontSize: tokens.fontSizeBase100, wordBreak: 'break-all' }}>{r.qualifiedName || '—'}</code></TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              )}

              {!hint && (
                <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center' }}>
                  <Button size="small" appearance="subtle" icon={<ChevronLeft20Regular />}
                    disabled={offset === 0 || loading} onClick={() => setOffset((o) => Math.max(0, o - LIMIT))}>
                    Previous
                  </Button>
                  <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                    Results {results.length === 0 ? 0 : offset + 1}–{offset + results.length}
                  </Caption1>
                  <Button size="small" appearance="subtle" icon={<ChevronRight20Regular />} iconPosition="after"
                    disabled={!hasMore || loading} onClick={() => setOffset((o) => o + LIMIT)}>
                    Next
                  </Button>
                </div>
              )}

              {addResult && (
                <MessageBar intent={addResult.ok ? 'success' : 'error'}>
                  <MessageBarBody>{addResult.msg}</MessageBarBody>
                </MessageBar>
              )}
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>Close</Button>
            <Button appearance="primary" icon={<Add20Regular />} onClick={add} disabled={selected.size === 0 || adding}>
              {adding ? 'Adding…' : `Add ${selected.size} selected`}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
