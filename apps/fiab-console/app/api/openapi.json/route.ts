/**
 * GET /api/openapi.json — the machine-readable OpenAPI 3.1 contract for the
 * Loom public API (BR-OPENAPI).
 *
 * Deliberately UNAUTHENTICATED: an API spec is public metadata (it names routes
 * + shapes, never data or secrets), and SDK/codegen/Terraform tooling needs to
 * read it without a credential. The primary server URL is derived from the
 * request origin (falling back to `LOOM_PUBLIC_BASE_URL`) so a generated client
 * targets THIS deployment — Commercial or Government — not a hard-coded host.
 *
 * Rendered by the explorer at `/developer/api`.
 */

import { NextResponse } from 'next/server';
import { buildOpenApiSpec } from '@/lib/openapi/spec';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  let origin = '';
  try {
    origin = new URL(req.url).origin;
  } catch {
    origin = '';
  }
  const base = origin || process.env.LOOM_PUBLIC_BASE_URL || '';
  const spec = buildOpenApiSpec(base);
  return NextResponse.json(spec, {
    headers: {
      // Public, cacheable metadata — safe to cache at the edge for a minute.
      'Cache-Control': 'public, max-age=60',
    },
  });
}
