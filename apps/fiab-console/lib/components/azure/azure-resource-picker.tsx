'use client';

/**
 * AzureResourcePicker — cross-subscription, user-RBAC backing-resource selector.
 *
 * Fetches /api/azure/resources?type=...&kind=... (Azure Resource Graph spanning
 * every subscription the caller can read) and renders a Fluent v9 Combobox of
 * the results GROUPED BY SUBSCRIPTION. The route resolves resources with the
 * signed-in user's RBAC when possible (via='user'), else the Loom UAMI
 * (via='uami') — surfaced subtly as a Badge. When neither path can see anything
 * the route returns an honest gate and we render a warning MessageBar naming the
 * exact one-time admin actions (no mock data — per .claude/rules/no-vaporware).
 *
 * Real backend only. Tokens never reach the browser; this component only ever
 * sees {id,name,type,kind,location,resourceGroup,subscriptionId}.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Combobox, Option, OptionGroup, Field, Badge, Spinner, Button, Caption1,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { ArrowSync16Regular } from '@fluentui/react-icons';

export interface AzureResource {
  id: string;
  name: string;
  type?: string;
  kind?: string;
  location: string;
  resourceGroup: string;
  subscriptionId: string;
}

export interface AzureResourcePickerProps {
  /** ARM resource type, e.g. 'Microsoft.DataFactory/factories'. */
  type: string;
  /** Optional ARM `kind` filter, e.g. 'Hub' | 'Project' | 'OpenAI'. */
  kind?: string;
  /** Currently selected resource id (controlled). */
  value?: string;
  /** Fires with the selected resource, or null when cleared. */
  onChange: (
    r: { id: string; name: string; subscriptionId: string; resourceGroup: string; location: string } | null,
  ) => void;
  label?: string;
  placeholder?: string;
}

interface ApiResponse {
  ok: boolean;
  resources?: AzureResource[];
  via?: 'user' | 'uami';
  code?: string;
  error?: string;
}

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '6px', minWidth: '320px' },
  row: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
  meta: { color: tokens.colorNeutralForeground3 },
  combo: { minWidth: '320px', flex: 1 },
});

/** Group resources by subscriptionId, preserving the route's name-sorted order. */
function groupBySub(resources: AzureResource[]): Array<{ sub: string; items: AzureResource[] }> {
  const map = new Map<string, AzureResource[]>();
  for (const r of resources) {
    const k = r.subscriptionId || 'unknown';
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(r);
  }
  return Array.from(map.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([sub, items]) => ({ sub, items }));
}

function shortSub(sub: string): string {
  return sub && sub.length > 12 ? `${sub.slice(0, 8)}…${sub.slice(-4)}` : sub || 'unknown';
}

export function AzureResourcePicker({
  type, kind, value, onChange, label, placeholder,
}: AzureResourcePickerProps) {
  const s = useStyles();
  const [resources, setResources] = useState<AzureResource[]>([]);
  const [via, setVia] = useState<'user' | 'uami' | null>(null);
  const [loading, setLoading] = useState(true);
  const [gate, setGate] = useState<string | null>(null);   // honest no_access gate
  const [error, setError] = useState<string | null>(null); // hard error (4xx/5xx)

  const load = useCallback(async () => {
    setLoading(true); setGate(null); setError(null);
    try {
      const qs = new URLSearchParams({ type });
      if (kind) qs.set('kind', kind);
      const res = await fetch(`/api/azure/resources?${qs.toString()}`);
      const j: ApiResponse = await res.json();
      if (j.ok && Array.isArray(j.resources)) {
        setResources(j.resources);
        setVia(j.via ?? null);
      } else if (j.code === 'no_access') {
        setResources([]);
        setGate(j.error || 'No access to Azure resources.');
      } else {
        setResources([]);
        setError(j.error || `Request failed (HTTP ${res.status}).`);
      }
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [type, kind]);

  useEffect(() => { load(); }, [load]);

  const grouped = useMemo(() => groupBySub(resources), [resources]);
  const selected = useMemo(() => resources.find((r) => r.id === value) || null, [resources, value]);

  const onSelect = useCallback((id: string | undefined) => {
    if (!id) { onChange(null); return; }
    const r = resources.find((x) => x.id === id);
    if (!r) { onChange(null); return; }
    onChange({ id: r.id, name: r.name, subscriptionId: r.subscriptionId, resourceGroup: r.resourceGroup, location: r.location });
  }, [resources, onChange]);

  return (
    <div className={s.root}>
      <Field label={label || 'Azure resource'}>
        <div className={s.row}>
          <Combobox
            className={s.combo}
            value={selected ? `${selected.name} · ${selected.location || selected.resourceGroup}` : ''}
            selectedOptions={value ? [value] : []}
            placeholder={loading ? 'Loading resources…' : (placeholder || (resources.length ? 'Select a resource' : 'No resources found'))}
            disabled={loading || (!resources.length && (gate != null || error != null))}
            onOptionSelect={(_, d) => onSelect(d.optionValue)}
          >
            {grouped.map((g) => (
              <OptionGroup key={g.sub} label={`Subscription ${shortSub(g.sub)} (${g.items.length})`}>
                {g.items.map((r) => (
                  <Option key={r.id} value={r.id} text={r.name}>
                    {`${r.name}${r.kind ? ` (${r.kind})` : ''} · ${r.resourceGroup || '—'} · ${r.location || '—'}`}
                  </Option>
                ))}
              </OptionGroup>
            ))}
          </Combobox>
          <Button
            size="small" appearance="subtle" icon={<ArrowSync16Regular />}
            onClick={load} disabled={loading} title="Refresh resource list"
            aria-label="Refresh resource list"
          />
        </div>
      </Field>

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
            {resources.length} resource{resources.length === 1 ? '' : 's'} across {grouped.length} subscription{grouped.length === 1 ? '' : 's'}
          </Caption1>
        )}
        {selected && (
          <Caption1 className={s.meta} title={selected.id}>
            sub {shortSub(selected.subscriptionId)} · {selected.resourceGroup}
          </Caption1>
        )}
      </div>

      {gate && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>No Azure resources visible</MessageBarTitle>
            {gate}
          </MessageBarBody>
        </MessageBar>
      )}
      {error && (
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>Could not list Azure resources</MessageBarTitle>
            {error}
          </MessageBarBody>
        </MessageBar>
      )}
    </div>
  );
}
