// Dependency-free Chrome DevTools Protocol helper (Node 24: global WebSocket/fetch).
// Every wait is bounded; close() kills the Chrome process tree and deletes the temp profile
// and throws when either is left behind.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

export const CHROME = process.env.OMO_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const LAUNCH_TIMEOUT_MS = 20000;
const CALL_TIMEOUT_MS = 15000;
const EXIT_TIMEOUT_MS = 10000;
const TASKKILL_TIMEOUT_MS = 5000;

function withTimeout(promise, ms, what) {
  let t;
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`timeout after ${ms}ms: ${what}`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

// Windows needs taskkill to take the child tree down; the wait is bounded by TASKKILL_TIMEOUT_MS.
export function killProcessTree(pid, { platform = process.platform, run = spawnSync } = {}) {
  if (platform !== 'win32') return;
  run('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: TASKKILL_TIMEOUT_MS, killSignal: 'SIGKILL' });
}

export function isPidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// Every chrome.exe whose command line names this profile: the browser and its renderer/GPU/utility children.
export function listProfilePids(profileDir) {
  if (process.platform !== 'win32') return [];
  const profile = profileDir.replace(/'/g, "''").replace(/[[\]`*?]/g, '`$&');
  const query = `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object CommandLine -like '*${profile}*' | Select-Object -ExpandProperty ProcessId`;
  const result = spawnSync('powershell', ['-NoProfile', '-Command', query], {
    windowsHide: true, encoding: 'utf8', timeout: 5000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`could not list Chrome processes for ${profileDir}: ${result.stderr}`);
  return result.stdout.trim().split(/\s+/).filter(Boolean).map(Number);
}

export async function closeChromeProcess({ proc, profileDir, deps = {} }) {
  const kill = deps.killProcessTree ?? killProcessTree;
  const list = deps.listProfilePids ?? listProfilePids;
  const rm = deps.rm ?? fs.promises.rm;
  const errors = [];
  if (proc?.pid && proc.exitCode === null && proc.signalCode === null) {
    let onExit;
    const exited = new Promise((resolve) => { onExit = resolve; proc.once('exit', onExit); });
    try {
      await kill(proc.pid);
      if (process.platform !== 'win32') proc.kill('SIGKILL');
      proc.stderr?.destroy();
      await withTimeout(exited, EXIT_TIMEOUT_MS, 'Chrome exit');
    } catch (e) {
      errors.push(e);
    } finally {
      proc.stderr?.destroy();
      proc.removeListener('exit', onExit);
    }
  } else {
    proc?.stderr?.destroy();
  }
  let pids = [];
  try {
    pids = await list(profileDir);
    for (const pid of pids) await kill(pid);
  } catch (e) {
    errors.push(e);
  }
  for (const pid of new Set([proc?.pid, ...pids].filter(Boolean))) {
    if (isPidAlive(pid)) errors.push(new Error(`Chrome pid ${pid} still alive for ${profileDir}`));
  }
  try {
    await rm(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    if (fs.existsSync(profileDir)) throw new Error(`temp profile still exists: ${profileDir}`);
  } catch (e) {
    errors.push(new Error(`could not remove temp profile: ${profileDir}`, { cause: e }));
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, `Chrome cleanup failed for ${profileDir}: ${errors.map((e) => e.message).join('; ')}`);
}

async function connect(url) {
  const ws = new WebSocket(url);
  let opened, failed, closed;
  try {
    await withTimeout(new Promise((resolve, reject) => {
      opened = resolve;
      failed = () => reject(new Error('CDP websocket error'));
      closed = () => reject(new Error('CDP websocket closed before open'));
      ws.addEventListener('open', opened);
      ws.addEventListener('error', failed);
      ws.addEventListener('close', closed);
    }), CALL_TIMEOUT_MS, 'CDP connect');
    return ws;
  } catch (e) {
    ws.close();
    throw e;
  } finally {
    ws.removeEventListener('open', opened);
    ws.removeEventListener('error', failed);
    ws.removeEventListener('close', closed);
  }
}

class Client {
  constructor(ws) {
    this.ws = ws; this.nextId = 1; this.pending = new Map(); this.listeners = new Map(); this.closed = false;
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`)); else p.resolve(msg.result);
      } else if (msg.method) {
        for (const f of this.listeners.get(msg.method) || []) f(msg.params);
      }
    });
    const dead = () => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new Error('CDP connection closed'));
      this.pending.clear();
    };
    ws.addEventListener('close', dead);
    ws.addEventListener('error', dead);
  }
  send(method, params = {}) {
    if (this.closed) return Promise.reject(new Error('CDP connection closed'));
    const id = this.nextId++;
    const p = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject, method }));
    this.ws.send(JSON.stringify({ id, method, params }));
    return withTimeout(p, CALL_TIMEOUT_MS, method).finally(() => this.pending.delete(id));
  }
  once(method, ms = CALL_TIMEOUT_MS) {
    let f;
    const p = new Promise((resolve) => {
      const arr = this.listeners.get(method) || [];
      f = (params) => resolve(params);
      arr.push(f); this.listeners.set(method, arr);
    });
    return withTimeout(p, ms, 'event ' + method).finally(() => {
      this.listeners.set(method, (this.listeners.get(method) || []).filter((x) => x !== f));
    });
  }
}

export async function launch({ width = 1440, height = 900, extraArgs = [], chrome = CHROME } = {}) {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-cdp-'));
  const args = [
    '--headless=new', '--remote-debugging-port=0', '--mute-audio', `--user-data-dir=${profileDir}`,
    `--window-size=${width},${height}`, '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-background-networking', ...extraArgs, 'about:blank',
  ];
  let proc, browserWs, pageWs;
  try {
    proc = spawn(chrome, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    // Chrome publishes the browser endpoint on stderr. Subscribe before it can emit; no file polling.
    const lines = createInterface({ input: proc.stderr });
    let onLine, onError, onClose;
    let endpoint;
    try {
      endpoint = await withTimeout(new Promise((resolve, reject) => {
        onLine = (line) => {
          const m = /^DevTools listening on (ws:\/\/\S+)/.exec(line);
          if (m) resolve(m[1]);
        };
        onError = reject;
        onClose = () => reject(new Error('Chrome closed before DevTools endpoint was published'));
        lines.on('line', onLine);
        proc.once('error', onError);
        proc.once('close', onClose);
      }), LAUNCH_TIMEOUT_MS, 'Chrome DevTools endpoint');
    } finally {
      lines.removeListener('line', onLine);
      proc.removeListener('error', onError);
      proc.removeListener('close', onClose);
      lines.close();
      proc.stderr.resume();
    }
    const port = Number(new URL(endpoint).port);
    browserWs = await connect(endpoint);
    const browser = new Client(browserWs);
    // Create the page by protocol request instead of polling /json/list for a target.
    const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
    pageWs = await connect(`ws://127.0.0.1:${port}/devtools/page/${targetId}`);
    browserWs.close();
    const c = new Client(pageWs);
    await c.send('Page.enable');
    await c.send('Runtime.enable');
    await c.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });

    let closed = false;
    const page = {
      pid: proc.pid, profileDir, port, client: c,
      async goto(url) {
        if (!/^(https?|file|about|data):/.test(url)) url = pathToFileURL(path.resolve(url)).href;
        const loaded = c.once('Page.loadEventFired');
        // Observe a failed navigation's load deadline as well as the navigation response.
        const navigated = c.send('Page.navigate', { url }).then((nav) => {
          if (nav.errorText) throw new Error('navigate failed: ' + nav.errorText);
        });
        await Promise.all([loaded, navigated]);
      },
      async eval(expression) {
        const r = await c.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
        if (r.exceptionDetails) throw new Error('eval failed: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
        return r.result.value;
      },
      async screenshot(file) {
        const r = await c.send('Page.captureScreenshot', { format: 'png' });
        fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
        fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
      },
      async addInitScript(source) {
        await c.send('Page.addScriptToEvaluateOnNewDocument', { source });
      },
      async close() {
        if (closed) return;
        pageWs.close();
        await closeChromeProcess({ proc, profileDir });
        closed = true;
      },
    };
    return page;
  } catch (e) {
    pageWs?.close();
    browserWs?.close();
    try {
      await closeChromeProcess({ proc, profileDir });
    } catch (cleanupError) {
      throw new AggregateError([e, cleanupError], 'Chrome launch and cleanup failed');
    }
    throw e;
  }
}

// --- QA helpers: CSP violations and accessibility snapshots -------------------------------

const CSP_BINDING = '__omoCspViolation';
const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'combobox', 'checkbox', 'radio',
  'slider', 'spinbutton', 'tab', 'menuitem', 'switch',
]);

// Call this BEFORE the first navigation: the binding and the document init script must exist
// before the document that may violate the policy is parsed, or the violation is lost.
// Collects securitypolicyviolation payloads from the binding plus Log entries that Chrome emits
// for the same refusal, so a QA run can fail on either signal independently.
export async function watchCsp(page) {
  const violations = [];
  const notes = [];
  const on = (method, fn) => {
    const list = page.client.listeners.get(method) || [];
    list.push(fn);
    page.client.listeners.set(method, list);
  };
  await page.client.send('Runtime.addBinding', { name: CSP_BINDING });
  await page.client.send('Log.enable');
  await page.addInitScript(`(() => {
    document.addEventListener('securitypolicyviolation', (event) => {
      try {
        globalThis.${CSP_BINDING}(JSON.stringify({
          disposition: event.disposition,
          directive: event.effectiveDirective,
          blocked: event.blockedURI,
          source: event.sourceFile,
          line: event.lineNumber,
        }));
      } catch {}
    }, true);
  })()`);
  on('Runtime.bindingCalled', (params) => {
    if (params.name !== CSP_BINDING) return;
    let record;
    try {
      record = JSON.parse(params.payload);
    } catch (err) {
      record = null;
    }
    if (record && typeof record === 'object') violations.push({ origin: 'binding', ...record });
    // An unparsable payload is still a refused page: fail closed instead of dropping it.
    else violations.push({ origin: 'binding', payload: params.payload, parseError: true });
  });
  const logRecord = (entry = {}) => ({
    level: entry.level, source: entry.source, text: entry.text, url: entry.url, lineNumber: entry.lineNumber,
  });
  on('Log.entryAdded', (params) => {
    const entry = params.entry || {};
    if (entry.level === 'error' && (entry.source === 'security' || /Content Security Policy/.test(entry.text || ''))) {
      violations.push({ origin: 'log', ...logRecord(entry) });
    } else {
      // Evidence only (autoplay refusal, network noise, console errors): never a CSP failure here.
      notes.push(logRecord(entry));
    }
  });
  return {
    violations,
    notes,
    assertNone(label = 'page') {
      if (!violations.length) return;
      const detail = violations.map((violation, i) => `  ${i + 1}. ${JSON.stringify(violation)}`).join('\n');
      throw new Error(`${label}: ${violations.length} CSP violation(s)\n${detail}`);
    },
  };
}

function axName(name) {
  const text = String(name ?? '').trim();
  return text === '' ? '' : ' ' + JSON.stringify(text);
}

// [checked|expanded|selected|disabled|value=...] in that fixed order; false states stay silent.
function axState(node) {
  const values = new Map((node.properties || []).map((property) => [property.name, property.value?.value]));
  const on = (value) => value === true || value === 'true';
  const flags = [];
  if (values.get('checked') === 'mixed') flags.push('checked=mixed');
  else if (on(values.get('checked'))) flags.push('checked');
  if (on(values.get('expanded'))) flags.push('expanded');
  if (on(values.get('selected'))) flags.push('selected');
  if (on(values.get('disabled'))) flags.push('disabled');
  // Chrome exposes the control value on the AXNode itself (AXValue), not in properties.
  const value = node.value?.value;
  if (value !== undefined && value !== null && String(value) !== '') flags.push(`value=${value}`);
  return flags.length ? ` [${flags.join(', ')}]` : '';
}

// Child order from childIds; ignored nodes are not printed and their children are flattened to the
// same depth. A node that is unreachable from every declared root still renders once.
function formatAxTree(nodes) {
  const byId = new Map(nodes.map((node) => [String(node.nodeId), node]));
  const rendered = new Set();
  const lines = [];
  const emit = (node, depth) => {
    if (!node) return;
    const id = String(node.nodeId);
    if (rendered.has(id)) return;
    rendered.add(id);
    const role = node.role?.value;
    if (node.ignored || !role) {
      for (const childId of node.childIds || []) emit(byId.get(String(childId)), depth);
      return;
    }
    lines.push('  '.repeat(depth) + role + axName(node.name?.value) + axState(node));
    for (const childId of node.childIds || []) emit(byId.get(String(childId)), depth + 1);
  };
  for (const node of nodes) {
    if (!node.parentId || !byId.has(String(node.parentId))) emit(node, 0);
  }
  for (const node of nodes) emit(node, 0);
  return lines.join('\n');
}

// Accessibility.enable then Accessibility.getFullAXTree; raw is the untouched response.
export async function axSnapshot(page) {
  await page.client.send('Accessibility.enable');
  const raw = await page.client.send('Accessibility.getFullAXTree');
  return { raw, text: formatAxTree(raw?.nodes || []) };
}

export function unnamedInteractive(nodes) {
  return (nodes || []).filter((node) => !node.ignored
    && INTERACTIVE_ROLES.has(node.role?.value)
    && String(node.name?.value ?? '').trim() === '');
}
