/**
 * Unit tests for the governed business-event registry's PURE helpers —
 * eventTypeId() (slugging) and validatePayload() (the governance gate that
 * makes published events "structured + governed"). These carry no Azure-SDK
 * import so they run without any mock; they assert the exact governance
 * contract the publish route enforces before emitting to Event Grid/Event Hubs.
 */
import { describe, it, expect } from 'vitest';
import {
  eventTypeId,
  validatePayload,
  BUSINESS_FIELD_TYPES,
  type BusinessEventField,
} from '../business-events-store';

describe('eventTypeId', () => {
  it('slugs an event type into a stable dotted id', () => {
    expect(eventTypeId('Order.Placed')).toBe('order.placed');
    expect(eventTypeId('  Customer Signed Up ')).toBe('customer.signed.up');
    expect(eventTypeId('Security/Alert!!')).toBe('security.alert');
  });
});

describe('validatePayload (governance gate)', () => {
  const fields: BusinessEventField[] = [
    { name: 'id', type: 'string', required: true },
    { name: 'amount', type: 'number', required: true },
    { name: 'paid', type: 'boolean', required: false },
    { name: 'when', type: 'datetime', required: false },
    { name: 'meta', type: 'json', required: false },
  ];

  it('accepts a well-typed payload', () => {
    expect(
      validatePayload({ fields }, {
        id: 'o-1', amount: 42.5, paid: true,
        when: '2026-06-10T12:00:00Z', meta: { a: 1 },
      }),
    ).toEqual([]);
  });

  it('rejects a missing required field', () => {
    const errs = validatePayload({ fields }, { id: 'o-1' });
    expect(errs).toContain('Missing required field "amount".');
  });

  it('rejects type mismatches', () => {
    const errs = validatePayload({ fields }, { id: 1 as any, amount: 'nope' as any });
    expect(errs).toContain('Field "id" must be a string.');
    expect(errs).toContain('Field "amount" must be a number.');
  });

  it('rejects an invalid datetime string', () => {
    const errs = validatePayload({ fields }, { id: 'o', amount: 1, when: 'not-a-date' });
    expect(errs.some((e) => e.includes('"when"'))).toBe(true);
  });

  it('rejects unknown fields not in the governed schema', () => {
    const errs = validatePayload({ fields }, { id: 'o', amount: 1, rogue: 'x' });
    expect(errs).toContain('Unknown field "rogue" is not part of the governed schema.');
  });

  it('exposes the supported field types', () => {
    expect(BUSINESS_FIELD_TYPES).toEqual(['string', 'number', 'boolean', 'datetime', 'json']);
  });
});
