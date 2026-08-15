'use client';

import { clientFetch } from '@/lib/client-fetch';
/**
 * AzureResourcePicker — cross-subscription, user-RBAC backing-resource selector.
 *
 * Fetches /api/azure/resources?type=…[&kind=…][&select=properties.<path>]
 * (Azure Resource Graph spanning every subscription the caller can read) and
 * renders a Fluent v9 Combobox of the results. The route resolves resources with
 * the signed-in user's RBAC when possible (via='user'), else the Loom UAMI
 * (via='uami') — surfaced subtly as a Badge.
 *
 * Real backend only. Tokens never reach the browser; this component only ever
 * sees {id,name,type,kind,location,resourceGroup,subscriptionId,value}.
 *
 * ── THE THREE DEFECTS THIS COMPONENT CARRIED, AND WHY THEY BLOCKED ADOPTION ──
 * This picker is the remediation shape for ~250 hand-typed infrastructure inputs
 * (scripts/ci/check-no-freeform.mjs). Adopting it as it stood would have
 * propagated all three of these across ~40 surfaces at once, so they are fixed
 * HERE, once, before anything adopts it:
 *
 *   1. IT SILENTLY DROPPED A STORED VALUE. `selected` was
 *      `resources.find(r => r.id === value)`, so a saved ARM id belonging to a
 *      subscription the current caller cannot see rendered as an EMPTY box —
 *      and every open flashed empty while the query was in flight. An
 *      edit-existing flow then looked unconfigured and a Save wrote the blank
 *      back. A value that cannot be resolved is now PRESERVED and shown as
 *      exactly that: kept, unverified, with the raw value in the tooltip.
 *
 *   2. IT WAS A DEAD END WHEN DISCOVERY FAILED. `disabled={loading ||
 *      (!resources.length && (gate != null || error != null))}` produced "No
 *      resources found" over a disabled control — verbatim the shape
 *      `.claude/rules/auto-bind-by-default.md` forbids. In Azure Government,
 *      where the Loom UAMI frequently lacks tenant-root Reader and the delegated
 *      user_impersonation consent may not be granted, that turns a working
 *      surface into a broken one — the exact `cloud-parity.md` inversion.
 *      Discovery failure now yields a USABLE control: the honest gate with its
 *      Fix-it, a Retry, and an explicit manual-entry escape hatch.
 *
 *   3. THE GATE HAD NO FIX-IT. It was a bare `intent="warning"` MessageBar,
 *      which `ux-baseline.md` G2 stopped accepting in July. It now renders the
 *      shared <HonestGate> for the registry's `subscription` gate, so the
 *      operator gets the Fix-it wizard, the gate-registry link, and a Recheck
 *      that re-runs discovery in place.
 *
 * THE MANUAL-ENTRY ESCAPE HATCH IS DELIBERATE, AND IT IS A FREE-TEXT ASK.
 * It exists because when ARG denies the caller, the platform genuinely cannot
 * enumerate — and the alternative (a disabled box) is the forbidden dead end.
 * It is never the primary surface: it appears only after discovery has actually
 * failed or returned nothing, under the gate that offers to fix the cause, and
 * the typed value is shape-validated before it is accepted. check-no-freeform
 * SHOULD see it; it is one site in one file rather than the ~40 it replaces.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Combobox, Option, OptionGroup, Field, Badge, Spinner, Button, Caption1, Input,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { ArrowSync16Regular, KeyboardShift16Regular } from '@fluentui/react-icons';
import { HonestGate } from '@/lib/components/shared/honest-gate';

export interface AzureResource {
  id: string;
  name: string;
  type?: string;
  kind?: string;
  location: string;
  resourceGroup: string;
  subscriptionId: string;
  /** The projected `select=properties.<path>` value, when one was requested. */
  value?: string;
}

/** One ARM query the picker merges into its option list. */
export interface AzureResourceSource {
  /** ARM resource type, e.g. 'Microsoft.Kusto/clusters'. */
  type: string;
  /** Optional ARM `kind` filter, e.g. 'Hub' | 'Project' | 'OpenAI'. */
  kind?: string;
  /** Resource Graph property path projected into `value` (the derived endpoint). */
  select?: string;
  /** Group heading when more than one source is merged (cloud-parity pairs). */
  label?: string;
}

/** Which field of a discovered resource the controlled value holds. */
export type MatchBy = 'id' | 'derived' | 'name' | 'subscriptionId';

/** What the picker hands back on selection. */
export interface AzureResourceSelection {
  id: string;
  name: string;
  subscriptionId: string;
  resourceGroup: string;
  location: string;
  /** The projected value when `select` was requested (else undefined). */
  value?: string;
  type?: string;
}

export interface AzureResourcePickerProps {
  /** ARM resource type, e.g. 'Microsoft.DataFactory/factories'. */
  type?: string;
  /** Optional ARM `kind` filter, e.g. 'Hub' | 'Project' | 'OpenAI'. */
  kind?: string;
  /** Resource Graph property path to project, e.g. 'properties.uri'. */
  select?: string;
  /**
   * Several ARM queries merged into one list. This is how cloud parity is kept:
   * a "catalog endpoint" is a Databricks workspace in Commercial and a Loom
   * Unity container app in Azure Government, and a picker that knows only the
   * first is empty in Gov (`cloud-parity.md`).
   */
  sources?: AzureResourceSource[];
  /** Currently selected value (controlled). */
  value?: string;
  /**
   * WHICH FIELD the controlled `value` is. The gate-registry loader table
   * (lib/gates/registry/types.ts `L`) stores four different things depending on
   * the setting — an ARM id, a bare resource NAME, a subscription GUID, or a
   * projected `properties.<path>` endpoint — so the picker has to be told which
   * one it is holding, or it cannot resolve a stored value at all.
   */
  matchBy?: MatchBy;
  /** Fires with the selected resource, or null when cleared. */
  onChange: (r: AzureResourceSelection | null) => void;
  label?: string;
  placeholder?: string;
  /** Human name of the surface, for the honest gate ("<surface> needs …"). */
  surface?: string;
  /** Label of the manual-entry escape hatch (what the user would be typing). */
  manualLabel?: string;
  /** Set false only where a typed value could never be valid. */
  allowManualEntry?: boolean;
}

interface ApiResponse {
  ok: boolean;
  resources?: AzureResource[];
  via?: 'user' | 'uami';
  code?: string;
  error?: string;
  select?: string;
  unresolved?: number;
  truncated?: boolean;
}

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, minWidth: '320px' },
  row: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', minWidth: 0 },
  meta: { color: tokens.colorNeutralForeground3, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' },
  combo: { minWidth: '320px', flex: 1 },
});

/** Group by an arbitrary key, preserving the route's name-sorted order. */
function groupBy<T>(rows: T[], key: (r: T) => string): Array<{ k: string; items: T[] }> {
  const map = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r) || 'unknown';
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(r);
  }
  return Array.from(map.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, items]) => ({ k, items }));
}

function shortSub(sub: string): string {
  return sub && sub.length > 12 ? `${sub.slice(0, 8)}…${sub.slice(-4)}` : sub || 'unknown';
}

/** Default label of the manual-entry escape hatch, per value kind. */
const MANUAL_LABEL: Record<MatchBy, string> = {
  id: 'Resource ID',
  derived: 'Endpoint',
  name: 'Resource name',
  subscriptionId: 'Subscription ID',
};

/**
 * A readable label for a stored value we could NOT resolve — an ARM id shows
 * its leaf name plus its resource group, anything else shows itself. Never
 * empty: the whole point is that the user sees what is stored.
 */
export function describeUnresolvedValue(v: string): string {
  const m = /\/resourceGroups\/([^/]+)\/providers\/.*\/([^/]+)$/i.exec(v);
  if (m) return `${m[2]} (resource group ${m[1]})`;
  const arm = /\/([^/]+)$/.exec(v);
  if (v.startsWith('/subscriptions/') && arm) return arm[1];
  return v;
}

/**
 * Shape-validate a hand-entered value before accepting it. Accepts an ARM id, an
 * https endpoint, or a bare resource name — and rejects whitespace-only /
 * control characters / an obviously truncated ARM id, so a typo is caught HERE
 * instead of becoming a 404 three screens later.
 */
export function validateManualValue(raw: string, matchBy: MatchBy): string | null {
  const v = (raw || '').trim();
  if (!v) return 'Enter a value or pick one from the list.';
  if (/[\u0000-\u001f]/.test(v)) return 'Control characters are not allowed.';
  if (v.startsWith('/')) {
    if (!/^\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/providers\/[^/]+\/[^/]+\/[^/]+/i.test(v)) {
      return 'That looks like a truncated ARM id — the full form is /subscriptions/<sub>/resourceGroups/<rg>/providers/<provider>/<type>/<name>.';
    }
    return null;
  }
  if (matchBy === 'id') {
    return 'An ARM resource id starts with /subscriptions/… — paste the full id from the Azure portal’s Properties blade.';
  }
  if (matchBy === 'subscriptionId') {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
      ? null
      : 'A subscription id is a GUID.';
  }
  if (/^https?:\/\//i.test(v)) {
    try {
      const u = new URL(v);
      if (!u.hostname.includes('.')) return 'That URL has no host.';
      return null;
    } catch {
      return 'That is not a valid URL.';
    }
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/.test(v)) return 'Use a resource name, an https endpoint, or a full ARM id.';
  return null;
}

export function AzureResourcePicker({
  type, kind, select, sources, value, matchBy = 'id', onChange, label, placeholder,
  surface, manualLabel, allowManualEntry = true,
}: AzureResourcePickerProps) {
  const s = useStyles();
  const [resources, setResources] = useState<AzureResource[]>([]);
  const [via, setVia] = useState<'user' | 'uami' | null>(null);
  const [loading, setLoading] = useState(true);
  const [gate, setGate] = useState<string | null>(null);   // honest no_access gate
  const [error, setError] = useState<string | null>(null); // hard error (4xx/5xx)
  const [truncated, setTruncated] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualDraft, setManualDraft] = useState('');
  const [manualError, setManualError] = useState<string | null>(null);

  // `sources` is the general form; `type`/`kind`/`select` are the shorthand that
  // every existing call site uses. Serialized so the effect key is stable.
  const sourceList: AzureResourceSource[] = useMemo(
    () => (sources?.length ? sources : type ? [{ type, kind, select }] : []),
    [sources, type, kind, select],
  );
  const sourceKey = JSON.stringify(sourceList);

  const load = useCallback(async () => {
    const list: AzureResourceSource[] = JSON.parse(sourceKey);
    if (!list.length) {
      setLoading(false);
      setError('This picker was mounted without an ARM resource type.');
      return;
    }
    setLoading(true); setGate(null); setError(null); setTruncated(false);
    try {
      const results = await Promise.all(list.map(async (src) => {
        const qs = new URLSearchParams({ type: src.type });
        if (src.kind) qs.set('kind', src.kind);
        if (src.select) qs.set('select', src.select);
        const res = await clientFetch(`/api/azure/resources?${qs.toString()}`);
        const j: ApiResponse = await res.json();
        return { src, j, status: res.status };
      }));

      const rows: AzureResource[] = [];
      const gates: string[] = [];
      const errors: string[] = [];
      let anyVia: 'user' | 'uami' | null = null;
      let anyTruncated = false;
      for (const { src, j, status } of results) {
        if (j.ok && Array.isArray(j.resources)) {
          for (const r of j.resources) rows.push({ ...r, type: r.type || src.type });
          anyVia = j.via ?? anyVia;
          anyTruncated = anyTruncated || !!j.truncated;
        } else if (j.code === 'no_access') {
          gates.push(j.error || 'No access to Azure resources.');
        } else {
          errors.push(j.error || `Request failed (HTTP ${status}).`);
        }
      }
      setResources(rows);
      setVia(anyVia);
      setTruncated(anyTruncated);
      // A gate only shows when NOTHING came back — one source of a cloud-parity
      // pair being unavailable is normal (Databricks does not exist in Gov) and
      // must not gate a list the other source populated.
      setGate(rows.length === 0 && gates.length ? gates[0] : null);
      setError(rows.length === 0 && !gates.length && errors.length ? errors[0] : null);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [sourceKey]);

  useEffect(() => { load(); }, [load]);

  const multiSource = sourceList.length > 1;
  const grouped = useMemo(
    () => (multiSource
      ? groupBy(resources, (r) => sourceList.find((x) => x.type.toLowerCase() === (r.type || '').toLowerCase())?.label || r.type || 'resources')
      : groupBy(resources, (r) => r.subscriptionId)),
    [resources, multiSource, sourceList],
  );

  const valueOf = useCallback(
    (r: AzureResource) => {
      switch (matchBy) {
        case 'derived': return r.value || '';
        case 'name': return r.name || '';
        case 'subscriptionId': return r.subscriptionId || '';
        default: return r.id;
      }
    },
    [matchBy],
  );

  const matched = useMemo(
    () => (value ? resources.find((r) => valueOf(r) === value) || null : null),
    [resources, value, valueOf],
  );

  /**
   * DEFECT 1 — a stored value we could not resolve is KEPT and labelled, never
   * blanked. `unresolved` is also true while the first query is in flight, so
   * the field never flashes empty on open.
   */
  const unresolved = !!value && !matched;

  const selectedText = matched
    ? `${matched.name}${matchBy === 'derived' && matched.value ? ` · ${matched.value}` : ` · ${matched.location || matched.resourceGroup}`}`
    : value
      ? describeUnresolvedValue(value)
      : '';

  const onSelect = useCallback((optionValue: string | undefined) => {
    if (!optionValue) { onChange(null); return; }
    const r = resources.find((x) => valueOf(x) === optionValue);
    if (!r) { onChange(null); return; }
    onChange({
      id: r.id, name: r.name, subscriptionId: r.subscriptionId,
      resourceGroup: r.resourceGroup, location: r.location,
      value: r.value, type: r.type,
    });
  }, [resources, onChange, valueOf]);

  const commitManual = useCallback(() => {
    const err = validateManualValue(manualDraft, matchBy);
    if (err) { setManualError(err); return; }
    const v = manualDraft.trim();
    setManualError(null);
    setManualOpen(false);
    // A hand-entered value fills only the field it IS. Every other field stays
    // empty rather than being guessed — a fabricated resourceGroup here would
    // become a wrong ARM call two layers down.
    onChange({
      id: matchBy === 'id' ? v : '',
      name: matchBy === 'name' ? v : describeUnresolvedValue(v),
      subscriptionId: matchBy === 'subscriptionId' ? v : '',
      resourceGroup: '', location: '',
      value: matchBy === 'derived' ? v : undefined,
    });
  }, [manualDraft, matchBy, onChange]);

  const discoveryFailed = !loading && resources.length === 0 && (gate != null || error != null);
  const manualVisible = allowManualEntry && (manualOpen || discoveryFailed);
  const manualFieldLabel = manualLabel || MANUAL_LABEL[matchBy];

  return (
    <div className={s.root}>
      {/* DEFECT 3 — the honest gate now carries the Fix-it wizard + registry link
          (ux-baseline G2), driven by the registry's `subscription` gate, and its
          Recheck re-runs discovery in place. */}
      {gate && (
        <HonestGate
          gateId="subscription"
          surface={surface || label || 'Azure resource picker'}
          detail={gate}
          onResolved={load}
        />
      )}
      {error && (
        <MessageBar intent="error" layout="multiline">
          <MessageBarBody>
            <MessageBarTitle>Could not list Azure resources</MessageBarTitle>
            {error}
          </MessageBarBody>
        </MessageBar>
      )}

      <Field label={label || 'Azure resource'}>
        <div className={s.row}>
          {/* DEFECT 2 — `disabled` is now bound to the in-flight query ALONE. A
              failed discovery never leaves the user without a working control:
              the manual-entry field below is rendered in its place. */}
          {!discoveryFailed && (
            <Combobox
              className={s.combo}
              value={selectedText}
              selectedOptions={value ? [value] : []}
              placeholder={loading ? 'Loading resources…' : (placeholder || (resources.length ? 'Select a resource' : 'No resources discovered — enter one below'))}
              disabled={loading}
              onOptionSelect={(_, d) => onSelect(d.optionValue)}
            >
              {unresolved && value && (
                <Option key={`__stored__${value}`} value={value} text={describeUnresolvedValue(value)}>
                  {`${describeUnresolvedValue(value)} — saved value, not in the discovered list`}
                </Option>
              )}
              {grouped.map((g) => (
                <OptionGroup key={g.k} label={multiSource ? `${g.k} (${g.items.length})` : `Subscription ${shortSub(g.k)} (${g.items.length})`}>
                  {g.items.map((r) => {
                    const ov = valueOf(r);
                    return (
                      <Option key={r.id} value={ov} text={r.name} disabled={!ov}>
                        {ov
                          ? `${r.name}${r.kind ? ` (${r.kind})` : ''} · ${r.resourceGroup || '—'} · ${r.location || '—'}`
                          : `${r.name} — Resource Graph returned no ${select || 'endpoint'} for this resource`}
                      </Option>
                    );
                  })}
                </OptionGroup>
              ))}
            </Combobox>
          )}
          <Button
            size="small" appearance="subtle" icon={<ArrowSync16Regular />}
            onClick={load} disabled={loading} title="Refresh resource list"
            aria-label="Refresh resource list"
          />
          {allowManualEntry && !manualVisible && (
            <Button
              size="small" appearance="subtle" icon={<KeyboardShift16Regular />}
              onClick={() => { setManualDraft(value || ''); setManualOpen(true); }}
            >
              Enter manually
            </Button>
          )}
        </div>
      </Field>

      {/* The escape hatch. Only reachable after discovery failed, or on an
          explicit request — never the surface the user lands on. */}
      {manualVisible && (
        <Field
          label={manualFieldLabel}
          validationState={manualError ? 'error' : 'none'}
          validationMessage={manualError || undefined}
          hint="Discovery could not enumerate this for you. Fix the cause above to get the picker back — this value is stored as typed and is not verified."
        >
          <div className={s.row}>
            <Input
              className={s.combo}
              value={manualDraft}
              onChange={(_, d) => { setManualDraft(d.value); setManualError(null); }}
              aria-label={manualFieldLabel}
            />
            <Button size="small" appearance="primary" onClick={commitManual}>Use this value</Button>
            {!discoveryFailed && (
              <Button size="small" appearance="subtle" onClick={() => { setManualOpen(false); setManualError(null); }}>Cancel</Button>
            )}
          </div>
        </Field>
      )}

      <div className={s.row}>
        {loading && <Spinner size="tiny" label="Querying Azure Resource Graph…" />}
        {!loading && via && (
          <Badge appearance="tint" color={via === 'user' ? 'brand' : 'informative'} size="small"
            title={via === 'user' ? 'Resolved with your Azure RBAC' : 'Resolved with the Loom managed identity'}>
            {via === 'user' ? 'your RBAC' : 'managed identity'}
          </Badge>
        )}
        {!loading && !gate && !error && (
          <Caption1 className={s.meta}>
            {resources.length} resource{resources.length === 1 ? '' : 's'} across {grouped.length} {multiSource ? 'source' : 'subscription'}{grouped.length === 1 ? '' : 's'}
          </Caption1>
        )}
        {truncated && (
          <Badge appearance="tint" color="warning" size="small" title="Resource Graph had more pages than this picker reads — narrow by type or use manual entry.">
            partial list
          </Badge>
        )}
        {matched && (
          <Caption1 className={s.meta} title={matched.id}>
            sub {shortSub(matched.subscriptionId)} · {matched.resourceGroup}
          </Caption1>
        )}
        {unresolved && value && (
          <Badge appearance="tint" color="warning" size="small" title={value}>
            {loading ? 'saved value — resolving' : 'saved value — not visible to you'}
          </Badge>
        )}
      </div>
    </div>
  );
}
