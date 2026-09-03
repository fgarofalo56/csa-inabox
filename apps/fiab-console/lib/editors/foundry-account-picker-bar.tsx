'use client';

/**
 * The AI Foundry / Azure OpenAI account picker bar.
 *
 * Extracted from foundry-hub-editor.tsx (#3565): the fix below plus the
 * reasoning that keeps it from being undone crossed that file's
 * check-file-size ceiling, and a self-contained component with two call sites
 * is what a monolith guard is asking you to move.
 *
 * The import is ONE-WAY — foundry-hub-editor imports this, never the reverse.
 * `pnpm guard:circular` runs madge, which counts type-only edges, so
 * `import type { FoundryAccount } from './foundry-hub-editor'` would register a
 * cycle. The type therefore lives HERE and foundry-hub-editor re-exports it.
 *
 * Fluent v9 + Loom tokens only (web3-ui.md).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Caption1, Badge, Button, Tooltip,
  MessageBar, MessageBarBody, MessageBarTitle,
  Field, Dropdown, Option,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { History24Regular } from '@fluentui/react-icons';
import { AzureResourcePicker } from '@/lib/components/azure/azure-resource-picker';

export interface FoundryAccount { id?: string; name: string; endpoint?: string; location?: string; kind?: string; resourceGroup?: string }

interface AccountsResponse { ok: boolean; accounts: FoundryAccount[]; defaultAccount?: string }

interface AccountsState {
  loading: boolean;
  data: AccountsResponse | null;
  error?: string;
  hint?: string;
  notDeployed?: boolean;
}

/**
 * One GET of /api/foundry/accounts.
 *
 * A local hook rather than foundry-hub-editor's `useLazyFetch`, because
 * importing that would be the reverse edge this module exists to avoid. It is
 * the same contract, narrowed to the single call this bar makes: no account
 * selector in the URL, no nonce, and an error is kept DISTINCT from an empty
 * list (deploy-integrity R7) so "no accounts provisioned" and "I could not list
 * accounts" render differently below.
 */
function useAccounts(): AccountsState {
  const [state, setState] = useState<AccountsState>({ loading: true, data: null });
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch('/api/foundry/accounts');
        const j = await r.json();
        if (cancelled) return;
        if (!j?.ok) {
          setState({ loading: false, data: null, error: j?.error || `HTTP ${r.status}`, hint: j?.hint, notDeployed: j?.notDeployed });
          return;
        }
        setState({ loading: false, data: j as AccountsResponse });
      } catch (e: any) {
        if (!cancelled) setState({ loading: false, data: null, error: e?.message || String(e) });
      }
    })();
    return () => { cancelled = true; };
  }, []);
  return state;
}

const usePickerStyles = makeStyles({
  bar: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM, flexWrap: 'wrap',
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalL}`, borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  grow: { flex: 1 },
});

/**
 * Azure AI Foundry / Azure OpenAI account picker. Lists the subscription's
 * Microsoft.CognitiveServices accounts (kind AIServices/OpenAI) via
 * /api/foundry/accounts and drives the selected account into every tab. The
 * env-var/discovery default (LOOM_AOAI_ACCOUNT) is preselected when present.
 *
 * #3565 — THREE CHANGES, and the reason for each:
 *
 *  1. NO `accounts[0]` FALLBACK. The old preselect ended
 *     `|| accounts[0]`, so when `defaultAccount` did not resolve, the FIRST row
 *     Resource Graph happened to return became the account every tab queried —
 *     an arbitrary, unrelated Cognitive Services account presented with no
 *     disclosure that it was picked by list order. With no resolvable default
 *     the picker now selects NOTHING and says so, which is the honest state.
 *  2. THE DEFAULT IS MARKED IN THE OPTIONS, not only on the chip after it is
 *     already selected. Marking it only once selected is exactly backwards:
 *     the badge is needed while CHOOSING, and its absence is why a non-Loom
 *     account was indistinguishable from the auto-bound one.
 *  3. A RECOVERY PATH. "Use the Loom-managed default" clears the selection and
 *     lets the preselect effect re-run, so a mis-selection is one click to
 *     undo. It is disabled — with a reason — when there is no default to go
 *     back to, rather than being a button that silently does nothing.
 *
 * WHAT THIS DOES NOT DO, stated rather than implied: the selection is component
 * state and is NOT persisted to the item. A reload therefore returns to the
 * Loom-managed default — which is the safe direction, and is why the
 * cross-subscription pickers below are now DEMOTED behind an explicit
 * disclosure (`auto-bind-by-default.md`: the bound account is the primary path;
 * reaching into another subscription is a deliberate secondary action). Making
 * the choice durable needs an item-state write this editor has no route for
 * (its only PATCH is networking) — tracked in #3565's follow-up, not faked here.
 */
export function AccountPickerBar({ acct, onSelect, onHub }: { acct: FoundryAccount | null; onSelect: (a: FoundryAccount | null) => void; onHub?: (h: { id: string; name: string } | null) => void }) {
  const s = usePickerStyles();
  const st = useAccounts();
  const accounts = Array.isArray(st.data?.accounts) ? st.data!.accounts : [];
  const defaultName = st.data?.defaultAccount;

  // Cross-subscription, user-RBAC selection (Azure Resource Graph). Lets the
  // operator pick an Azure OpenAI / AI Services account OR an AI Foundry
  // hub/project that lives in ANY subscription they can see — not just the
  // single LOOM_SUBSCRIPTION_ID the /api/foundry/accounts lister covers.
  const [hubId, setHubId] = useState<string>('');
  // #3565 — the cross-sub pickers are a SECONDARY action, closed by default.
  const [crossSubOpen, setCrossSubOpen] = useState(false);

  /** The Loom-managed default, resolved against the listed accounts. */
  const defaultAcct = useMemo(
    () => (defaultName ? accounts.find((a) => a.name === defaultName) || null : null),
    [accounts, defaultName],
  );
  const isOnDefault = !!defaultAcct && acct?.name === defaultAcct.name;

  // Preselect the env-var/discovery default once accounts load. NO `accounts[0]`
  // fallback — see the header. When the default does not resolve, nothing is
  // selected and the caption below says why.
  useEffect(() => {
    if (acct || !accounts.length) return;
    if (defaultAcct) onSelect(defaultAcct);
  }, [accounts.length, defaultAcct, acct, onSelect]);

  /**
   * Recovery path (#3565). Clearing the selection is enough: the preselect
   * effect above re-runs on the next render and re-applies `defaultAcct`. The
   * cross-sub hub is cleared too, because a hub chosen alongside a non-default
   * account is part of the same mis-selection.
   */
  const restoreDefault = useCallback(() => {
    setHubId('');
    onHub?.(null);
    onSelect(null);
  }, [onHub, onSelect]);

  return (
    <div className={s.bar} style={{ flexDirection: 'column', alignItems: 'stretch' }}>
      <div className={s.bar} style={{ padding: tokens.spacingVerticalNone, border: 'none', background: 'transparent' }}>
        <Field label="AI Foundry account (this subscription)" orientation="horizontal">
          <Dropdown
            style={{ minWidth: 280 }}
            value={acct ? `${acct.name}${acct.location ? ` · ${acct.location}` : ''}` : ''}
            selectedOptions={acct ? [acct.name] : []}
            placeholder={st.loading ? 'Loading accounts…' : (accounts.length ? 'Select an AI Foundry / Azure OpenAI account' : 'No accounts found')}
            disabled={st.loading || !!st.error}
            onOptionSelect={(_, d) => {
              const next = accounts.find((a) => a.name === d.optionValue) || null;
              if (next) onSelect(next);
            }}
          >
            {accounts.map((a) => (
              <Option key={a.id || a.name} value={a.name} text={a.name}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, minWidth: 0, flexWrap: 'wrap' }}>
                  <span>{`${a.name}${a.kind ? ` (${a.kind})` : ''}${a.location ? ` · ${a.location}` : ''}`}</span>
                  {/* #3565 — marked HERE, while choosing, not only on the chip
                      after the choice is already made. */}
                  {defaultName && a.name === defaultName && (
                    <Badge appearance="tint" color="brand" size="small">Loom default</Badge>
                  )}
                </span>
              </Option>
            ))}
          </Dropdown>
        </Field>
        {acct?.endpoint && <Badge appearance="outline" title={acct.endpoint}>endpoint set</Badge>}
        {defaultName && acct?.name === defaultName && <Badge appearance="tint" color="brand">default</Badge>}
        {/* #3565 — the way back. Always rendered so the recovery path is
            discoverable; disabled with a reason when there is nothing to
            restore, rather than a button that would do nothing. */}
        <Tooltip
          relationship="description"
          content={
            !defaultAcct
              ? 'No Loom-managed default resolved in this deployment — LOOM_AOAI_ACCOUNT is unset, or it names an account this subscription listing did not return.'
              : isOnDefault
                ? `Already on the Loom-managed default (${defaultAcct.name}).`
                : `Switch back to the Loom-managed default (${defaultAcct.name}).`
          }
        >
          <Button
            size="small"
            appearance="secondary"
            icon={<History24Regular />}
            disabled={!defaultAcct || isOnDefault}
            onClick={restoreDefault}
          >
            Use the Loom-managed default
          </Button>
        </Tooltip>
        <div className={s.grow} />
        {st.error && (
          <MessageBar intent={st.notDeployed ? 'warning' : 'error'}>
            <MessageBarBody>
              <MessageBarTitle>{st.notDeployed ? 'No AI Foundry account provisioned' : 'Could not list accounts'}</MessageBarTitle>
              {st.error}{st.hint ? <><br /><Caption1>{st.hint}</Caption1></> : null}
            </MessageBarBody>
          </MessageBar>
        )}
      </div>
      {/* #3565 — honest disclosure when the Loom-managed default did not
          resolve. NOT a remediation MessageBar: the surface is fully usable
          (every account in the subscription is in the dropdown above), so this
          names what is absent rather than gating on it. */}
      {!st.loading && !st.error && accounts.length > 0 && !defaultAcct && (
        <Caption1 style={{ padding: `0 ${tokens.spacingHorizontalL}`, color: tokens.colorNeutralForeground3 }}>
          {defaultName
            ? `No Loom-managed default selected: LOOM_AOAI_ACCOUNT names '${defaultName}', which this subscription's account listing did not return. Pick an account above — nothing is chosen for you.`
            : 'No Loom-managed default is set for this deployment (LOOM_AOAI_ACCOUNT is unset). Pick an account above — nothing is chosen for you.'}
        </Caption1>
      )}
      {/* Cross-subscription pickers — span every sub the user has RBAC for.
          #3565: DEMOTED behind a disclosure. The Loom-bound account is the
          primary path (auto-bind-by-default.md); reaching into another
          subscription is a deliberate act, not the first control on the bar. */}
      <div className={s.bar} style={{ padding: tokens.spacingVerticalNone, border: 'none', background: 'transparent' }}>
        <Button
          size="small"
          appearance="transparent"
          onClick={() => setCrossSubOpen((v) => !v)}
          aria-expanded={crossSubOpen}
        >
          {crossSubOpen ? 'Hide other subscriptions' : 'Use an account or hub from another subscription'}
        </Button>
      </div>
      {crossSubOpen && (
      <div className={s.bar} style={{ padding: tokens.spacingVerticalNone, border: 'none', background: 'transparent', alignItems: 'flex-start' }}>
        <AzureResourcePicker
          type="Microsoft.CognitiveServices/accounts"
          label="Azure OpenAI / AI Services (any subscription)"
          placeholder="Select an Azure OpenAI / AI Services account across all subs"
          value={acct?.id}
          onChange={(r) => {
            if (!r) return;
            // Drive every tab at the cross-sub account. Tabs key off name+rg.
            onSelect({ id: r.id, name: r.name, resourceGroup: r.resourceGroup, location: r.location });
          }}
        />
        <AzureResourcePicker
          type="Microsoft.MachineLearningServices/workspaces"
          label="AI Foundry hub / project (any subscription)"
          placeholder="Select an AI Foundry hub or project across all subs"
          value={hubId}
          onChange={(r) => { setHubId(r?.id || ''); onHub?.(r ? { id: r.id, name: r.name } : null); }}
        />
      </div>
      )}
    </div>
  );
}
