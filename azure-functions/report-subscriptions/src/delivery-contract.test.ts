/**
 * Delivery-contract test — the Function's Logic App payload vs the REAL bicep.
 *
 * Why this file exists: before this test, `deliverViaLogicApp` POSTed
 * `{ recipients: string[], format, contentBytes, fileName }`. The delivery
 * workflow (integration/report-subscription-logicapp.bicep) reads
 * `attachmentBase64` / `attachmentName` and takes `recipients` as a
 * ';'-separated STRING. None of the posted attachment keys existed in the
 * schema, so `Attachments` would have evaluated to `json('[]')` — an email with
 * no attachment while the Function recorded `succeeded`.
 *
 * No such email was ever sent: this Function App has never had code published,
 * and the Y1 runtime it targets is documented non-functional on this estate
 * (docs/fiab/functions-to-aca-jobs.md). A real contract defect in code that has
 * never run — which is exactly the kind only a test can catch.
 *
 * The assertions below read the bicep module itself (not a copied fixture, per
 * the "fixtures that model the code, not reality" lesson) and compare it to the
 * keys `deliveryPayload` actually emits. Break either side and this goes red.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deliveryPayload } from './delivery-payload';

const BICEP = join(
  __dirname,
  '..', '..', '..',
  'platform', 'fiab', 'bicep', 'modules', 'integration', 'report-subscription-logicapp.bicep',
);

function bicepText(): string {
  return readFileSync(BICEP, 'utf8');
}

/** The property names declared on the workflow's `manual` trigger schema. */
function triggerSchemaProperties(text: string): string[] {
  const schemaAt = text.indexOf('schema: {');
  expect(schemaAt, 'manual trigger schema block not found in the bicep').toBeGreaterThan(-1);
  const required = text.indexOf('required:', schemaAt);
  const block = text.slice(schemaAt, required > -1 ? required : schemaAt + 4000);
  const names = new Set<string>();
  for (const m of block.matchAll(/^\s*(\w+):\s*\{\s*type:\s*'(?:string|integer|boolean)'\s*\}/gm)) {
    names.add(m[1]);
  }
  return [...names];
}

describe('delivery payload ↔ Logic App trigger schema', () => {
  it('emits only keys the workflow trigger declares', () => {
    const declared = new Set(triggerSchemaProperties(bicepText()));
    expect(declared.size, 'parsed zero properties — the parser drifted from the bicep').toBeGreaterThan(0);

    const posted = Object.keys(
      deliveryPayload({
        recipients: ['a@example.com', 'b@example.com'],
        subject: 's',
        reportName: 'r',
        attachmentName: 'r.pdf',
        attachmentContentType: 'application/pdf',
        attachmentBase64: 'AAA=',
      }),
    );

    const undeclared = posted.filter((k) => !declared.has(k));
    expect(
      undeclared,
      `these keys are POSTed but absent from the trigger schema (the workflow will ignore them): ${undeclared.join(', ')}`,
    ).toEqual([]);
  });

  it('supplies every REQUIRED trigger property', () => {
    const text = bicepText();
    const req = /required:\s*\[([^\]]*)\]/.exec(text);
    expect(req, 'no required[] on the trigger schema').not.toBeNull();
    const required = [...req![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(required.length).toBeGreaterThan(0);

    const posted = deliveryPayload({ recipients: ['a@example.com'], subject: 's' });
    for (const key of required) {
      expect(posted, `required trigger property '${key}' is not posted`).toHaveProperty(key);
      expect(String((posted as Record<string, string>)[key]).length, `required '${key}' posted empty`).toBeGreaterThan(0);
    }
  });

  it("joins recipients into the ';'-separated string the O365 To: field expects", () => {
    const p = deliveryPayload({ recipients: ['a@example.com', 'b@example.com'], subject: 's' });
    expect(p.recipients).toBe('a@example.com;b@example.com');
    expect(Array.isArray(p.recipients)).toBe(false);
  });

  it('carries the attachment on the key the workflow reads (attachmentBase64)', () => {
    // The workflow: Attachments = if(empty(coalesce(triggerBody()?['attachmentBase64'],'')), json('[]'), …)
    expect(bicepText()).toContain("triggerBody()?[\\'attachmentBase64\\']");
    const p = deliveryPayload({
      recipients: ['a@example.com'], subject: 's', attachmentName: 'r.pdf', attachmentBase64: 'AAA=',
    });
    expect(p.attachmentBase64).toBe('AAA=');
    expect(p.attachmentName).toBe('r.pdf');
  });

  it('a B-N19d digest posts bodyHtml and no attachment', () => {
    const p = deliveryPayload({ recipients: ['a@example.com'], subject: 'Digest', bodyHtml: '<h1>hi</h1>' });
    expect(p.bodyHtml).toBe('<h1>hi</h1>');
    // Empty attachmentBase64 is what makes the workflow send Attachments: [].
    expect(p.attachmentBase64).toBe('');
  });
});
