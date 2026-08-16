'use client';

/**
 * Shared SQL server-admin pieces for the Azure SQL editor family.
 *
 * Extracted from `azure-sql-editors.tsx` rather than added to it, for two
 * reasons that both bit in review of #3639:
 *
 *  1. FILE SIZE. The auto-bind logic inlined in two components pushed
 *     `azure-sql-editors.tsx` from 1875 to 1978 LOC, past its frozen 1900
 *     ceiling. It is not editor-specific — every surface in this family that
 *     drives an item-scoped SQL route needs the same binding — so the ceiling
 *     was the guard correctly naming a shared concern living in the wrong file.
 *
 *  2. NO-FREEFORM. The Entra-admin dialog asked for an object id (sid) and a
 *     tenant id as free text. `check-no-freeform` had both baselined, and the
 *     boy-scout rule made clearing them the price of touching the file — which
 *     is right: a GUID typed by hand is exactly the "guess and figure it out"
 *     this repo's rules exist to remove. `EntraAdminPicker` below replaces both
 *     with a live Microsoft Graph search that yields the login AND the sid from
 *     one pick, and drops the tenant field entirely (ARM defaults it).
 *
 * Both pieces are deliberately generic over the item id so
 * `unified-sql-database-editor.tsx` — which carries the identical three-field
 * Entra-admin form under its own baseline (#3626) — can adopt them without
 * further extraction work.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Button, Caption1, Field, Input, Spinner, Tag,
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  MessageBar, MessageBarBody, MessageBarTitle,
  Radio, RadioGroup, tokens,
} from '@fluentui/react-components';
import { clientFetch } from '@/lib/client-fetch';
import { bindItemConnection } from '../sql-bind-connection';

/** One Entra principal as `lib/azure/graph-principals.ts` returns it. */
export interface EntraPrincipalLite {
  id: string;
  type: 'user' | 'group';
  displayName: string;
  upn?: string;
  mail?: string;
}

/**
 * `postJson` adapter for {@link bindItemConnection} over `clientFetch`. A
 * non-JSON / failed response becomes `{ ok:false }` so the caller reports a
 * refusal rather than throwing mid-dialog.
 */
async function postSqlJson(url: string, init: RequestInit): Promise<any> {
  const r = await clientFetch(url, init);
  return r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
}

/**
 * AUTO-BIND A PICKED SERVER/DATABASE TO THE ITEM (auto-bind-by-default.md §1/§4).
 *
 * The item-scoped SQL routes resolve their target from `state.connection` and
 * refuse a body that names anything else — GHSA-v8r7-c2p5-mjf2 Layer 2. Surfaces
 * that pick their target from LIVE ARM DISCOVERY persist nothing, so past the
 * owner check they hit 409 `no_bound_connection`, whose remediation names a
 * Connect tab those surfaces do not have. A dead end with a different status
 * code is not a fix, so the PICK IS THE BINDING.
 *
 * Returns an `ensureBound()` that resolves to `null` on success or the message
 * to show in the caller's error slot. Cached on the selection key, so this is at
 * most one POST per distinct selection — not one per click.
 */
export function useSqlItemBinding(opts: {
  id: string;
  family: 'azure-sql' | 'managed-instance' | 'postgres';
  server: string;
  database?: string;
  /** Message when nothing is selected yet. */
  unselectedMessage?: string;
}): () => Promise<string | null> {
  const { id, family, server, database = '', unselectedMessage } = opts;
  const boundKeyRef = useRef('');
  return useCallback(async () => {
    if (!server) return unselectedMessage ?? 'Pick a server first.';
    const bound = await bindItemConnection({
      id, family, server, database,
      cachedKey: boundKeyRef.current,
      postJson: postSqlJson,
    });
    if (!bound.ok) return bound.error;
    boundKeyRef.current = bound.key;
    return null;
  }, [id, family, server, database, unselectedMessage]);
}

/** The login Azure SQL wants for a principal: UPN for a user, name for a group. */
export function loginFor(p: EntraPrincipalLite): string {
  return p.type === 'group' ? p.displayName : (p.upn || p.mail || p.displayName);
}

/**
 * Pick the server's Microsoft Entra admin from a LIVE GRAPH SEARCH.
 *
 * WHAT THIS REPLACED, and why it is not cosmetic. The dialog used to carry three
 * free-text boxes: login, "Object id (sid)" and "Tenant id (optional)". The sid
 * is a GUID with no meaning to a human — the operator had to leave Loom, find
 * the principal in the portal or via `az ad`, copy its object id back, and hope
 * they pasted the id of the same principal they typed the login for. A mismatch
 * is not rejected by ARM's schema: it sets a SERVER ADMIN (sysadmin-equivalent
 * on every database) whose login text and actual identity disagree.
 *
 * `GET /api/items/azure-sql-database/[id]/principal-search` already existed for
 * the Share dialog's picker and is real Microsoft Graph (cloud-aware:
 * Commercial / GCC-High / IL5). One pick yields BOTH coordinates from the same
 * Graph object, so they cannot disagree.
 *
 * THE TENANT FIELD IS GONE, not hidden. `setAadAdmin` passes `tenantId` straight
 * into the ARM body, and `JSON.stringify` omits an undefined one — so ARM
 * defaults it to the server's own tenant, which is exactly what the old
 * placeholder ("leave blank to use the server's tenant") told the operator to
 * do. A principal resolved through this deployment's own Graph is in that tenant
 * by definition, including B2B guests (a guest's object id lives in the RESOURCE
 * tenant, which is the one the server is in). So the field could only ever be
 * set to the value the platform already derives, or to a wrong one.
 *
 * Graph permission gaps surface honestly (no-vaporware.md): the route returns a
 * structured `remediation` and it is rendered rather than swallowed.
 */
export function EntraAdminPicker({
  itemId,
  selected,
  onSelect,
  disabled,
}: {
  /** The `[id]` whose `principal-search` route is queried. */
  itemId: string;
  selected: EntraPrincipalLite | null;
  onSelect: (p: EntraPrincipalLite | null) => void;
  disabled?: boolean;
}) {
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<'user' | 'group'>('user');
  const [results, setResults] = useState<EntraPrincipalLite[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [remediation, setRemediation] = useState<string | null>(null);

  // Debounced live search — the same shape share-dialog.tsx uses.
  useEffect(() => {
    const term = query.trim();
    if (!term) { setResults([]); setError(null); setRemediation(null); return; }
    let cancelled = false;
    setSearching(true);
    const h = setTimeout(async () => {
      try {
        const r = await clientFetch(
          `/api/items/azure-sql-database/${encodeURIComponent(itemId)}/principal-search`
          + `?q=${encodeURIComponent(term)}&kind=${kind}`,
        );
        const j = await r.json();
        if (cancelled) return;
        if (!j.ok) {
          setResults([]);
          setError(j.error || `HTTP ${r.status}`);
          setRemediation(j.remediation || null);
        } else {
          setResults(j.results || []);
          setError(null);
          setRemediation(null);
        }
      } catch (e: any) {
        if (!cancelled) { setResults([]); setError(e?.message || String(e)); }
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 350);
    return () => { cancelled = true; clearTimeout(h); };
  }, [query, kind, itemId]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS }}>
      <RadioGroup
        layout="horizontal"
        value={kind}
        disabled={disabled}
        onChange={(_, d) => { setKind(d.value as 'user' | 'group'); onSelect(null); }}
      >
        <Radio value="user" label="User" />
        <Radio value="group" label="Group" />
      </RadioGroup>

      <Field label={kind === 'group' ? 'Search Entra groups' : 'Search Entra users'}>
        <Input
          value={query}
          disabled={disabled}
          onChange={(_, d) => { setQuery(d.value); onSelect(null); }}
          placeholder={kind === 'group' ? 'Start typing a group name…' : 'Start typing a name or UPN…'}
          contentAfter={searching ? <Spinner size="tiny" /> : undefined}
        />
      </Field>

      {selected && (
        <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', minWidth: 0 }}>
          <Tag
            appearance="brand"
            dismissible
            disabled={disabled}
            onClick={() => onSelect(null)}
            secondaryText={selected.type === 'group' ? 'Group' : 'User'}
          >
            {loginFor(selected)}
          </Tag>
          {/* The sid is shown, never typed — provenance the operator can check. */}
          <Caption1>Object id <code>{selected.id}</code></Caption1>
        </div>
      )}

      {!selected && results.length > 0 && (
        <div
          role="group"
          aria-label="Entra principal results"
          style={{
            display: 'flex', flexDirection: 'column',
            maxHeight: '11rem', overflowY: 'auto',
            border: `1px solid ${tokens.colorNeutralStroke2}`,
            borderRadius: tokens.borderRadiusMedium,
          }}
        >
          {results.map((p) => (
            <Button
              key={p.id}
              appearance="subtle"
              disabled={disabled}
              style={{ justifyContent: 'flex-start' }}
              onClick={() => { onSelect(p); setResults([]); }}
            >
              <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', minWidth: 0 }}>
                <span>{p.displayName}</span>
                <Caption1>{loginFor(p)}</Caption1>
              </span>
            </Button>
          ))}
        </div>
      )}

      {!selected && !searching && query.trim() && !results.length && !error && (
        <Caption1>No {kind === 'group' ? 'groups' : 'users'} matched “{query.trim()}”.</Caption1>
      )}

      {error && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Entra directory search unavailable</MessageBarTitle>
            {error}
            {remediation && <><br /><Caption1>{remediation}</Caption1></>}
          </MessageBarBody>
        </MessageBar>
      )}

      <Caption1>
        The tenant is not asked for: ARM defaults the Entra admin to the server’s own
        tenant, which is the tenant this directory search resolves against.
      </Caption1>
    </div>
  );
}

/** The server's current Entra admin, as `GET /aad-admin` returns it. */
export interface AadAdminState {
  login: string;
  sid: string;
  tenantId?: string;
  azureADOnlyAuthentication?: boolean;
}

/**
 * The Microsoft Entra admin dialog for one Azure SQL logical server.
 *
 * Owns its own load / save against `/api/items/azure-sql-database/[id]/aad-admin`
 * so the host editor keeps only an open flag. Lives here rather than in
 * `azure-sql-editors.tsx` because `unified-sql-database-editor.tsx` carries the
 * identical form (under its own no-freeform baseline, #3626) and should adopt
 * this instead of growing a second copy of it.
 *
 * `ensureBound` is REQUIRED, not optional, and is awaited before every call. The
 * route resolves its target from the item's `state.connection`; a surface that
 * picks its server from live discovery has not written one yet, so without this
 * the dialog 409s. Making it a required prop means a future adopter cannot
 * forget it — the omission is a type error rather than a runtime dead end.
 */
export function EntraAdminDialog({
  open, onOpenChange, itemId, serverName, ensureBound,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  itemId: string;
  serverName: string;
  ensureBound: () => Promise<string | null>;
}) {
  const [current, setCurrent] = useState<AadAdminState | null>(null);
  const [pick, setPick] = useState<EntraPrincipalLite | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const base = `/api/items/azure-sql-database/${encodeURIComponent(itemId)}/aad-admin`;

  const load = useCallback(async () => {
    if (!serverName) return;
    setBusy(true); setError(null);
    try {
      const bindErr = await ensureBound();
      if (bindErr) { setError(bindErr); return; }
      const r = await clientFetch(`${base}?server=${encodeURIComponent(serverName)}`);
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setCurrent(j.admin || null);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [base, serverName, ensureBound]);

  useEffect(() => { if (open) void load(); }, [open, load]);

  const save = useCallback(async () => {
    if (!serverName || !pick) return;
    setBusy(true); setError(null);
    try {
      const bindErr = await ensureBound();
      if (bindErr) { setError(bindErr); return; }
      const r = await clientFetch(base, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        // login + sid come from ONE Graph object, so they cannot disagree; the
        // tenant is omitted so ARM defaults it to the server's own.
        body: JSON.stringify({ server: serverName, login: loginFor(pick), sid: pick.id }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setCurrent(j.admin || null);
      setPick(null);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [base, serverName, pick, ensureBound]);

  return (
    <Dialog open={open} onOpenChange={(_, d) => onOpenChange(d.open)}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Microsoft Entra admin — {serverName}</DialogTitle>
          <DialogContent>
            {busy && <Spinner size="tiny" label="Calling ARM…" labelPosition="after" />}
            {current && (
              <Caption1>
                Current: <strong>{current.login}</strong> (<code>{current.sid?.slice(0, 8)}…</code>)
                {current.azureADOnlyAuthentication ? ' · Entra-only auth enabled' : ''}
              </Caption1>
            )}
            <EntraAdminPicker itemId={itemId} selected={pick} onSelect={setPick} disabled={busy} />
            {error && (
              <MessageBar intent="error">
                <MessageBarBody>
                  <MessageBarTitle>Entra admin update failed</MessageBarTitle>{error}
                </MessageBarBody>
              </MessageBar>
            )}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={() => onOpenChange(false)} disabled={busy}>Close</Button>
            <Button appearance="primary" onClick={save} disabled={busy || !pick}>
              {busy ? 'Saving…' : 'Set Microsoft Entra admin'}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
