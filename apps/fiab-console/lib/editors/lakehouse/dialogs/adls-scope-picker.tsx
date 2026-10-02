'use client';
/**
 * The ADLS step of the shortcut wizard offers the locations this lakehouse may
 * use. ADLS shortcuts and browse share one container scope
 * (`app/api/lakehouse/_lib/adls-scope.ts`), and
 * `GET /api/lakehouse/shortcuts/adls-scope?itemId=` returns it: this
 * deployment's lake containers and the containers readable lakehouses in the
 * workspace record. A caller who is not a tenant admin picks one of those; a
 * tenant admin (`unrestricted`) may also name any account and container.
 */
import { useEffect, useState } from 'react';
import { Badge, Caption1, Dropdown, Field, Option, tokens } from '@fluentui/react-components';
import { clientFetch } from '@/lib/client-fetch';

export interface AdlsScopeLocation {
  account: string;
  container: string;
  dfsHost: string;
  source: 'lake' | 'lakehouse';
  lakehouseName?: string;
}

export interface AdlsScopeState {
  loading: boolean;
  error: string | null;
  unrestricted: boolean;
  locations: AdlsScopeLocation[];
}

/** Fetch the ADLS scope for `itemId` while `enabled`. */
export function useAdlsScope(itemId: string, enabled: boolean): AdlsScopeState {
  const [state, setState] = useState<AdlsScopeState>({ loading: false, error: null, unrestricted: false, locations: [] });
  useEffect(() => {
    if (!enabled || !itemId) return;
    let live = true;
    setState({ loading: true, error: null, unrestricted: false, locations: [] });
    clientFetch(`/api/lakehouse/shortcuts/adls-scope?itemId=${encodeURIComponent(itemId)}`)
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (!live) return;
        if (!j?.ok) throw new Error(j?.error || j?.hint || `HTTP ${r.status}`);
        setState({
          loading: false, error: null,
          unrestricted: j.data?.unrestricted === true,
          locations: Array.isArray(j.data?.locations) ? j.data.locations : [],
        });
      })
      .catch((e: unknown) => {
        if (live) setState({ loading: false, error: e instanceof Error ? e.message : String(e), unrestricted: false, locations: [] });
      });
    return () => { live = false; };
  }, [itemId, enabled]);
  return state;
}

/** `value`, updated only after it has stopped changing for `ms`. */
export function useDebouncedValue<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

const keyOf = (l: Pick<AdlsScopeLocation, 'dfsHost' | 'container'>) => `${l.container}@${l.dfsHost}`;

/** A dropdown of the locations in scope; picking one sets the account host and the container. */
export function AdlsBoundLocationPicker({ locations, acctHost, container, onPick, label }: {
  locations: AdlsScopeLocation[];
  acctHost: string;
  container: string;
  onPick: (dfsHost: string, container: string) => void;
  label: string;
}) {
  const selected = locations.find((l) => l.dfsHost === acctHost && l.container === container);
  return (
    <Field label={label} required hint="This deployment's lake containers and the containers lakehouses in this workspace are bound to.">
      <Dropdown
        placeholder="Select a container"
        value={selected ? `${selected.account} / ${selected.container}` : ''}
        selectedOptions={selected ? [keyOf(selected)] : []}
        onOptionSelect={(_, d) => {
          const l = locations.find((x) => keyOf(x) === d.optionValue);
          if (l) onPick(l.dfsHost, l.container);
        }}
      >
        {locations.map((l) => (
          <Option key={keyOf(l)} value={keyOf(l)} text={`${l.account} / ${l.container}`}>
            <span style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, minWidth: 0, flexWrap: 'wrap' }}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{l.account} / {l.container}</span>
              <Badge appearance="tint" size="small" color={l.source === 'lake' ? 'brand' : 'informative'}>
                {l.source === 'lake' ? 'Lake' : (l.lakehouseName || 'Lakehouse')}
              </Badge>
            </span>
          </Option>
        ))}
      </Dropdown>
      {!locations.length && (
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
          No container is available to this workspace yet. A tenant admin can create this shortcut for you.
        </Caption1>
      )}
    </Field>
  );
}
