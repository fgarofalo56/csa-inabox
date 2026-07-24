/**
 * GET /api/s3-gateway/info — S3-compatible ADLS gateway connect info (N8 lab 3).
 *
 * Always renders (no-vaporware: the surface is useful with or without a
 * gateway). Returns the REAL configured endpoint + connect snippets when
 * LOOM_S3_GATEWAY_URL is set, plus the native abfss:// / N1 IRC path every
 * deployment already has. When unset the payload carries the honest gate so the
 * editor shows a Fix-it; it never claims a live gateway that is not there.
 *
 * 200 → { ok:true, ...S3GatewayInfo }
 * 401 → unauthenticated
 */
import { apiOk } from '@/lib/api/respond';
import { withSession } from '@/lib/api/route-toolkit';
import { s3GatewayInfo } from '@/lib/azure/s3-gateway-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withSession(async () => {
  return apiOk({ ...s3GatewayInfo() });
});
