'use client';

/**
 * Publish-side pickers for the Marketplace "Data shares" surface (issue #2618 /
 * LU-9).
 *
 * Both dialogs on the Loom (Azure-native) sharing backend used to take
 * hand-typed identifiers, which `loom_no_freeform_config` forbids:
 *
 *   AddObjectDialog     schema + table + a raw
 *                       `abfss://<container>@<account>.dfs.<suffix>/<path>`
 *   NewRecipientDialog  a comma-separated textarea of Entra GUIDs
 *
 * The Databricks branch of the very same AddObjectDialog has always been a
 * cascading Catalog → Schema → Table picker, so the Loom branch was also a
 * parity regression (`ui-parity.md`), not just a rule violation.
 *
 * This module supplies the two replacements, in their own file because
 * `data-shares.tsx` sits at ~1.1k LOC and the monolith ratchet
 * (scripts/ci/check-file-size.mjs) blocks any source file crossing 1500 LOC
 * without an explicit allowlist entry.
 *
 * Every option below comes from a real backend call — no hard-coded arrays:
 *   GET /api/workspaces                                     (workspaces)
 *   GET /api/items/lakehouse?workspaceId=…                  (lakehouse items)
 *   GET /api/marketplace/sharing/publishable-tables?…       (real Delta scan)
 *   GET /api/governance/identities/search  (via IdentityPicker → MS Graph)
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Caption1, Button, Dropdown, Option, Field, Persona, Spinner,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Dismiss16Regular } from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';
import { IdentityPicker, type IdentityHit } from '@/lib/components/ui/identity-picker';

const useStyles = makeStyles({
  stack: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: 0 },
  hint: { color: tokens.colorNeutralForeground3 },
  location: {
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
    wordBreak: 'break-all',
    backgroundColor: tokens.colorNeutralBackground2,
    padding: tokens.spacingHorizontalS,
    borderRadius: tokens.borderRadiusMedium,
    color: tokens.colorNeutralForeground2,
  },
  chips: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS,
    marginTop: tokens.spacingVerticalS, minWidth: 0,
  },
  chip: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    gap: tokens.spacingHorizontalS,
    padding: tokens.spacingHorizontalS,
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
    minWidth: 0,
  },
  chipMain: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, minWidth: 0, flex: 1 },
});

/* ------------------------- lakehouse Delta table ------------------------- */

/** A Delta table the Loom sharing backend can publish. */
export interface PublishableTable {
  name: string;
  location: string;
  latestVersion?: number | null;
  sizeBytes?: number | null;
  lastModified?: string | null;
}

/** What the picker hands back: the chosen table plus the lakehouse it came from. */
export interface PickedDeltaTable extends PublishableTable {
  lakehouseName: string;
}

interface WorkspaceLite { id: string; displayName: string }
interface LakehouseLite { id: string; displayName: string }

function humanSize(bytes: number | null | undefined): string | null {
  if (bytes == null || !Number.isFinite(bytes)) return null;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes; let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/**
 * Workspace → Lakehouse → Delta table, the Azure-native mirror of the
 * Databricks branch's Catalog → Schema → Table cascade.
 *
 * The selected table's `abfss://` root is produced by the BFF, never assembled
 * here — the browser has neither the storage account name nor the sovereign
 * cloud's DFS suffix, and guessing either is the exact failure the hand-typed
 * field used to produce.
 */
export function LakehouseTablePicker({
  open, selected, onSelect,
}: {
  /** Dialog visibility — the cascade resets to empty each time it opens. */
  open: boolean;
  selected: PickedDeltaTable | null;
  onSelect: (t: PickedDeltaTable | null) => void;
}) {
  const s = useStyles();
  const [workspaces, setWorkspaces] = useState<WorkspaceLite[] | null>(null);
  const [lakehouses, setLakehouses] = useState<LakehouseLite[] | null>(null);
  const [tables, setTables] = useState<PublishableTable[] | null>(null);
  const [wsId, setWsId] = useState('');
  const [lhId, setLhId] = useState('');
  const [err, setErr] = useState<string | null>(null);
  /** Honest infra gate from the tables route (missing LOOM_*_URL / RBAC). */
  const [gate, setGate] = useState<string | null>(null);

  const lakehouseName = useMemo(
    () => (lakehouses || []).find((l) => l.id === lhId)?.displayName || '',
    [lakehouses, lhId],
  );

  // Reset the whole cascade whenever the dialog opens, so a second "Add table"
  // never inherits the first one's selection.
  useEffect(() => {
    if (!open) return;
    setWsId(''); setLhId(''); setLakehouses(null); setTables(null);
    setErr(null); setGate(null); onSelect(null);
    setWorkspaces(null);
    clientFetch('/api/workspaces')
      .then((r) => r.json())
      .then((d: unknown) => {
        const raw = Array.isArray(d) ? d : ((d as { workspaces?: unknown[] })?.workspaces || []);
        setWorkspaces((raw as Record<string, string>[]).map((w) => ({
          id: w.id, displayName: w.displayName || w.name || w.id,
        })));
      })
      .catch((e: unknown) => { setErr(String((e as Error)?.message || e)); setWorkspaces([]); });
    // onSelect is a parent callback; including it would re-run on every parent
    // render and wipe the operator's in-progress selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Workspace → lakehouses.
  useEffect(() => {
    setLhId(''); setTables(null); setGate(null); onSelect(null);
    if (!wsId) { setLakehouses(null); return; }
    setLakehouses(null);
    clientFetch(`/api/items/lakehouse?workspaceId=${encodeURIComponent(wsId)}`)
      .then((r) => r.json())
      .then((d: { ok?: boolean; items?: Record<string, string>[]; error?: string }) => {
        if (!d?.ok) { setErr(d?.error || 'Could not list lakehouses.'); setLakehouses([]); return; }
        setLakehouses((d.items || []).map((i) => ({ id: i.id, displayName: i.displayName || i.id })));
      })
      .catch((e: unknown) => { setErr(String((e as Error)?.message || e)); setLakehouses([]); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsId]);

  // Lakehouse → real Delta tables (ADLS listing + _delta_log probe, server-side).
  useEffect(() => {
    setGate(null); onSelect(null);
    if (!lhId || !wsId) { setTables(null); return; }
    setTables(null);
    clientFetch(`/api/marketplace/sharing/publishable-tables?lakehouseId=${encodeURIComponent(lhId)}&workspaceId=${encodeURIComponent(wsId)}`)
      .then((r) => r.json())
      .then((d: { ok?: boolean; tables?: PublishableTable[]; error?: string }) => {
        if (!d?.ok) { setGate(d?.error || 'Could not list Delta tables.'); setTables([]); return; }
        setTables(d.tables || []);
      })
      .catch((e: unknown) => { setGate(String((e as Error)?.message || e)); setTables([]); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lhId, wsId]);

  const pickTable = useCallback((name: string) => {
    const t = (tables || []).find((x) => x.name === name) || null;
    onSelect(t ? { ...t, lakehouseName } : null);
  }, [tables, lakehouseName, onSelect]);

  return (
    <div className={s.stack}>
      <Field label="Workspace" required>
        {workspaces === null ? <Spinner size="tiny" /> : (
          <Dropdown
            placeholder="Select a workspace…"
            value={workspaces.find((w) => w.id === wsId)?.displayName || ''}
            selectedOptions={wsId ? [wsId] : []}
            onOptionSelect={(_e, d) => setWsId(d.optionValue || '')}
          >
            {workspaces.map((w) => <Option key={w.id} value={w.id}>{w.displayName}</Option>)}
          </Dropdown>
        )}
      </Field>

      <Field label="Lakehouse" required hint="The Delta tables Loom can publish live under a lakehouse item's own ADLS Gen2 root.">
        {wsId && lakehouses === null ? <Spinner size="tiny" /> : (
          <Dropdown
            placeholder={wsId ? 'Select a lakehouse…' : 'Pick a workspace first'}
            disabled={!wsId}
            value={(lakehouses || []).find((l) => l.id === lhId)?.displayName || ''}
            selectedOptions={lhId ? [lhId] : []}
            onOptionSelect={(_e, d) => setLhId(d.optionValue || '')}
          >
            {(lakehouses || []).map((l) => <Option key={l.id} value={l.id}>{l.displayName}</Option>)}
          </Dropdown>
        )}
      </Field>

      <Field label="Delta table" required hint="Scanned live from the lakehouse's storage — only real Delta tables are listed.">
        {lhId && tables === null ? <Spinner size="tiny" /> : (
          <Dropdown
            placeholder={lhId ? 'Select a Delta table…' : 'Pick a lakehouse first'}
            disabled={!lhId || !(tables || []).length}
            value={selected?.name || ''}
            selectedOptions={selected ? [selected.name] : []}
            onOptionSelect={(_e, d) => pickTable(d.optionValue || '')}
          >
            {(tables || []).map((t) => (
              <Option key={t.name} value={t.name} text={t.name}>
                {humanSize(t.sizeBytes) ? `${t.name} · ${humanSize(t.sizeBytes)}` : t.name}
              </Option>
            ))}
          </Dropdown>
        )}
      </Field>

      {lhId && tables !== null && tables.length === 0 && !gate && (
        <MessageBar intent="warning" layout="multiline">
          <MessageBarBody>
            <MessageBarTitle>No Delta tables in this lakehouse</MessageBarTitle>
            Load data into it first (for example run a notebook that writes a Delta table under
            its <code>Tables/</code> folder), then reopen this dialog.
          </MessageBarBody>
        </MessageBar>
      )}
      {gate && (
        <MessageBar intent="warning" layout="multiline">
          <MessageBarBody>
            <MessageBarTitle>Can&apos;t list Delta tables</MessageBarTitle>
            {gate}
          </MessageBarBody>
        </MessageBar>
      )}
      {err && <MessageBar intent="error" layout="multiline"><MessageBarBody>{err}</MessageBarBody></MessageBar>}

      {selected && (
        <div>
          <Caption1 className={s.hint}>Publishes this Delta root:</Caption1>
          <div className={s.location}>{selected.location}</div>
        </div>
      )}
    </div>
  );
}

/* --------------------------- recipient principals --------------------------- */

/** One Entra principal registered as (part of) a recipient. */
export interface SelectedPrincipal {
  /** The id actually stored + matched at authentication time. */
  principalId: string;
  displayName: string;
  secondary?: string;
  type: IdentityHit['type'];
}

/**
 * Which id a recipient record must hold for this hit.
 *
 * `lib/sharing/recipient-auth.ts` matches an incoming token against
 * `[claims.objectId, claims.appId]`. For a service principal the reliable,
 * tenant-independent value is therefore the APPLICATION id — a federated SPN's
 * object id differs in every tenant it is provisioned into, so storing the
 * directory object id of an SPN found in this tenant would not match the token
 * a partner tenant presents.
 */
export function principalIdFor(hit: IdentityHit): string {
  return hit.type === 'spn' ? (hit.appId || hit.id) : hit.id;
}

/**
 * Entra principal picker for a Delta Sharing recipient — the shared
 * `IdentityPicker` (real Microsoft Graph search) instead of the GUID textarea.
 *
 * GROUPS ARE REFUSED, deliberately. Recipient authentication compares the
 * token's `oid`/`appid` claims, and a group's object id appears as neither, so
 * a group-backed recipient would be created successfully and then authenticate
 * nobody — a silent, un-diagnosable deny. The picker's own transitive-member
 * expander is the supported path, so the refusal points at it rather than just
 * saying no.
 */
export function RecipientPrincipalPicker({
  selected, onChange,
}: {
  selected: SelectedPrincipal[];
  onChange: (next: SelectedPrincipal[]) => void;
}) {
  const s = useStyles();
  const [groupWarning, setGroupWarning] = useState<string | null>(null);

  const add = useCallback((hit: IdentityHit | null | undefined) => {
    if (!hit) return;
    if (hit.type === 'group') {
      setGroupWarning(
        `"${hit.displayName}" is a group. A Delta Sharing recipient is matched on the object id (or `
        + 'application id) carried in the caller\'s own token, and a group id never appears there — so a '
        + 'group-backed recipient would authenticate nobody. Use the group\'s "Members" expander above to '
        + 'add its users individually.',
      );
      return;
    }
    setGroupWarning(null);
    const principalId = principalIdFor(hit);
    if (selected.some((p) => p.principalId.toLowerCase() === principalId.toLowerCase())) return;
    onChange([...selected, {
      principalId,
      displayName: hit.displayName,
      secondary: hit.type === 'spn'
        ? (hit.appId ? `appId ${hit.appId}` : 'service principal')
        : (hit.upn || hit.mail || 'user'),
      type: hit.type,
    }]);
  }, [selected, onChange]);

  const remove = useCallback((principalId: string) => {
    onChange(selected.filter((p) => p.principalId !== principalId));
  }, [selected, onChange]);

  return (
    <div className={s.stack}>
      <IdentityPicker
        kind="all"
        onSelect={add}
        label="Search Entra for the recipient's users or service principals"
        placeholder="Display name, UPN, or app name"
      />
      {groupWarning && (
        <MessageBar intent="warning" layout="multiline">
          <MessageBarBody>
            <MessageBarTitle>A group can&apos;t be a recipient</MessageBarTitle>
            {groupWarning}
          </MessageBarBody>
        </MessageBar>
      )}
      {selected.length === 0
        ? <Caption1 className={s.hint}>No principals selected yet. A recipient needs at least one.</Caption1>
        : (
          <div className={s.chips}>
            {selected.map((p) => (
              <div key={p.principalId} className={s.chip}>
                <div className={s.chipMain}>
                  <Persona
                    name={p.displayName}
                    secondaryText={p.secondary}
                    size="extra-small"
                    presence={undefined}
                  />
                </div>
                <Button
                  appearance="subtle"
                  size="small"
                  icon={<Dismiss16Regular />}
                  aria-label={`Remove ${p.displayName}`}
                  onClick={() => remove(p.principalId)}
                />
              </div>
            ))}
          </div>
        )}
      {selected.length > 0 && (
        <Caption1 className={s.hint}>
          Each recipient authenticates with its own Entra token — Loom mints no long-lived bearer profile.
        </Caption1>
      )}
    </div>
  );
}
