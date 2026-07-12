'use client';

/**
 * PinButton — the pin/unpin affordance. Reads shared pin state (pin-store) so
 * it renders filled when the target is already pinned, and toggles it (real
 * Cosmos-backed persistence) on click. Stops propagation so a pin click inside
 * a clickable ItemTile / table row never also "opens" the item.
 */

import { Button, Tooltip } from '@fluentui/react-components';
import { Pin16Regular, Pin16Filled } from '@fluentui/react-icons';
import { usePins, type PinnedItem } from './pin-store';

export function PinButton({
  pin,
  size = 'small',
}: {
  pin: PinnedItem;
  size?: 'small' | 'medium';
}) {
  const { isPinned, togglePin } = usePins();
  const pinned = isPinned(pin.id);
  return (
    <Tooltip content={pinned ? 'Unpin' : 'Pin'} relationship="label">
      <Button
        appearance="transparent"
        size={size}
        icon={pinned ? <Pin16Filled /> : <Pin16Regular />}
        aria-pressed={pinned}
        aria-label={pinned ? `Unpin ${pin.label}` : `Pin ${pin.label}`}
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          togglePin(pin);
        }}
        onKeyDown={(e) => e.stopPropagation()}
      />
    </Tooltip>
  );
}

export default PinButton;
