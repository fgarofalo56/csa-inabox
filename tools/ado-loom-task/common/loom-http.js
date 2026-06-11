'use strict';
/*
 * Shared, ZERO-DEPENDENCY helper for the CSA Loom Azure DevOps tasks.
 *
 * Why no `azure-pipelines-task-lib`: the lib is a convenience wrapper over two
 * agent contracts that are themselves stable and documented —
 *   1. task INPUTS are exposed to the task process as `INPUT_<NAME>` env vars
 *      (name upper-cased, '.' and ' ' → '_'); and
 *   2. the agent reacts to `##vso[...]` logging commands written to stdout.
 * Implementing directly against those contracts keeps the packaged extension a
 * few KB (well under the 50 MB VSIX limit), needs no `npm install` at build
 * time, and runs on any agent that ships the Node20 handler — including
 * air-gapped Azure DevOps Server installs where the VSIX is side-loaded. Every
 * Loom call uses Node's built-in `https`/`http`; nothing else is required.
 *
 * The tasks talk ONLY to the tenant's own Loom Console URL (the `loomBaseUrl`
 * input) — never api.fabric.microsoft.com / api.powerbi.com — so they are
 * cloud-agnostic (Commercial / GCC / GCC-High / IL5 / air-gapped) by design.
 */
const https = require('node:https');
const http = require('node:http');
const { URL } = require('node:url');

/** Read a task input. ADO sets INPUT_<UPPERCASE name, . and space → _>. */
function getInput(name, required) {
  const key = 'INPUT_' + String(name).toUpperCase().replace(/[ .]/g, '_');
  const v = (process.env[key] || '').trim();
  if (!v && required) fail(`Required input '${name}' was not supplied.`);
  return v;
}

/** Read a boolean task input (true/1/yes ⇒ true). */
function getBool(name) {
  return /^(true|1|yes)$/i.test(getInput(name, false));
}

function oneLine(s) {
  return String(s).replace(/\r?\n/g, ' ');
}

function logError(msg) {
  console.log('##vso[task.logissue type=error]' + oneLine(msg));
}
function logWarn(msg) {
  console.log('##vso[task.logissue type=warning]' + oneLine(msg));
}
/** Publish a task output variable (referenceable downstream via the task's ref name). */
function setOutput(name, val) {
  console.log(`##vso[task.setvariable variable=${name};isOutput=true]${oneLine(String(val))}`);
}
/** Set the final task result. result ∈ Succeeded | SucceededWithIssues | Failed. */
function complete(result, msg) {
  console.log(`##vso[task.complete result=${result};]${oneLine(msg || '')}`);
}
function fail(msg) {
  logError(msg);
  complete('Failed', msg);
  process.exit(1);
}
function succeed(msg) {
  if (msg) console.log(msg);
  complete('Succeeded', msg || '');
}

function trimSlash(u) {
  return String(u).replace(/\/+$/, '');
}

/**
 * Make an authenticated JSON request to the Loom Console.
 * Resolves { status, json, text }; rejects only on transport error.
 */
function request(method, baseUrl, routePath, token, userOid, body) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(trimSlash(baseUrl) + routePath);
    } catch (e) {
      return reject(new Error('Invalid loomBaseUrl: ' + baseUrl));
    }
    const lib = url.protocol === 'http:' ? http : https;
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const headers = {
      authorization: 'Bearer ' + token,
      'x-user-oid': userOid,
      accept: 'application/json',
      'user-agent': 'csa-loom-ado-task',
    };
    if (payload) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = payload.length;
    }
    const req = lib.request(url, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        let json;
        try {
          json = text ? JSON.parse(text) : {};
        } catch {
          json = { ok: false, error: 'Loom returned a non-JSON response', raw: text.slice(0, 300) };
        }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Friendly 401 message shared by every task. */
function unauthorizedHint() {
  return (
    'Loom returned 401 Unauthorized. Confirm: (1) LOOM_PIPELINE_CI_ENABLED=true on the Console ' +
    '(redeploy with -p loomPipelineCiEnabled=true / set LOOM_PIPELINE_CI_ENABLED=true), ' +
    '(2) the Bearer token matches LOOM_CI_TOKEN (or LOOM_INTERNAL_TOKEN when LOOM_CI_TOKEN is unset), ' +
    'and (3) the userOid input is the acting tenant oid.'
  );
}

/** Parse "itemType:sourceItemId" lines into [{itemType, sourceItemId}]. */
function parseItemLines(raw) {
  if (!raw) return [];
  return raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const idx = line.indexOf(':');
      if (idx < 0) return { itemType: '', sourceItemId: line };
      return { itemType: line.slice(0, idx).trim(), sourceItemId: line.slice(idx + 1).trim() };
    })
    .filter((i) => i.sourceItemId);
}

module.exports = {
  getInput,
  getBool,
  oneLine,
  logError,
  logWarn,
  setOutput,
  complete,
  fail,
  succeed,
  request,
  trimSlash,
  unauthorizedHint,
  parseItemLines,
};
