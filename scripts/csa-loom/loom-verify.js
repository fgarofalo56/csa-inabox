const crypto=require('crypto');
const ss=process.env.SESSION_SECRET;
const url=(process.env.LOOM_URL||'').replace(/\/+$/,'');
// Identity guard (#3804). Inlined rather than imported from mint-cookie.mjs
// because this file is CommonJS and that module is ESM; the regex and the
// refusal semantics are identical. Without it an unset LOOM_AUTOMATION_OID
// minted a cookie with NO oid claim (JSON.stringify drops undefined), every
// endpoint 401'd, and the harness reported those as endpoint failures — a red
// verdict for entirely the wrong reason.
// NORMALIZED BEFORE THE TEST (#3805), matching the chokepoint: a repo variable
// or an `az -o tsv` read carries the padding GitHub never trims, and the raw
// form of this test ACCEPTED "…0001 " while refusing "…0001". The normalized
// value is what is sealed into the claim below.
// SHAPE-CHECKED TOO (#3805 review): "hello", "<unset>" and a comma-list are not
// object ids either, and each mints a session that names nobody. The comma case
// is the sharp one — feature-gate.ts compares with strict equality, so "a,b"
// matches neither a nor b and the run silently drops to non-admin.
const oid=String(process.env.LOOM_AUTOMATION_OID||'').replace(/\r/g,'').trim();
if(!oid){console.error('[loom-verify] LOOM_AUTOMATION_OID is required - this harness mints a REAL session against a live estate, so it must run as a real principal. Refusing to mint without an oid (#3804).');process.exit(2);}
if(oid.includes(',')){console.error('[loom-verify] LOOM_AUTOMATION_OID is a comma-separated list ('+oid+') and was refused. feature-gate.ts compares with strict equality, so "a,b" matches neither a nor b (#3804).');process.exit(2);}
if(!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(oid)){console.error('[loom-verify] LOOM_AUTOMATION_OID is not a GUID ('+oid+') and was refused. It names no Entra object (#3804).');process.exit(2);}
if(/^0{8}-0{4}-0{4}-0{4}-0{11}[0-9a-f]$/i.test(oid)){console.error('[loom-verify] LOOM_AUTOMATION_OID is a placeholder ('+oid+') and was refused. Set it to a real automation identity (#3801/#3804).');process.exit(2);}
const claims={oid,name:process.env.LOOM_AUTOMATION_NAME||'verify',upn:process.env.LOOM_AUTOMATION_UPN||'verify@auto'};
const exp=Math.floor(Date.now()/1000)+3600;
const key=Buffer.from(crypto.hkdfSync('sha256',Buffer.from(ss,'utf-8'),Buffer.alloc(32),Buffer.from('loom-session-v1'),32));
const iv=crypto.randomBytes(12);const c=crypto.createCipheriv('aes-256-gcm',key,iv);
const enc=Buffer.concat([c.update(Buffer.from(JSON.stringify({claims,exp}))),c.final()]);const tag=c.getAuthTag();
const cookie='loom_session='+Buffer.concat([iv,tag,enc]).toString('base64url');
const eps=['/api/admin/self-audit','/api/admin/security/purview/sources','/api/governance/scans','/api/admin/security/mip/labels','/api/admin/dspm-ai?days=30','/api/admin/domains/purview-status'];
(async()=>{let fail=0;const out={};for(const e of eps){try{const r=await fetch(url+e,{headers:{cookie}});out[e]=r.status;if(r.status>=500||r.status===401)fail++;}catch(x){out[e]='ERR:'+(x&&x.message);fail++;}}console.log('LOOM_VERIFY_RESULT '+JSON.stringify(out));console.log(fail?('VERIFY_FAIL count='+fail):'VERIFY_PASS');process.exit(fail?1:0);})();
