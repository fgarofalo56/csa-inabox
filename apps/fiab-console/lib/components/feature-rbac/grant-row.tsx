'use client';

import { clientFetch } from '@/lib/client-fetch';
/**
 * Grant row — renders a single FeatureGrant in the capability detail
 * pane.  Inline Remove button calls DELETE
 * /api/admin/permissions/grants?id=...
 */
import { useState, useCallback } from 'react';
import { Button, Badge, Persona, makeStyles, tokens } from '@fluentui/react-components';
import { Delete16Regular } from '@fluentui/react-icons';
import type { FeatureGrant } from '@/lib/auth/feature-gate';

const useStyles = makeStyles({
  row: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '6px 8px', borderRadius: '4px', borderBottom: `1px solid ${tokens.colorNeutralStroke3}`,
  },
  leftCol: { display: 'flex', alignItems: 'center', gap: '12px' },
});

export interface GrantRowProps {
  grant: FeatureGrant;
  onRemoved: () => void;
}

export function GrantRow({ grant, onRemoved }: GrantRowProps) {
  const styles = useStyles();
  const [removing, setRemoving] = useState(false);

  const remove = useCallback(async () => {
    if (!confirm(`Remove ${grant.principalDisplayName || grant.principalId} from ${grant.capabilityId}?`)) return;
    setRemoving(true);
    try {
      const res = await clientFetch(`/api/admin/permissions/grants?id=${encodeURIComponent(grant.id)}`, { method: 'DELETE' });
      if (res.ok) onRemoved();
    } finally {
      setRemoving(false);
    }
  }, [grant, onRemoved]);

  return (
    <div className={styles.row}>
      <div className={styles.leftCol}>
        <Persona
          name={grant.principalDisplayName || grant.principalId}
          secondaryText={grant.principalUpn || grant.principalType}
        />
        <Badge appearance="tint" color={grant.role === 'Admin' ? 'danger' : grant.role === 'Contributor' ? 'warning' : 'informative'}>
          {grant.role}
        </Badge>
      </div>
      <Button
        size="small"
        appearance="subtle"
        icon={<Delete16Regular />}
        onClick={remove}
        disabled={removing}
        aria-label={`Remove ${grant.principalDisplayName} from ${grant.capabilityId}`}
      >
        {removing ? 'Removing…' : 'Remove'}
      </Button>
    </div>
  );
}
