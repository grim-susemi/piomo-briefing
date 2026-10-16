// omo-briefing src/herdr-tab.mjs - the herdr tab this conversation runs in: its label and number, for the board's card names.
//
// readTab({ env, execFile, timeoutMs, platform }) -> Promise<{ tabLabel: string, tabNumber: integer } | null>
//   Runs `herdr tab get <HERDR_TAB_ID>` with an argument array (never a shell string) and a timeout. Resolves null on any
//   failure: no HERDR_TAB_ID (not a herdr terminal), herdr missing or exiting non-zero, timeout, or output that is not the
//   `{"result":{"tab":{"label":"수리","number":181,...}}}` shape. It never rejects, so a caller can fire and forget it.

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function herdrBin(env, platform = process.platform) {
  const bin = env && typeof env.HERDR_BIN_PATH === 'string' ? env.HERDR_BIN_PATH : '';
  return bin || (platform === 'win32' ? 'herdr.exe' : 'herdr');
}

export function parseTab(stdout) {
  let out;
  try { out = JSON.parse(String(stdout)); } catch { return null; }
  const tab = isObj(out) && isObj(out.result) ? out.result.tab : null;
  if (!isObj(tab) || typeof tab.label !== 'string' || !Number.isInteger(tab.number)) return null;
  return { tabLabel: tab.label, tabNumber: tab.number };
}

export function readTab({ env = process.env, execFile, timeoutMs = 3000, platform = process.platform } = {}) {
  const tabId = env && typeof env.HERDR_TAB_ID === 'string' ? env.HERDR_TAB_ID : '';
  if (!tabId || typeof execFile !== 'function') return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      execFile(herdrBin(env, platform), ['tab', 'get', tabId], { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
        resolve(err ? null : parseTab(stdout));
      });
    } catch {
      resolve(null); // a synchronous spawn failure is the same as herdr missing
    }
  });
}
