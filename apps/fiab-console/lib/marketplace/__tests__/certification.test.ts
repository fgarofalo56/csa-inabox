import { describe, it, expect } from 'vitest';
import { evaluateCertification, KIND_REQUIRED_GATES } from '@/lib/marketplace/certification';

describe('WS-10.4 auto-certification (gate registry run)', () => {
  it('certifies when there are zero required gates (default-ON substrate)', () => {
    // app + ontology have no external gate → certifiable by default (acceptance:
    // publish an ontology as certified with no extra infra).
    for (const kind of ['app', 'ontology'] as const) {
      const req = KIND_REQUIRED_GATES[kind];
      expect(req.length).toBe(0);
      const r = evaluateCertification(req, []);
      expect(r.certification).toBe('certified');
      expect(r.gates).toEqual([]);
      expect(r.blockers).toEqual([]);
    }
  });

  it('certifies when every required gate is configured (e.g. agent + AOAI)', () => {
    const req = KIND_REQUIRED_GATES.agent; // ['svc-aoai']
    const r = evaluateCertification(req, [
      { id: 'svc-aoai', status: 'configured', missing: [], title: 'Azure OpenAI' },
    ]);
    expect(r.certification).toBe('certified');
    expect(r.gates[0]).toMatchObject({ gateId: 'svc-aoai', status: 'configured' });
    expect(r.blockers).toEqual([]);
  });

  it('fails with an honest missing-var receipt when a required gate is blocked', () => {
    const req = KIND_REQUIRED_GATES.data; // ['svc-adls']
    const r = evaluateCertification(req, [
      { id: 'svc-adls', status: 'blocked', missing: ['LOOM_ADLS_ACCOUNT'], title: 'ADLS Gen2' },
    ]);
    expect(r.certification).toBe('failed');
    expect(r.gates[0].status).toBe('blocked');
    expect(r.blockers).toContain('LOOM_ADLS_ACCOUNT'); // no fake cert — real remediation surfaced
  });

  it('treats a required gate with no reported status as blocked', () => {
    const r = evaluateCertification(['svc-aoai'], []); // status missing → conservative block
    expect(r.certification).toBe('failed');
    expect(r.gates[0].status).toBe('blocked');
  });
});
