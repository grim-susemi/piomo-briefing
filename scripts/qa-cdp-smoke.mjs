// Smoke: open a temp file page in headless Chrome, screenshot it, close, assert cleanup.
// usage: node scripts/qa-cdp-smoke.mjs --out <png>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch, isPidAlive } from './cdp.mjs';

const i = process.argv.indexOf('--out');
const out = i > 0 ? process.argv[i + 1] : '';
if (!out) { console.error('usage: node scripts/qa-cdp-smoke.mjs --out <png>'); process.exit(2); }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-smoke-'));
let page; let failure = null;
try {
  const html = path.join(dir, 'smoke.html');
  fs.writeFileSync(html, '<!doctype html><meta charset="utf-8"><title>smoke</title><body style="font:32px sans-serif"><h1 id="h">omo-briefing CDP smoke</h1>');
  page = await launch({ width: 800, height: 400 });
  await page.goto(html);
  // Frame events, bounded by eval's CDP deadline, let the visible heading paint before capture.
  const heading = await page.eval(`new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const h = document.getElementById('h');
      const rect = h.getBoundingClientRect();
      resolve({ text: h.textContent, width: rect.width, height: rect.height,
        visible: getComputedStyle(h).visibility === 'visible' && rect.top < innerHeight && rect.bottom > 0 });
    }));
  })`);
  if (heading.text !== 'omo-briefing CDP smoke') throw new Error('unexpected page text: ' + heading.text);
  if (!heading.visible || heading.width <= 0 || heading.height <= 0) throw new Error('smoke heading is not visible');
  await page.screenshot(out);
  const size = fs.statSync(out).size;
  if (size < 500) throw new Error('screenshot too small: ' + size);
  console.log(`screenshot ${out} (${size} bytes)`);
} catch (e) {
  failure = e;
}
const pid = page?.pid; const profile = page?.profileDir;
try { await page?.close(); } catch (e) { failure ||= e; }
fs.rmSync(dir, { recursive: true, force: true });
if (pid !== undefined) {
  const alive = isPidAlive(pid); const prof = fs.existsSync(profile);
  console.log(`chrome pid ${pid} alive=${alive}; profile ${profile} exists=${prof}`);
  if (alive || prof) failure ||= new Error('cleanup assertion failed');
}
if (failure) { console.error('FAIL', failure); process.exit(1); }
console.log('OK');
