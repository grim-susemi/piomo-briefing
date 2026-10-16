// Pure pieces of scripts/qa-answer.mjs (the real-Chrome board answer and forgery run), kept apart so they are unit tested.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

// name -> sha256 of every file in <state>/answers ({} when the folder does not exist yet)
export function answersSnapshot(stateDir) {
  const dir = path.join(stateDir, 'answers');
  if (!existsSync(dir)) return {};
  const out = {};
  for (const name of readdirSync(dir).sort()) {
    out[name] = createHash('sha256').update(readFileSync(path.join(dir, name))).digest('hex');
  }
  return out;
}

// files added, removed or rewritten between two answersSnapshot results
export function snapshotDiff(before, after) {
  const added = Object.keys(after).filter((n) => !(n in before));
  const removed = Object.keys(before).filter((n) => !(n in after));
  const changed = Object.keys(after).filter((n) => n in before && before[n] !== after[n]);
  return { added, removed, changed, writes: added.length + removed.length + changed.length };
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// A text/plain form whose encoded body ("<name>=<value>") is exactly the JSON object `body`: the classic cross-site JSON
// POST. The browser puts one '=' between name and value, so `body` must already contain one (a text answer like
// "forged=approval"); no extra key is added, so the body is a valid /answer object that only the header guards can refuse.
export function formFieldFor(body) {
  const json = JSON.stringify(body);
  const at = json.indexOf('=');
  if (at < 0) throw new Error('form body needs an "=" inside a value (e.g. a text answer)');
  return { name: json.slice(0, at), value: json.slice(at + 1) };
}

// window.__attack() of a page on another origin (or a file:// copy): a no-cors fetch, a text/plain form POST into a
// hidden iframe, and (when a token is given, i.e. it leaked) a CORS fetch carrying the token header.
// Resolves an object naming what each request did; it never rejects.
export function attackScript(target, body, { token = '', form = true } = {}) {
  return `window.__attack = async function () {
  var out = {};
  try {
    var r = await fetch(${JSON.stringify(target)}, { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain' }, body: ${JSON.stringify(JSON.stringify(body))} });
    out.noCorsFetch = 'resolved:' + r.type;
  } catch (e) { out.noCorsFetch = 'rejected:' + e.message; }
  ${token ? `try {
    var r2 = await fetch(${JSON.stringify(target)}, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Board-Token': ${JSON.stringify(token)} }, body: ${JSON.stringify(JSON.stringify(body))} });
    out.corsTokenFetch = 'resolved:' + r2.status;
  } catch (e) { out.corsTokenFetch = 'rejected:' + e.message; }` : ''}
  ${form ? `out.formPost = await new Promise(function (resolve) {
    var fr = document.querySelector('iframe[name=sink]');
    var t = setTimeout(function () { resolve('no-load-in-10s'); }, 10000);
    fr.addEventListener('load', function () { clearTimeout(t); resolve('iframe-loaded'); }, { once: true });
    document.getElementById('forge').submit();
  });` : ''}
  return out;
};`;
}

export function formHtml(target, body) {
  const f = formFieldFor(body);
  return `<iframe name="sink" style="width:1px;height:1px;border:0"></iframe>` +
    `<form id="forge" method="POST" action="${esc(target)}" enctype="text/plain" target="sink">` +
    `<input type="hidden" name="${esc(f.name)}" value="${esc(f.value)}"></form>`;
}

// `body` = the fetch body, `formBody` = the form's (valid /answer object containing an '=')
export function evilPageHtml(target, body, formBody) {
  return `<!doctype html><meta charset="utf-8"><title>other origin</title><body><h1>other origin</h1>${formHtml(target, formBody)}` +
    `<script>${attackScript(target, body)}</script></body>`;
}
