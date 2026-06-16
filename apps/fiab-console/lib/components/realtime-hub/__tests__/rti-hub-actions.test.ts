/**
 * Unit tests for the RTI catalog per-kind action matrix (rti-hub-actions.ts).
 *
 * These pin the contract that the data-streams action menu and the parity doc
 * share: which actions each row kind exposes, and that Subscribe + Create
 * activator are universal. Pure logic — no React render (the repo's component
 * render harness is env-gated), so this runs reliably in CI.
 */
import { describe, it, expect } from 'vitest';
import { streamRowActions, isLoomItemKind, editorLabel } from '../rti-hub-actions';

describe('streamRowActions', () => {
  it('Loom eventstream rows: preview/test events + endpoints + open editor', () => {
    const a = streamRowActions('eventstream');
    expect(a.previewTestEvents).toBe(true);
    expect(a.endpoints).toBe(true);
    expect(a.openEditor).toBe(true);
    // eventstreams are deletable from the catalog (audit B1)
    expect(a.deleteEventstream).toBe(true);
    // not a KQL/Eventhouse preview, not an Event Hub peek
    expect(a.previewData).toBe(false);
    expect(a.peekSendEvents).toBe(false);
  });

  it('only eventstream rows are deletable from the catalog (B1)', () => {
    expect(streamRowActions('eventstream').deleteEventstream).toBe(true);
    for (const kind of ['kql-database', 'eventhouse', 'eventhub-entity', 'adx-cluster', 'iothub']) {
      expect(streamRowActions(kind).deleteEventstream).toBe(false);
    }
  });

  it('KQL database + Eventhouse rows: preview data + open editor (no eventstream peek/endpoints)', () => {
    for (const kind of ['kql-database', 'eventhouse']) {
      const a = streamRowActions(kind);
      expect(a.previewData).toBe(true);
      expect(a.previewClusterData).toBe(false);
      expect(a.openEditor).toBe(true);
      expect(a.previewTestEvents).toBe(false);
      expect(a.peekSendEvents).toBe(false);
      expect(a.endpoints).toBe(false);
    }
  });

  it('Event Hub entity rows: peek/send events, not a Loom editor', () => {
    const a = streamRowActions('eventhub-entity');
    expect(a.peekSendEvents).toBe(true);
    expect(a.openEditor).toBe(false);
    expect(a.previewData).toBe(false);
    expect(a.previewTestEvents).toBe(false);
  });

  it('ADX cluster rows: cluster-scoped preview (clusterUri override) + subscribe + activator', () => {
    const a = streamRowActions('adx-cluster');
    expect(a.previewClusterData).toBe(true);
    expect(a.subscribe).toBe(true);
    expect(a.createActivator).toBe(true);
    // Not a Loom-item preview/editor (it is a discovered Azure resource).
    expect(a.previewData).toBe(false);
    expect(a.openEditor).toBe(false);
    expect(a.previewTestEvents).toBe(false);
    expect(a.peekSendEvents).toBe(false);
  });

  it('namespace / IoT Hub rows: subscribe + activator only (no inline preview)', () => {
    for (const kind of ['eventhub-namespace', 'iothub']) {
      const a = streamRowActions(kind);
      expect(a.subscribe).toBe(true);
      expect(a.createActivator).toBe(true);
      expect(a.previewTestEvents).toBe(false);
      expect(a.peekSendEvents).toBe(false);
      expect(a.previewData).toBe(false);
      expect(a.previewClusterData).toBe(false);
      expect(a.endpoints).toBe(false);
      expect(a.openEditor).toBe(false);
    }
  });

  it('Subscribe + Create activator are universal across every kind', () => {
    for (const kind of [
      'eventstream', 'eventhub-entity', 'eventhub-namespace',
      'iothub', 'adx-cluster', 'kql-database', 'eventhouse',
    ]) {
      const a = streamRowActions(kind);
      expect(a.subscribe).toBe(true);
      expect(a.createActivator).toBe(true);
    }
  });
});

describe('isLoomItemKind', () => {
  it('true only for the deployed Loom item kinds', () => {
    expect(isLoomItemKind('eventstream')).toBe(true);
    expect(isLoomItemKind('kql-database')).toBe(true);
    expect(isLoomItemKind('eventhouse')).toBe(true);
    expect(isLoomItemKind('eventhub-entity')).toBe(false);
    expect(isLoomItemKind('adx-cluster')).toBe(false);
  });
});

describe('editorLabel', () => {
  it('maps each Loom item kind to its editor label', () => {
    expect(editorLabel('eventhouse')).toBe('eventhouse');
    expect(editorLabel('kql-database')).toBe('KQL database');
    expect(editorLabel('eventstream')).toBe('eventstream');
  });
});
