/**
 * Backend contract tests for GET /api/lakehouse/download — ADLS Gen2 byte
 * passthrough backing the lakehouse explorer's right-click "Download".
 *
 *   1. unauthenticated → 401
 *   2. missing params → 400
 *   3. unknown container → 404
 *   4. happy-path streams bytes with attachment disposition
 *   5. 404 from ADLS surfaces as 404 JSON
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/azure/adls-client', async () => {
  const actual: any = await vi.importActual('@/lib/azure/adls-client');
  return { ...actual, downloadFile: vi.fn() };
});

import { GET } from '../download/route';
import { getSession } from '@/lib/auth/session';
import { downloadFile } from '@/lib/azure/adls-client';

function getReq(qs: string) { return { nextUrl: new URL(`http://x/api/lakehouse/download?${qs}`) } as any; }

beforeEach(() => { vi.resetAllMocks(); });

describe('GET /api/lakehouse/download', () => {
  it('401 when no session', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await GET(getReq('container=bronze&path=a.csv'));
    expect(res.status).toBe(401);
  });

  it('400 when params missing', async () => {
    (getSession as any).mockReturnValue({ claims: { upn: 'u' } });
    const res = await GET(getReq('container=bronze'));
    expect(res.status).toBe(400);
  });

  it('404 when container is unknown', async () => {
    (getSession as any).mockReturnValue({ claims: { upn: 'u' } });
    const res = await GET(getReq('container=nope&path=a.csv'));
    expect(res.status).toBe(404);
  });

  it('streams bytes with attachment disposition on happy path', async () => {
    (getSession as any).mockReturnValue({ claims: { upn: 'u' } });
    (downloadFile as any).mockResolvedValue({ body: Buffer.from('hello'), contentType: 'text/csv', size: 5 });
    const res = await GET(getReq('container=bronze&path=data/a.csv'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain('attachment; filename="a.csv"');
    expect(res.headers.get('content-type')).toBe('text/csv');
    expect(downloadFile).toHaveBeenCalledWith('bronze', 'data/a.csv');
  });

  it('404 when ADLS reports file not found', async () => {
    (getSession as any).mockReturnValue({ claims: { upn: 'u' } });
    (downloadFile as any).mockRejectedValue(Object.assign(new Error('not found'), { statusCode: 404 }));
    const res = await GET(getReq('container=bronze&path=missing.csv'));
    expect(res.status).toBe(404);
  });
});
