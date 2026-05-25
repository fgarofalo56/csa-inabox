/**
 * /api/feedback — receives bug reports, feature requests, and
 * auto-captured errors. Forwards to the upstream csa-inabox GitHub
 * issue tracker so deployed customer tenants funnel into one queue
 * for the maintainers to address.
 *
 * Privacy:
 *  - Server-side redaction is re-applied even on already-scrubbed
 *    client payloads (defense in depth).
 *  - The signed-in user's identity is never read from the session,
 *    never included in the upstream issue, and never written to logs.
 *  - The tenant ID is hashed (SHA-256, first 8 chars) so the maintainer
 *    can de-dup reports across the same deployment without identifying
 *    the customer.
 *  - If LOOM_FEEDBACK_GITHUB_TOKEN is not configured, the endpoint
 *    accepts the report and logs a short summary (no upstream forward).
 *    Customers running fully air-gapped Loom can leave it unset.
 */

import { NextRequest, NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { redact, redactStack, scrubEnv } from '@/lib/feedback/redaction';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UPSTREAM_OWNER = process.env.LOOM_FEEDBACK_REPO_OWNER || 'fgarofalo56';
const UPSTREAM_REPO  = process.env.LOOM_FEEDBACK_REPO_NAME  || 'csa-inabox';

interface Body {
  kind: 'bug' | 'feature' | 'auto-error';
  title?: string;
  description?: string;
  errorName?: string;
  errorMessage?: string;
  stack?: string;
  url?: string;
  userAgent?: string;
  loomVersion?: string;
}

function tenantHash(): string {
  const tenant = process.env.AZURE_TENANT_ID || 'unknown';
  return crypto.createHash('sha256').update(tenant).digest('hex').slice(0, 8);
}

export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return new NextResponse('Invalid JSON', { status: 400 });
  }
  if (!body.kind || !['bug', 'feature', 'auto-error'].includes(body.kind)) {
    return new NextResponse('kind required', { status: 400 });
  }

  // Re-scrub server-side
  const env = scrubEnv({ url: body.url, userAgent: body.userAgent, loomVersion: body.loomVersion });
  const safeTitle = redact(body.title ?? body.errorMessage ?? '(no title)').slice(0, 120);
  const safeDescription = redact(body.description ?? '').slice(0, 4000);
  const safeStack = redactStack(body.stack).slice(0, 4000);
  const safeErrName = redact(body.errorName ?? '').slice(0, 80);
  const safeErrMsg = redact(body.errorMessage ?? '').slice(0, 400);

  const issueTitle = `[${body.kind}] ${safeTitle}`;
  const labels: string[] = ['csa-loom-feedback'];
  if (body.kind === 'bug') labels.push('bug');
  if (body.kind === 'feature') labels.push('enhancement');
  if (body.kind === 'auto-error') labels.push('bug', 'auto-captured');

  const fingerprint = body.kind === 'auto-error'
    ? crypto.createHash('sha256').update(safeErrName + safeErrMsg + env.url).digest('hex').slice(0, 12)
    : undefined;

  const issueBody = [
    `**Source**: deployed CSA Loom tenant (hash: \`${tenantHash()}\`)`,
    `**Loom version**: \`${env.loomVersion ?? 'unknown'}\``,
    `**Route**: \`${env.url ?? 'unknown'}\``,
    `**User agent**: \`${env.userAgent ?? 'unknown'}\``,
    fingerprint ? `**Fingerprint**: \`${fingerprint}\`` : '',
    '',
    body.kind === 'auto-error' ? `## Error\n**${safeErrName}**: ${safeErrMsg}\n\n\`\`\`\n${safeStack}\n\`\`\`` : '',
    body.kind !== 'auto-error' ? `## Description\n${safeDescription || '(none)'}` : '',
    '',
    '> _Submitted via the in-app feedback widget. No user PII, no workspace IDs, no data values are forwarded. See `lib/feedback/redaction.ts` in the Loom source for the scrub rules._',
  ].filter(Boolean).join('\n');

  const token = process.env.LOOM_FEEDBACK_GITHUB_TOKEN;
  if (!token) {
    // Air-gapped / unconfigured: log a short summary and accept.
    console.log(`[feedback] kind=${body.kind} tenant=${tenantHash()} title=${issueTitle}`);
    return NextResponse.json({ status: 'accepted-local', forwarded: false });
  }

  try {
    const r = await fetch(`https://api.github.com/repos/${UPSTREAM_OWNER}/${UPSTREAM_REPO}/issues`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({ title: issueTitle, body: issueBody, labels }),
    });
    if (!r.ok) {
      const txt = await r.text();
      console.error('[feedback] upstream forward failed', r.status, txt.slice(0, 200));
      return NextResponse.json({ status: 'accepted-queue-only', forwarded: false }, { status: 202 });
    }
    const j = (await r.json()) as { number?: number; html_url?: string };
    return NextResponse.json({ status: 'forwarded', issueNumber: j.number, issueUrl: j.html_url });
  } catch (e) {
    console.error('[feedback] upstream forward exception', (e as Error).message);
    return NextResponse.json({ status: 'accepted-queue-only', forwarded: false }, { status: 202 });
  }
}
