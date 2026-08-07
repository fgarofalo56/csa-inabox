/**
 * delivery-payload — the PURE contract between this Function and the delivery
 * Logic App (`platform/fiab/bicep/modules/integration/report-subscription-logicapp.bicep`).
 *
 * No Azure SDK imports here (same rule as `schedule.ts`) so the contract is
 * unit-testable on its own, and so `delivery-contract.test.ts` can assert it
 * against the real bicep without dragging @azure/cosmos into the test graph.
 *
 * Why this module exists: the pre-fix delivery POSTed
 * `{ recipients: string[], format, contentBytes, fileName }`. The workflow
 * trigger schema declares `recipients` (a ';'-separated STRING), `subject`,
 * `reportName`, `attachmentName`, `attachmentContentType`, `attachmentBase64`
 * and `bodyHtml` — so `contentBytes`/`fileName` would have been silently
 * ignored and `Attachments` would have evaluated to `json('[]')`, i.e. an email
 * with no attachment while the Function recorded `succeeded`.
 *
 * NOTE — no such email was ever sent. This Function App has never had code
 * published (`csa-loom-post-deploy-bootstrap.yml` has 7 runs ever; last success
 * 2026-07-19, and its publish step was added 2026-07-21), and the Y1
 * Consumption runtime it targets is documented non-functional on this estate
 * (`docs/fiab/functions-to-aca-jobs.md`). This was a real contract defect in
 * code that has never run — worth fixing, but it broke nothing.
 *
 * One typed builder + a bicep-grounded test is what stops it recurring.
 */

/** Content types for the report formats the renderer produces. */
export const FORMAT_MIME: Record<string, string> = {
  PDF: 'application/pdf',
  PPTX: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  PNG: 'image/png',
};

export interface DeliveryMessage {
  /** Recipient addresses; joined with ';' for the O365 `To:` field. */
  recipients: string[];
  subject: string;
  /** Used in the default (no-bodyHtml) message body. */
  reportName?: string;
  attachmentName?: string;
  attachmentContentType?: string;
  attachmentBase64?: string;
  /**
   * HTML message body (B-N19d insight digests). When set, the workflow uses it
   * as the body; leave `attachmentBase64` empty so no attachment is sent.
   */
  bodyHtml?: string;
}

/**
 * Build the EXACT body the workflow's `manual` trigger accepts. Every declared
 * property is always present (empty string when unused) so the workflow's
 * `coalesce(...)` expressions never see `null`.
 */
export function deliveryPayload(msg: DeliveryMessage): Record<string, string> {
  return {
    recipients: msg.recipients.join(';'),
    subject: msg.subject,
    reportName: msg.reportName || '',
    attachmentName: msg.attachmentName || '',
    attachmentContentType: msg.attachmentContentType || '',
    attachmentBase64: msg.attachmentBase64 || '',
    bodyHtml: msg.bodyHtml || '',
  };
}
