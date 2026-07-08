/**
 * loom-browser-tool — one-shot Playwright browser-automation runner (AIF-18).
 *
 * The Azure-native substitute for a native browser-automation PaaS: a Loom-owned
 * Playwright process the agent's `browser_automation` function tool drives. Runs
 * as an Azure Container Apps JOB execution — the Console
 * (browser-tool-client.runBrowserTask) starts one execution per task, passing
 * the task as the BROWSER_TASK env override; this process reads it, drives a
 * headless Chromium, and prints the result JSON to stdout (captured by the job's
 * Log Analytics sink). No external browser service is contacted — Gov-portable
 * (.claude/rules/no-fabric-dependency.md, no-vaporware.md).
 *
 * BROWSER_TASK shape: { url: string, actions?: Array<{op, selector?, text?}> }
 *   op: 'click' | 'type' | 'read' | 'screenshot'
 */
import { chromium } from 'playwright';

const MAX_ACTIONS = 25;
const NAV_TIMEOUT_MS = 30_000;

function parseTask() {
  const raw = process.env.BROWSER_TASK || '';
  if (!raw.trim()) throw new Error('BROWSER_TASK env is empty — nothing to run.');
  let task;
  try { task = JSON.parse(raw); } catch { throw new Error('BROWSER_TASK is not valid JSON.'); }
  if (!task?.url || typeof task.url !== 'string') throw new Error('BROWSER_TASK.url is required.');
  return task;
}

async function run() {
  const task = parseTask();
  const results = [];
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    const page = await browser.newPage();
    await page.goto(task.url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });

    const actions = Array.isArray(task.actions) ? task.actions.slice(0, MAX_ACTIONS) : [];
    for (const a of actions) {
      const op = String(a?.op || '').toLowerCase();
      if (op === 'click' && a.selector) {
        await page.click(String(a.selector), { timeout: 10_000 });
        results.push({ op, selector: a.selector, ok: true });
      } else if (op === 'type' && a.selector) {
        await page.fill(String(a.selector), String(a.text ?? ''), { timeout: 10_000 });
        results.push({ op, selector: a.selector, ok: true });
      } else if (op === 'read') {
        const text = a.selector
          ? await page.textContent(String(a.selector)).catch(() => null)
          : await page.evaluate(() => document.body?.innerText ?? '');
        results.push({ op, selector: a.selector ?? null, text: (text || '').slice(0, 8000) });
      } else if (op === 'screenshot') {
        const buf = await page.screenshot({ fullPage: false });
        results.push({ op, screenshot: `data:image/png;base64,${buf.toString('base64')}` });
      } else {
        results.push({ op, ok: false, error: 'unsupported or malformed action' });
      }
    }

    const pageText = (await page.evaluate(() => document.body?.innerText ?? '')).slice(0, 8000);
    // Structured result on stdout for the job's log sink.
    process.stdout.write(JSON.stringify({ ok: true, url: task.url, title: await page.title(), pageText, results }) + '\n');
  } finally {
    await browser.close();
  }
}

run().catch((e) => {
  process.stdout.write(JSON.stringify({ ok: false, error: e?.message || String(e) }) + '\n');
  process.exitCode = 1;
});
