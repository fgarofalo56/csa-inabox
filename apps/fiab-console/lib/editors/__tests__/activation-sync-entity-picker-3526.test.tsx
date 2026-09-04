/**
 * #3526 — the Service Bus activation destination must PICK its queue/topic from
 * the namespace chosen one field above it, not ask for it as free text.
 *
 * WHAT WAS WRONG. `activation-sync-editor.tsx` rendered
 * `<Field label="Queue / topic"><Input placeholder="activation-queue">` — a raw
 * text box for an infrastructure value the platform can enumerate
 * (`loom_no_freeform_config`, `auto-bind-by-default.md` §5). The namespace one
 * field above it was already an `AzureBackedField`, so the surface asked the
 * user to hand-type a child of a resource it had just discovered for them. The
 * lister that existed (`servicebus-client.listQueues`) was pinned to
 * `LOOM_SERVICEBUS_NAMESPACE`, so wiring the field to IT would have listed a
 * DIFFERENT namespace's entities under the one the user picked — worse than the
 * text box. Hence the namespace-scoped route + `listQueuesIn`/`listTopicsIn`.
 *
 * The file is NOT in `scripts/ci/no-freeform-inputs-baseline.json`, so no
 * ratchet would ever have flagged it — which is why this spec asserts the
 * ABSENCE of the text input directly.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { useState } from 'react';
import { DestinationPicker } from '../activation-sync-editor';
import { parseNamespaceId } from '@/lib/azure/servicebus-client';

const NS_NAME = 'sb-loom-eastus2';
const NS_ID = `/subscriptions/sub-1/resourceGroups/rg-loom/providers/Microsoft.ServiceBus/namespaces/${NS_NAME}`;

/** Records every URL the component fetched, so the SCOPE can be asserted. */
function installEntityFetch(entities: Array<{ name: string; kind: 'queue' | 'topic' }>) {
  const urls: string[] = [];
  vi.spyOn(global, 'fetch').mockImplementation(async (input: any) => {
    const u = typeof input === 'string' ? input : (input?.url ?? String(input));
    urls.push(u);
    if (u.includes('/api/azure/servicebus-entities')) {
      return new Response(JSON.stringify({ ok: true, namespace: NS_NAME, entities }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  });
  return urls;
}

function Harness({ namespace, entity }: { namespace: string; entity: string }) {
  const [spec, setSpec] = useState<any>({
    mapping: [], mode: 'full', runs: [],
    destination: { kind: 'service-bus', namespace, entity },
  });
  return <DestinationPicker spec={spec} onChange={setSpec} />;
}

describe('activation-sync Service Bus destination (#3526)', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('offers a combobox for the entity and NO text input for it', async () => {
    installEntityFetch([{ name: 'activation-queue', kind: 'queue' }]);
    render(<Harness namespace={NS_NAME} entity="" />);

    const picker = await screen.findByTestId('activation-sync-sb-entity');
    expect(picker.querySelector('input[type="text"], textarea')).toBeNull();
    // Fluent's Dropdown IS a combobox; the old surface had none here.
    expect(picker.querySelector('[role="combobox"]')).not.toBeNull();
  });

  it('lists the mocked queues AND topics of the picked namespace', async () => {
    installEntityFetch([
      { name: 'activation-queue', kind: 'queue' },
      { name: 'activation-topic', kind: 'topic' },
    ]);
    render(<Harness namespace={NS_NAME} entity="" />);

    const picker = await screen.findByTestId('activation-sync-sb-entity');
    fireEvent.click(picker.querySelector('[role="combobox"]')!);
    expect(await screen.findByRole('option', { name: /activation-queue/ })).toBeInTheDocument();
    expect(await screen.findByRole('option', { name: /activation-topic/ })).toBeInTheDocument();
  });

  it('scopes the entity request to the PICKED namespace, not the env-pinned one', async () => {
    const urls = installEntityFetch([{ name: 'activation-queue', kind: 'queue' }]);
    render(<Harness namespace={NS_NAME} entity="" />);
    await waitFor(() => {
      expect(urls.some((u) => u.includes('/api/azure/servicebus-entities'))).toBe(true);
    });
    const call = urls.find((u) => u.includes('/api/azure/servicebus-entities'))!;
    // The namespace the user picked is IN the request. If the wiring ever falls
    // back to LOOM_SERVICEBUS_NAMESPACE, the request carries no namespace at all
    // and this fails rather than silently listing the wrong one.
    expect(decodeURIComponent(call)).toContain(NS_NAME);
  });

  it('does not call the entity route before a namespace is chosen', async () => {
    const urls = installEntityFetch([]);
    render(<Harness namespace="" entity="" />);
    await screen.findByTestId('activation-sync-sb-entity');
    // An unset cascade parent is an empty list with NO error — calling the
    // route with an empty namespace would 400 and read as a failure the user
    // did not cause.
    expect(urls.filter((u) => u.includes('/api/azure/servicebus-entities'))).toHaveLength(0);
  });

  it('keeps a STORED entity visible even when this namespace did not return it', async () => {
    installEntityFetch([{ name: 'activation-queue', kind: 'queue' }]);
    render(<Harness namespace={NS_NAME} entity="queue-from-an-older-namespace" />);
    const picker = await screen.findByTestId('activation-sync-sb-entity');
    await waitFor(() => {
      expect(picker.textContent).toContain('queue-from-an-older-namespace');
    });
  });
});

describe('parseNamespaceId (#3526)', () => {
  it('splits a real Service Bus namespace id', () => {
    expect(parseNamespaceId(NS_ID)).toEqual({
      subscriptionId: 'sub-1', resourceGroup: 'rg-loom', namespace: NS_NAME,
    });
  });

  it('returns null — never a partial ref — for a non-Service-Bus id', () => {
    // A half-filled ref would build an ARM path that 404s, and the caller would
    // report "no queues" for what is really a malformed id (R7).
    expect(parseNamespaceId('/subscriptions/sub-1/resourceGroups/rg/providers/Microsoft.EventHub/namespaces/eh')).toBeNull();
    expect(parseNamespaceId('sb-loom-eastus2')).toBeNull();
    expect(parseNamespaceId('')).toBeNull();
    expect(parseNamespaceId(null)).toBeNull();
  });

  it('accepts the child-resource form and stops at the namespace segment', () => {
    expect(parseNamespaceId(`${NS_ID}/queues/activation-queue`)?.namespace).toBe(NS_NAME);
  });
});
