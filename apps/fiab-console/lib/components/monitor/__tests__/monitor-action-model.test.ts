/**
 * Unit coverage for the Azure Monitor rule ACTION model (G3). Asserts the typed
 * action state maps to the exact request-body shapes the activator-monitor
 * backend reads (email / Teams / webhook / SMS / Logic App), and that an empty
 * / partial action degrades to "no action group" rather than emitting junk.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_MONITOR_ACTION,
  monitorActionToBody,
  monitorActionIsConfigured,
  monitorActionSummary,
  type MonitorActionState,
} from '../monitor-action-model';

const base = (patch: Partial<MonitorActionState>): MonitorActionState => ({ ...DEFAULT_MONITOR_ACTION, ...patch });

describe('monitorActionToBody', () => {
  it('composes an Email action into config.to (+ subject)', () => {
    const body = monitorActionToBody(base({ kind: 'Email', target: 'ops@example.com', message: 'Breach' }));
    expect(body.action).toEqual({ kind: 'Email', config: { to: 'ops@example.com', subject: 'Breach' } });
    expect(body.existingActionGroupId).toBeUndefined();
  });

  it('composes a Teams action into config.webhookUrl + message', () => {
    const body = monitorActionToBody(base({ kind: 'TeamsMessage', target: 'https://outlook.office.com/webhook/x', message: 'Hi' }));
    expect(body.action).toEqual({ kind: 'TeamsMessage', config: { webhookUrl: 'https://outlook.office.com/webhook/x', message: 'Hi' } });
  });

  it('composes a Webhook action into config.url', () => {
    const body = monitorActionToBody(base({ kind: 'Webhook', target: 'https://hook.example.com/x' }));
    expect(body.action).toEqual({ kind: 'Webhook', config: { url: 'https://hook.example.com/x' } });
  });

  it('composes SMS with digit-normalized country code + phone', () => {
    const body = monitorActionToBody(base({ kind: 'SMS', countryCode: '+1', phone: '(555) 123-4567' }));
    expect(body.action).toEqual({ kind: 'SMS', config: { countryCode: '1', phoneNumber: '5551234567' } });
  });

  it('composes a Logic App action into resource id + callback url', () => {
    const body = monitorActionToBody(base({
      kind: 'LogicApp',
      logicAppResourceId: '/subscriptions/s/providers/Microsoft.Logic/workflows/wf',
      logicAppCallbackUrl: 'https://prod-1.logic.azure.com/…/invoke?sig=abc',
    }));
    expect(body.action).toEqual({
      kind: 'LogicApp',
      config: { logicAppResourceId: '/subscriptions/s/providers/Microsoft.Logic/workflows/wf', callbackUrl: 'https://prod-1.logic.azure.com/…/invoke?sig=abc' },
    });
  });

  it('returns the pick-existing action group id when useExisting', () => {
    const id = '/subscriptions/s/resourceGroups/rg/providers/microsoft.insights/actionGroups/ag';
    const body = monitorActionToBody(base({ useExisting: true, existingActionGroupId: id }));
    expect(body).toEqual({ existingActionGroupId: id });
  });

  it('degrades to {} (no action group) when nothing is fully configured', () => {
    // Email with a default subject but no recipient → not configured → {}.
    expect(monitorActionToBody(base({ kind: 'Email', target: '' }))).toEqual({});
    expect(monitorActionToBody(base({ useExisting: true, existingActionGroupId: '' }))).toEqual({});
    // A Logic App with only the resource id (no callback URL) is incomplete —
    // the backend needs both to attach a receiver — so it degrades to {}.
    expect(monitorActionToBody(base({ kind: 'LogicApp', logicAppResourceId: '/x', logicAppCallbackUrl: '' }))).toEqual({});
  });
});

describe('monitorActionIsConfigured', () => {
  it('requires a real target per kind', () => {
    expect(monitorActionIsConfigured(base({ kind: 'Email', target: 'x' }))).toBe(false);
    expect(monitorActionIsConfigured(base({ kind: 'Email', target: 'x@y.com' }))).toBe(true);
    expect(monitorActionIsConfigured(base({ kind: 'Webhook', target: 'notaurl' }))).toBe(false);
    expect(monitorActionIsConfigured(base({ kind: 'Webhook', target: 'https://h/x' }))).toBe(true);
    expect(monitorActionIsConfigured(base({ kind: 'SMS', phone: '' }))).toBe(false);
    expect(monitorActionIsConfigured(base({ kind: 'SMS', phone: '5551234' }))).toBe(true);
    expect(monitorActionIsConfigured(base({ kind: 'LogicApp', logicAppResourceId: '/x', logicAppCallbackUrl: '' }))).toBe(false);
    expect(monitorActionIsConfigured(base({ kind: 'LogicApp', logicAppResourceId: '/x', logicAppCallbackUrl: 'https://cb' }))).toBe(true);
  });
});

describe('monitorActionSummary', () => {
  it('reads "no action" when unconfigured, else a per-kind label', () => {
    expect(monitorActionSummary(base({ kind: 'Email', target: '' }))).toBe('no action');
    expect(monitorActionSummary(base({ kind: 'Email', target: 'a@b.com' }))).toContain('email → a@b.com');
    expect(monitorActionSummary(base({ kind: 'LogicApp', logicAppResourceId: '/x', logicAppCallbackUrl: 'https://cb' }))).toBe('trigger Logic App');
    expect(monitorActionSummary(base({ useExisting: true, existingActionGroupId: '/ag' }))).toBe('existing action group');
  });
});
