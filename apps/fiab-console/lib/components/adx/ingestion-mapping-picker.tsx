'use client';
/**
 * IngestionMappingPicker — the ADX ingestion-mapping NAME, PICKED from the live
 * database instead of typed (#3519, `loom_no_freeform_config`).
 *
 * WHAT WAS WRONG. Both KQL-database wizards that reference an ingestion mapping
 * asked for its name as free text — `placeholder="EventMapping"` in the ingest
 * wizard and `placeholder="myMapping"` in the Event Hub data-connection wizard.
 * Kusto resolves a mapping by exact name, so one wrong character produces a
 * command that is accepted by the form, submitted, and then fails at the
 * cluster (or, for a data connection, provisions and never ingests). The names
 * are enumerable — `.show ingestion mappings`, already exposed by
 * `GET /api/adx/ingestion-mappings?id=ITEM` — so asking for them is the
 * "user-performed plumbing" `auto-bind-by-default.md` forbids.
 *
 * WHY IT STAYS FREEFORM ANYWAY. Replacing a text box with a closed list is how
 * a picker becomes a NEW dead end — the "'No pipelines found' + a disabled Bind
 * button" shape `auto-bind-by-default.md` lists as forbidden. A list that cannot
 * populate, or that has not yet seen the value the operator wants, would leave
 * no way forward. This is a `Combobox freeform`: the discovered names are
 * offered, and a name the list does not carry can still be typed. Same shape as
 * `ai-search-tree.tsx`'s PathCombobox.
 *
 * WHAT ACTUALLY HOLDS THAT ESCAPE HATCH (#4348 review, blocker 2 — measured,
 * not assumed). It is `onChange` lifting the typed text to the parent plus the
 * parent controlling `value`, NOT the `freeform` prop. `freeform` gates two
 * `setValue(undefined)` calls in Fluent — one on collapse
 * (`@fluentui/react-combobox@9.17.1`,
 * `lib/utils/useComboboxBaseState.js:109`) and one on blur-while-collapsed
 * (`lib/components/Combobox/useInputTriggerSlot.js:18-26`) — and
 * `useControllableState` makes both inert whenever `props.value` is defined,
 * which it always is here because `value` is a REQUIRED prop of this component.
 *
 * Measured, in this repo's jsdom harness: rendering this Combobox with and
 * without `freeform` produces an `<input>` whose every attribute and whose
 * entire class list are identical — the two strings differ only in React's
 * render-order-generated `id`/`aria-describedby` (`field-_r_1__` vs
 * `field-_r_5__`). The prop is NOT inert in general: with an UNCONTROLLED value,
 * typing then blurring keeps `"Typed"` with `freeform` and resets to `""`
 * without it. It is inert only under the controlled contract this component
 * imposes. So the prop stays — it is the declared intent, and it is what keeps
 * the escape working for any future caller that lets the value go uncontrolled —
 * and it is pinned STRUCTURALLY in `wave1a-adopted-surfaces.test.tsx`, because
 * no DOM assertion against this component can reach it.
 *
 * WHY THE FILTER IS CLIENT-SIDE. `.show ingestion mappings` is DATABASE-scoped:
 * one call returns every mapping with its owning `Table` (absent for a
 * database-scoped mapping). The route takes no table parameter — measured, not
 * assumed, at `app/api/adx/ingestion-mappings/route.ts:25-34` — so re-fetching
 * when the target table changes would re-issue the identical control command.
 * The list is fetched once per mount and re-filtered as the table selection
 * moves: table-scoped mappings for the chosen table, plus every database-scoped
 * mapping (those apply to any table).
 *
 * HONESTY (deploy-integrity R7). The hint below states only what the response
 * established, across FOUR distinct states: an unsaved item (nothing was read
 * and nothing can be), a read in flight, a read that failed — which shows the
 * route's own error — and a read that succeeded and found nothing. Only the
 * last of those is allowed to say "this database has no mappings", because that
 * is a different fact and the one an operator would act on.
 */

import { useEffect, useState } from 'react';
import { Combobox, Option, Field, tokens } from '@fluentui/react-components';
import { clientFetch } from '@/lib/client-fetch';

/** One row of `.show ingestion mappings`, as the BFF route shapes it. */
export interface AdxIngestionMapping {
  name: string;
  kind?: string;
  /** Table-scoped mappings carry their table; database-scoped ones do not. */
  table?: string;
  mapping?: string;
}

export interface IngestionMappingPickerProps {
  /** The kql-database item id the mappings are read from. */
  itemId: string;
  /** The wizard's selected target table; blank = show every mapping. */
  table?: string;
  value: string;
  onChange: (next: string) => void;
  label: string;
  disabled?: boolean;
}

const NONE_TEXT = '— none (the table’s identity mapping) —';

/**
 * The literal id an editor carries before its item's first save. Re-declared
 * rather than imported: the canonical `UNSAVED_ITEM_ID` lives in
 * `app/api/items/_lib/synapse-item-scope.ts`, which imports `next/server`, the
 * session helper and the Cosmos client — pulling that into a `'use client'`
 * component would drag the server bundle across the boundary. The two values
 * are pinned together by `__tests__/ingestion-mapping-picker.test.tsx`.
 */
const UNSAVED_ITEM_ID = 'new';


/** Table-scoped mappings for `table`, plus every database-scoped one, deduped by name. */
export function selectMappings(all: AdxIngestionMapping[], table?: string): AdxIngestionMapping[] {
  const t = (table || '').trim();
  const seen = new Set<string>();
  const out: AdxIngestionMapping[] = [];
  for (const m of all) {
    const name = (m?.name || '').trim();
    if (!name || seen.has(name)) continue;
    // A mapping with no table is database-scoped and applies to any table.
    if (t && m.table && m.table !== t) continue;
    seen.add(name);
    out.push(m);
  }
  return out;
}

export function IngestionMappingPicker({
  itemId, table, value, onChange, label, disabled,
}: IngestionMappingPickerProps) {
  // `null` = still reading. Distinguished from `[]` so "loading" and "this
  // database has none" are never rendered as the same statement.
  const [mappings, setMappings] = useState<AdxIngestionMapping[] | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  // #4348 review — AN UNSAVED ITEM IS A THIRD STATE, not an empty database.
  // This branch used to `setMappings([])`, which made the hint read "This
  // database has no ingestion mappings yet" for an item nothing was ever read
  // for: an absence the code had not established (deploy-integrity R7), and the
  // exact distinction the rest of this component gets right via `null`.
  const unsaved = !itemId || itemId === UNSAVED_ITEM_ID;

  useEffect(() => {
    if (!itemId || itemId === UNSAVED_ITEM_ID) { setMappings(null); setReadError(null); return; }
    let cancelled = false;
    setMappings(null); setReadError(null);
    clientFetch(`/api/adx/ingestion-mappings?id=${encodeURIComponent(itemId)}`)
      .then((r) => r.json())
      .then((j: any) => {
        if (cancelled) return;
        if (j?.ok && Array.isArray(j.mappings)) { setMappings(j.mappings); return; }
        setMappings([]);
        setReadError(
          typeof j?.error === 'string' && j.error
            ? j.error
            : 'Loom could not read this database’s ingestion mappings.',
        );
      })
      .catch((e: any) => {
        if (cancelled) return;
        setMappings([]);
        setReadError(e?.message || String(e));
      });
    return () => { cancelled = true; };
  }, [itemId]);

  const options = selectMappings(mappings ?? [], table);
  const t = (table || '').trim();

  const hint = unsaved
    ? 'Save this database first — its ingestion mappings are read from the cluster once the item exists.'
    : mappings === null
      ? 'Reading the database’s ingestion mappings…'
      : readError
        ? `${readError} Type the mapping name if you know it, or leave it blank for the identity mapping.`
        : options.length === 0
          ? (t
            ? `No ingestion mapping is defined for ${t} (and none database-wide). Leave this blank for the table’s identity mapping, or create one with Home → New → Ingestion mapping.`
            : 'This database has no ingestion mappings yet. Leave this blank for the table’s identity mapping, or create one with Home → New → Ingestion mapping.')
          : (t
            ? `Mappings defined on ${t}, plus every database-scoped mapping.`
            : 'Every ingestion mapping on this database. Pick a target table above to narrow the list.');

  return (
    <Field label={label} hint={hint}>
      <Combobox
        freeform
        disabled={disabled}
        value={value}
        selectedOptions={value ? [value] : []}
        placeholder={!unsaved && mappings === null ? 'Loading…' : NONE_TEXT}
        onOptionSelect={(_, d) => onChange(d.optionValue ?? '')}
        onChange={(e) => onChange((e.target as HTMLInputElement).value)}
        style={{ minWidth: 0 }}
      >
        <Option value="" text={NONE_TEXT}>{NONE_TEXT}</Option>
        {options.map((m) => (
          <Option key={`${m.table || '(database)'}:${m.name}`} value={m.name} text={m.name}>
            {m.name}
          </Option>
        ))}
      </Combobox>
      {options.length > 0 && (
        <span style={{ color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 }}>
          {options.length} mapping{options.length === 1 ? '' : 's'} available
        </span>
      )}
    </Field>
  );
}
