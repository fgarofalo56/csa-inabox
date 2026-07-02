'use client';

/**
 * EndorsementControl — generic Promote / Certify / Master-data endorsement for
 * ANY Loom item, rendered in the shared editor chrome so every editor carries it
 * (Fabric/Power-BI endorsement parity).
 *
 * Reads + writes the real Azure-native backend (Cosmos `state.endorsement`) via
 * `/api/items/[type]/[id]/endorsement` (GET + PATCH). Promote/clear are open to
 * the item owner; Certify / Master data are gated on the tenant-admin certifier
 * (the route returns 403 otherwise, and this control disables those options with
 * a tooltip so they are never dead buttons). Every level carries a Caption1
 * description (what it means + who can set it), and a failed write is surfaced
 * as an error toast with the route's message — never silently swallowed.
 * Web5: Fluent v9 + Loom tokens.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Badge, Button, Menu, MenuTrigger, MenuPopover, MenuList, MenuItemRadio, Tooltip, Spinner,
  Caption1, Toast, ToastTitle, ToastBody, Toaster, useToastController, useId,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Ribbon16Regular, ShieldCheckmark16Regular } from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';

type Endorsement = 'Promoted' | 'Certified' | 'Master data';

const OPTIONS: Array<{ value: string; label: string; hint: string; elevated?: boolean }> = [
  {
    value: 'None',
    label: 'None',
    hint: 'No endorsement — clears the badge. Any item owner can set this.',
  },
  {
    value: 'Promoted',
    label: 'Promoted',
    hint: 'Ready to share — signals this item is good to use. Any item owner can promote.',
  },
  {
    value: 'Certified',
    label: 'Certified',
    hint: "Meets your org's quality standards. Only a certifier (tenant admin) can set this.",
    elevated: true,
  },
  {
    value: 'Master data',
    label: 'Master data',
    hint: 'The single authoritative source of truth for this data. Only a certifier (tenant admin) can set this.',
    elevated: true,
  },
];

const useStyles = makeStyles({
  root: { display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalSNudge },
  // Two-line radio option: label on top, Caption1 description underneath.
  option: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXXS,
    whiteSpace: 'normal',
    maxWidth: '280px',
    paddingTop: tokens.spacingVerticalXXS,
    paddingBottom: tokens.spacingVerticalXXS,
  },
  hint: { color: tokens.colorNeutralForeground3 },
});

interface Props {
  itemType: string;
  itemId: string;
}

/** The badge shown in the chrome header when an item is endorsed. */
export function endorsementBadge(endorsement: Endorsement) {
  if (endorsement === 'Certified' || endorsement === 'Master data') {
    return (
      <Badge appearance="tint" color="success" size="small" icon={<ShieldCheckmark16Regular />}>
        {endorsement}
      </Badge>
    );
  }
  return (
    <Badge appearance="tint" color="brand" size="small" icon={<Ribbon16Regular />}>
      {endorsement}
    </Badge>
  );
}

export function EndorsementControl({ itemType, itemId }: Props) {
  const s = useStyles();
  const [endorsement, setEndorsement] = useState<Endorsement | null>(null);
  const [canCertify, setCanCertify] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Failed writes surface as an error toast (never silently keep the prior
  // value with no feedback — the menu radio would otherwise LOOK applied).
  const toasterId = useId('endorsement-toaster');
  const { dispatchToast } = useToastController(toasterId);
  const notifyError = useCallback((detail: string) => {
    dispatchToast(
      <Toast>
        <ToastTitle>Endorsement not saved</ToastTitle>
        <ToastBody>{detail}</ToastBody>
      </Toast>,
      { intent: 'error' },
    );
  }, [dispatchToast]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await clientFetch(`/api/items/${itemType}/${encodeURIComponent(itemId)}/endorsement`, { cache: 'no-store' });
      const j = await r.json();
      if (j?.ok) {
        setEndorsement(j.endorsement ?? null);
        setCanCertify(!!j.canCertify);
      }
    } catch {
      /* header affordance is best-effort — leave unendorsed on error */
    } finally {
      setLoading(false);
    }
  }, [itemType, itemId]);

  useEffect(() => { load(); }, [load]);

  const apply = useCallback(async (value: string) => {
    const next = value === 'None' ? null : (value as Endorsement);
    setSaving(true);
    try {
      const r = await clientFetch(`/api/items/${itemType}/${encodeURIComponent(itemId)}/endorsement`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endorsement: next ?? 'None' }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j?.ok) {
        setEndorsement(j.endorsement ?? null);
      } else {
        // Surface the failure (405 route gap, 403 certifier race, 4xx/5xx…)
        // with the route's own message — the prior value is kept, but never
        // silently: the operator sees exactly why the write didn't stick.
        notifyError((j as { error?: string })?.error || `The endorsement service returned HTTP ${r.status}.`);
      }
    } catch (e) {
      notifyError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [itemType, itemId, notifyError]);

  const current = endorsement ?? 'None';

  return (
    <span className={s.root}>
      <Toaster toasterId={toasterId} />
      {endorsement && endorsementBadge(endorsement)}
      <Menu
        checkedValues={{ endorsement: [current] }}
        onCheckedValueChange={(_e, data) => {
          const v = data.checkedItems?.[0];
          if (v && v !== current) apply(v);
        }}
      >
        <MenuTrigger disableButtonEnhancement>
          <Tooltip
            content="Endorse this item — Promote it, or Certify it as an authoritative source (certifier only)"
            relationship="label"
          >
            <Button
              appearance="subtle"
              size="small"
              icon={saving || loading ? <Spinner size="extra-tiny" /> : <Ribbon16Regular />}
              disabled={saving}
            >
              Endorse
            </Button>
          </Tooltip>
        </MenuTrigger>
        <MenuPopover>
          <MenuList>
            {OPTIONS.map((o) => {
              // Two-line option: level label + a Caption1 description of what
              // the level means and who can set it (no bare radio labels).
              const body = (
                <span className={s.option}>
                  <span>{o.label}</span>
                  <Caption1 className={s.hint}>{o.hint}</Caption1>
                </span>
              );
              return o.elevated && !canCertify ? (
                <Tooltip key={o.value} content="Certifying is restricted to a tenant admin (certifier)." relationship="label">
                  {/* Disabled radio still needs a wrapper for the tooltip to anchor. */}
                  <MenuItemRadio name="endorsement" value={o.value} disabled>
                    {body}
                  </MenuItemRadio>
                </Tooltip>
              ) : (
                <MenuItemRadio key={o.value} name="endorsement" value={o.value}>
                  {body}
                </MenuItemRadio>
              );
            })}
          </MenuList>
        </MenuPopover>
      </Menu>
    </span>
  );
}

export default EndorsementControl;
