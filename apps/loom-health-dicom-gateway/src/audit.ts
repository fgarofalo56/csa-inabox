// One audit record per gateway interaction (decision, then completion). Fields
// follow the LhdsAudit_CL shape loosely (W2/W8 own the table). Records carry NO
// query values (a QIDO query can contain PatientName/PatientID) and no token.

export interface AuditEvent {
  ts: string;
  event: 'dicom.gateway.interaction';
  phase: 'decision' | 'complete';
  requestId: string;
  tenant: string | null;
  interaction: string;
  method: string;
  path: string;
  queryKeys: string[];
  outcome: 'permit' | 'deny' | 'unauthenticated' | 'pdp-unavailable' | 'rejected' | 'not-found' | 'error';
  reason: string;
  policyVersion?: string;
  /** Subject fields are read from the token only AFTER the PDP verified it. */
  sub?: string;
  clientId?: string;
  status?: number;
  bytesIn?: number;
  bytesOut?: number;
}

export type AuditSink = (e: AuditEvent) => void;

export const stdoutAudit: AuditSink = (e) => {
  process.stdout.write(`${JSON.stringify(e)}\n`);
};

/** Unverified payload read; call ONLY for a token the PDP has allowed. */
export function subjectOf(token: string): { sub?: string; clientId?: string } {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;
    const out: { sub?: string; clientId?: string } = {};
    if (typeof payload.sub === 'string') out.sub = payload.sub.slice(0, 200);
    if (typeof payload.client_id === 'string') out.clientId = payload.client_id.slice(0, 200);
    return out;
  } catch {
    return {};
  }
}
