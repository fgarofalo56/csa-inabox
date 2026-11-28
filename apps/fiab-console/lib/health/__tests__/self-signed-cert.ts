/**
 * Test-only: a minimal self-signed X.509 v1 certificate built at test time, so
 * no certificate or key is committed. DER per RFC 5280 4.1, signed with node:crypto.
 * EC keys sign with ecdsa-with-SHA384, RSA keys with sha384WithRSAEncryption.
 */
import { sign, type KeyObject } from 'node:crypto';

function len(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag: number, body: Buffer) => Buffer.concat([Buffer.from([tag]), len(body.length), body]);
const seq = (...parts: Buffer[]) => tlv(0x30, Buffer.concat(parts));

const OID_ECDSA_SHA384 = Buffer.from('06082a8648ce3d040303', 'hex');
const OID_RSA_SHA384 = Buffer.from('06092a864886f70d01010c', 'hex');
const NULL = Buffer.from('0500', 'hex');
const OID_CN = Buffer.from('0603550403', 'hex');

/** Base64 (standard) DER of a self-signed certificate for `publicKey`, signed by `privateKey`. */
export function selfSignedCertB64(publicKey: KeyObject, privateKey: KeyObject, cn = 'loom-test'): string {
  const isEc = publicKey.asymmetricKeyType === 'ec';
  const alg = isEc ? seq(OID_ECDSA_SHA384) : seq(OID_RSA_SHA384, NULL);
  const name = seq(tlv(0x31, seq(OID_CN, tlv(0x0c, Buffer.from(cn, 'utf8')))));
  const validity = seq(tlv(0x17, Buffer.from('250101000000Z')), tlv(0x17, Buffer.from('351231235959Z')));
  const spki = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  const tbs = seq(tlv(0x02, Buffer.from([0x01])), alg, name, validity, name, spki);
  const sig = sign('sha384', tbs, privateKey);
  const cert = seq(tbs, alg, tlv(0x03, Buffer.concat([Buffer.from([0x00]), sig])));
  return cert.toString('base64');
}
