/**
 * eventstream-hub-scope — pure extraction of the Event Hub entity names an
 * eventstream item references (backs the least-privilege Event Hubs tree).
 */
import { describe, it, expect } from 'vitest';
import { hubNamesFromEventstreamState } from '../eventstream-hub-scope';

describe('hubNamesFromEventstreamState', () => {
  it('returns [] for empty / missing state', () => {
    expect(hubNamesFromEventstreamState(undefined)).toEqual([]);
    expect(hubNamesFromEventstreamState(null)).toEqual([]);
    expect(hubNamesFromEventstreamState({})).toEqual([]);
  });

  it('collects source hub names, kafka topics and provisioned entity paths', () => {
    const names = hubNamesFromEventstreamState({
      sources: [
        { kind: 'eventhub', eventHubName: 'Orders-Hub' },
        { kind: 'kafka', topic: 'telemetry' },
        { kind: 'custom-app', provisionedEndpoint: { entityPath: 'custom-1' } },
      ],
    });
    expect(names).toContain('orders-hub'); // lower-cased
    expect(names).toContain('telemetry');
    expect(names).toContain('custom-1');
  });

  it('collects sink hub names, the transport hub and the ehId entity segment', () => {
    const names = hubNamesFromEventstreamState({
      sink: { kind: 'eventhub', eventHubName: 'transformed-out' },
      transportHub: 'es-transport-abc',
      ehId: '/subscriptions/s/resourceGroups/rg/providers/Microsoft.EventHub/namespaces/ns/eventhubs/es-live-1',
    });
    expect(names).toContain('transformed-out');
    expect(names).toContain('es-transport-abc');
    expect(names).toContain('es-live-1');
  });

  it('handles the legacy singular source shape and dedupes', () => {
    const names = hubNamesFromEventstreamState({
      source: { kind: 'eventhub', eventHubName: 'hub-a', provisionedEndpoint: { entityPath: 'hub-a' } },
    });
    expect(names).toEqual(['hub-a']);
  });

  it('ignores blank / non-string values', () => {
    const names = hubNamesFromEventstreamState({
      sources: [{ eventHubName: '  ' }, { topic: 42 }, null, 'nope'],
      sinks: [{ eventHubName: '' }],
      ehId: '/not-an-eventhub-id',
    });
    expect(names).toEqual([]);
  });
});
