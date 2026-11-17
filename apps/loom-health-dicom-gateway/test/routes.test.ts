import { describe, expect, it } from 'vitest';
import { parseRoute } from '../src/routes.js';
import { archiveBase, loadConfig } from '../src/config.js';
import { baseConfig } from './helpers.js';

const AET = 'DCM4CHEE';
const S = '1.2.840.1';
const R = '1.2.840.2';
const I = '1.2.840.3';
const p = (rest: string, tenant = 'acme') => `/${tenant}/dicomweb/v1/${rest}`;

describe('route grammar (allowlist)', () => {
  const ok: Array<[string, string, string, string]> = [
    ['GET', 'studies', 'qido', 'studies'],
    ['GET', 'series', 'qido', 'series'],
    ['GET', 'instances', 'qido', 'instances'],
    ['GET', `studies/${S}/series`, 'qido', ''],
    ['GET', `studies/${S}/instances`, 'qido', ''],
    ['GET', `studies/${S}/series/${R}/instances`, 'qido', ''],
    ['GET', `studies/${S}`, 'wado', ''],
    ['GET', `studies/${S}/metadata`, 'wado', ''],
    ['GET', `studies/${S}/series/${R}`, 'wado', ''],
    ['GET', `studies/${S}/series/${R}/metadata`, 'wado', ''],
    ['GET', `studies/${S}/series/${R}/instances/${I}`, 'wado', ''],
    ['GET', `studies/${S}/series/${R}/instances/${I}/rendered`, 'wado', ''],
    ['GET', `studies/${S}/series/${R}/instances/${I}/frames/1,2`, 'wado', ''],
    ['GET', `studies/${S}/series/${R}/instances/${I}/frames/1/rendered`, 'wado', ''],
    ['HEAD', `studies/${S}`, 'wado', ''],
    ['POST', 'studies', 'stow', ''],
    ['POST', `studies/${S}`, 'stow', ''],
  ];
  it.each(ok)('%s %s -> %s', (method, rest, interaction) => {
    const r = parseRoute(method, p(rest), AET);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (r.ok) {
      expect(r.route.interaction).toBe(interaction);
      expect(r.route.tenant).toBe('acme');
      expect(r.route.archivePath).toBe(`/dcm4chee-arc/aets/DCM4CHEE/rs/${rest}`);
    }
  });

  // Each input below would reach the archive if the allowlist were a prefix match.
  const bad: Array<[string, string, string]> = [
    ['GET', 'changefeed', 'W03b surface, not routed here'],
    ['GET', 'partitions', 'W03b surface'],
    ['GET', 'extendedquerytags', 'W03b surface'],
    ['DELETE', `studies/${S}`, 'soft delete is W03b lifecycle'],
    ['PUT', `studies/${S}`, 'no PUT upsert in the skeleton'],
    ['GET', `studies/${S}/series/${R}/instances/${I}/frames/0`, 'frame numbers start at 1'],
    ['GET', `studies/${S}/series/${R}/instances/${I}/frames/1/other`, 'unknown suffix'],
    ['GET', `studies/not-a-uid`, 'UID grammar'],
    ['GET', `studies/${S}/../../../../ui`, 'dot segments'],
    ['GET', `studies/${S}%2f..%2fadmin`, 'encoded slash'],
    ['GET', `studies/%2e%2e/x`, 'encoded dot'],
    ['GET', `studies//x`, 'empty segment'],
    ['POST', `studies/${S}/series`, 'STOW only at studies'],
    ['GET', `studies/${'1'.repeat(65)}`, 'UID longer than 64'],
    ['GET', `studies/01.2`, 'UID leading zero component'],
  ];
  it.each(bad)('%s %s is not routed (%s)', (method, rest) => {
    expect(parseRoute(method, p(rest), AET).ok).toBe(false);
  });

  it('only /{tenant}/dicomweb/v1 is a mount point', () => {
    for (const path of ['/studies', '/acme/dicomweb/studies', '/acme/fhir/v1/studies', '/ACME/dicomweb/v1/studies', '/-a/dicomweb/v1/studies', '/a/dicomweb/v1/studies', '/dcm4chee-arc/aets/X/rs/studies']) {
      expect(parseRoute('GET', path, AET).ok, path).toBe(false);
    }
    expect(parseRoute('GET', '/acme/dicomweb/v1/studies', AET).ok).toBe(true);
  });

  it('wrong verb on a collection root is 405 with Allow, not 404', () => {
    const r = parseRoute('DELETE', p('studies'), AET);
    expect(r).toMatchObject({ ok: false, status: 405, allow: 'GET, HEAD, POST' });
  });
});

describe('archive template (SSRF guard)', () => {
  const cfg = baseConfig({ archiveUrlTemplate: 'http://loom-health-dicom.{tenant}.svc:8080/' });
  it('substitutes a valid slug', () => {
    expect(archiveBase(cfg, 'acme')).toBe('http://loom-health-dicom.acme.svc:8080');
  });
  it.each(['a.evil.com#', 'a/b', 'ACME', '', 'a@b'])('refuses tenant %j (would redirect the proxy)', (t) => {
    expect(() => archiveBase(cfg, t)).toThrow('invalid tenant slug');
  });
  it('config requires {tenant} in the template and the PDP URL', () => {
    expect(() => loadConfig({ LOOM_DICOM_GW_PDP_URL: 'http://p', LOOM_DICOM_GW_PUBLIC_BASE: 'https://s', LOOM_DICOM_GW_ARCHIVE_URL_TEMPLATE: 'http://one-archive' })).toThrow('{tenant}');
    expect(() => loadConfig({ LOOM_DICOM_GW_PUBLIC_BASE: 'https://s', LOOM_DICOM_GW_ARCHIVE_URL_TEMPLATE: 'http://a.{tenant}' })).toThrow('LOOM_DICOM_GW_PDP_URL is required');
    const c = loadConfig({ LOOM_DICOM_GW_PDP_URL: 'http://p/', LOOM_DICOM_GW_PUBLIC_BASE: 'https://s/', LOOM_DICOM_GW_ARCHIVE_URL_TEMPLATE: 'http://a.{tenant}' });
    expect(c).toMatchObject({ pdpUrl: 'http://p', publicBase: 'https://s', stowMaxBytes: 4 * 1024 ** 3, qidoMaxLimit: 200 });
  });
});
