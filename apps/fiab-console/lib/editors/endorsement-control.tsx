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
 * a tooltip so they are never dead buttons). Web5: Fluent v9 + Loom tokens.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Badge, Button, Menu, MenuTrigger, MenuPopover, MenuList, MenuItemRadio, Tooltip, Spinner,
} from '@fluentui/react-components';
import { Ribbon16Regular, ShieldCheckmark16Regular } from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';

type Endorsement = 'Promoted' | 'Certified' | 'Master data';

const OPTIONS: Array<{ value: string; label: string; elevated?: boolean }> = [
  { value: 'None', label: 'None' },
  { value: 'Promoted', label: 'Promoted' },
  { value: 'Certified', label: 'Certified', elevated: true },
  { value: 'Master data', label: 'Master data', elevated: true },
];

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
  const [endorsement, setEndorsement] = useState<Endorsement | null>(null);
  const [canCertify, setCanCertify] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

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
      }
      // A 403 (certifier required) leaves the prior value; the option is already
      // disabled for non-certifiers, so this only guards a race.
    } catch {
      /* keep prior value on failure */
    } finally {
      setSaving(false);
    }
  }, [itemType, itemId]);

  const current = endorsement ?? 'None';

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
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
            {OPTIONS.map((o) =>
              o.elevated && !canCertify ? (
                <Tooltip key={o.value} content="Certifying is restricted to a tenant admin (certifier)." relationship="label">
                  {/* Disabled radio still needs a wrapper for the tooltip to anchor. */}
                  <MenuItemRadio name="endorsement" value={o.value} disabled>
                    {o.label}
                  </MenuItemRadio>
                </Tooltip>
              ) : (
                <MenuItemRadio key={o.value} name="endorsement" value={o.value}>
                  {o.label}
                </MenuItemRadio>
              ),
            )}
          </MenuList>
        </MenuPopover>
      </Menu>
    </span>
  );
}

export default EndorsementControl;
