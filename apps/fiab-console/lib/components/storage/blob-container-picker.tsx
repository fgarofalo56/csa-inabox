'use client';

/**
 * BlobContainerPicker — choose a blob container / ADLS Gen2 filesystem inside a
 * storage account that has ALREADY been picked, from the containers that
 * actually exist in it.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 * `AzureBackedField kind="storage-account-id"` drains the ACCOUNT half of every
 * "where should this write?" question — it enumerates
 * `Microsoft.Storage/storageAccounts` through Resource Graph. Nothing drained
 * the CONTAINER half, so surfaces that had a real picker for the account still
 * asked the user to TYPE the container beside it. Event Hubs Capture was one:
 * the account came from a picker and the container from a bare
 * `<Input placeholder="captures">`.
 *
 * `check-no-freeform.mjs` could not see that site until #3928 widened the
 * `storage-loc` pattern to match a label naming the SERVICE ("Blob container")
 * rather than the generic noun ("Storage container"). The ask was real the
 * whole time; the guard simply could not name it.
 *
 * The containers of an arbitrary account ARE enumerable —
 * `/api/storage/[account]/containers` has listed them since the ADLS-browser
 * work — so asking a user to type one is exactly the ask
 * `loom_no_freeform_config` and `auto-bind-by-default.md` §5 forbid: a value
 * the platform can supply must not be demanded from the customer.
 *
 * ── THE DENIAL PATH IS NOT A DEAD END ───────────────────────────────────────
 * Enumerating containers needs "Storage Blob Data Reader" at ACCOUNT scope; a
 * container-scope-only grant can read inside one but cannot list them, which is
 * common in Gov (`cloud-parity.md`). When the listing is refused this renders
 * the shared `HonestGate` (`svc-adls`, so the inline Fix-it wizard and the
 * `/admin/gates` entry come with it, per `ux-baseline.md` G2) PLUS a by-name
 * escape hatch — the same hybrid `adls-path-picker.tsx` already ships, and the
 * shape `auto-bind-by-default.md` §Allowed permits. Deleting the escape hatch
 * would turn a missing role assignment into a surface the customer cannot use
 * at all, which that rule forbids outright.
 *
 * ── PRESERVED VALUE ─────────────────────────────────────────────────────────
 * A stored container that the current listing does not contain (the grant was
 * narrowed, the container was renamed out-of-band, or the value was set from
 * another estate) is shown AS STORED and stays selected rather than being
 * silently blanked — losing a saved value on open is a worse failure than
 * showing one that no longer resolves.
 *
 * Azure-native only: ADLS Gen2 / Blob over the Loom BFF. No OneLake, no Fabric
 * host (`no-fabric-dependency.md`).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Button, Caption1, Dropdown, Field, Input, Option, Spinner,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { ArrowSync16Regular } from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';
import { HonestGate } from '@/lib/components/shared/honest-gate';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, minWidth: '0' },
  row: {
    display: 'flex', alignItems: 'flex-end', gap: tokens.spacingHorizontalS,
    flexWrap: 'wrap', minWidth: '0',
  },
  grow: { flexGrow: '1', minWidth: '180px' },
  hint: { color: tokens.colorNeutralForeground3, display: 'block' },
});

interface ContainerRow { name: string }

/**
 * The account NAME out of whatever the caller holds — an ARM resource id (what
 * `AzureBackedField kind="storage-account-id"` stores) or a bare account name.
 *
 * Returns '' when neither, so the picker renders its "choose an account first"
 * state instead of firing a request at `/api/storage//containers`.
 */
export function storageAccountName(accountOrArmId: string | undefined | null): string {
  const raw = (accountOrArmId || '').trim();
  if (!raw) return '';
  if (raw.startsWith('/')) {
    const m = /\/providers\/Microsoft\.Storage\/storageAccounts\/([^/?#]+)/i.exec(raw);
    return (m?.[1] || '').trim().toLowerCase();
  }
  return raw.split('/')[0].trim().toLowerCase();
}

export function BlobContainerPicker({
  account,
  value,
  onChange,
  label = 'Container',
  surface,
  required = false,
  disabled = false,
  hint,
}: {
  /** Storage account name, OR the ARM resource id of one. */
  account: string;
  /** The stored container name. */
  value: string;
  onChange: (container: string) => void;
  /** Overrides the default field label. */
  label?: string;
  /** Human name of the calling surface, used by the gate bar. */
  surface: string;
  required?: boolean;
  disabled?: boolean;
  /** Optional caption rendered under the control. */
  hint?: string;
}) {
  const s = useStyles();
  const acct = storageAccountName(account);

  const [rows, setRows] = useState<ContainerRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [manual, setManual] = useState('');

  /**
   * REQUEST-SEQUENCE GUARD. The account is changed from a picker, so a user
   * switching accounts faster than the BFF answers could have a STALE listing
   * overwrite a newer one — and then the options on screen would belong to a
   * different account than the label above them. Each load takes a ticket and
   * only the newest may write.
   */
  const seq = useRef(0);

  const load = useCallback(async (a: string) => {
    if (!a) { setRows(null); setError(null); return; }
    const ticket = ++seq.current;
    const fresh = () => ticket === seq.current;
    setRows(null); setError(null);
    try {
      const r = await clientFetch(`/api/storage/${encodeURIComponent(a)}/containers`);
      const j = await r.json();
      if (!fresh()) return;
      if (j?.ok && Array.isArray(j.containers)) {
        setRows(
          j.containers
            .map((c: { name?: unknown }) => ({ name: String(c?.name ?? '').trim() }))
            .filter((c: ContainerRow) => c.name),
        );
        return;
      }
      // R7 — report what was actually established. A refusal is a missing
      // grant and says so; anything else is "could not list", never "empty".
      setRows([]);
      setError(j?.error || `Could not list containers on '${a}' (HTTP ${r.status}).`);
    } catch (e) {
      if (!fresh()) return;
      setRows([]);
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { void load(acct); }, [acct, load]);

  // No account chosen yet — the control exists and explains itself rather than
  // rendering an empty picker the user cannot act on.
  if (!acct) {
    return (
      <div className={s.root}>
        <Field label={label} required={required} className={s.grow}>
          <Dropdown disabled placeholder="Choose a storage account first" selectedOptions={[]} />
        </Field>
        <Caption1 className={s.hint}>Pick the destination storage account above and its containers are listed here.</Caption1>
      </div>
    );
  }

  if (rows === null) {
    return (
      <div className={s.root}>
        <Field label={label} required={required} className={s.grow}>
          <Dropdown disabled placeholder="Listing containers…" selectedOptions={[]} />
        </Field>
        <Spinner size="tiny" label={`Listing containers on ${acct}…`} />
      </div>
    );
  }

  if (rows.length) {
    // PRESERVED VALUE — a stored container the listing does not contain is kept
    // as a selectable option so re-opening does not blank it.
    const names = rows.map((r) => r.name);
    const options = value && !names.includes(value) ? [value, ...names] : names;
    return (
      <div className={s.root}>
        <div className={s.row}>
          <Field label={label} required={required} className={s.grow}>
            <Dropdown
              disabled={disabled}
              value={value}
              selectedOptions={value ? [value] : []}
              placeholder={`Select a container in ${acct}`}
              onOptionSelect={(_, d) => onChange(d.optionValue || '')}
            >
              {options.map((n) => (
                <Option key={n} value={n} text={n}>{n}</Option>
              ))}
            </Dropdown>
          </Field>
          <Button
            size="small"
            appearance="subtle"
            icon={<ArrowSync16Regular />}
            onClick={() => { void load(acct); }}
            aria-label="Refresh the container list"
          >
            Refresh
          </Button>
        </div>
        {hint && <Caption1 className={s.hint}>{hint}</Caption1>}
        {value && !names.includes(value) && (
          <Caption1 className={s.hint}>
            &lsquo;{value}&rsquo; is the stored value and was not returned by the listing on {acct} — it is kept as-is, not cleared.
          </Caption1>
        )}
      </div>
    );
  }

  // Refused or empty. The shared gate carries the Fix-it wizard and the
  // /admin/gates entry (G2); the by-name field below keeps a narrowed grant
  // from becoming a dead end (auto-bind-by-default.md §Allowed).
  return (
    <div className={s.root}>
      <HonestGate
        gateId="svc-adls"
        surface={`${surface} (${acct})`}
        detail={
          `${error || 'The container listing returned nothing.'} `
          + 'Enumerating them needs the "Storage Blob Data Reader" role at ACCOUNT scope for the Loom '
          + 'Console identity; a container-scope grant can read inside one but cannot list them. '
          + 'If you already know which one to write to, name it below.'
        }
        onResolved={() => { void load(acct); }}
      />
      <Field
        label="Use a container by name"
        hint="Only needed while enumeration is denied. It is not verified here — it is checked when the destination is first written to."
        className={s.grow}
      >
        <div className={s.row}>
          <Input
            className={s.grow}
            value={manual}
            disabled={disabled}
            onChange={(_, d) => setManual(d.value)}
            aria-label="Container to use"
          />
          <Button
            appearance="primary"
            disabled={disabled || !manual.trim()}
            onClick={() => onChange(manual.trim().toLowerCase())}
          >
            Use it
          </Button>
        </div>
      </Field>
      {value && <Caption1 className={s.hint}>Current: {value}</Caption1>}
    </div>
  );
}
