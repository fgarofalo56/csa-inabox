import { describe, it, expect } from 'vitest';
import {
  ACTIVITY_CATALOG, byCategory, findByType, findByKey, findForActivity, nextNameSuffix,
} from '../activity-catalog';
import { ACTIVITY_FORMS, activityLoomKind } from '../activity-forms';

describe('activity-catalog', () => {
  it('exposes all three Fabric palette categories', () => {
    const mt = byCategory('move-transform');
    const orch = byCategory('orchestration');
    const cf = byCategory('control-flow');
    expect(mt.length).toBeGreaterThan(0);
    expect(orch.length).toBeGreaterThan(0);
    expect(cf.length).toBeGreaterThan(0);
    expect(mt.length + orch.length + cf.length).toBe(ACTIVITY_CATALOG.length);
  });

  it('covers all Fabric activity types required by the parity spec', () => {
    const keys = ACTIVITY_CATALOG.map((a) => a.key);
    const required = [
      'Copy', 'DataflowGen2', 'ExecuteDataFlow', 'Lookup', 'GetMetadata', 'Delete',
      'Notebook', 'SparkJob', 'ExecutePipeline', 'Script', 'StoredProcedure',
      'Web', 'Webhook', 'Fail', 'Validation', 'Office365Outlook',
      'SetVariable', 'AppendVariable', 'Filter', 'ForEach', 'IfCondition',
      'Switch', 'Until', 'Wait',
    ];
    for (const k of required) expect(keys).toContain(k);
  });

  it('marks Fabric-only activities as non-runnable with remediation', () => {
    const office = findByKey('Office365Outlook');
    expect(office?.runnable).toBe(false);
    expect(office?.remediation).toBeTruthy();
    const dfg2 = findByKey('DataflowGen2');
    expect(dfg2?.runnable).toBe(false);
    expect(dfg2?.remediation).toBeTruthy();
  });

  it('every catalog entry has a build() that produces a valid PipelineActivity', () => {
    for (const def of ACTIVITY_CATALOG) {
      const a = def.build(`${def.namePrefix}1`);
      expect(a.name).toBe(`${def.namePrefix}1`);
      expect(a.type).toBe(def.type);
      expect(Array.isArray(a.dependsOn)).toBe(true);
      // typeProperties must exist (even if empty) so ADF accepts the JSON
      expect(typeof a.typeProperties).toBe('object');
    }
  });

  it('findByType / findByKey round-trip', () => {
    const def = findByKey('Copy');
    expect(def).toBeDefined();
    expect(findByType(def!.type)?.key).toBe('Copy');
  });

  it('nextNameSuffix increments past existing numeric tails', () => {
    const activities = [
      { name: 'Copy1', type: 'Copy' },
      { name: 'Copy2', type: 'Copy' },
      { name: 'Wait1', type: 'Wait' },
      { name: 'CopyData', type: 'Copy' }, // non-numeric tail ignored
    ];
    expect(nextNameSuffix(activities, 'Copy')).toBe(3);
    expect(nextNameSuffix(activities, 'Wait')).toBe(2);
    expect(nextNameSuffix(activities, 'NewType')).toBe(1);
  });
});

describe('Approval activity (F25 — Logic App + O365)', () => {
  it('exposes a runnable Approval palette entry on the native WebHook wire type', () => {
    const def = findByKey('ApprovalWebhook');
    expect(def).toBeDefined();
    // Native ADF WebHook — runs against any ADF/Synapse backing, no Fabric.
    expect(def!.type).toBe('WebHook');
    expect(def!.runnable).toBe(true);
    expect(def!.category).toBe('control-flow');
  });

  it('build() stamps the _loomKind discriminator + callback wiring', () => {
    const def = findByKey('ApprovalWebhook')!;
    const a = def.build('Approval1');
    expect(a.type).toBe('WebHook');
    expect(activityLoomKind(a)).toBe('ApprovalWebhook');
    const tp = a.typeProperties as Record<string, any>;
    expect(tp.method).toBe('POST');
    // reportStatusOnCallBack must be true so Approve/Reject drives activity status.
    expect(tp.reportStatusOnCallBack).toBe(true);
    // Body carries pipeline context to the Logic App (callBackUri is injected by ADF).
    expect(JSON.stringify(tp.body)).toContain('approverEmail');
  });

  it('findForActivity discriminates Approval from plain Webhook (shared WebHook type)', () => {
    const approval = findByKey('ApprovalWebhook')!.build('Approval1');
    const plain = findByKey('Webhook')!.build('Webhook1');
    expect(findForActivity(approval)?.key).toBe('ApprovalWebhook');
    expect(findForActivity(plain)?.key).toBe('Webhook');
    // type-only lookup still resolves to the first WebHook entry (plain Webhook).
    expect(findByType('WebHook')?.key).toBe('Webhook');
  });

  it('has a typed Approval form distinct from the plain Webhook form', () => {
    expect(Array.isArray(ACTIVITY_FORMS.ApprovalWebhook)).toBe(true);
    const paths = ACTIVITY_FORMS.ApprovalWebhook.map((f) => f.path);
    expect(paths).toContain('url');
    expect(paths).toContain('reportStatusOnCallBack');
  });
});
