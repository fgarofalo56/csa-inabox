/**
 * Contract tests for the business-events client's pure governance logic —
 * schema validation + strict payload validation (the gate that makes a
 * published signal "structured & governed"). These exercise the contract
 * enforcement without any Cosmos / Event Hubs I/O.
 */
import { describe, it, expect, vi } from 'vitest';

// Stub identity + the I/O deps so importing the module never touches Azure.
vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'T', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});
vi.mock('../cosmos-client', () => ({ businessEventsContainer: vi.fn() }));
vi.mock('../eventhubs-data-client', () => ({ sendEvents: vi.fn(), readEventHubsDataConfig: vi.fn() }));

import {
  validateSchema,
  validatePayload,
  defaultBusinessEventHub,
  eventGridTopicEndpoint,
  transportConfigGate,
  BusinessEventError,
  type BusinessEventProperty,
} from '../business-events-client';

describe('validateSchema', () => {
  it('accepts a well-formed typed schema', () => {
    const out = validateSchema([
      { name: 'storeId', type: 'string', required: true },
      { name: 'salesAmount', type: 'number' },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].required).toBe(true);
  });

  it('rejects an empty schema', () => {
    expect(() => validateSchema([])).toThrow(BusinessEventError);
  });

  it('rejects duplicate property names (case-insensitive)', () => {
    expect(() => validateSchema([{ name: 'x', type: 'string' }, { name: 'X', type: 'number' }])).toThrow(/duplicate/);
  });

  it('rejects an invalid type', () => {
    expect(() => validateSchema([{ name: 'x', type: 'json' as any }])).toThrow(/invalid type/);
  });

  it('rejects an invalid property name', () => {
    expect(() => validateSchema([{ name: '1bad', type: 'string' }])).toThrow(/invalid property name/);
  });
});

describe('validatePayload', () => {
  const schema: BusinessEventProperty[] = [
    { name: 'storeId', type: 'string', required: true },
    { name: 'salesAmount', type: 'number', required: true },
    { name: 'breached', type: 'boolean' },
    { name: 'at', type: 'datetime' },
  ];

  it('coerces and accepts a conforming payload', () => {
    const out = validatePayload(schema, { storeId: 'S1', salesAmount: '9500', breached: 'true', at: '2026-06-10T00:00:00Z' });
    expect(out.storeId).toBe('S1');
    expect(out.salesAmount).toBe(9500);
    expect(out.breached).toBe(true);
    expect(typeof out.at).toBe('string');
  });

  it('throws on a missing required field', () => {
    expect(() => validatePayload(schema, { storeId: 'S1' })).toThrow(/missing required field "salesAmount"/);
  });

  it('throws on a non-numeric number field', () => {
    expect(() => validatePayload(schema, { storeId: 'S1', salesAmount: 'NaNish' })).toThrow(/must be a number/);
  });

  it('throws on an invalid datetime', () => {
    expect(() => validatePayload(schema, { storeId: 'S1', salesAmount: 1, at: 'not-a-date' })).toThrow(/valid date\/time/);
  });

  it('rejects unknown fields (strict contract)', () => {
    expect(() => validatePayload(schema, { storeId: 'S1', salesAmount: 1, rogue: 'x' })).toThrow(/unknown field "rogue"/);
  });
});

describe('config helpers', () => {
  it('transportConfigGate flags a missing namespace', () => {
    const prev = process.env.LOOM_EVENTHUB_NAMESPACE;
    delete process.env.LOOM_EVENTHUB_NAMESPACE;
    expect(transportConfigGate()).toEqual({ missing: 'LOOM_EVENTHUB_NAMESPACE' });
    process.env.LOOM_EVENTHUB_NAMESPACE = 'loom-evhns';
    expect(transportConfigGate()).toBeNull();
    if (prev === undefined) delete process.env.LOOM_EVENTHUB_NAMESPACE; else process.env.LOOM_EVENTHUB_NAMESPACE = prev;
  });

  it('defaultBusinessEventHub falls back to the conventional hub', () => {
    const prev = process.env.LOOM_BUSINESS_EVENTS_HUB;
    delete process.env.LOOM_BUSINESS_EVENTS_HUB;
    expect(defaultBusinessEventHub()).toBe('loom-business-events');
    if (prev !== undefined) process.env.LOOM_BUSINESS_EVENTS_HUB = prev;
  });

  it('eventGridTopicEndpoint normalizes bare hostnames and is null when unset', () => {
    const prev = process.env.LOOM_BUSINESS_EVENTS_EGTOPIC;
    delete process.env.LOOM_BUSINESS_EVENTS_EGTOPIC;
    expect(eventGridTopicEndpoint()).toBeNull();
    expect(eventGridTopicEndpoint('topic.eastus2-1.eventgrid.azure.net')).toBe('https://topic.eastus2-1.eventgrid.azure.net');
    expect(eventGridTopicEndpoint('https://t.example.net/')).toBe('https://t.example.net');
    if (prev !== undefined) process.env.LOOM_BUSINESS_EVENTS_EGTOPIC = prev;
  });
});
